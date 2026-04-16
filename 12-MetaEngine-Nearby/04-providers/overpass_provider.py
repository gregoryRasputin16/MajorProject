"""Overpass provider helper.

Kept standalone so this folder can be copied into any service without package-name constraints.
"""

from dataclasses import dataclass
from typing import List, Optional
import os
import requests


@dataclass
class Place:
    id: str
    name: str
    category: str
    lat: float
    lon: float
    address: Optional[str] = None
    phone: Optional[str] = None
    opening_hours: Optional[str] = None


def fetch_nearby_from_overpass(
    lat: float,
    lon: float,
    radius_m: int,
    entity_type: str,
    overpass_url: str = "https://overpass-api.de/api/interpreter",
    user_agent: str = "medai-metaengine-nearby/1.0",
) -> List[Place]:
    tag = "pharmacy" if entity_type == "pharmacy" else "doctors"
    query = f"""
[out:json][timeout:25];
(
  node[\"amenity\"=\"{tag}\"](around:{radius_m},{lat},{lon});
  way[\"amenity\"=\"{tag}\"](around:{radius_m},{lat},{lon});
  relation[\"amenity\"=\"{tag}\"](around:{radius_m},{lat},{lon});
);
out center tags;
""".strip()

    overpass_urls = [
        u.strip()
        for u in (
            os.getenv(
                "OVERPASS_URLS",
                f"{overpass_url},https://overpass.kumi.systems/api/interpreter,https://overpass.openstreetmap.fr/api/interpreter",
            )
        ).split(",")
        if u.strip()
    ]

    data = None
    errors: List[str] = []
    for url in overpass_urls:
        try:
            response = requests.post(
                url,
                data={"data": query},
                headers={"User-Agent": user_agent},
                timeout=20,
            )
            response.raise_for_status()
            data = response.json()
            break
        except Exception as exc:
            errors.append(f"{url}: {exc}")
            continue

    if data is None:
        raise RuntimeError("Overpass query failed on all endpoints: " + " | ".join(errors[:3]))

    places: List[Place] = []
    for e in data.get("elements", []):
        tags = e.get("tags", {})
        center = e.get("center", {})
        p_lat = e.get("lat", center.get("lat"))
        p_lon = e.get("lon", center.get("lon"))
        if p_lat is None or p_lon is None:
            continue
        places.append(
            Place(
                id=f"osm_{e.get('type')}_{e.get('id')}",
                name=tags.get("name", "Unknown"),
                category=entity_type,
                lat=p_lat,
                lon=p_lon,
                address=tags.get("addr:full"),
                phone=tags.get("phone") or tags.get("contact:phone"),
                opening_hours=tags.get("opening_hours"),
            )
        )
    return places

