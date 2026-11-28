import type { Pool } from "pg";
import type { SyncMessage } from "./rabbitmq.js";

interface SyncJob {
    id: string;
    user_id: string;
    mal_anime_id: string;
    episode: number;
    watch_status: string;
    progress_version: number;
}

// A crash between publish and COMMIT can redeliver a job. The MAL worker must
// deduplicate by syncJobId and reject stale progressVersion values.
export async function publishNextJob(
    pool: Pool,
    publish: (message: SyncMessage) => Promise<void>,
    jobId?: string,
): Promise<string | null> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query<SyncJob>(
            `SELECT id, user_id, mal_anime_id, episode, watch_status, progress_version
             FROM sync_jobs
             WHERE state = 'pending' AND published_at IS NULL AND next_attempt_at <= now()
               AND ($1::bigint IS NULL OR id = $1)
             ORDER BY id
             LIMIT 1
             FOR UPDATE SKIP LOCKED`, [jobId ?? null],
        );
        const job = result.rows[0];
        if (!job) {
            await client.query("COMMIT");
            return null;
        }

        await publish({
            schemaVersion: 1,
            syncJobId: job.id,
            userId: job.user_id,
            malAnimeId: job.mal_anime_id,
            episode: job.episode,
            watchStatus: job.watch_status,
            progressVersion: job.progress_version,
        });
        await client.query("UPDATE sync_jobs SET published_at = now() WHERE id = $1", [job.id]);
        await client.query("COMMIT");
        return job.id;
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}
