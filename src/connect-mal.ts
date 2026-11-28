import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { pool } from "./db.js";
import { connectMalAccount, MalError } from "./mal.js";
import { checkTokenKey } from "./token-crypto.js";

async function main() {
    checkTokenKey();
    if (!process.env.MAL_CLIENT_ID) throw new Error("MAL_CLIENT_ID is missing from .env");
    const redirectUri = process.env.MAL_REDIRECT_URI ?? "http://localhost:8080/";
    const callback = new URL(redirectUri);
    if (callback.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(callback.hostname) ||
        callback.search || callback.hash || callback.username || callback.password) {
        throw new Error("MAL_REDIRECT_URI must be a local HTTP URL without a query or fragment");
    }
    const verifier = randomBytes(48).toString("base64url");
    const state = randomBytes(32).toString("hex");
    const cookie = randomBytes(32).toString("hex");
    let started = false;
    let used = false;
    const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
    const server = createServer(async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        const url = new URL(req.url ?? "/", callback.origin);
        if (req.method !== "GET" || url.pathname !== callback.pathname) { res.writeHead(404).end(); return; }
        if (url.searchParams.has("code") || url.searchParams.has("error")) {
            const browserCookie = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("mal_connect="))?.slice(12) ?? "";
            if (!started || used || !equal(url.searchParams.get("state") ?? "", state) || !equal(browserCookie, cookie)) {
                res.writeHead(400).end("Invalid or expired OAuth state. Restart npm run mal:connect."); return;
            }
            used = true;
            if (url.searchParams.has("error")) {
                res.writeHead(400).end("MAL authorization was declined. Restart npm run mal:connect to try again."); return;
            }
            try {
                const account = await connectMalAccount(pool, url.searchParams.get("code")!, verifier, redirectUri);
                console.log(`Connected MAL account ${account.malUserId}; local userId: ${account.userId}`);
                console.log(`MAL list import: ${account.listSync.state} (${account.listSync.imported} entries)${account.listSync.error ? `: ${account.listSync.error}` : ""}`);
                res.setHeader("Set-Cookie", "mal_connect=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
                res.setHeader("Content-Type", "text/plain; charset=utf-8");
                res.end(`MAL connected successfully. Your local userId is ${account.userId}. ` +
                    (account.listSync.state === "synced" ? `Imported ${account.listSync.imported} anime entries. ` : "List import is pending; the sync worker will retry. ") +
                    "You can close this tab.");
                server.close(); clearTimeout(timeout); await pool.end();
            } catch (error) {
                console.error(error instanceof MalError ? error.message : "Could not save MAL authorization");
                res.writeHead(502).end("MAL connection failed. Check the terminal and restart npm run mal:connect.");
            }
            return;
        }
        started = true;
        const params = new URLSearchParams({ response_type: "code", client_id: process.env.MAL_CLIENT_ID!,
            redirect_uri: redirectUri, state, code_challenge: verifier, code_challenge_method: "plain" });
        res.setHeader("Set-Cookie", `mal_connect=${cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`);
        res.writeHead(302, { Location: `https://myanimelist.net/v1/oauth2/authorize?${params}` }).end();
    });
    const timeout = setTimeout(() => { server.close(); void pool.end(); }, 600000);
    const stop = () => { clearTimeout(timeout); server.close(); void pool.end(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    server.once("error", (error: NodeJS.ErrnoException) => {
        console.error(error.code === "EADDRINUSE" ? "The MAL callback port is in use. Stop the server on that port and retry." : error.message);
        stop(); process.exitCode = 1;
    });
    server.listen(Number(callback.port || 80), "127.0.0.1", () => {
        console.log(`Open ${redirectUri} in your browser to connect MAL (expires in 10 minutes).`);
        console.log("The redirect URI must exactly match the one registered in your MAL API settings.");
    });
}
main().catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    await pool.end(); process.exitCode = 1;
});
