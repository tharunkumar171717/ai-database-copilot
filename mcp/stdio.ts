/**
 * Standalone entry point: run the database MCP server over stdio.
 *
 *   npm run mcp:stdio
 *   npx @modelcontextprotocol/inspector npx tsx mcp/stdio.ts
 *
 * Only MCP_DATABASE_URL (the read-only connection) is needed.
 */
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDatabaseMcpServer } from "./server";

async function main() {
  const server = createDatabaseMcpServer();
  await server.connect(new StdioServerTransport());
  // stdout is reserved for the MCP protocol - log to stderr.
  console.error("AI Database Copilot MCP server running on stdio");
}

main().catch((err) => {
  console.error("Failed to start MCP server:", err instanceof Error ? err.message : err);
  process.exit(1);
});
