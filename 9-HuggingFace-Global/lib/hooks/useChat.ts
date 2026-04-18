"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import type { Provider, Preset } from "../types";
import {
  buildPatientContext,
  buildMedicineInventoryContext,
  buildContactsContext,
} from "../health-store";

export type ChatMessage = {
  id: number;
  role: "user" | "ai";
  content: string;
  timestamp: string;
};

export type SendOptions = {
  preset?: Preset;
  provider?: Provider;
  model?: string;
  apiKey?: string;
  userHfToken?: string;
  context?: {
    country: string;
    language: string;
    emergencyNumber: string;
    units?: "metric" | "imperial";
  };
};

export type ChatSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  preview: string;
  messageCount: number;
};

type ChatThread = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

/**
 * Providers that require the user to supply credentials client-side.
 * Free presets route via the server's HF_TOKEN, so no key is needed.
 */
const BYO_KEY_PROVIDERS: Provider[] = ["openai", "gemini", "claude"];
const THREADS_STORAGE_KEY = "medos_chat_threads_v1";
const ACTIVE_THREAD_STORAGE_KEY = "medos_chat_active_thread_v1";

function introMessage(): ChatMessage {
  return {
    id: 1,
    role: "ai",
    content:
      "Hello! I'm your medical AI assistant. I'm here to help answer health questions and provide guidance. How can I assist you today?\n\n*Please note: I'm an AI and cannot replace professional medical advice. For emergencies, please call 112 or visit your nearest emergency room.*",
    timestamp: new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
  };
}

function makeThread(title: string = "New chat"): ChatThread {
  const now = new Date().toISOString();
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    createdAt: now,
    updatedAt: now,
    messages: [introMessage()],
  };
}

function guessTitleFromMessage(content: string): string {
  const trimmed = content.replace(/\s+/g, " ").trim();
  if (!trimmed) return "New chat";
  return trimmed.length > 42 ? `${trimmed.slice(0, 42)}...` : trimmed;
}

export function useChat() {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string>("");
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const rawThreads = localStorage.getItem(THREADS_STORAGE_KEY);
      const rawActive = localStorage.getItem(ACTIVE_THREAD_STORAGE_KEY);

      if (rawThreads) {
        const parsed = JSON.parse(rawThreads) as ChatThread[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          setThreads(parsed);
          const activeExists = rawActive && parsed.some((t) => t.id === rawActive);
          setActiveThreadId(activeExists ? rawActive! : parsed[0].id);
          return;
        }
      }
    } catch {
      // malformed storage fallback
    }

    const first = makeThread();
    setThreads([first]);
    setActiveThreadId(first.id);
  }, []);

  useEffect(() => {
    if (threads.length === 0) return;
    localStorage.setItem(THREADS_STORAGE_KEY, JSON.stringify(threads));
    if (activeThreadId) {
      localStorage.setItem(ACTIVE_THREAD_STORAGE_KEY, activeThreadId);
    }
  }, [threads, activeThreadId]);

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId) ?? threads[0],
    [threads, activeThreadId],
  );

  const messages = useMemo(
    () => activeThread?.messages ?? [introMessage()],
    [activeThread],
  );

  const sessions: ChatSession[] = useMemo(() => {
    return [...threads]
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
      .map((thread) => {
        const firstUser =
          thread.messages.find((m) => m.role === "user")?.content || "";
        return {
          id: thread.id,
          title: thread.title,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          preview: firstUser,
          messageCount: thread.messages.length,
        };
      });
  }, [threads]);

  const updateThreadById = useCallback(
    (threadId: string, updater: (thread: ChatThread) => ChatThread) => {
      setThreads((prev) => prev.map((t) => (t.id === threadId ? updater(t) : t)));
    },
    [],
  );

  const createNewChat = useCallback(() => {
    const next = makeThread();
    setThreads((prev) => [next, ...prev]);
    setActiveThreadId(next.id);
    setError(null);
    setIsTyping(false);
    return next.id;
  }, []);

  const switchChat = useCallback((threadId: string) => {
    setActiveThreadId(threadId);
    setError(null);
  }, []);

  const deleteChat = useCallback(
    (threadId: string) => {
      setThreads((prev) => {
        const filtered = prev.filter((t) => t.id !== threadId);
        if (filtered.length === 0) {
          const replacement = makeThread();
          setActiveThreadId(replacement.id);
          return [replacement];
        }
        if (threadId === activeThreadId) {
          setActiveThreadId(filtered[0].id);
        }
        return filtered;
      });
    },
    [activeThreadId],
  );

  const sendMessage = useCallback(
    async (content: string, options: SendOptions) => {
      if (!content.trim()) return;

      const threadId = activeThread?.id;
      if (!threadId) return;

      if (
        !options.preset &&
        options.provider &&
        BYO_KEY_PROVIDERS.includes(options.provider) &&
        !options.apiKey?.trim()
      ) {
        setError("Please add an API key in Settings first.");
        return;
      }

      const timestamp = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });

      const userMessage: ChatMessage = {
        id: Date.now(),
        role: "user",
        content: content.trim(),
        timestamp,
      };

      updateThreadById(threadId, (thread) => ({
        ...thread,
        title:
          thread.title === "New chat"
            ? guessTitleFromMessage(userMessage.content)
            : thread.title,
        updatedAt: new Date().toISOString(),
        messages: [...thread.messages, userMessage],
      }));

      setIsTyping(true);
      setError(null);

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45000);

        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            preset: options.preset,
            provider: options.provider,
            model: options.model,
            apiKey: options.apiKey,
            userHfToken: options.userHfToken,
            context: options.context,
            messages: [...messages, userMessage].map((m, i) => ({
              role: m.role === "ai" ? "assistant" : "user",
              content:
                i === 0 && m.role === "user"
                  ?
                    m.content +
                    buildPatientContext() +
                    buildMedicineInventoryContext() +
                    buildContactsContext()
                  : m.content,
            })),
          }),
        });

        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`Request failed: ${response.statusText}`);
        }

        if (!response.body) {
          throw new Error("No response body");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let aiContent = "";
        let buffer = "";
        const aiMessageId = Date.now() + 1;
        let firstByteAt: number | null = null;
        const requestStartedAt = Date.now();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() || "";

          for (const frame of frames) {
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (!data) continue;
              if (data === "[DONE]") break;

              try {
                const parsed = JSON.parse(data);
                if (parsed.error) throw new Error(parsed.error);

                const chunkContent =
                  parsed?.choices?.[0]?.delta?.content ?? parsed?.content ?? "";

                if (chunkContent) {
                  if (firstByteAt === null) {
                    firstByteAt = Date.now();
                    if (typeof console !== "undefined") {
                      console.info(
                        `[Chat] First token received in ${firstByteAt - requestStartedAt}ms` +
                          (parsed?.provider ? ` via ${parsed.provider}` : "") +
                          (parsed?.model ? ` (${parsed.model})` : ""),
                      );
                    }
                  }
                  aiContent += chunkContent;

                  updateThreadById(threadId, (thread) => {
                    const existing = thread.messages.find((m) => m.id === aiMessageId);
                    const nextMessages = existing
                      ? thread.messages.map((m) =>
                          m.id === aiMessageId ? { ...m, content: aiContent } : m,
                        )
                      : [
                          ...thread.messages,
                          {
                            id: aiMessageId,
                            role: "ai" as const,
                            content: aiContent,
                            timestamp: new Date().toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            }),
                          },
                        ];

                    return {
                      ...thread,
                      updatedAt: new Date().toISOString(),
                      messages: nextMessages,
                    };
                  });
                }
              } catch {
                if (typeof console !== "undefined") {
                  console.debug("[Chat] Skipped SSE frame:", data.slice(0, 120));
                }
              }
            }
          }
        }

        if (!aiContent) {
          throw new Error(
            "The AI returned an empty response. Check Admin -> LLM for provider health.",
          );
        }
      } catch (err: any) {
        const errorMessage =
          err?.name === "AbortError"
            ? "Response took too long. The AI service may be starting up - please try again in a moment."
            : err?.message || "Failed to send message";
        setError(errorMessage);

        if (typeof console !== "undefined") {
          console.error("[Chat] Stream failed:", errorMessage, err);
        }

        updateThreadById(threadId, (thread) => ({
          ...thread,
          updatedAt: new Date().toISOString(),
          messages: [
            ...thread.messages,
            {
              id: Date.now() + 2,
              role: "ai",
              content: `Error: ${errorMessage}\n\nPlease check your settings and try again.`,
              timestamp: new Date().toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              }),
            },
          ],
        }));
      } finally {
        setIsTyping(false);
      }
    },
    [activeThread, messages, updateThreadById],
  );

  // Backward-compatible alias for old callers.
  const clearMessages = useCallback(() => {
    createNewChat();
  }, [createNewChat]);

  return {
    messages,
    sessions,
    activeThreadId: activeThread?.id || "",
    isTyping,
    error,
    sendMessage,
    createNewChat,
    switchChat,
    deleteChat,
    clearMessages,
  };
}
