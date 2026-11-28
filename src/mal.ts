import type { Pool, PoolClient } from "pg";
import { decryptToken, encryptToken } from "./token-crypto.js";
import { importMalList, type ListSyncResult } from "./mal-list.js";
import { MalError } from "./mal-error.js";
export { MalError } from "./mal-error.js";

const apiOrigin = "https://api.myanimelist.net";
const tokenUrl = "https://myanimelist.net/v1/oauth2/token";
export type Fetch = typeof fetch;

export interface MalListEntry {
    node: { id: number; title: string; [key: string]: unknown };
    list_status: { status: string; num_episodes_watched: number; [key: string]: unknown };
}

interface Tokens { access_token: string; refresh_token: string; expires_in: number }
interface Account { access_token: string; refresh_token: string; expires_at: Date; reauth_required: boolean }

async function request(fetcher: Fetch, url: string, init: RequestInit): Promise<Response> {
    try {
        return await fetcher(url, { ...init, signal: AbortSignal.timeout(15000), redirect: "error" });
    } catch {
        throw new MalError("MAL request timed out or could not connect");
    }
}

function httpError(response: Response, context: string): MalError {
    const retryHeader = response.headers.get("retry-after");
    const seconds = retryHeader && /^\d+$/.test(retryHeader)
        ? Number(retryHeader) : Math.ceil((Date.parse(retryHeader ?? "") - Date.now()) / 1000);
    return new MalError(`${context} (HTTP ${response.status})`,
        response.status === 429 || response.status >= 500,
        response.status === 401,
        Number.isFinite(seconds) ? Math.min(3600, Math.max(0, seconds)) : 0);
}

async function tokenRequest(body: URLSearchParams, fetcher: Fetch): Promise<Tokens> {
    if (!process.env.MAL_CLIENT_ID) throw new MalError("MAL_CLIENT_ID is missing from .env", false);
    body.set("client_id", process.env.MAL_CLIENT_ID);
    if (process.env.MAL_CLIENT_SECRET) body.set("client_secret", process.env.MAL_CLIENT_SECRET);
    const response = await request(fetcher, tokenUrl, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    });
    if (!response.ok) {
        if (response.status === 400 || response.status === 401) {
            throw new MalError("MAL authorization expired or was rejected; connect to MAL again", false, true);
        }
        throw httpError(response, "MAL token request failed");
    }
    const data = await response.json().catch(() => { throw new MalError("MAL returned an invalid token response"); }) as Partial<Tokens> | null;
    if (!data || typeof data.access_token !== "string" || !data.access_token ||
        typeof data.refresh_token !== "string" || !data.refresh_token ||
        typeof data.expires_in !== "number" || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 315360000) {
        throw new MalError("MAL returned an invalid token response");
    }
    return data as Tokens;
}

async function storeTokens(client: PoolClient, userId: string, tokens: Tokens) {
    await client.query(
        `INSERT INTO mal_accounts (user_id, access_token, refresh_token, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET access_token = EXCLUDED.access_token,
             refresh_token = EXCLUDED.refresh_token, expires_at = EXCLUDED.expires_at,
             reauth_required = false, updated_at = now(),
             list_sync_generation = mal_accounts.list_sync_generation + 1,
             list_sync_next_attempt_at = now()`,
        [userId, encryptToken(tokens.access_token), encryptToken(tokens.refresh_token),
            new Date(Date.now() + tokens.expires_in * 1000)],
    );
}

export async function connectMalAccount(
    pool: Pool, code: string, verifier: string, redirectUri?: string, fetcher: Fetch = fetch,
): Promise<{ userId: string; malUserId: number; listSync: Omit<ListSyncResult, "data"> }> {
    const body = new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier });
    if (redirectUri) body.set("redirect_uri", redirectUri);
    const tokens = await tokenRequest(body, fetcher);
    const profile = await request(fetcher, `${apiOrigin}/v2/users/@me`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!profile.ok) throw httpError(profile, "MAL account lookup failed");
    const data = await profile.json().catch(() => { throw new MalError("MAL returned an invalid account profile"); }) as { id?: number } | null;
    if (!data || !Number.isSafeInteger(data.id) || data.id! <= 0) throw new MalError("MAL returned an invalid account ID");

    const client = await pool.connect();
    let userId: string;
    try {
        await client.query("BEGIN");
        const result = await client.query<{ id: string }>(
            `INSERT INTO users (mal_user_id) VALUES ($1)
             ON CONFLICT (mal_user_id) DO UPDATE SET mal_user_id = EXCLUDED.mal_user_id RETURNING id`, [data.id],
        );
        userId = result.rows[0].id;
        await storeTokens(client, userId, tokens);
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally { client.release(); }
    // A failed list download must not turn a successful login into a failure.
    let listSync: Omit<ListSyncResult, "data">;
    try {
        const { data: _entries, ...result } = await importMalList(pool, userId, new MalClient(fetcher));
        listSync = result;
    } catch { listSync = { state: "pending", imported: 0, error: "List import queued for retry" }; }
    return { userId, malUserId: data.id!, listSync };
}

export class MalClient {
    constructor(private fetcher: Fetch = fetch) {}

    async fetchAnimeList(client: PoolClient, userId: string): Promise<MalListEntry[]> {
        const entries: MalListEntry[] = [];
        const visited = new Set<string>();
        const ids = new Set<number>();
        const statuses = new Set(["watching", "completed", "on_hold", "dropped", "plan_to_watch"]);
        let next: string | null = `${apiOrigin}/v2/users/@me/animelist?fields=list_status&limit=1000&nsfw=true`;
        while (next) {
            let url: URL;
            try { url = new URL(next); } catch { throw new MalError("Invalid MAL pagination link"); }
            if (url.origin !== apiOrigin || url.pathname !== "/v2/users/@me/animelist" || url.username || url.password || visited.has(url.href)) {
                throw new MalError("Invalid MAL pagination link");
            }
            visited.add(url.href);
            const response = await this.request(client, userId, url.href);
            const page = await response.json().catch(() => { throw new MalError("Invalid MAL anime list response"); }) as {
                data?: MalListEntry[]; paging?: { next?: unknown };
            } | null;
            if (!page || !Array.isArray(page.data) || (page.paging?.next != null && typeof page.paging.next !== "string")) {
                throw new MalError("Invalid MAL anime list response");
            }
            for (const entry of page.data) {
                if (!entry || !Number.isSafeInteger(entry.node?.id) || entry.node.id <= 0 || ids.has(entry.node.id) ||
                    typeof entry.node.title !== "string" || !entry.node.title.trim() ||
                    !statuses.has(entry.list_status?.status) || !Number.isSafeInteger(entry.list_status.num_episodes_watched) ||
                    entry.list_status.num_episodes_watched < 0 || entry.list_status.num_episodes_watched > 2147483647) {
                    throw new MalError("Invalid MAL anime list entry");
                }
                ids.add(entry.node.id); entries.push(entry);
            }
            next = (page.paging?.next as string | undefined) || null;
        }
        return entries;
    }

    // Call inside a transaction. The account row lock serializes token refreshes.
    async request(client: PoolClient, userId: string, path: string, init: RequestInit = {}): Promise<Response> {
        const url = new URL(path, apiOrigin);
        if (url.origin !== apiOrigin || !url.pathname.startsWith("/v2/")) throw new Error("Invalid MAL API URL");
        const result = await client.query<Account>("SELECT * FROM mal_accounts WHERE user_id = $1 FOR UPDATE", [userId]);
        const account = result.rows[0];
        if (!account || account.reauth_required) throw new MalError("Connect this user to MAL with npm run mal:connect", false, true);
        const decrypt = (value: string) => {
            try { return decryptToken(value); }
            catch { throw new MalError("Stored MAL credentials cannot be decrypted; restore MAL_TOKEN_KEY or connect to MAL again", false, true); }
        };
        const refresh = async () => {
            const tokens = await tokenRequest(new URLSearchParams({
                grant_type: "refresh_token", refresh_token: decrypt(account.refresh_token),
            }), this.fetcher);
            await storeTokens(client, userId, tokens);
            account.access_token = encryptToken(tokens.access_token);
            account.refresh_token = encryptToken(tokens.refresh_token);
        };
        if (account.expires_at.getTime() <= Date.now() + 60000) await refresh();
        const send = () => request(this.fetcher, url.href, {
            ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${decrypt(account.access_token)}` },
        });
        let response = await send();
        if (response.status === 401) {
            await refresh();
            response = await send();
        }
        if (!response.ok) throw httpError(response, "MAL API request failed");
        return response;
    }
}
