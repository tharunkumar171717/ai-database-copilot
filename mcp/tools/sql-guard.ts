/**
 * SQL guard for the query_database MCP tool.
 *
 * Defence in depth - this is the FIRST layer. Even if something slipped past
 * these checks, the query still runs:
 *   1. as the `mcp_readonly` Postgres role (SELECT-only grants on 3 tables),
 *   2. inside a `BEGIN READ ONLY` transaction that is always rolled back,
 *   3. with a statement timeout and a hard row limit.
 */

export const MAX_SQL_LENGTH = 4000;

const FORBIDDEN_KEYWORDS = [
  "insert", "update", "delete", "drop", "alter", "truncate", "create", "grant",
  "revoke", "copy", "merge", "call", "do", "execute", "exec", "prepare",
  "deallocate", "vacuum", "analyze", "cluster", "reindex", "lock", "set", "reset",
  "comment", "refresh", "listen", "notify", "unlisten", "discard", "checkpoint",
  "into", "begin", "commit", "rollback", "savepoint", "transaction", "import",
  "declare",
];

/** Functions / schemas that could leak server details or touch the filesystem. */
const FORBIDDEN_PATTERNS: [RegExp, string][] = [
  [/\bpg_[a-z_]*/i, "PostgreSQL system catalogs/functions (pg_*) are not allowed"],
  [/\binformation_schema\b/i, "information_schema is not allowed in queries; use the describe_table tool"],
  [/\bcurrent_setting\b|\bset_config\b/i, "Reading or changing server settings is not allowed"],
  [/\binet_(server|client)_(addr|port)\b/i, "Server network details are not allowed"],
  [/\bdblink\w*|\blo_\w+/i, "External connections and large objects are not allowed"],
  [/query_logs|_prisma_migrations/i, "Only the copilot_users, copilot_products and copilot_orders tables can be queried"],
  [/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i, "Row locking clauses are not allowed"],
];

export type SqlCheck = { ok: true; sql: string } | { ok: false; reason: string };

/** Remove string literals and quoted identifiers so keyword checks don't false-positive on data. */
function stripLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

export function validateReadOnlySql(input: unknown): SqlCheck {
  if (typeof input !== "string") return { ok: false, reason: "SQL must be a string" };

  let sql = input.trim();
  if (!sql) return { ok: false, reason: "SQL query is empty" };
  if (sql.length > MAX_SQL_LENGTH) return { ok: false, reason: `SQL is too long (max ${MAX_SQL_LENGTH} characters)` };

  // Dollar-quoted strings can hide arbitrary text from our checks.
  if (/\$[a-z_0-9]*\$/i.test(sql)) return { ok: false, reason: "Dollar-quoted strings are not allowed" };
  if (/--|\/\*/.test(sql)) return { ok: false, reason: "SQL comments are not allowed" };

  // Allow a single trailing semicolon only - no statement stacking.
  sql = sql.replace(/;\s*$/, "");
  const bare = stripLiterals(sql);
  if (bare.includes(";")) return { ok: false, reason: "Only a single SQL statement is allowed" };
  if (/'(?:[^']|'')*$/.test(sql.replace(/'(?:[^']|'')*'/g, ""))) {
    return { ok: false, reason: "Unterminated string literal" };
  }

  const lowered = bare.toLowerCase();
  if (!/^(select|with)\b/.test(lowered)) {
    return { ok: false, reason: "Only read-only SELECT queries are allowed" };
  }

  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, "i").test(lowered)) {
      return { ok: false, reason: `Forbidden keyword "${keyword.toUpperCase()}" - only read-only SELECT queries are allowed` };
    }
  }
  for (const [pattern, reason] of FORBIDDEN_PATTERNS) {
    if (pattern.test(bare)) return { ok: false, reason };
  }

  return { ok: true, sql };
}
