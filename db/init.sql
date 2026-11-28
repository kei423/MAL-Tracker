-- The local tracker stores one MAL account per user.
CREATE TABLE IF NOT EXISTS users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    mal_user_id BIGINT NOT NULL UNIQUE
);

-- Use MAL's numeric anime ID as the stable identifier, rather than the title.
CREATE TABLE IF NOT EXISTS anime (
    mal_anime_id BIGINT PRIMARY KEY,
    title TEXT NOT NULL
);

-- The latest progress visible to the browser extension.
CREATE TABLE IF NOT EXISTS progress (
    user_id BIGINT NOT NULL REFERENCES users(id),
    mal_anime_id BIGINT NOT NULL REFERENCES anime(mal_anime_id),
    episode INTEGER NOT NULL CHECK (episode >= 0),
    watch_status TEXT NOT NULL CHECK (
        watch_status IN ('watching', 'completed', 'on_hold', 'dropped', 'plan_to_watch')
    ),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, mal_anime_id)
);

-- Every progress change that needs to be delivered to MAL is recorded here.
-- Keep an unsynced row even if RabbitMQ is temporarily unavailable.
CREATE TABLE IF NOT EXISTS sync_jobs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    mal_anime_id BIGINT NOT NULL REFERENCES anime(mal_anime_id),
    episode INTEGER NOT NULL CHECK (episode >= 0),
    watch_status TEXT NOT NULL CHECK (
        watch_status IN ('watching', 'completed', 'on_hold', 'dropped', 'plan_to_watch')
    ),
    progress_version INTEGER NOT NULL CHECK (progress_version > 0),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'synced', 'failed', 'superseded')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    synced_at TIMESTAMPTZ,
    last_error TEXT,
    UNIQUE (user_id, mal_anime_id, progress_version)
);

CREATE INDEX IF NOT EXISTS sync_jobs_pending_idx
    ON sync_jobs (created_at)
    WHERE state = 'pending';

-- Also applies safely to databases created before RabbitMQ was added.
ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS sync_jobs_unpublished_idx
    ON sync_jobs (id)
    WHERE state = 'pending' AND published_at IS NULL;

CREATE TABLE IF NOT EXISTS mal_accounts (
    user_id BIGINT PRIMARY KEY REFERENCES users(id),
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    reauth_required BOOLEAN NOT NULL DEFAULT false,
    list_sync_generation BIGINT NOT NULL DEFAULT 1,
    list_synced_at TIMESTAMPTZ,
    list_sync_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    list_sync_error TEXT,
    list_sync_attempts INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One history entry for each successfully synced progress change.
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

-- Last complete list fetched from MAL; local unsent progress lives separately.
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
