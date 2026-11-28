-- Run once against an existing database; safe to run again.
ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS sync_jobs_unpublished_idx
    ON sync_jobs (id)
    WHERE state = 'pending' AND published_at IS NULL;
