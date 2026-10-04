import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import QueryLogsTable from "@/components/QueryLogsTable";
import { auth } from "@/lib/auth";
import { listQueryLogs } from "@/lib/query-logs";

export const metadata: Metadata = { title: "Query logs - AI Database Copilot" };

export default async function LogsPage({ searchParams }: PageProps<"/logs">) {
  const session = await auth();
  if (!session?.user) redirect("/");

  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : "";
  const pageParam = typeof params.page === "string" ? Number(params.page) : 1;

  let data: Awaited<ReturnType<typeof listQueryLogs>> | null = null;
  try {
    data = await listQueryLogs({ page: pageParam, search: q });
  } catch (err) {
    console.error("[logs] failed to load:", (err as Error).message);
  }

  const pageHref = (page: number) => {
    const sp = new URLSearchParams();
    if (data?.search) sp.set("q", data.search);
    sp.set("page", String(page));
    return `/logs?${sp}`;
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader user={session.user} active="logs" />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Query logs</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Every question asked, newest first{data ? ` - ${data.total} total` : ""}.
            </p>
          </div>
          <form method="get" className="flex gap-2">
            <input
              name="q"
              defaultValue={q}
              placeholder="Search question or email..."
              className="w-64 max-w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900"
            />
            <button className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">Search</button>
            {q && (
              <Link href="/logs" className="rounded-md px-2 py-1.5 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
                Clear
              </Link>
            )}
          </form>
        </div>

        {data ? (
          <>
            <QueryLogsTable logs={data.logs} />
            {data.totalPages > 1 && (
              <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
                {data.page > 1 ? (
                  <Link href={pageHref(data.page - 1)} className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
                    &larr; Previous
                  </Link>
                ) : <span />}
                <span className="text-slate-500">Page {data.page} of {data.totalPages}</span>
                {data.page < data.totalPages ? (
                  <Link href={pageHref(data.page + 1)} className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
                    Next &rarr;
                  </Link>
                ) : <span />}
              </nav>
            )}
          </>
        ) : (
          <p className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            Could not load logs. Please try again later.
          </p>
        )}
      </main>
    </div>
  );
}
