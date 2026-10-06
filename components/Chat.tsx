"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import ChatInput from "./ChatInput";
import Message, { type ChatMessage } from "./Message";

const CLIENT_TIMEOUT_MS = 185_000;

type Props = { initialRemaining: number; limit: number };

export default function Chat({ initialRemaining, limit }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [remaining, setRemaining] = useState(initialRemaining);
  const limitReached = remaining <= 0;
  const bottomRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function send(question: string) {
    const text = question.trim();
    if (!text || loading || limitReached) return;

    const history = messages
      .filter((m) => !m.isError)
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", content: text }]);
    setLoading(true);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history }),
        signal: controller.signal,
      });

      if (res.status === 401) {
        router.push("/");
        return;
      }

      const data = await res.json().catch(() => null);
      if (typeof data?.remaining === "number") setRemaining(data.remaining);
      if (!res.ok || !data?.answer) {
        throw new Error(data?.error ?? `Request failed (${res.status}). Please try again.`);
      }

      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", content: data.answer },
      ]);
    } catch (err) {
      const message =
        err instanceof DOMException && err.name === "AbortError"
          ? "The request timed out. Please try again."
          : err instanceof TypeError
            ? "Network error - please check your connection and try again."
            : (err as Error).message;
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: message, isError: true }]);
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  }


  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto px-1 py-4">
        {messages.length === 0 && (
          <div className="py-10 text-center">
            <h2 className="text-xl font-semibold text-slate-900 dark:text-white">Ask your database anything...</h2>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              Gemini inspects the schema and runs read-only SQL through MCP tools.
            </p>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Type a question below or pick one of the suggestions.
            </p>
          </div>
        )}

        {messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}

        {loading && (
          <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400" role="status">
            <span className="flex gap-1">
              <span className="h-2 w-2 animate-bounce rounded-full bg-indigo-500 [animation-delay:-0.3s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-indigo-500 [animation-delay:-0.15s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-indigo-500" />
            </span>
            Thinking and querying the database...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <ChatInput onSend={send} loading={loading} remaining={remaining} limit={limit} />
    </div>
  );
}
