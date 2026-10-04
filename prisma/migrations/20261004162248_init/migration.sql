-- CreateTable
CREATE TABLE "copilot_users" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copilot_products" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copilot_orders" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "total_amount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copilot_query_logs" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "user_email" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "generated_sql" TEXT,
    "tool_used" TEXT,
    "response" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_query_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "copilot_users_email_key" ON "copilot_users"("email");

-- CreateIndex
CREATE INDEX "copilot_orders_user_id_idx" ON "copilot_orders"("user_id");

-- CreateIndex
CREATE INDEX "copilot_orders_product_id_idx" ON "copilot_orders"("product_id");

-- CreateIndex
CREATE INDEX "copilot_orders_status_idx" ON "copilot_orders"("status");

-- CreateIndex
CREATE INDEX "copilot_query_logs_created_at_idx" ON "copilot_query_logs"("created_at");

-- CreateIndex
CREATE INDEX "copilot_query_logs_user_email_idx" ON "copilot_query_logs"("user_email");

-- AddForeignKey
ALTER TABLE "copilot_orders" ADD CONSTRAINT "copilot_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "copilot_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copilot_orders" ADD CONSTRAINT "copilot_orders_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "copilot_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security: deny-by-default for every role that is not the table owner.
-- The app (owner connection) bypasses RLS; the MCP read-only role gets an explicit
-- SELECT policy in scripts/setup-readonly-user.ts. On Supabase this also blocks the
-- public Data API (anon/authenticated) from reading these tables.
ALTER TABLE "copilot_users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_query_logs" ENABLE ROW LEVEL SECURITY;
