"use client";

import { useState, type FormEvent } from "react";

const EXAMPLES = [
  "What tables are available?",
  "How many pending orders are there?",
  "What are the top 5 products by sales?",
  "Which customer has placed the most orders?",
  "Show me orders above 50000.",
  "What products are out of stock?",
];

type Props = {
  onSend: (question: string) => void;
  loading: boolean;
  remaining: number;
  limit: number;
};

/** Bottom bar of the chat: example questions, text input and the remaining-questions counter. */
export default function ChatInput({ onSend, loading, remaining, limit }: Props) {
  const [input, setInput] = useState("");
  const limitReached = remaining <= 0;
  const disabled = loading || limitReached;

  function submit(question: string) {
    if (disabled || !question.trim()) return;
    onSend(question);
    setInput("");
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    submit(input);
  }

  return (
    <div className="sticky bottom-0 border-t border-slate-200 bg-slate-50 pb-3 pt-2 dark:border-slate-800 dark:bg-slate-950">
      {/* Suggestions stay visible for the whole conversation */}
      <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
        {EXAMPLES.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => submit(q)}
            disabled={disabled}
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
          disabled={disabled}
          aria-label="Ask a question about the database"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
        />
        <button
          type="submit"
          disabled={disabled || !input.trim()}
          className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Sending..." : "Send"}
        </button>
      </form>

      <p
        className={`mt-1.5 text-right text-xs ${
          limitReached ? "text-red-600 dark:text-red-400" : "text-slate-500 dark:text-slate-400"
        }`}
      >
        {limitReached ? `Question limit reached (${limit} of ${limit} used).` : `${remaining} of ${limit} questions left`}
      </p>
    </div>
  );
}
