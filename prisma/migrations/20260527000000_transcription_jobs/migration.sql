-- CreateTable
CREATE TABLE "transcription_jobs" (
    "job_name" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "audio_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "speaker_label" BOOLEAN NOT NULL,
    "max_speakers" INTEGER NOT NULL,
    "language_code" TEXT,
    "transcripts" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expire_at" TIMESTAMPTZ(6),

    CONSTRAINT "transcription_jobs_pkey" PRIMARY KEY ("job_name")
);

-- CreateIndex
CREATE INDEX "transcription_jobs_owner_user_id_idx" ON "transcription_jobs"("owner_user_id");

-- CreateIndex
CREATE INDEX "transcription_jobs_expire_at_idx" ON "transcription_jobs"("expire_at");
