/**
 * MCP server exposing read-only database tools and read-only code tools
 * (for reading and investigating the repository set by CODE_REPOSITORY; any branch, tag or commit).
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
import {
  MAX_READ_LINES,
  findReferences,
  getBranch,
  getCommit,
  getFile,
  getRecentCommits,
  listBranches,
  listRepositoryFiles,
  parseIncidentText,
  readFileRange,
  searchCode,
} from "./tools/code";
import { CodeToolError, configuredRepo } from "./tools/github";

const tableNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Table name may only contain letters, digits and underscores")
  .describe(`Table name. One of: ${EXPOSED_TABLES.join(", ")}`);

const repoPathSchema = z.string().trim().min(1).max(500);
const refSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .describe("Branch, tag or commit SHA of the same repository (default: the investigated branch)");

/** Wrap a tool implementation so results/errors are always well-formed MCP responses. Strings are returned as-is. */
async function run(fn: () => unknown): Promise<CallToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }] };
  } catch (err) {
    const known = err instanceof DatabaseToolError || err instanceof CodeToolError;
    const message = known ? err.message : `Unexpected error: ${sanitizeError(err)}`;
    if (!known) console.error("[mcp] tool error:", sanitizeError(err));
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

function repoLabel(): string {
  try {
    const { repo, ref } = configuredRepo();
    return `${repo.owner}/${repo.name}@${ref}`;
  } catch {
    return "the configured repository";
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
        `Run a single read-only PostgreSQL SELECT (or WITH ... SELECT) query against the ${EXPOSED_TABLES.join(", ")} tables. ` +
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

  // --- Read-only code tools (incident investigation) ---------------------------
  const repo = repoLabel();

  server.registerTool(
    "parse_stack_trace",
    {
      title: "Parse stack trace / logs",
      description:
        "Parse a pasted stack trace and/or log lines (Python, Node, Java/Kotlin, Go, Ruby, .NET). Returns the runtime, error type/message, " +
        "application frames (innermost first, file:line) and error/warn log lines. Use it first when the user pastes an incident.",
      inputSchema: { text: z.string().min(1).max(20_000).describe("The stack trace and/or logs, verbatim") },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => run(() => parseIncidentText({ text })),
  );

  server.registerTool(
    "list_repository_files",
    {
      title: "List repository files",
      description: `List file paths in ${repo} (dependency, build, binary and secret files are excluded). Narrow with path_prefix and/or a glob like '**/*order*'.`,
      inputSchema: {
        path_prefix: repoPathSchema.optional().describe("Directory to list, e.g. 'src/services'"),
        glob: z.string().max(200).optional().describe("Glob filter, e.g. '**/*.py' or 'routes/*'"),
        limit: z.number().int().min(1).max(300).optional().describe("Max paths (default 200)"),
        ref: refSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => run(() => listRepositoryFiles(input)),
  );

  server.registerTool(
    "search_code",
    {
      title: "Search code",
      description: `Search file contents in ${repo} (like grep). Returns path:line matches. Literal by default; set regex=true for a regular expression.`,
      inputSchema: {
        query: z.string().min(1).max(300),
        regex: z.boolean().optional(),
        case_sensitive: z.boolean().optional(),
        path_prefix: repoPathSchema.optional().describe("Only search under this directory"),
        file_glob: z.string().max(200).optional().describe("e.g. '**/*.ts'"),
        max_results: z.number().int().min(1).max(50).optional().describe("Default 30"),
        ref: refSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => run(() => searchCode(input)),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file lines",
      description: `Read a range of lines (max ${MAX_READ_LINES} per call) from a file in ${repo}, with line numbers. Read around the lines you need, not whole large files.`,
      inputSchema: {
        path: repoPathSchema.describe("Repository-relative path"),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
        ref: refSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => run(() => readFileRange(input)),
  );

  server.registerTool(
    "get_file",
    {
      title: "Get file",
      description: `Get a file's language, line count and first 150 lines from ${repo}. Use read_file for other ranges.`,
      inputSchema: { path: repoPathSchema.describe("Repository-relative path"), ref: refSchema },
      annotations: { readOnlyHint: true },
    },
    async (input) => run(() => getFile(input)),
  );

  server.registerTool(
    "find_references",
    {
      title: "Find references",
      description: `Find where a symbol (function, class, variable) is defined and used in ${repo}. Use it to follow call chains, e.g. route -> service -> failing function.`,
      inputSchema: {
        symbol: z.string().min(1).max(120).regex(/^[A-Za-z_$][\w$.]*$/, "must be an identifier"),
        path_prefix: repoPathSchema.optional(),
        max_results: z.number().int().min(1).max(50).optional().describe("Default 30"),
        ref: refSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => run(() => findReferences(input)),
  );

  server.registerTool(
    "get_recent_commits",
    {
      title: "Get recent commits",
      description: `List recent commits on ${repo}, optionally only those touching a path. Useful to check whether a recent change introduced the bug.`,
      inputSchema: {
        path: repoPathSchema.optional().describe("File or directory to filter by"),
        limit: z.number().int().min(1).max(20).optional().describe("Default 10"),
        ref: refSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => run(() => getRecentCommits(input)),
  );

  server.registerTool(
    "get_commit",
    {
      title: "Get commit",
      description: `Show a commit of ${repo}: message, changed files and patches (truncated). Optionally filter to one path.`,
      inputSchema: {
        sha: z.string().min(4).max(40).regex(/^[0-9a-f]+$/i, "must be a commit SHA"),
        path: repoPathSchema.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => run(() => getCommit(input)),
  );

  server.registerTool(
    "list_branches",
    {
      title: "List branches",
      description: `List the branches of ${repo} with their head commits. Pass a branch as \`ref\` to the other code tools to read it.`,
      inputSchema: { limit: z.number().int().min(1).max(200).optional().describe("Max branches (default 100)") },
      annotations: { readOnlyHint: true },
    },
    async (input) => run(() => listBranches(input)),
  );

  server.registerTool(
    "get_branch",
    {
      title: "Get branch",
      description: `Get a branch's head commit in ${repo}. Defaults to the investigated branch.`,
      inputSchema: { name: z.string().min(1).max(200).regex(/^[\w./-]+$/, "invalid branch name").optional() },
      annotations: { readOnlyHint: true },
    },
    async (input) => run(() => getBranch(input)),
  );

  return server;
}
