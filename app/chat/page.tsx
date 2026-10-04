import type { Metadata } from "next";
import { redirect } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import Chat from "@/components/Chat";
import { auth } from "@/lib/auth";
import { getRemainingQuestions, QUESTION_LIMIT } from "@/lib/query-logs";

export const metadata: Metadata = { title: "Chat - AI Database Copilot" };

export default async function ChatPage() {
  const session = await auth();
  if (!session?.user) redirect("/");

  const remaining = await getRemainingQuestions().catch(() => QUESTION_LIMIT);

  return (
    <div className="flex h-dvh flex-col">
      <AppHeader user={session.user} active="chat" />
      <main className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4">
        <Chat initialRemaining={remaining} limit={QUESTION_LIMIT} />
      </main>
    </div>
  );
}
