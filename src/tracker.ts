import express from "express";
import cors from "cors";
import "dotenv/config";
import { pool } from "./db.js";
import { progressRouter } from "./progress.js";

const app = express();
app.use(cors({
    origin: "http://localhost:8080",
    methods: ["POST"],
    allowedHeaders: ["Content-Type"],
}));
app.use(express.json());
app.use("/api", progressRouter);

// Create the local user record before recording progress. MAL OAuth can later
// call the same upsert after it learns the account's numeric MAL ID.
app.post("/api/users", async (req, res) => {
    const malUserId = req.body?.malUserId;
    if (!Number.isSafeInteger(malUserId) || malUserId <= 0) {
        res.status(400).json({ error: "malUserId must be a positive integer" });
        return;
    }
    try {
        const result = await pool.query<{ id: string }>(
            `INSERT INTO users (mal_user_id) VALUES ($1)
             ON CONFLICT (mal_user_id) DO UPDATE SET mal_user_id = EXCLUDED.mal_user_id
             RETURNING id`,
            [malUserId],
        );
        res.json({ userId: result.rows[0].id });
    } catch (error) {
        console.error("Saving user failed:", error);
        res.status(503).json({ error: "Database unavailable" });
    }
});

app.get("/api/db/health", async (_req, res) => {
    try {
        await pool.query("SELECT 1");
        res.json({ database: "ok" });
    } catch {
        res.status(503).json({ database: "unavailable" });
    }
});

const PORT = 3000;
const clientId = process.env.MAL_CLIENT_ID;
const clientSecret = process.env.MAL_CLIENT_SECRET;

interface MALTokens {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
}

let malTokens: MALTokens | null = null;

app.post("/api/auth/mal/callback", async (req, res) => {
    try {
        const { code, verifier, redirectUri } = req.body;

        if (!code || !verifier || !redirectUri || !clientId || !clientSecret) {
            res.status(400).json({ error: "Missing required parameters" });
            return;
        }

        const body = new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: "authorization_code",
            code: code,
            // redirect_uri: redirectUri,
            code_verifier: verifier
        })

        const response = await fetch(
            "https://myanimelist.net/v1/oauth2/token",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body,
            }
        );

        const responseText = await response.text();

        if (!response.ok) {
            console.error(
                "MAL token exchange failed:",
                response.status,
                responseText
            );

            res.status(502).json({
                error: "MAL token exchange failed",
                upstreamStatus: response.status,
            });
            return;
        }

        const data = JSON.parse(responseText);

        malTokens = data;

        res.json({ success: true });

    } catch (error) {
        console.error("OAuth callback failed:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.get("/api/mal/animelist", async (req, res) => {
    if (!malTokens) {
        res.status(401).json({
            error: "Please authorize with MAL first"
        });
        return;
    }

    try {
        const entries: unknown[] = [];
        const visited = new Set<string>();
        let nextUrl: string | null =
            "https://api.myanimelist.net/v2/users/@me/animelist?fields=list_status&limit=1000";

        while (nextUrl) {
            const url = new URL(nextUrl);
            if (url.origin !== "https://api.myanimelist.net" ||
                url.pathname !== "/v2/users/@me/animelist" ||
                visited.has(url.href)) {
                res.status(502).json({ error: "Invalid MAL pagination link" });
                return;
            }
            visited.add(url.href);

            const response = await fetch(url, {
                headers: { Authorization: `Bearer ${malTokens.access_token}` },
            });
            if (!response.ok) {
                res.status(response.status).json({
                    error: "Failed to retrieve anime list from MAL",
                });
                return;
            }

            const page = await response.json() as {
                data?: unknown[];
                paging?: { next?: string | null };
            } | null;
            if (!page || !Array.isArray(page.data) ||
                (page.paging?.next != null && typeof page.paging.next !== "string")) {
                res.status(502).json({ error: "Invalid MAL anime list response" });
                return;
            }
            entries.push(...page.data);
            nextUrl = page.paging?.next || null;
        }

        res.json({ data: entries });
    } catch (error) {
        console.error("Anime list request failed:", error);
        res.status(500).json({
            error: "Internal server error",
        });
    }
});

app.listen(PORT, () => {
    console.log(`Tracker API running on http://localhost:${PORT}`);
})
