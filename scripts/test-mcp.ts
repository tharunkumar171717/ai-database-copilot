/**
 * End-to-end test of the MCP server over stdio (spawns mcp/stdio.ts).
 * Verifies every tool works, that destructive / unsafe SQL is rejected, and that the
 * read-only code tools work against the default repository (CODE_REPOSITORY is not
 * passed through, so tharunkumar171717/incident-investigator@main is used) and
 * reject path traversal. Needs network access to GitHub; GITHUB_TOKEN is optional.
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
    env: {
      PATH: process.env.PATH ?? "",
      MCP_DATABASE_URL: process.env.MCP_DATABASE_URL ?? "",
      ...(process.env.GITHUB_TOKEN ? { GITHUB_TOKEN: process.env.GITHUB_TOKEN } : {}),
    },
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
  check("tools/list exposes 16 tools (6 database + 10 code)", names.length === 16, names.join(", "));
  check(
    "no write tools are exposed",
    !names.some((n) => /create|update|delete|write|commit_|pull_request|run_tests/.test(n)),
    names.join(", "),
  );
  check("all tools are annotated read-only", tools.every((t) => t.annotations?.readOnlyHint === true));

  let r = await call("list_tables");
  check("list_tables", !r.isError && r.text.includes("copilot_orders"), r.text);

  r = await call("describe_table", { table_name: "copilot_orders" });
  check("describe_table(orders) has FK", !r.isError && r.text.includes("copilot_users.id"), r.text.slice(0, 120));

  r = await call("describe_table", { table_name: "copilot_query_logs" });
  check("describe_table(query_logs) is hidden", r.isError, r.text);

  r = await call("describe_table", { table_name: "copilot_users; DROP TABLE copilot_users" });
  check("describe_table rejects injection in table name", r.isError, r.text.slice(0, 100));

  r = await call("get_table_relationships");
  check("get_table_relationships", !r.isError && r.text.includes("copilot_orders.user_id"), r.text.slice(0, 120));

  r = await call("get_table_sample", { table_name: "copilot_products", limit: 3 });
  check("get_table_sample(products, 3)", !r.isError && JSON.parse(r.text).rows.length === 3);

  r = await call("database_summary");
  check("database_summary", !r.isError && r.text.includes("row_count"), r.text.slice(0, 120));

  r = await call("query_database", { sql: "SELECT COUNT(*) AS pending FROM copilot_orders WHERE status = 'pending';" });
  check("query_database pending count", !r.isError, r.text);

  r = await call("query_database", { sql: "SELECT * FROM copilot_orders CROSS JOIN copilot_products CROSS JOIN copilot_users" });
  check("query_database caps rows at 100", !r.isError && JSON.parse(r.text).row_count === 100 && JSON.parse(r.text).truncated);

  r = await call("query_database", { sql: "SELECT * FROM copilot_users WHERE name = 'Delete Update'" });
  check("keywords inside string literals are allowed", !r.isError, r.text.slice(0, 100));

  const attacks = [
    "DELETE FROM copilot_orders",
    "UPDATE copilot_products SET stock = 0",
    "INSERT INTO copilot_users (name, email) VALUES ('x', 'y')",
    "DROP TABLE copilot_users",
    "ALTER TABLE copilot_users ADD COLUMN x int",
    "TRUNCATE orders",
    "SELECT 1; DROP TABLE copilot_users",
    "SELECT * INTO hacked FROM copilot_users",
    "WITH d AS (DELETE FROM copilot_orders RETURNING *) SELECT * FROM d",
    "SELECT * FROM copilot_query_logs",
    "SELECT current_setting('data_directory')",
    "SELECT pg_sleep(10)",
    "SELECT * FROM pg_shadow",
    "SELECT * FROM copilot_users -- comment",
    "SELECT $$x$$",
    "SELECT * FROM copilot_users FOR UPDATE",
    "COPY copilot_users TO '/tmp/x'",
    "GRANT ALL ON copilot_users TO public",
    "SELECT * FROM information_schema.tables",
  ];
  for (const sql of attacks) {
    r = await call("query_database", { sql });
    check(`rejects: ${sql}`, r.isError, r.text.slice(0, 90));
  }

  r = await call("query_database", { sql: "SELECT nonexistent FROM copilot_users" });
  check("invalid SQL returns friendly error", r.isError && r.text.startsWith("Database error"), r.text.slice(0, 100));

  r = await call("query_database", { sql: "SELECT * FROM copilot_orders WHERE total_amount > 99999999" });
  check("empty result is handled", !r.isError && JSON.parse(r.text).row_count === 0, r.text.slice(0, 120));

  const all = JSON.stringify(await call("database_summary"));
  const pw = process.env.MCP_DATABASE_URL ? new URL(process.env.MCP_DATABASE_URL).password : "";
  check("no credentials in tool output", !!pw && !all.includes(pw) && !all.includes("postgresql://"));

  // --- Code tools -------------------------------------------------------------
  const svc = "examples/orders-service";

  r = await call("search_code", { query: "createOrder", path_prefix: svc });
  check(
    "search_code finds createOrder in examples/orders-service",
    !r.isError && /examples\/orders-service\/src\/services\/order_service\.js:\d+:.*createOrder/.test(r.text),
    r.text.slice(0, 160),
  );

  r = await call("find_references", { symbol: "getUser", path_prefix: svc });
  check(
    "find_references finds getUser definition and caller",
    !r.isError &&
      /Definitions of getUser \(1\):\nexamples\/orders-service\/src\/repositories\/user_repository\.js:\d+: function getUser/.test(r.text) &&
      /order_service\.js:\d+: .*getUser\(userId\)/.test(r.text),
    r.text.slice(0, 200),
  );

  r = await call("read_file", { path: `${svc}/src/services/order_service.js`, start_line: 19, end_line: 21 });
  check("read_file returns numbered lines", !r.isError && /\n20 \|\s+ownerId: user\.id,/.test(r.text), r.text.slice(0, 160));

  r = await call("read_file", { path: `${svc}/src/services/order_service.js`, start_line: 1, end_line: 5000 });
  check("read_file caps the range", !r.isError && !r.text.includes(" 301 | "), r.text.split("\n")[0]);

  for (const path of ["../.env", "/etc/passwd", `${svc}/../../../.env`, "~/.ssh/id_rsa"]) {
    r = await call("read_file", { path });
    check(`read_file rejects ${path}`, r.isError && /outside the repository/.test(r.text), r.text.slice(0, 100));
  }

  r = await call("list_repository_files", { path_prefix: svc });
  check("list_repository_files", !r.isError && r.text.includes(`${svc}/src/server.js`), r.text.split("\n")[0]);

  r = await call("list_repository_files", { path_prefix: "../" });
  check("list_repository_files rejects traversal", r.isError, r.text.slice(0, 100));

  r = await call("get_file", { path: `${svc}/src/routes/orders.js` });
  check("get_file", !r.isError && r.text.includes("language: javascript"), r.text.slice(0, 120));

  r = await call("get_branch", {});
  check("get_branch (default ref)", !r.isError && /^branch main\nhead [0-9a-f]{40}/.test(r.text), r.text.slice(0, 100));

  r = await call("list_branches", {});
  check("list_branches includes main", !r.isError && /\nmain [0-9a-f]{7} \(investigated\)/.test(r.text), r.text.slice(0, 160));

  r = await call("read_file", { path: `${svc}/src/services/order_service.js`, start_line: 20, end_line: 20, ref: "main" });
  check("read_file with an explicit ref", !r.isError && /@main [0-9a-f]{7}\] .*\n20 \|/.test(r.text), r.text.slice(0, 120));

  for (const ref of ["../main", "main..evil", "-x", "https://github.com/someone/else"]) {
    r = await call("search_code", { query: "x", ref });
    check(`rejects ref ${ref}`, r.isError && /Invalid ref/.test(r.text), r.text.slice(0, 100));
  }

  r = await call("read_file", { path: "README.md", ref: "branch-that-does-not-exist" });
  check("unknown ref is a friendly error", r.isError && /was not found in/.test(r.text), r.text.slice(0, 100));

  r = await call("get_recent_commits", { limit: 3 });
  check("get_recent_commits", !r.isError && /\n[0-9a-f]{7} \d{4}-\d{2}-\d{2} /.test(r.text), r.text.slice(0, 160));

  const sampleIncident = [
    "POST /api/orders is returning 500 errors.",
    "",
    "Error: TypeError: Cannot read properties of null (reading 'id')",
    "",
    "Stack trace:",
    "TypeError: Cannot read properties of null (reading 'id')",
    "    at Object.createOrder (/srv/orders-service/src/services/order_service.js:20:18)",
    "    at handleCreateOrder (/srv/orders-service/src/routes/orders.js:7:30)",
    "    at Server.<anonymous> (/srv/orders-service/src/server.js:23:22)",
    "",
    "Logs:",
    "2026-10-06T14:05:10Z INFO POST /api/orders 201 4ms",
    "2026-10-06T14:05:12Z ERROR POST /api/orders 500 TypeError: Cannot read properties of null (reading 'id') user=u_300",
    "2026-10-06T14:05:15Z ERROR POST /api/orders 500 TypeError: Cannot read properties of null (reading 'id') user=u_999",
  ].join("\n");
  r = await call("parse_stack_trace", { text: sampleIncident });
  const parsed = r.isError ? null : JSON.parse(r.text);
  check(
    "parse_stack_trace parses the sample incident",
    parsed?.runtime === "node" &&
      parsed.error_type === "TypeError" &&
      parsed.frames.length === 3 &&
      parsed.frames[0].file === "/srv/orders-service/src/services/order_service.js" &&
      parsed.frames[0].line === 20 &&
      parsed.frames[0].func === "Object.createOrder" &&
      parsed.frames[1].func === "handleCreateOrder" &&
      parsed.logs.by_level.error >= 2 &&
      parsed.logs.errors.some((l: { message: string }) => l.message.includes("user=u_999")),
    r.text.slice(0, 200),
  );

  await client.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll MCP checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
