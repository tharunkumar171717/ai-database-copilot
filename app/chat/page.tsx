import type { Metadata } from "next";
import { redirect } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import Chat from "@/components/Chat";
import { auth } from "@/lib/auth";

export const metadata: Metadata = { title: "Chat - AI Database Copilot" };

export default async function ChatPage() {
  const session = await auth();
  if (!session?.user) redirect("/");

  return (
    <div className="flex h-dvh flex-col">
      <AppHeader user={session.user} active="chat" />
      <main className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4">
        <Chat />
      </main>
    </div>
  );
}
