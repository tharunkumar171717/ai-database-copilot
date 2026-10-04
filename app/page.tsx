import { redirect } from "next/navigation";
import LoginButton from "@/components/LoginButton";
import { auth } from "@/lib/auth";

const ERROR_MESSAGES: Record<string, string> = {
  AccessDenied: "Access was denied. Please try another Google account.",
  Configuration: "Sign-in is not configured correctly on the server. Please contact the administrator.",
  Verification: "The sign-in link is no longer valid. Please try again.",
};

export default async function Home({ searchParams }: PageProps<"/">) {
  const session = await auth();
  if (session?.user) redirect("/chat");

  const { error } = await searchParams;
  const errorMessage = typeof error === "string" ? (ERROR_MESSAGES[error] ?? "Sign-in failed. Please try again.") : null;

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/30">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-7 w-7" aria-hidden="true">
            <ellipse cx="12" cy="5" rx="8" ry="3" />
            <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
          </svg>
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-white">AI Database Copilot</h1>
        <p className="mt-3 text-slate-600 dark:text-slate-400">
          Ask questions about your PostgreSQL database in plain English. Gemini explores the schema and runs
          safe, read-only queries through MCP tools.
        </p>

        {errorMessage && (
          <p className="mt-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {errorMessage}
          </p>
        )}

        <div className="mt-8 flex justify-center">
          <LoginButton />
        </div>
        <p className="mt-4 text-xs text-slate-500">Sign in with your Google account to continue.</p>
      </div>
    </main>
  );
}
