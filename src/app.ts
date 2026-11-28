import express from "express";
import cors from "cors";
import type { Pool } from "pg";
import { createProgressRouter } from "./progress.js";
import { connectMalAccount, MalClient, MalError, type Fetch } from "./mal.js";
import { importMalList } from "./mal-list.js";
import { createExtensionRouter } from "./extension.js";

export function createApp(pool: Pool, mal = new MalClient(), fetcher: Fetch = fetch,
    options: { publishJob?: (jobId: string) => Promise<boolean> } = {}) {
    const app = express();
    app.use(cors({ origin: "http://localhost:8080", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));
    app.use(express.json());
    app.use("/api", createProgressRouter(pool));
    app.use("/api/extension", createExtensionRouter(pool, mal, options.publishJob));
    app.post("/api/users", async (req, res) => {
        const malUserId = req.body?.malUserId;
        if (!Number.isSafeInteger(malUserId) || malUserId <= 0) {
            res.status(400).json({ error: "malUserId must be a positive integer" }); return;
        }
        try {
            const result = await pool.query<{ id: string }>(
                `INSERT INTO users (mal_user_id) VALUES ($1)
                 ON CONFLICT (mal_user_id) DO UPDATE SET mal_user_id = EXCLUDED.mal_user_id RETURNING id`, [malUserId]);
            res.json({ userId: result.rows[0].id });
        } catch { res.status(503).json({ error: "Database unavailable" }); }
    });
    app.get("/api/db/health", async (_req, res) => {
        try { await pool.query("SELECT 1"); res.json({ database: "ok" }); }
        catch { res.status(503).json({ database: "unavailable" }); }
    });
    app.post("/api/auth/mal/callback", async (req, res) => {
        const { code, verifier, redirectUri } = req.body ?? {};
        if (typeof code !== "string" || !code || typeof verifier !== "string" || !verifier ||
            (redirectUri !== undefined && redirectUri !== (process.env.MAL_REDIRECT_URI ?? "http://localhost:8080/"))) {
            res.status(400).json({ error: "Invalid OAuth callback parameters" }); return;
        }
        try {
            const account = await connectMalAccount(pool, code, verifier, redirectUri, fetcher);
            res.json({ success: true, ...account });
        } catch (error) {
            res.status(502).json({ error: error instanceof MalError ? error.message : "Could not save MAL authorization" });
        }
    });
    app.get("/api/sync/jobs", async (req, res) => {
        if (typeof req.query.userId !== "string" || !/^[1-9]\d{0,18}$/.test(req.query.userId) || BigInt(req.query.userId) > 9223372036854775807n) {
            res.status(400).json({ error: "Provide a positive userId" }); return;
        }
        try {
            const result = await pool.query(
                `SELECT id, mal_anime_id, episode, watch_status, progress_version, state,
                 attempts, published_at, synced_at, next_attempt_at, last_error
                 FROM sync_jobs WHERE user_id = $1 ORDER BY id DESC LIMIT 100`, [req.query.userId]);
            res.json({ jobs: result.rows });
        } catch { res.status(503).json({ error: "Database unavailable" }); }
    });
    app.get("/api/mal/animelist", async (req, res) => {
        const userId = req.query.userId;
        if (typeof userId !== "string" || !/^[1-9]\d{0,18}$/.test(userId) || BigInt(userId) > 9223372036854775807n) {
            res.status(400).json({ error: "Provide the userId returned by MAL authorization" }); return;
        }
        try {
            const { data, ...listSync } = await importMalList(pool, userId, mal);
            if (listSync.state !== "synced") { res.status(502).json({ error: listSync.error, listSync }); return; }
            res.json({ data, listSync });
        } catch { res.status(503).json({ error: "List import unavailable" }); }
    });
    app.post("/api/mal/animelist/sync", async (req, res) => {
        const userId = String(req.body?.userId ?? "");
        if (!/^[1-9]\d{0,18}$/.test(userId) || BigInt(userId) > 9223372036854775807n) {
            res.status(400).json({ error: "Provide a positive userId" }); return;
        }
        try {
            const { data: _entries, ...listSync } = await importMalList(pool, userId, mal);
            res.status(listSync.state === "synced" ? 200 : 202).json({ listSync });
        } catch { res.status(503).json({ error: "List import unavailable" }); }
    });
    app.get("/api/mal/animelist/local", async (req, res) => {
        const userId = req.query.userId;
        if (typeof userId !== "string" || !/^[1-9]\d{0,18}$/.test(userId) || BigInt(userId) > 9223372036854775807n) {
            res.status(400).json({ error: "Provide a positive userId" }); return;
        }
        try {
            const account = await pool.query(
                `SELECT list_synced_at, list_sync_next_attempt_at, list_sync_error, reauth_required
                 FROM mal_accounts WHERE user_id = $1`, [userId]);
            if (!account.rows[0]) { res.status(404).json({ error: "MAL account is not connected" }); return; }
            const entries = await pool.query<{ mal_anime_id: string; title: string; list_status: unknown }>(
                `SELECT e.mal_anime_id, a.title, e.list_status FROM mal_list_entries e
                 JOIN anime a ON a.mal_anime_id = e.mal_anime_id WHERE e.user_id = $1 ORDER BY e.mal_anime_id`, [userId]);
            res.json({ data: entries.rows.map((row) => ({ node: { id: Number(row.mal_anime_id), title: row.title }, list_status: row.list_status })),
                listSync: account.rows[0] });
        } catch { res.status(503).json({ error: "Database unavailable" }); }
    });
    return app;
}
