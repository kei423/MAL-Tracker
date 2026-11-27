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
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'synced', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    synced_at TIMESTAMPTZ,
    last_error TEXT,
    UNIQUE (user_id, mal_anime_id, progress_version)
);

CREATE INDEX IF NOT EXISTS sync_jobs_pending_idx
    ON sync_jobs (created_at)
    WHERE state = 'pending';