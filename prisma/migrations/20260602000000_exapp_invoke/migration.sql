-- ExApp ローカル実行配線（apiKey 実ストア＋非同期 polling 外部状態）。
-- seam (1) apiKey 保存：専用テーブル ex_app_api_keys（平文 or AES-256-GCM）。
-- seam (2) 非同期外部呼び出し：invoke_ex_app_histories に status_url / external_request_id を追加。

-- AlterTable: 非同期 ExApp の外部状態（202＋status_url を worker が永続化して polling）。同期は null。
ALTER TABLE "invoke_ex_app_histories" ADD COLUMN "status_url" TEXT;
ALTER TABLE "invoke_ex_app_histories" ADD COLUMN "external_request_id" TEXT;

-- CreateTable: ex_app_api_keys（呼び出し用 apiKey の格納先・ApiKeyStore 実ストア）。
CREATE TABLE "ex_app_api_keys" (
    "team_id" TEXT NOT NULL,
    "ex_app_id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "enc_iv" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ex_app_api_keys_pkey" PRIMARY KEY ("team_id", "ex_app_id")
);
