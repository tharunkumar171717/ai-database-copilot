/**
 * Stack-trace and log parsing (Python, Node, Java/Kotlin, Go, Ruby, .NET), used by the
 * parse_stack_trace tool. Pure functions: no I/O.
 */
export interface StackFrame {
  file: string;
  line: number | null;
  column: number | null;
  func: string | null;
}

export interface ParsedStack {
  runtime: "python" | "node" | "java" | "go" | "ruby" | "dotnet" | "unknown";
  errorType: string | null;
  errorMessage: string | null;
  frames: StackFrame[];
}

const PATTERNS: Array<{ runtime: ParsedStack["runtime"]; re: RegExp; map: (m: RegExpMatchArray) => StackFrame }> = [
  // File "/app/services/order_service.py", line 142, in create_order
  { runtime: "python", re: /File "([^"]+)", line (\d+)(?:, in (\S+))?/, map: (m) => ({ file: m[1], line: +m[2], column: null, func: m[3] ?? null }) },
  // at createOrder (/app/src/orders.ts:42:13)   |   at /app/src/orders.ts:42:13
  { runtime: "node", re: /^\s*at (?:(?:async )?([^\s(]+) )?\(?((?:file:\/\/)?[^\s()]+?):(\d+):(\d+)\)?\s*$/, map: (m) => ({ file: m[2].replace(/^file:\/\//, ""), line: +m[3], column: +m[4], func: m[1] ?? null }) },
  // at com.shop.OrderService.create(OrderService.java:88)
  { runtime: "java", re: /^\s*at ([\w$.<>]+)\(([\w$.-]+\.(?:java|kt|scala)):(\d+)\)/, map: (m) => ({ file: m[2], line: +m[3], column: null, func: m[1] }) },
  // /app/orders/service.go:57 +0x1d
  { runtime: "go", re: /^\s*(\/?[\w./-]+\.go):(\d+)(?: \+0x[0-9a-f]+)?\s*$/, map: (m) => ({ file: m[1], line: +m[2], column: null, func: null }) },
  // app/models/order.rb:12:in `create'
  { runtime: "ruby", re: /^\s*([\w./-]+\.rb):(\d+):in [`'](.+)'/, map: (m) => ({ file: m[1], line: +m[2], column: null, func: m[3] }) },
  // at Shop.Orders.Create() in /src/Orders.cs:line 42
  { runtime: "dotnet", re: /^\s*at (.+?) in (.+\.cs):line (\d+)/, map: (m) => ({ file: m[2], line: +m[3], column: null, func: m[1] }) },
];

export function parseStackTrace(text: string | null | undefined): ParsedStack | null {
  if (!text?.trim()) return null;
  const lines = text.split(/\r?\n/);
  const frames: StackFrame[] = [];
  const counts = new Map<ParsedStack["runtime"], number>();
  for (const line of lines) {
    for (const p of PATTERNS) {
      const m = line.match(p.re);
      if (m) {
        const f = p.map(m);
        if (!/node:internal|<anonymous>|site-packages|node_modules/.test(f.file)) frames.push(f);
        counts.set(p.runtime, (counts.get(p.runtime) ?? 0) + 1);
        break;
      }
    }
  }
  const runtime = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";

  let errorType: string | null = null;
  let errorMessage: string | null = null;
  const errLine =
    (runtime === "python" ? [...lines].reverse() : lines).find((l) => /^\s*([\w.$]+(Error|Exception|Panic|Fault))\b[:(]?/.test(l) || /^panic:/.test(l)) ?? null;
  if (errLine) {
    const m = errLine.trim().match(/^([\w.$]+)(?::\s*(.*))?$/) ?? errLine.trim().match(/^([\w.$]+)[:(]\s*(.*)$/);
    errorType = m?.[1] ?? null;
    errorMessage = m?.[2] ?? errLine.trim();
  }
  if (!frames.length && !errorType) return { runtime: "unknown", errorType: null, errorMessage: null, frames: [] };
  // Python prints the innermost frame last; normalise to innermost-first.
  if (runtime === "python") frames.reverse();
  return { runtime, errorType, errorMessage, frames: frames.slice(0, 40) };
}

const LEVEL_RE = /\b(FATAL|CRITICAL|ERROR|ERR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i;
const TS_RE = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;

export interface ParsedLogLine {
  line_no: number;
  level: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | null;
  message: string;
  logged_at: string | null;
  source: string | null;
}

export function parseLogs(text: string | null | undefined, maxLines = 2000): ParsedLogLine[] {
  if (!text?.trim()) return [];
  const out: ParsedLogLine[] = [];
  text.split(/\r?\n/).slice(0, maxLines).forEach((raw, i) => {
    const line = raw.trimEnd();
    if (!line.trim()) return;
    let level: ParsedLogLine["level"] = null;
    let loggedAt: string | null = null;
    let source: string | null = null;
    let message = line;
    // JSON logs: {"level":"error","msg":"...","time":"..."}
    if (line.trimStart().startsWith("{")) {
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        level = normLevel(String(j.level ?? j.severity ?? j.lvl ?? ""));
        loggedAt = toIso(String(j.time ?? j.timestamp ?? j.ts ?? ""));
        source = (j.service ?? j.logger ?? j.source ?? null) as string | null;
        message = String(j.msg ?? j.message ?? line);
        if (j.error || j.err) message += ` | ${typeof j.error === "string" ? j.error : JSON.stringify(j.error ?? j.err)}`;
      } catch {
        // not JSON
      }
    }
    if (!level) level = normLevel(line.match(LEVEL_RE)?.[1] ?? "");
    if (!loggedAt) loggedAt = toIso(line.match(TS_RE)?.[1] ?? "");
    out.push({ line_no: i + 1, level, message: message.slice(0, 4000), logged_at: loggedAt, source });
  });
  return out;
}

function normLevel(s: string): ParsedLogLine["level"] {
  const v = s.toLowerCase();
  if (!v) return null;
  if (v.startsWith("fatal") || v.startsWith("crit")) return "fatal";
  if (v.startsWith("err")) return "error";
  if (v.startsWith("warn")) return "warn";
  if (v.startsWith("info")) return "info";
  if (v.startsWith("debug")) return "debug";
  if (v.startsWith("trace")) return "trace";
  return null;
}

function toIso(s: string): string | null {
  if (!s) return null;
  // Timestamps without an offset are treated as UTC, the usual server-log convention.
  let v = s.replace(",", ".");
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(v)) v = `${v.replace(" ", "T")}Z`;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
