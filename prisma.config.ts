import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Migrations need the owner connection. On Supabase, set DIRECT_URL to the
    // non-pooled (port 5432) connection string; otherwise DATABASE_URL is used.
    url: process.env["DIRECT_URL"] || process.env["DATABASE_URL"],
  },
});
