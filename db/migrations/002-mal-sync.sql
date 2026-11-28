CREATE TABLE IF NOT EXISTS mal_accounts (
    user_id BIGINT PRIMARY KEY REFERENCES users(id),
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    reauth_required BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE sync_jobs DROP CONSTRAINT IF EXISTS sync_jobs_state_check;
ALTER TABLE sync_jobs ADD CONSTRAINT sync_jobs_state_check
    CHECK (state IN ('pending', 'synced', 'failed', 'superseded'));
