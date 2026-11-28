import type { Pool } from "pg";
import { MalClient, MalError } from "./mal.js";
import { lockUser } from "./user-lock.js";

export async function syncJob(pool: Pool, jobId: string, mal = new MalClient()): Promise<string> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        // Serialize jobs for one user's anime, including duplicate deliveries.
        const identity = await client.query<{ user_id: string; mal_anime_id: string }>(
            "SELECT user_id, mal_anime_id FROM sync_jobs WHERE id = $1", [jobId]);
        if (!identity.rows[0]) { await client.query("COMMIT"); return "missing"; }
        const { user_id: userId, mal_anime_id: animeId } = identity.rows[0];
        await lockUser(client, userId);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':' || $1, 0))", [`mal:${userId}:${animeId}`]);
        const { rows: [job] } = await client.query<{
            state: string; episode: number; watch_status: string; progress_version: number;
            attempts: number; next_attempt_at: Date;
        }>("SELECT * FROM sync_jobs WHERE id = $1 FOR UPDATE", [jobId]);
        if (job.state !== "pending") { await client.query("COMMIT"); return job.state; }
        if (job.next_attempt_at.getTime() > Date.now()) {
            // An early/duplicate delivery must not strand a scheduled retry.
            await client.query("UPDATE sync_jobs SET published_at = NULL WHERE id = $1", [jobId]);
            await client.query("COMMIT"); return "pending";
        }
        const progress = await client.query<{ version: number }>(
            "SELECT version FROM progress WHERE user_id = $1 AND mal_anime_id = $2 FOR UPDATE", [userId, animeId]);
        if (!progress.rows[0] || progress.rows[0].version > job.progress_version) {
            await client.query("UPDATE sync_jobs SET state = 'superseded', last_error = NULL WHERE id = $1", [jobId]);
            await client.query("COMMIT");
            return "superseded";
        }
        let state = "synced";
        try {
            const response = await mal.request(client, userId, `/v2/anime/${animeId}/my_list_status`, {
                method: "PUT", headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ status: job.watch_status, num_watched_episodes: String(job.episode) }),
            });
            let confirmed: { status?: string; num_episodes_watched?: number };
            try { confirmed = await response.json(); }
            catch { throw new MalError("MAL returned an invalid progress response"); }
            if (!confirmed || confirmed.status !== job.watch_status || confirmed.num_episodes_watched !== job.episode) {
                throw new MalError("MAL did not confirm the requested episode and watch status", false);
            }
            await client.query(
                "UPDATE sync_jobs SET state = 'synced', synced_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1", [jobId]);
        } catch (error) {
            if (!(error instanceof MalError)) throw error;
            const attempts = job.attempts + (error.requiresAuth ? 0 : 1);
            const retry = error.requiresAuth || (error.retryable && attempts < 5);
            state = retry ? "pending" : "failed";
            if (error.requiresAuth) {
                await client.query("UPDATE mal_accounts SET reauth_required = true WHERE user_id = $1", [userId]);
            }
            const wait = error.requiresAuth ? 60 : Math.max(error.retryAfter, Math.min(300, 5 * 2 ** Math.max(0, attempts - 1)));
            await client.query(
                `UPDATE sync_jobs SET state = $2, attempts = $3, last_error = $4,
                 published_at = NULL, next_attempt_at = now() + $5 * interval '1 second' WHERE id = $1`,
                [jobId, state, attempts, error.message, wait]);
        }
        await client.query("COMMIT");
        return state;
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally { client.release(); }
}
