BEGIN;

ALTER TABLE mal_accounts
    ADD COLUMN IF NOT EXISTS list_sync_generation BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS list_synced_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS list_sync_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS list_sync_error TEXT,
    ADD COLUMN IF NOT EXISTS list_sync_attempts INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS mal_list_entries (
    user_id BIGINT NOT NULL REFERENCES users(id),
    mal_anime_id BIGINT NOT NULL REFERENCES anime(mal_anime_id),
    episode INTEGER NOT NULL CHECK (episode >= 0),
    watch_status TEXT NOT NULL CHECK (
        watch_status IN ('watching', 'completed', 'on_hold', 'dropped', 'plan_to_watch')
    ),
    list_status JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, mal_anime_id)
);

CREATE INDEX IF NOT EXISTS mal_accounts_list_sync_due_idx
    ON mal_accounts (list_sync_next_attempt_at) WHERE NOT reauth_required;

COMMIT;
