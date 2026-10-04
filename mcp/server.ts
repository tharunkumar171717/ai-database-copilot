/**
 * MCP server exposing read-only database tools.
 *
 * Built with the official TypeScript MCP SDK. The same server definition is used:
 *   - in-process by the Next.js app (lib/mcp-client.ts, via InMemoryTransport)
 *   - standalone over stdio (mcp/stdio.ts) for MCP Inspector / Claude Desktop etc.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  EXPOSED_TABLES,
  MAX_QUERY_ROWS,
  DatabaseToolError,
  databaseSummary,
  describeTable,
  getTableRelationships,
  getTableSample,
  listTables,
  queryDatabase,
  sanitizeError,
} from "./tools/database";

const tableNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Table name may only contain letters, digits and underscores")
  .describe(`Table name. One of: ${EXPOSED_TABLES.join(", ")}`);

/** Wrap a tool implementation so results/errors are always well-formed MCP responses. */
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  } catch (err) {
    const message =
      err instanceof DatabaseToolError ? err.message : `Unexpected error: ${sanitizeError(err)}`;
    if (!(err instanceof DatabaseToolError)) console.error("[mcp] tool error:", sanitizeError(err));
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

export function createDatabaseMcpServer(): McpServer {
  const server = new McpServer({ name: "ai-database-copilot", version: "1.0.0" });

  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description: "Return all database tables that can be queried.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(() => listTables()),
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe table",
      description: "Return the columns, data types, primary key and foreign keys of a table.",
      inputSchema: { table_name: tableNameSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ table_name }) => run(() => describeTable(table_name)),
  );

  server.registerTool(
    "get_table_relationships",
    {
      title: "Get table relationships",
      description: "Return the foreign-key relationships between all tables.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(() => getTableRelationships()),
  );

  server.registerTool(
    "get_table_sample",
    {
      title: "Get table sample",
      description: "Return a small sample of rows (default 5, max 20) from a table.",
      inputSchema: {
        table_name: tableNameSchema,
        limit: z.number().int().min(1).max(20).optional().describe("Number of rows (1-20), default 5"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ table_name, limit }) => run(() => getTableSample(table_name, limit)),
  );

  server.registerTool(
    "query_database",
    {
      title: "Query database (read-only)",
      description:
        `Run a single read-only PostgreSQL SELECT (or WITH ... SELECT) query against the users, products and orders tables. ` +
        `INSERT/UPDATE/DELETE/DDL and multiple statements are rejected. At most ${MAX_QUERY_ROWS} rows are returned.`,
      inputSchema: {
        sql: z.string().trim().min(1).max(4000).describe("A single PostgreSQL SELECT statement"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sql }) => run(() => queryDatabase(sql)),
  );

  server.registerTool(
    "database_summary",
    {
      title: "Database summary",
      description: "Return all tables with their columns and row counts, plus table relationships.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(() => databaseSummary()),
  );

  return server;
}
