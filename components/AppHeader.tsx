import Image from "next/image";
import Link from "next/link";
import LogoutButton from "./LogoutButton";

type Props = {
  user: { name?: string | null; email?: string | null; image?: string | null };
  active: "chat" | "logs";
};

export default function AppHeader({ user, active }: Props) {
  const firstName = user.name?.split(" ")[0] ?? user.email;
  const linkClass = (isActive: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition ${
      isActive
        ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
        : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
    }`;

  return (
    <header className="border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-4">
          <Link href="/chat" className="text-lg font-semibold tracking-tight text-slate-900 dark:text-white">
            AI Database Copilot
          </Link>
          <nav className="flex gap-1">
            <Link href="/chat" className={linkClass(active === "chat")}>Chat</Link>
            <Link href="/logs" className={linkClass(active === "logs")}>Logs</Link>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {user.image && (
            <Image src={user.image} alt="" width={32} height={32} className="rounded-full" />
          )}
          <div className="hidden text-right text-sm leading-tight sm:block">
            <div className="font-medium text-slate-900 dark:text-white">Hello {firstName}</div>
            <div className="text-slate-500 dark:text-slate-400">{user.email}</div>
          </div>
          <LogoutButton />
        </div>
      </div>
    </header>
  );
}
