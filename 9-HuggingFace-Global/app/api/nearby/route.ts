import { NextResponse } from 'next/server';

const NEARBY_URL =
  process.env.NEARBY_URL || 'https://ruslanmv-metaengine-nearby.hf.space';
const OVERPASS_ENDPOINTS = (
  process.env.OVERPASS_URLS ||
  [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter',
  ].join(',')
)
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type EntityType = 'all' | 'pharmacy' | 'doctor';

type NearbyResult = {
  id: string;
  name: string;
  category: 'pharmacy' | 'doctor';
  phone: string | null;
  opening_hours: string | null;
  address: string | null;
  lat: number;
  lon: number;
  distance_m: number;
  eta_walk_min: number;
  eta_drive_min: number;
  directions_url: string;
  maps: string;
  source: string;
};

function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const r = 6_371_000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildAddress(tags: Record<string, string>): string | null {
  if (tags['addr:full']) return tags['addr:full'];
  const parts = [
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:suburb'],
    tags['addr:city'],
    tags['addr:postcode'],
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

async function queryOverpass(
  overpassUrl: string,
  lat: number,
  lon: number,
  radius_m: number,
  amenityTag: 'pharmacy' | 'doctors',
  category: 'pharmacy' | 'doctor',
): Promise<NearbyResult[]> {
  const query = `
[out:json][timeout:25];
(
  node["amenity"="${amenityTag}"](around:${radius_m},${lat},${lon});
  way["amenity"="${amenityTag}"](around:${radius_m},${lat},${lon});
  relation["amenity"="${amenityTag}"](around:${radius_m},${lat},${lon});
);
out center tags;
`.trim();

  const res = await fetch(overpassUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'medai-nearby/1.0',
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Overpass ${res.status} at ${overpassUrl}`);
  }

  const data = await res.json();
  const elements = Array.isArray(data?.elements) ? data.elements : [];
  const rows: NearbyResult[] = [];

  for (const e of elements) {
    const tags: Record<string, string> = e?.tags || {};
    const center = e?.center || {};
    const pLat = toFiniteNumber(e?.lat ?? center?.lat);
    const pLon = toFiniteNumber(e?.lon ?? center?.lon);
    if (pLat === null || pLon === null) continue;

    const distance = Math.round(haversineMeters(lat, lon, pLat, pLon) * 10) / 10;
    rows.push({
      id: `osm_${e?.type || 'node'}_${e?.id ?? `${pLat}_${pLon}`}`,
      name: tags.name || 'Unknown',
      category,
      phone: tags.phone || tags['contact:phone'] || null,
      opening_hours: tags.opening_hours || null,
      address: buildAddress(tags),
      lat: pLat,
      lon: pLon,
      distance_m: distance,
      eta_walk_min: Math.max(1, Math.round(distance / 80)),
      eta_drive_min: Math.max(1, Math.round(distance / 500)),
      directions_url: `https://www.google.com/maps/dir/${lat},${lon}/${pLat},${pLon}`,
      maps: `https://www.openstreetmap.org/?mlat=${pLat}&mlon=${pLon}#map=17/${pLat}/${pLon}`,
      source: `osm_overpass:${new URL(overpassUrl).host}`,
    });
  }

  return rows;
}

async function searchDirectOverpass(
  lat: number,
  lon: number,
  radius_m: number,
  entity_type: EntityType,
  limit: number,
): Promise<NearbyResult[]> {
  const plan: Array<{ amenityTag: 'pharmacy' | 'doctors'; category: 'pharmacy' | 'doctor' }> =
    entity_type === 'all'
      ? [
          { amenityTag: 'pharmacy', category: 'pharmacy' },
          { amenityTag: 'doctors', category: 'doctor' },
        ]
      : entity_type === 'pharmacy'
        ? [{ amenityTag: 'pharmacy', category: 'pharmacy' }]
        : [{ amenityTag: 'doctors', category: 'doctor' }];

  const gathered: NearbyResult[] = [];
  const errors: string[] = [];

  for (const p of plan) {
    let entityResolved = false;
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const rows = await queryOverpass(endpoint, lat, lon, radius_m, p.amenityTag, p.category);
        gathered.push(...rows);
        entityResolved = true;
        break;
      } catch (e: any) {
        errors.push(`${p.category}@${endpoint}: ${e?.message || 'unknown error'}`);
      }
    }
    if (!entityResolved) {
      // Keep trying remaining entity types; we still may return partial results.
      continue;
    }
  }

  if (!gathered.length && errors.length) {
    throw new Error(errors.slice(0, 3).join(' | '));
  }

  const seen = new Set<string>();
  const deduped: NearbyResult[] = [];
  for (const row of gathered) {
    const k = `${row.category}|${row.name.toLowerCase()}|${row.lat.toFixed(5)}|${row.lon.toFixed(5)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(row);
  }

  deduped.sort((a, b) => a.distance_m - b.distance_m);
  return deduped.slice(0, Math.max(1, limit));
}

async function tryNearbyRest(payload: {
  lat: number;
  lon: number;
  radius_m: number;
  entity_type: EntityType;
  limit: number;
}) {
  const res = await fetch(`${NEARBY_URL}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`Nearby /api/search failed (${res.status})`);

  const data = await res.json();
  if (data?.error) throw new Error(String(data.error));
  if (!Array.isArray(data?.results)) throw new Error('Invalid /api/search response');
  return data;
}

async function tryNearbyGradio(payload: {
  lat: number;
  lon: number;
  radius_m: number;
  entity_type: EntityType;
  limit: number;
}) {
  const submitRes = await fetch(`${NEARBY_URL}/gradio_api/call/search_ui`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: [
        String(payload.lat),
        String(payload.lon),
        payload.radius_m,
        payload.entity_type,
        payload.limit,
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!submitRes.ok) throw new Error(`Gradio submit failed (${submitRes.status})`);

  const { event_id } = await submitRes.json();
  if (!event_id) throw new Error('No Gradio event_id');

  const resultRes = await fetch(`${NEARBY_URL}/gradio_api/call/search_ui/${event_id}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!resultRes.ok) throw new Error(`Gradio result failed (${resultRes.status})`);

  const text = await resultRes.text();
  const dataLine = text
    .split('\n')
    .find((l: string) => l.startsWith('data: [') && !l.includes('[DONE]'));
  if (!dataLine) throw new Error('Empty Gradio SSE data');

  const gradioData = JSON.parse(dataLine.slice(6));
  const jsonStr = gradioData?.[2];
  if (!jsonStr) throw new Error('No Gradio json payload');
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed?.error) throw new Error(String(parsed.error));
    if (!Array.isArray(parsed?.results)) throw new Error('Invalid Gradio result payload');
    return parsed;
  } catch (e: any) {
    throw new Error(e?.message || String(jsonStr));
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const lat = toFiniteNumber(body?.lat);
    const lon = toFiniteNumber(body?.lon);
    const radius_m = Math.max(200, Math.min(50_000, Number(body?.radius_m ?? 3000)));
    const limit = Math.max(1, Math.min(100, Number(body?.limit ?? 25)));
    const entity_type = String(body?.entity_type || 'all') as EntityType;

    if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return NextResponse.json(
        { error: 'Invalid coordinates', count: 0, results: [] },
        { status: 400 },
      );
    }

    const payload = { lat, lon, radius_m, entity_type, limit };
    const failures: string[] = [];

    // 1) Preferred path: nearby Space REST endpoint
    try {
      const data = await tryNearbyRest(payload);
      return NextResponse.json(data);
    } catch (e: any) {
      failures.push(`rest:${e?.message || 'failed'}`);
    }

    // 2) Backward compatibility path: Gradio submit + SSE fetch
    try {
      const data = await tryNearbyGradio(payload);
      return NextResponse.json(data);
    } catch (e: any) {
      failures.push(`gradio:${e?.message || 'failed'}`);
    }

    // 3) Last-resort path: query Overpass mirrors directly from this backend.
    try {
      const results = await searchDirectOverpass(lat, lon, radius_m, entity_type, limit);
      return NextResponse.json({
        count: results.length,
        query: { lat, lon, radius_m, entity_type, limit },
        results,
        meta: { fallback: 'direct_overpass', tried: failures },
      });
    } catch (e: any) {
      failures.push(`overpass:${e?.message || 'failed'}`);
    }

    return NextResponse.json(
      {
        error:
          'Nearby search failed after retries. Please try again in a few seconds.',
        count: 0,
        results: [],
        debug: failures.slice(0, 3),
      },
      { status: 502 },
    );
  } catch (error: any) {
    console.error('[Nearby Proxy]', error?.name, error?.message?.slice(0, 100));
    const msg =
      error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'Search timed out. The service may be starting up — please try again.'
        : 'Nearby finder unavailable. Please try again.';
    return NextResponse.json({ error: msg, count: 0, results: [] }, { status: 502 });
  }
}

export async function GET() {
  try {
    const res = await fetch(`${NEARBY_URL}/api/health`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return NextResponse.json({ status: 'ok' });
    return NextResponse.json({ status: 'waking' }, { status: 503 });
  } catch {
    return NextResponse.json({ status: 'sleeping' }, { status: 503 });
  }
}

