"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Message, { type ChatMessage } from "./Message";

const EXAMPLES = [
  "What tables are available?",
  "How many pending orders are there?",
  "What are the top 5 products by sales?",
  "Which customer has placed the most orders?",
  "Show me orders above 50000.",
  "What products are out of stock?",
];

const CLIENT_TIMEOUT_MS = 65_000;

type Props = { initialRemaining: number; limit: number };

export default function Chat({ initialRemaining, limit }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
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
    setInput("");
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
        { id: crypto.randomUUID(), role: "assistant", content: data.answer, toolsUsed: data.toolsUsed },
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

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    send(input);
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

      <div className="sticky bottom-0 border-t border-slate-200 bg-slate-50 pb-3 pt-2 dark:border-slate-800 dark:bg-slate-950">
      {/* Suggestions stay visible for the whole conversation */}
      <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
        {EXAMPLES.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => send(q)}
            disabled={loading || limitReached}
            className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 transition hover:border-indigo-300 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-indigo-500"
          >
            {q}
          </button>
        ))}
      </div>
      <form onSubmit={onSubmit} className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={limitReached ? "Question limit reached" : "How many pending orders are there?"}
          maxLength={1000}
          disabled={loading || limitReached}
          aria-label="Ask a question about the database"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
        />
        <button
          type="submit"
          disabled={loading || limitReached || !input.trim()}
          className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Sending..." : "Send"}
        </button>
      </form>
      <p className={`mt-1.5 text-right text-xs ${limitReached ? "text-red-600 dark:text-red-400" : "text-slate-500 dark:text-slate-400"}`}>
        {limitReached
          ? `Question limit reached (${limit} of ${limit} used).`
          : `${remaining} of ${limit} questions left`}
      </p>
      </div>
    </div>
  );
}
