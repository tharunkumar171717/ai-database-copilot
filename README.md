# AI Database Copilot

Ask questions about a PostgreSQL database in plain English. **Gemini** understands the question, decides which **MCP tools** it needs, the MCP server runs safe **read-only** queries against **PostgreSQL**, and Gemini turns the result into an answer. Every question is recorded in a `query_logs` audit table.

Built with Next.js 16 (App Router), TypeScript, Tailwind CSS, Auth.js (Google OAuth), the Google Gen AI SDK, the official MCP TypeScript SDK, Prisma 7 and PostgreSQL.

---

## What is MCP?

The **Model Context Protocol (MCP)** is an open standard for connecting AI models to tools and data. An **MCP server** publishes a list of *tools* (name, description, JSON-schema input). An **MCP client** discovers those tools (`tools/list`) and invokes them (`tools/call`) over JSON-RPC. The model never touches the data source directly. It can only ask the client to call one of the published tools, and the server decides what each tool is allowed to do.

In this project, the MCP server is the **only** component that can read business data, and it does so through a read-only Postgres role.

## Architecture

```
Browser (React UI, /chat)
   │  POST /api/chat  { message, history }        ← session cookie (httpOnly)
   ▼
Next.js route handler (app/api/chat/route.ts)
   │  1. auth()  → reject if not signed in
   │  2. askDatabaseCopilot()  (lib/gemini.ts)
   ▼
Gemini API  ◄──── function declarations built from MCP tools/list
   │  "call query_database({sql: ...})"
   ▼
MCP client (lib/mcp-client.ts) ──JSON-RPC──► MCP server (mcp/server.ts)
                                                │  zod input validation
                                                │  SQL guard (mcp/tools/sql-guard.ts)
                                                ▼
                                   mcp/tools/database.ts  (pg Pool, MCP_DATABASE_URL)
                                                │  BEGIN READ ONLY; statement_timeout; LIMIT 100
                                                ▼
                                          PostgreSQL (role: mcp_readonly)
   ◄──────────── tool result (JSON) ────────────┘
Gemini → natural-language answer
   ▼
Route handler → writes query_logs (lib/query-logs.ts, Prisma, DATABASE_URL) → JSON to browser
```

```
app/
  page.tsx                     Landing / login ("Continue with Google")
  chat/page.tsx                Protected chat page
  logs/page.tsx                Protected query-log viewer (search + pagination)
  api/chat/route.ts            Chat endpoint (auth → Gemini+MCP → log)
  api/logs/route.ts            JSON logs endpoint (auth, ?page=&q=)
  api/auth/[...nextauth]/      Auth.js handlers
components/
  Chat.tsx  Message.tsx  LoginButton.tsx  LogoutButton.tsx  AppHeader.tsx  QueryLogsTable.tsx
lib/
  auth.ts  auth-actions.ts     Auth.js config + sign-in/out server actions
  gemini.ts                    Gemini ⇄ MCP tool-calling loop, system prompt, error mapping
  mcp-client.ts                MCP client (official SDK)
  db.ts                        Prisma client (app DB: query_logs)
  query-logs.ts                Create/list query logs
mcp/
  server.ts                    MCP server: registers the 6 tools
  stdio.ts                     Run the MCP server standalone over stdio
  tools/database.ts            Tool implementations (read-only pg pool)
  tools/sql-guard.ts           SELECT-only validator
prisma/
  schema.prisma  seed.ts  migrations/
scripts/
  setup-readonly-user.ts       Creates the mcp_readonly Postgres role
  test-mcp.ts                  MCP end-to-end + security tests
  test-copilot.ts              Asks the example questions through Gemini + MCP
```

### How Gemini interacts with MCP

`lib/gemini.ts`:

1. Connects an MCP client to the MCP server and calls **`tools/list`**.
2. Converts each MCP tool into a Gemini **function declaration**. The tool's JSON Schema is passed through as `parametersJsonSchema`.
3. Sends the question, recent chat history and a strict system prompt to Gemini. The prompt says: never invent data, inspect the schema when unsure, SELECT only, say when data is unavailable, and decline off-topic questions.
4. When Gemini returns `functionCalls`, each one is executed with MCP **`tools/call`**, and the result (or error) goes back to Gemini as a `functionResponse`.
5. Steps 3–4 repeat (max 8 rounds, 55 s overall deadline) until Gemini returns text.
6. It returns the answer, the tools used and the SQL generated.

The MCP client and server run inside the same Next.js server function and talk the real MCP protocol over the SDK's `InMemoryTransport`. This works on Vercel serverless (there's no child process to spawn and no extra public endpoint to secure). The same server can also run standalone over **stdio** (`npm run mcp:stdio`) for MCP Inspector or desktop MCP clients:

```bash
npx @modelcontextprotocol/inspector npx tsx mcp/stdio.ts
```

### MCP tools

| Tool | Input | Returns |
|---|---|---|
| `list_tables` | – | Queryable tables |
| `describe_table` | `table_name` | Columns, types, nullability, primary key, foreign keys |
| `get_table_relationships` | – | All foreign-key relationships |
| `get_table_sample` | `table_name`, `limit?` (1–20) | Sample rows |
| `query_database` | `sql` | Rows of a single read-only SELECT (max 100 rows) |
| `database_summary` | – | Tables, columns, row counts, relationships |

### How PostgreSQL is connected

There are two connections with different privileges:

| Env var | Role | Used by | Can do |
|---|---|---|---|
| `DATABASE_URL` | owner | Prisma (migrations, seed, `query_logs`) | Full access |
| `MCP_DATABASE_URL` | `mcp_readonly` | MCP server only | `SELECT` on `users`, `products`, `orders`, nothing else |

`npm run db:readonly` creates `mcp_readonly` with `default_transaction_read_only = on`, a 5 s `statement_timeout`, and `SELECT`-only grants. It has **no access** to `query_logs`.

### How Google authentication works

Auth.js (NextAuth v5) with the Google provider (`lib/auth.ts`). Clicking **Continue with Google** runs a server action → Google consent → callback at `/api/auth/callback/google` → Auth.js sets an encrypted, httpOnly JWT session cookie → redirect to `/chat`. Every protected page (`/chat`, `/logs`) and API route (`/api/chat`, `/api/logs`) calls `auth()` on the server. Pages redirect anonymous users to `/`; APIs return `401`.

### How query logging works

After each question, `/api/chat` writes one row to `query_logs`:

| Column | Content |
|---|---|
| `user_id` | Google account id (`sub`) |
| `user_email` | Signed-in email |
| `question` | The question |
| `generated_sql` | Every SQL statement sent to `query_database` (joined with `;\n`), or null |
| `tool_used` | MCP tools called, e.g. `describe_table, query_database` |
| `response` | Final answer, or `ERROR: <message>` on failure |
| `created_at` | Timestamp |

Failures are logged too. View the logs at **/logs**: newest first, searchable by question or email, 20 per page.

### Question limit

The project answers at most **100 questions in total** (all users combined). The cap is hard-coded as `QUESTION_LIMIT` in `lib/query-logs.ts`. Usage is the number of rows in `query_logs`, so failed questions count too. When the cap is reached, `/api/chat` returns `429` **before** calling Gemini, and the chat input is disabled. The chat page shows "N of 100 questions left". To reset, clear `query_logs`; to change the cap, edit the constant.

---

## Environment variables

See `.env.example`.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | Owner connection (app + Prisma) |
| `DIRECT_URL` | optional | Non-pooled connection for migrations (Supabase) |
| `MCP_DATABASE_URL` | ✅ | Read-only connection for the MCP server |
| `GEMINI_API_KEY` | ✅ | Google AI Studio API key (server only) |
| `GEMINI_MODEL` | optional | Default `gemini-flash-latest` |
| `AUTH_SECRET` | ✅ | Random secret for Auth.js (`npx auth secret`) |
| `AUTH_GOOGLE_ID` | ✅ | Google OAuth client id |
| `AUTH_GOOGLE_SECRET` | ✅ | Google OAuth client secret |

None of these use the `NEXT_PUBLIC_` prefix, so none are ever bundled into browser code.

## PostgreSQL setup (local)

```bash
brew install postgresql@16
brew services start postgresql@16
createdb ai_db_copilot

# .env:
#   DATABASE_URL="postgresql://<your-mac-user>@localhost:5432/ai_db_copilot"
#   MCP_DATABASE_URL="postgresql://mcp_readonly:<strong-password>@localhost:5432/ai_db_copilot"

npx prisma migrate deploy     # create tables
npm run db:seed               # 12 users, 15 products, 44 orders
npm run db:readonly           # create the read-only mcp_readonly role
```

### Supabase (for Vercel)

1. Supabase → Project → **Connect**. Copy the **Session pooler** URI (port 5432) as both `DATABASE_URL` and `DIRECT_URL`. If you use the transaction pooler (6543), append `?pgbouncer=true` to `DATABASE_URL`.
2. Set `MCP_DATABASE_URL` to the same host but with user `mcp_readonly.<project-ref>` and a new strong password.
3. Run `npx prisma migrate deploy && npm run db:seed && npm run db:readonly` once from your machine.

> Use a dedicated Supabase project/database. `db:seed` **clears** the `users`, `products` and `orders` tables.

## Google OAuth setup

1. [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → **OAuth consent screen**: configure it (External; add yourself as a test user).
2. **Credentials → Create credentials → OAuth client ID → Web application**.
3. Authorized JavaScript origins: `http://localhost:3000` and `https://<your-app>.vercel.app`.
4. Authorized redirect URIs:
   - `http://localhost:3000/api/auth/callback/google`
   - `https://<your-app>.vercel.app/api/auth/callback/google`
5. Put the client id/secret in `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`.

## Gemini API setup

1. Go to [Google AI Studio](https://aistudio.google.com/apikey) → **Create API key**.
2. Put it in `GEMINI_API_KEY`. Optionally set `GEMINI_MODEL` (e.g. `gemini-2.5-flash`).

## Run locally

```bash
npm install
cp .env.example .env        # fill in values
npx prisma migrate deploy && npm run db:seed && npm run db:readonly
npm run dev                 # http://localhost:3000
```

Tests / checks:

```bash
npm run test:mcp            # MCP tools over stdio + 19 destructive/unsafe SQL attempts
npm run test:copilot        # example questions through Gemini → MCP → Postgres
npm run lint && npm run build
```

## Deploy to Vercel

```bash
vercel link
vercel env add DATABASE_URL production      # repeat for each variable above
vercel --prod
```

`npm run build` runs `prisma generate` before building. Run migrations/seed against the production DB from your machine (see Supabase above). Add the Vercel URL to the Google OAuth origins and redirect URIs.

## Example questions

- What tables are available?
- How many users do we have?
- How many pending orders are there?  → *7*
- What are the top 5 products by sales?
- Which customer has placed the most orders?  → *Vikram Reddy (7)*
- Show me orders above 50000.
- Explain the relationship between users and orders.
- What products are out of stock?  → *Samsung Galaxy S25, iPad Air, Samsung T7 SSD*

## Security considerations

- **Secrets stay on the server.** The Gemini key and DB URLs are read only in server modules (`import "server-only"`), never prefixed `NEXT_PUBLIC_`. `.env` is git-ignored; `.env.example` has placeholders.
- **The AI has no direct DB access.** It can only call the six MCP tools.
- **Defence in depth for SQL:**
  1. zod validation of every tool input; table names are checked against an allow-list.
  2. SQL guard: a single statement starting with `SELECT`/`WITH`. It rejects DML/DDL keywords, `SELECT INTO`, `FOR UPDATE`, comments, dollar quoting, stacked statements, `pg_*` functions/catalogs, `information_schema`, `current_setting`, and `query_logs`.
  3. Execution inside `BEGIN READ ONLY … ROLLBACK` with a 5 s statement timeout, wrapped in an outer `LIMIT 101` (100 rows returned).
  4. Postgres role `mcp_readonly`: SELECT-only on 3 tables, read-only by default, with no access to `query_logs`.
- **Parameterized queries** for all schema tools; identifiers come only from the allow-list.
- **Errors are sanitized**: connection strings and passwords are stripped from messages, and users get friendly messages for Gemini, MCP, Postgres, timeout and network failures.
- **Auth on every protected route** (pages and APIs) via `auth()`; session cookies are httpOnly and encrypted.
- **Prompt rules**: the model is told never to reveal secrets or system prompts, never to fabricate data, and to refuse modification requests. Even if it ignored those rules, steps 1–4 above still block any write.
