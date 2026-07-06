-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_users" (
    "team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "is_admin" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_users_pkey" PRIMARY KEY ("team_id","user_id")
);

-- CreateTable
CREATE TABLE "chats" (
    "chat_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT,
    "created_date" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expire_at" TIMESTAMPTZ(6),

    CONSTRAINT "chats_pkey" PRIMARY KEY ("chat_id")
);

-- CreateTable
CREATE TABLE "messages" (
    "chat_id" TEXT NOT NULL,
    "created_date" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "feedback" TEXT,
    "llm_type" TEXT,
    "expire_at" TIMESTAMPTZ(6),

    CONSTRAINT "messages_pkey" PRIMARY KEY ("chat_id","created_date")
);

-- CreateTable
CREATE TABLE "system_contexts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "system_context" TEXT NOT NULL,
    "created_date" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expire_at" TIMESTAMPTZ(6),

    CONSTRAINT "system_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ex_apps" (
    "team_id" TEXT NOT NULL,
    "ex_app_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ex_apps_pkey" PRIMARY KEY ("team_id","ex_app_id")
);

-- CreateTable
CREATE TABLE "invoke_ex_app_histories" (
    "team_id" TEXT NOT NULL,
    "ex_app_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_date" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "team_name_snapshot" TEXT NOT NULL,
    "ex_app_name_snapshot" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "outputs" JSONB,
    "status" TEXT NOT NULL,
    "expire_at" TIMESTAMPTZ(6),

    CONSTRAINT "invoke_ex_app_histories_pkey" PRIMARY KEY ("team_id","ex_app_id","user_id","created_date")
);

-- CreateIndex
CREATE INDEX "team_users_user_id_idx" ON "team_users"("user_id");

-- CreateIndex
CREATE INDEX "chats_user_id_created_date_idx" ON "chats"("user_id", "created_date" DESC);

-- CreateIndex
CREATE INDEX "chats_expire_at_idx" ON "chats"("expire_at");

-- CreateIndex
CREATE INDEX "messages_user_id_idx" ON "messages"("user_id");

-- CreateIndex
CREATE INDEX "messages_feedback_idx" ON "messages"("feedback");

-- CreateIndex
CREATE INDEX "messages_expire_at_idx" ON "messages"("expire_at");

-- CreateIndex
CREATE INDEX "system_contexts_user_id_idx" ON "system_contexts"("user_id");

-- CreateIndex
CREATE INDEX "system_contexts_expire_at_idx" ON "system_contexts"("expire_at");

-- CreateIndex
CREATE INDEX "invoke_ex_app_histories_user_id_idx" ON "invoke_ex_app_histories"("user_id");

-- CreateIndex
CREATE INDEX "invoke_ex_app_histories_team_id_ex_app_id_idx" ON "invoke_ex_app_histories"("team_id", "ex_app_id");

-- CreateIndex
CREATE INDEX "invoke_ex_app_histories_expire_at_idx" ON "invoke_ex_app_histories"("expire_at");

-- AddForeignKey
ALTER TABLE "team_users" ADD CONSTRAINT "team_users_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("chat_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ex_apps" ADD CONSTRAINT "ex_apps_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
