import { Router } from "express";
import { pool } from "./db.js";

export const progressRouter = Router();

const validStatuses = new Set([
    "watching", "completed", "on_hold", "dropped", "plan_to_watch",
]);

// For the first local test, the caller provides a database user ID and MAL anime ID.
// The extension does not supply those yet; connect account identity and anime lookup later.
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

    try {
        await client.query("BEGIN");
        await client.query(
            `INSERT INTO anime (mal_anime_id, title)
             VALUES ($1, $2)
             ON CONFLICT (mal_anime_id) DO UPDATE SET title = EXCLUDED.title`,
            [malAnimeId, title.trim()],
        );

        // Repeated reports of the same episode do not create extra jobs.
        // Older episode reports cannot lower saved progress.
        const progress = await client.query<{ version: number }>(
            `INSERT INTO progress (user_id, mal_anime_id, episode, watch_status)
             VALUES ($1, $2, $3, $4)
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
        res.status(201).json({
            saved: true,
            progressVersion: progress.rows[0].version,
            syncJobId: job.rows[0].id,
            syncState: "pending",
        });
    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch (rollbackError) {
            console.error("PostgreSQL rollback failed:", rollbackError);
        }
        console.error("Saving progress failed:", error);
        res.status(500).json({ error: "Could not save progress" });
    } finally {
        client.release();
    }
});