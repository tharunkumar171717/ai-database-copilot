/**
 * Creates (or updates) the read-only PostgreSQL role used by the MCP server.
 *
 * Reads the role name + password from MCP_DATABASE_URL and connects with the
 * owner connection (DIRECT_URL or DATABASE_URL) to create it. The role:
 *   - can only SELECT from users, products, orders
 *   - has NO access to query_logs or any other table
 *   - runs every transaction as READ ONLY with a statement timeout
 *
 * Usage: npm run db:readonly
 */
import "dotenv/config";
import { Client } from "pg";

const EXPOSED_TABLES = ["users", "products", "orders"];

async function main() {
  const ownerUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
  const mcpUrl = process.env.MCP_DATABASE_URL;
  if (!ownerUrl || !mcpUrl) throw new Error("DATABASE_URL and MCP_DATABASE_URL must be set");

  const parsed = new URL(mcpUrl);
  // Supabase pooler usernames look like "mcp_readonly.<project-ref>"; the role is the part before the dot.
  const role = decodeURIComponent(parsed.username).split(".")[0];
  const password = decodeURIComponent(parsed.password);
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error("Invalid role name in MCP_DATABASE_URL");
  if (!password) throw new Error("MCP_DATABASE_URL must include a password");

  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
    const pw = await client.query("SELECT quote_literal($1) AS lit", [password]);
    const passwordLiteral: string = pw.rows[0].lit;

    if (rows.length === 0) {
      await client.query(`CREATE ROLE ${role} WITH LOGIN PASSWORD ${passwordLiteral} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 10`);
      console.log(`Created role ${role}`);
    } else {
      await client.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${passwordLiteral} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
      console.log(`Updated role ${role}`);
    }

    await client.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
    await client.query(`ALTER ROLE ${role} SET statement_timeout = '5s'`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role}`);
    await client.query(`REVOKE CREATE ON SCHEMA public FROM ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    for (const table of EXPOSED_TABLES) {
      await client.query(`GRANT SELECT ON public.${table} TO ${role}`);
    }
    console.log(`Granted SELECT on ${EXPOSED_TABLES.join(", ")} to ${role} (read-only).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Failed to set up read-only user:", err.message);
  process.exit(1);
});
