/**
 * Database access for the MCP server.
 *
 * Uses its own connection pool with MCP_DATABASE_URL - a read-only Postgres
 * role that can only SELECT from the exposed business tables. Credentials are
 * never included in any tool output.
 */
import { Pool, type PoolClient } from "pg";
import { pgConfig } from "../../lib/pg-config";
import { validateReadOnlySql } from "./sql-guard";

/** Tables the AI is allowed to see. Everything else (copilot_query_logs, other apps' tables, migrations...) is hidden. */
export const EXPOSED_TABLES = ["copilot_users", "copilot_products", "copilot_orders"] as const;
export type ExposedTable = (typeof EXPOSED_TABLES)[number];

export const MAX_QUERY_ROWS = 100;
export const SAMPLE_ROWS = 5;
const STATEMENT_TIMEOUT_MS = 5000;

export class DatabaseToolError extends Error {}

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.MCP_DATABASE_URL;
    if (!connectionString) throw new DatabaseToolError("The MCP database connection is not configured.");
    pool = new Pool({
      ...pgConfig(connectionString),
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
    });
    pool.on("error", (err) => console.error("[mcp] idle pg client error:", sanitizeError(err)));
  }
  return pool;
}

/** Strip anything that looks like a connection string / password from error text. */
export function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/postgres(ql)?:\/\/[^\s]+/gi, "[redacted-connection-string]")
    .replace(/password[^\s,]*/gi, "[redacted]")
    .slice(0, 500);
}

/** Run a callback inside a READ ONLY transaction that is always rolled back. */
async function withReadOnly<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient;
  try {
    client = await getPool().connect();
  } catch (err) {
    console.error("[mcp] connection failed:", sanitizeError(err));
    throw new DatabaseToolError("Could not connect to the database. Please try again later.");
  }
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    return await fn(client);
  } catch (err) {
    if (err instanceof DatabaseToolError) throw err;
    const pgErr = err as { code?: string };
    if (pgErr.code === "57014") throw new DatabaseToolError("The query took too long and was cancelled.");
    if (pgErr.code === "42501") throw new DatabaseToolError(`Permission denied: only ${EXPOSED_TABLES.join(", ")} can be read.`);
    if (pgErr.code === "25006") throw new DatabaseToolError("Write operations are not allowed (read-only).");
    throw new DatabaseToolError(`Database error: ${sanitizeError(err)}`);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

/** Convert pg values (Date, bigint strings, numeric strings) into JSON-friendly values. */
function normalizeRows(rows: Record<string, unknown>[]) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]),
    ),
  );
}

export function assertExposedTable(table: string): ExposedTable {
  const normalized = table.trim().toLowerCase();
  if (!(EXPOSED_TABLES as readonly string[]).includes(normalized)) {
    throw new DatabaseToolError(
      `Table "${table}" does not exist or is not accessible. Available tables: ${EXPOSED_TABLES.join(", ")}.`,
    );
  }
  return normalized as ExposedTable;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export async function listTables() {
  return withReadOnly(async (client) => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name = ANY($1)
       ORDER BY table_name`,
      [EXPOSED_TABLES],
    );
    return { tables: rows.map((r) => r.table_name) };
  });
}

async function getForeignKeys(client: PoolClient, tables: readonly string[]) {
  const { rows } = await client.query<{
    from_table: string; from_column: string; to_table: string; to_column: string; constraint_name: string;
  }>(
    // information_schema.constraint_column_usage only shows constraints on tables the
    // current role OWNS, so the read-only role must use pg_catalog instead.
    `SELECT src.relname AS from_table, src_col.attname AS from_column,
            dst.relname AS to_table, dst_col.attname AS to_column, con.conname AS constraint_name
     FROM pg_constraint con
     JOIN pg_class src ON src.oid = con.conrelid
     JOIN pg_class dst ON dst.oid = con.confrelid
     JOIN pg_namespace ns ON ns.oid = src.relnamespace
     JOIN pg_attribute src_col ON src_col.attrelid = con.conrelid AND src_col.attnum = con.conkey[1]
     JOIN pg_attribute dst_col ON dst_col.attrelid = con.confrelid AND dst_col.attnum = con.confkey[1]
     WHERE con.contype = 'f' AND ns.nspname = 'public' AND src.relname = ANY($1)
     ORDER BY src.relname, src_col.attname`,
    [tables],
  );
  return rows;
}

export async function describeTable(tableName: string) {
  const table = assertExposedTable(tableName);
  return withReadOnly(async (client) => {
    const columns = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table],
    );
    const pk = await client.query<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public' AND tc.table_name = $1`,
      [table],
    );
    const fks = await getForeignKeys(client, [table]);
    return {
      table,
      columns: columns.rows.map((c) => ({
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === "YES",
        default: c.column_default,
      })),
      primary_key: pk.rows.map((r) => r.column_name),
      foreign_keys: fks.map((f) => ({ column: f.from_column, references: `${f.to_table}.${f.to_column}` })),
    };
  });
}

export async function getTableRelationships() {
  return withReadOnly(async (client) => {
    const fks = await getForeignKeys(client, EXPOSED_TABLES);
    return {
      relationships: fks.map((f) => ({
        from: `${f.from_table}.${f.from_column}`,
        to: `${f.to_table}.${f.to_column}`,
        type: "many-to-one",
        description: `Each row in ${f.from_table} references one row in ${f.to_table} via ${f.from_column}; one ${f.to_table} row can have many ${f.from_table} rows.`,
      })),
    };
  });
}

export async function getTableSample(tableName: string, limit = SAMPLE_ROWS) {
  const table = assertExposedTable(tableName);
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 20);
  return withReadOnly(async (client) => {
    // Identifier comes from the EXPOSED_TABLES allow-list, so interpolation is safe.
    const { rows } = await client.query(`SELECT * FROM public.${table} ORDER BY id LIMIT $1`, [safeLimit]);
    return { table, rows: normalizeRows(rows) };
  });
}

export async function queryDatabase(sql: string) {
  const check = validateReadOnlySql(sql);
  if (!check.ok) throw new DatabaseToolError(`Query rejected: ${check.reason}`);
  return withReadOnly(async (client) => {
    // Wrap the user's query so a hard row cap applies no matter what it contains.
    const { rows, fields } = await client.query(
      `SELECT * FROM (${check.sql}) AS copilot_query LIMIT ${MAX_QUERY_ROWS + 1}`,
    );
    const truncated = rows.length > MAX_QUERY_ROWS;
    return {
      sql: check.sql,
      columns: fields.map((f) => f.name),
      row_count: Math.min(rows.length, MAX_QUERY_ROWS),
      truncated,
      rows: normalizeRows(rows.slice(0, MAX_QUERY_ROWS)),
      note: rows.length === 0 ? "The query returned no rows." : truncated ? `Only the first ${MAX_QUERY_ROWS} rows are shown.` : undefined,
    };
  });
}

export async function databaseSummary() {
  return withReadOnly(async (client) => {
    const tables = [];
    for (const table of EXPOSED_TABLES) {
      const { rows } = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM public.${table}`);
      const cols = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      );
      tables.push({ table, row_count: Number(rows[0].count), columns: cols.rows.map((c) => c.column_name) });
    }
    const fks = await getForeignKeys(client, EXPOSED_TABLES);
    return {
      tables,
      relationships: fks.map((f) => `${f.from_table}.${f.from_column} -> ${f.to_table}.${f.to_column}`),
    };
  });
}
