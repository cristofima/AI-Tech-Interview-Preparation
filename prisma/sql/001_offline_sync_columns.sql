-- Offline response sync: idempotency + audio persistence columns.
-- Equivalent to `pnpm exec prisma db push` for the QuestionResponse changes.
-- Safe to run more than once.
ALTER TABLE "question_responses"
  ADD COLUMN IF NOT EXISTS "audio_mime_type"    TEXT,
  ADD COLUMN IF NOT EXISTS "audio_size_bytes"   INTEGER,
  ADD COLUMN IF NOT EXISTS "audio_sha256"       TEXT,
  ADD COLUMN IF NOT EXISTS "client_response_id" TEXT,
  ADD COLUMN IF NOT EXISTS "recorded_at"        TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "question_responses_client_response_id_key"
  ON "question_responses" ("client_response_id");
