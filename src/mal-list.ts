import type { Pool } from "pg";
import type { MalClient, MalListEntry } from "./mal.js";
import { MalError } from "./mal-error.js";
import { lockUser } from "./user-lock.js";

export interface ListSyncResult {
    state: "synced" | "pending";
    imported: number;
    error?: string;
    data?: MalListEntry[];
}

export function listSyncIntervalSeconds(): number {
    const seconds = Number(process.env.MAL_LIST_SYNC_INTERVAL_SECONDS ?? 10);
    if (!Number.isInteger(seconds) || seconds < 10 || seconds > 86400) {
        throw new Error("MAL_LIST_SYNC_INTERVAL_SECONDS must be an integer between 10 and 86400");
    }
    return seconds;
}

export async function importMalList(pool: Pool, userId: string, mal: MalClient): Promise<ListSyncResult> {
    const interval = listSyncIntervalSeconds();
    const client = await pool.connect();
    const lease = `mal-list:${userId}`;
    let locked = false;
    try {
        // A session lock spans the fetch and merge transactions, preventing two
        // processes from applying competing snapshots of the same account.
        locked = (await client.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended(current_schema() || ':' || $1, 0)) AS locked", [lease])).rows[0].locked;
        if (!locked) return { state: "pending", imported: 0, error: "A list import is already running" };

        await client.query("BEGIN");
        // Fetch every page and validate it before changing any local list rows.
        const entries = await mal.fetchAnimeList(client, userId);
        const generation = (await client.query<{ list_sync_generation: string }>(
            "SELECT list_sync_generation FROM mal_accounts WHERE user_id = $1", [userId])).rows[0].list_sync_generation;
        // Save rotated OAuth credentials before acquiring local progress locks.
        await client.query("COMMIT");

        await client.query("BEGIN");
        await lockUser(client, userId);
        // MAL is authoritative at import time. Cancel unsent/retryable local
        // jobs atomically with replacement so queued deliveries cannot undo it.
        await client.query(
            `UPDATE sync_jobs SET state = 'superseded', last_error = 'Superseded by MAL list import'
             WHERE user_id = $1 AND state IN ('pending', 'failed')`, [userId]);
        const fetchedAt = (await client.query<{ time: Date }>("SELECT clock_timestamp() AS time")).rows[0].time;
        const ids: string[] = [];
        for (const entry of [...entries].sort((a, b) => a.node.id - b.node.id)) {
            const id = String(entry.node.id);
            ids.push(id);
            await client.query(
                `INSERT INTO anime (mal_anime_id, title) VALUES ($1, $2)
                 ON CONFLICT (mal_anime_id) DO UPDATE SET title = EXCLUDED.title`, [id, entry.node.title]);
            await client.query(
                `INSERT INTO mal_list_entries (user_id, mal_anime_id, episode, watch_status, list_status, fetched_at)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (user_id, mal_anime_id) DO UPDATE SET episode = EXCLUDED.episode,
                     watch_status = EXCLUDED.watch_status, list_status = EXCLUDED.list_status, fetched_at = EXCLUDED.fetched_at`,
                [userId, id, entry.list_status.num_episodes_watched, entry.list_status.status, entry.list_status, fetchedAt]);
            await client.query(
                `INSERT INTO progress (user_id, mal_anime_id, episode, watch_status, version)
                 VALUES ($1, $2, $3, $4, COALESCE((
                     SELECT max(j.progress_version) FROM sync_jobs j WHERE j.user_id = $1 AND j.mal_anime_id = $2
                 ), 0) + 1)
                 ON CONFLICT (user_id, mal_anime_id) DO UPDATE SET episode = EXCLUDED.episode,
                     watch_status = EXCLUDED.watch_status, version = progress.version + 1, updated_at = now()
                 WHERE (progress.episode, progress.watch_status) IS DISTINCT FROM (EXCLUDED.episode, EXCLUDED.watch_status)`,
                [userId, id, entry.list_status.num_episodes_watched, entry.list_status.status]);
        }
        await client.query("DELETE FROM mal_list_entries WHERE user_id = $1 AND NOT (mal_anime_id = ANY($2::bigint[]))", [userId, ids]);
        await client.query("DELETE FROM progress WHERE user_id = $1 AND NOT (mal_anime_id = ANY($2::bigint[]))", [userId, ids]);
        await client.query(
            `UPDATE mal_accounts SET list_synced_at = $2, list_sync_attempts = 0, list_sync_error = NULL,
             list_sync_next_attempt_at = CASE WHEN list_sync_generation = $3
                 THEN now() + $4 * interval '1 second' ELSE now() END WHERE user_id = $1`,
            [userId, fetchedAt, generation, interval]);
        await client.query("COMMIT");
        return { state: "synced", imported: entries.length, data: entries };
    } catch (error) {
        // A MAL error must not discard a refresh token that was already rotated.
        // No list changes are made in the fetch transaction.
        if (error instanceof MalError) await client.query("COMMIT").catch(() => {});
        else await client.query("ROLLBACK").catch(() => {});
        const message = error instanceof MalError ? error.message : "Could not save MAL list import";
        await client.query(
            `UPDATE mal_accounts SET list_sync_error = $2, list_sync_attempts = list_sync_attempts + 1,
             reauth_required = reauth_required OR $3,
             list_sync_next_attempt_at = now() + $4 * interval '1 second' WHERE user_id = $1`,
            [userId, message, error instanceof MalError && error.requiresAuth,
                Math.max(60, error instanceof MalError ? error.retryAfter : 0)]);
        return { state: "pending", imported: 0, error: message };
    } finally {
        let releaseError: Error | undefined;
        if (locked) {
            try { await client.query("SELECT pg_advisory_unlock(hashtextextended(current_schema() || ':' || $1, 0))", [lease]); }
            catch { releaseError = new Error("Could not release MAL list import lock"); }
        }
        client.release(releaseError);
    }
}
