import "server-only";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { createDatabaseMcpServer } from "@/mcp/server";

/**
 * MCP client used by the chat API.
 *
 * The client and server speak the real MCP protocol (JSON-RPC: initialize,
 * tools/list, tools/call) over a linked in-memory transport pair. This keeps the
 * MCP server inside the same serverless function on Vercel (no extra process or
 * public endpoint to secure) while still going through the MCP boundary.
 */
export type McpSession = {
  listTools: () => Promise<Tool[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
  close: () => Promise<void>;
};

export async function connectMcp(): Promise<McpSession> {
  const server = createDatabaseMcpServer();
  const client = new Client({ name: "ai-database-copilot-web", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    async listTools() {
      const { tools } = await client.listTools();
      return tools;
    },
    async callTool(name, args) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const text = result.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n")
        .trim();
      return { text, isError: Boolean(result.isError) };
    },
    async close() {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}
