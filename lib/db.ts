import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import { pgConfig } from "./pg-config";

/**
 * Application database client (owner connection, DATABASE_URL).
 * Used for writing copilot_query_logs and reading them on /logs.
 * The AI never touches this client - it only talks to the MCP server,
 * which uses its own read-only connection (see mcp/tools/database.ts).
 */
function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured");
  return new PrismaClient({ adapter: new PrismaPg({ ...pgConfig(connectionString), max: 3 }) });
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
