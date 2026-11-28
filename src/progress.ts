import { Router } from "express";
import { pool } from "./db.js";
import type { Pool } from "pg";
import { lockUser } from "./user-lock.js";

export function createProgressRouter(pool: Pool, options: {
    requireMalAccount?: boolean;
    onSaved?: (jobId: string) => Promise<boolean>;
} = {}) {
    const progressRouter = Router();

    const validStatuses = new Set([
        "watching", "completed", "on_hold", "dropped", "plan_to_watch",
    ]);

    // Local test callers supply IDs directly. The extension uses this same
    // transaction with an additional connected-MAL-account identity check.
    progressRouter.post("/progress", async (req, res) => {
        const { userId, malAnimeId, title, episode, watchStatus } = req.body ?? {};

        if (
            !Number.isSafeInteger(userId) || userId <= 0 ||
            !Number.isSafeInteger(malAnimeId) || malAnimeId <= 0 ||
            typeof title !== "string" || !title.trim() || title.length > 500 ||
            !Number.isSafeInteger(episode) || episode < 0 ||
            typeof watchStatus !== "string" || !validStatuses.has(watchStatus)
        ) {
            res.status(400).json({ error: "Invalid progress update" });
            return;
        }

        let client;
        try {
            client = await pool.connect();
        } catch (error) {
            console.error("PostgreSQL connection failed:", error);
            res.status(503).json({ error: "Database unavailable" });
            return;
        }

        let released = false;
        try {
            await client.query("BEGIN");
            await lockUser(client, String(userId));
            if (options.requireMalAccount) {
                const malUserId = String(req.body?.malUserId ?? "");
                const account = await client.query<{ mal_user_id: string; reauth_required: boolean }>(
                    `SELECT u.mal_user_id, a.reauth_required FROM users u
                     JOIN mal_accounts a ON a.user_id = u.id WHERE u.id = $1`, [userId]);
                if (!account.rows[0] || account.rows[0].reauth_required || account.rows[0].mal_user_id !== malUserId) {
                    await client.query("ROLLBACK");
                    res.status(409).json({ error: "Reconnect MAL with mal:connect and select the account again in the extension" }); return;
                }
            }
            await client.query(
                `INSERT INTO anime (mal_anime_id, title)
                 VALUES ($1, $2)
                 ON CONFLICT (mal_anime_id) DO UPDATE SET title = EXCLUDED.title`,
                [malAnimeId, title.trim()],
            );

            // Repeated reports of the same episode do not create extra jobs.
            // Older episode reports cannot lower saved progress.
            const progress = await client.query<{ version: number }>(
                `INSERT INTO progress (user_id, mal_anime_id, episode, watch_status, version)
                 VALUES ($1, $2, $3, $4, COALESCE((
                     SELECT max(j.progress_version) FROM sync_jobs j WHERE j.user_id = $1 AND j.mal_anime_id = $2
                 ), 0) + 1)
                 ON CONFLICT (user_id, mal_anime_id) DO UPDATE SET
                     episode = EXCLUDED.episode,
                     watch_status = EXCLUDED.watch_status,
                     version = progress.version + 1,
                     updated_at = now()
                 WHERE progress.episode < EXCLUDED.episode
                    OR (progress.episode = EXCLUDED.episode
                        AND progress.watch_status <> EXCLUDED.watch_status
                        AND progress.watch_status <> 'completed')
                 RETURNING version`,
                [userId, malAnimeId, episode, watchStatus],
            );

            if (progress.rowCount === 0) {
                await client.query("COMMIT");
                res.status(200).json({ saved: false, reason: "Progress already recorded or older" });
                return;
            }

            const job = await client.query<{ id: string }>(
                `INSERT INTO sync_jobs
                    (user_id, mal_anime_id, episode, watch_status, progress_version)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id`,
                [userId, malAnimeId, episode, watchStatus, progress.rows[0].version],
            );

            await client.query("COMMIT");
            // Publishing uses its own DB transaction; return this connection
            // first so simultaneous extension requests cannot exhaust the pool.
            client.release();
            released = true;
            let queued: boolean | undefined;
            if (options.onSaved) {
                try { queued = await options.onSaved(job.rows[0].id); }
                catch { queued = false; }
            }
            res.status(201).json({
                saved: true,
                progressVersion: progress.rows[0].version,
                syncJobId: job.rows[0].id,
                syncState: "pending",
                queued,
            });
        } catch (error) {
            if (!released) {
                try { await client.query("ROLLBACK"); }
                catch (rollbackError) { console.error("PostgreSQL rollback failed:", rollbackError); }
            }
            console.error("Saving progress failed:", error);
            res.status(500).json({ error: "Could not save progress" });
        } finally {
            if (!released) client.release();
        }
    });
    return progressRouter;
}

export const progressRouter = createProgressRouter(pool);
