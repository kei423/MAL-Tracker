BEGIN;

CREATE TABLE IF NOT EXISTS transactions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sync_job_id BIGINT NOT NULL UNIQUE REFERENCES sync_jobs(id),
    user_id BIGINT NOT NULL REFERENCES users(id),
    mal_anime_id BIGINT NOT NULL REFERENCES anime(mal_anime_id),
    episode INTEGER NOT NULL CHECK (episode >= 0),
    watch_status TEXT NOT NULL CHECK (
        watch_status IN ('watching', 'completed', 'on_hold', 'dropped', 'plan_to_watch')
    ),
    progress_version INTEGER NOT NULL CHECK (progress_version > 0),
    synced_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS transactions_user_time_idx
    ON transactions (user_id, synced_at DESC, id DESC);

-- Runs inside the transaction that marks the sync job successful. A failed
-- history insert rolls that update back, so the worker cannot acknowledge it.
CREATE OR REPLACE FUNCTION record_successful_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO transactions
        (sync_job_id, user_id, mal_anime_id, episode, watch_status, progress_version, synced_at)
    VALUES
        (NEW.id, NEW.user_id, NEW.mal_anime_id, NEW.episode, NEW.watch_status,
         NEW.progress_version, COALESCE(NEW.synced_at, now()))
    ON CONFLICT (sync_job_id) DO NOTHING;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER sync_jobs_record_success
    AFTER INSERT OR UPDATE OF state ON sync_jobs
    FOR EACH ROW WHEN (NEW.state = 'synced')
    EXECUTE FUNCTION record_successful_sync();

-- Preserve the original success timestamp for jobs completed before this
-- migration. Running the migration again does not duplicate history.
INSERT INTO transactions
    (sync_job_id, user_id, mal_anime_id, episode, watch_status, progress_version, synced_at)
SELECT id, user_id, mal_anime_id, episode, watch_status, progress_version, synced_at
FROM sync_jobs
WHERE state = 'synced' AND synced_at IS NOT NULL
ON CONFLICT (sync_job_id) DO NOTHING;

COMMIT;
