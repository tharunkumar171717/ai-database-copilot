import type { PoolConfig } from "pg";

/**
 * Build a node-postgres config from a connection URL.
 *
 * Local connections use no TLS. Remote hosts (Supabase, Neon...) use TLS.
 * `sslmode` is stripped from the URL because node-postgres lets URL params
 * override the `ssl` object, and treats sslmode=require as full certificate
 * verification, which fails against Supabase's pooler certificate chain.
 */
export function pgConfig(connectionString: string): PoolConfig {
  const url = new URL(connectionString);
  url.searchParams.delete("sslmode");
  url.searchParams.delete("pgbouncer");
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  return {
    connectionString: url.toString(),
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  };
}
