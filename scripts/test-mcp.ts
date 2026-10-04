/**
 * End-to-end test of the MCP server over stdio (spawns mcp/stdio.ts).
 * Verifies every tool works and that destructive / unsafe SQL is rejected.
 *
 *   npm run test:mcp
 */
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
}

async function main() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "mcp/stdio.ts"],
    env: { PATH: process.env.PATH ?? "", MCP_DATABASE_URL: process.env.MCP_DATABASE_URL ?? "" },
    stderr: "ignore",
  });
  const client = new Client({ name: "mcp-test", version: "1.0.0" });
  await client.connect(transport);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    return { text, isError: Boolean(r.isError) };
  };

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check("tools/list exposes 6 tools", names.length === 6, names.join(", "));

  let r = await call("list_tables");
  check("list_tables", !r.isError && r.text.includes("orders"), r.text);

  r = await call("describe_table", { table_name: "orders" });
  check("describe_table(orders) has FK", !r.isError && r.text.includes("users.id"), r.text.slice(0, 120));

  r = await call("describe_table", { table_name: "query_logs" });
  check("describe_table(query_logs) is hidden", r.isError, r.text);

  r = await call("describe_table", { table_name: "users; DROP TABLE users" });
  check("describe_table rejects injection in table name", r.isError, r.text.slice(0, 100));

  r = await call("get_table_relationships");
  check("get_table_relationships", !r.isError && r.text.includes("orders.user_id"), r.text.slice(0, 120));

  r = await call("get_table_sample", { table_name: "products", limit: 3 });
  check("get_table_sample(products, 3)", !r.isError && JSON.parse(r.text).rows.length === 3);

  r = await call("database_summary");
  check("database_summary", !r.isError && r.text.includes("row_count"), r.text.slice(0, 120));

  r = await call("query_database", { sql: "SELECT COUNT(*) AS pending FROM orders WHERE status = 'pending';" });
  check("query_database pending count", !r.isError, r.text);

  r = await call("query_database", { sql: "SELECT * FROM orders CROSS JOIN products CROSS JOIN users" });
  check("query_database caps rows at 100", !r.isError && JSON.parse(r.text).row_count === 100 && JSON.parse(r.text).truncated);

  r = await call("query_database", { sql: "SELECT * FROM users WHERE name = 'Delete Update'" });
  check("keywords inside string literals are allowed", !r.isError, r.text.slice(0, 100));

  const attacks = [
    "DELETE FROM orders",
    "UPDATE products SET stock = 0",
    "INSERT INTO users (name, email) VALUES ('x', 'y')",
    "DROP TABLE users",
    "ALTER TABLE users ADD COLUMN x int",
    "TRUNCATE orders",
    "SELECT 1; DROP TABLE users",
    "SELECT * INTO hacked FROM users",
    "WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d",
    "SELECT * FROM query_logs",
    "SELECT current_setting('data_directory')",
    "SELECT pg_sleep(10)",
    "SELECT * FROM pg_shadow",
    "SELECT * FROM users -- comment",
    "SELECT $$x$$",
    "SELECT * FROM users FOR UPDATE",
    "COPY users TO '/tmp/x'",
    "GRANT ALL ON users TO public",
    "SELECT * FROM information_schema.tables",
  ];
  for (const sql of attacks) {
    r = await call("query_database", { sql });
    check(`rejects: ${sql}`, r.isError, r.text.slice(0, 90));
  }

  r = await call("query_database", { sql: "SELECT nonexistent FROM users" });
  check("invalid SQL returns friendly error", r.isError && r.text.startsWith("Database error"), r.text.slice(0, 100));

  r = await call("query_database", { sql: "SELECT * FROM orders WHERE total_amount > 99999999" });
  check("empty result is handled", !r.isError && JSON.parse(r.text).row_count === 0, r.text.slice(0, 120));

  const all = JSON.stringify(await call("database_summary"));
  const pw = process.env.MCP_DATABASE_URL ? new URL(process.env.MCP_DATABASE_URL).password : "";
  check("no credentials in tool output", !!pw && !all.includes(pw) && !all.includes("postgresql://"));

  await client.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll MCP checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
