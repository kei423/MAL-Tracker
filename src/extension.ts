import { Router } from "express";
import type { Pool } from "pg";
import { MalClient, MalError } from "./mal.js";
import { createProgressRouter } from "./progress.js";
import { publishSyncJob } from "./publish-job.js";

const validId = (value: unknown): value is string => typeof value === "string" &&
    /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;

function animeNode(value: unknown) {
    const node = value as { id?: number; title?: string; num_episodes?: number;
        alternative_titles?: { en?: unknown; ja?: unknown; synonyms?: unknown } } | null;
    if (!node || !Number.isSafeInteger(node.id) || node.id! <= 0 || typeof node.title !== "string" || !node.title.trim() ||
        !Number.isSafeInteger(node.num_episodes) || node.num_episodes! < 0) throw new MalError("Invalid MAL anime details");
    const alternatives = node.alternative_titles;
    return { id: node.id!, title: node.title, num_episodes: node.num_episodes!, alternative_titles: {
        en: typeof alternatives?.en === "string" ? alternatives.en : "",
        ja: typeof alternatives?.ja === "string" ? alternatives.ja : "",
        synonyms: Array.isArray(alternatives?.synonyms) ? alternatives.synonyms.filter((title): title is string => typeof title === "string") : [],
    } };
}

export function createExtensionRouter(pool: Pool, mal: MalClient,
    publishJob = (jobId: string) => publishSyncJob(pool, jobId)) {
    const router = Router();
    router.get("/accounts", async (_req, res) => {
        try {
            const result = await pool.query(
                `SELECT u.id AS "userId", u.mal_user_id AS "malUserId", a.reauth_required AS "reauthRequired"
                 FROM users u JOIN mal_accounts a ON a.user_id = u.id ORDER BY u.id`);
            res.json({ accounts: result.rows });
        } catch { res.status(503).json({ error: "Tracker database unavailable" }); }
    });

    router.get(["/anime/search", "/anime/:id"], async (req, res) => {
        const userId = req.query.userId;
        const id = req.params.id;
        const query = req.query.q;
        if (!validId(userId) || (id !== undefined && !validId(id)) ||
            (id === undefined && (typeof query !== "string" || query.trim().length < 2 || query.length > 100))) {
            res.status(400).json({ error: "Provide a valid userId and anime ID or search query (2–100 characters)" }); return;
        }
        const client = await pool.connect().catch(() => null);
        if (!client) { res.status(503).json({ error: "Tracker database unavailable" }); return; }
        try {
            await client.query("BEGIN");
            const path = id === undefined
                ? `/v2/anime?${new URLSearchParams({ q: (query as string).trim(), limit: "10", fields: "num_episodes,alternative_titles" })}`
                : `/v2/anime/${id}?fields=num_episodes,alternative_titles`;
            const response = await mal.request(client, userId, path);
            const data = await response.json().catch(() => { throw new MalError("Invalid MAL anime response"); });
            let result;
            if (id === undefined) {
                if (!Array.isArray(data?.data)) throw new MalError("Invalid MAL search response");
                result = { data: data.data.map((entry: { node?: unknown }) => ({ node: animeNode(entry?.node) })) };
            } else {
                const node = animeNode(data);
                if (String(node.id) !== id) throw new MalError("MAL returned a different anime ID");
                result = { node };
            }
            await client.query("COMMIT");
            res.json(result);
        } catch (error) {
            try {
                if (error instanceof MalError) {
                    if (error.requiresAuth) await client.query("UPDATE mal_accounts SET reauth_required = true WHERE user_id = $1", [userId]);
                    await client.query("COMMIT");
                } else await client.query("ROLLBACK");
            } catch { await client.query("ROLLBACK").catch(() => {}); }
            res.status(error instanceof MalError && error.requiresAuth ? 401 : 502)
                .json({ error: error instanceof MalError ? error.message : "MAL lookup failed" });
        } finally { client.release(); }
    });

    router.use(createProgressRouter(pool, { requireMalAccount: true, onSaved: publishJob }));
    return router;
}
