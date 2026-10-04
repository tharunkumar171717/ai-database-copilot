import type { QueryLogRow } from "@/lib/query-logs";

const dateFormat = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});

export default function QueryLogsTable({ logs }: { logs: QueryLogRow[] }) {
  if (logs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        No logs found.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <table className="min-w-full divide-y divide-slate-200 text-left text-sm dark:divide-slate-800">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
          <tr>
            {["User", "Question", "SQL", "Tool", "Response", "Time"].map((h) => (
              <th key={h} scope="col" className="px-3 py-2.5 font-semibold">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 align-top dark:divide-slate-800">
          {logs.map((log) => (
            <tr key={log.id} className="text-slate-700 dark:text-slate-300">
              <td className="whitespace-nowrap px-3 py-2.5 text-xs">{log.userEmail}</td>
              <td className="min-w-48 px-3 py-2.5">{log.question}</td>
              <td className="px-3 py-2.5">
                {log.generatedSql ? (
                  <code className="block max-w-xs whitespace-pre-wrap break-words font-mono text-[11px] text-slate-600 dark:text-slate-400">
                    {log.generatedSql}
                  </code>
                ) : (
                  <span className="text-slate-400">-</span>
                )}
              </td>
              <td className="px-3 py-2.5 text-xs">{log.toolUsed ?? <span className="text-slate-400">-</span>}</td>
              <td className="min-w-64 px-3 py-2.5">
                <div className={`line-clamp-4 whitespace-pre-wrap text-xs ${log.response.startsWith("ERROR:") ? "text-red-600 dark:text-red-400" : ""}`} title={log.response}>
                  {log.response}
                </div>
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-xs text-slate-500">{dateFormat.format(new Date(log.createdAt))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
