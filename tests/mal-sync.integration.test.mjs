import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { Pool } from "pg";
import { createApp } from "../dist/app.js";
import { MalClient, connectMalAccount } from "../dist/mal.js";
import { encryptToken, decryptToken } from "../dist/token-crypto.js";
import { syncJob } from "../dist/sync.js";
import { openRabbitMQ } from "../dist/rabbitmq.js";
import { publishNextJob } from "../dist/outbox.js";
import { consumeSyncQueue } from "../dist/consumer.js";
import { importMalList } from "../dist/mal-list.js";

const waitFor = async (check) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { if (await check()) return; await delay(20); }
    throw new Error("Timed out waiting for consumer");
};

test("MAL Sync integration (all MAL requests simulated)", { timeout: 30000 }, async (t) => {
    const schema = `sync_test_${randomUUID().replaceAll("-", "")}`;
    const queue = `mal.sync.test.${randomUUID()}`;
    const previousKey = process.env.MAL_TOKEN_KEY;
    const previousClient = process.env.MAL_CLIENT_ID;
    process.env.MAL_TOKEN_KEY = randomBytes(32).toString("hex");
    process.env.MAL_CLIENT_ID = "test-client";
    const config = {
        host: process.env.DB_HOST ?? "127.0.0.1", port: Number(process.env.DB_PORT ?? 5432),
        user: process.env.DB_USER ?? "tracker", password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME ?? "tracker", connectionTimeoutMillis: 5000,
    };
    const admin = new Pool(config);
    const db = new Pool({ ...config, options: `-c search_path=${schema}` });
    let server, broker, consumer;
    let apiStatus = 200, refreshStatus = 200, unauthorizedOnce = false, networkDown = false, mismatch = false;
    let refreshes = 0;
    const calls = [];
    const fakeFetch = async (url, init = {}) => {
        url = String(url);
        calls.push({ url, init });
        if (url === "https://myanimelist.net/v1/oauth2/token") {
            const refresh = init.body.get("grant_type") === "refresh_token";
            if (refresh) {
                refreshes++;
                if (refreshStatus !== 200) return Response.json({ error: "invalid_grant" }, { status: refreshStatus });
            }
            return Response.json({ access_token: `access-${refreshes}`, refresh_token: `refresh-${refreshes}`, expires_in: 3600 });
        }
        if (url === "https://api.myanimelist.net/v2/users/@me") return Response.json({ id: 1001, name: "test-user" });
        if (url.includes("/animelist")) return Response.json({ data: [], paging: {} });
        assert.match(url, /^https:\/\/api\.myanimelist\.net\/v2\/anime\/5114\/my_list_status$/);
        assert.equal(init.method, "PUT");
        assert.equal(new Headers(init.headers).get("content-type"), "application/x-www-form-urlencoded");
        if (networkDown) throw new Error("Network failure with private details");
        if (unauthorizedOnce) { unauthorizedOnce = false; return new Response(null, { status: 401 }); }
        if (apiStatus !== 200) return new Response(null, { status: apiStatus, headers: { "Retry-After": "20" } });
        return Response.json({ status: init.body.get("status"), num_episodes_watched: mismatch ? 0 : Number(init.body.get("num_watched_episodes")) });
    };
    const mal = new MalClient(fakeFetch);
    const updateCalls = () => calls.filter((call) => call.url.endsWith("/my_list_status"));
    let userId;
    let episode = 0;
    const job = async (id) => (await db.query("SELECT * FROM sync_jobs WHERE id = $1", [id])).rows[0];
    const history = async (id) => (await db.query("SELECT * FROM transactions WHERE sync_job_id = $1", [id])).rows;
    const ready = (id) => db.query("UPDATE sync_jobs SET next_attempt_at = now() WHERE id = $1", [id]);
    let base;
    const createJob = async (owner = userId) => {
        const response = await fetch(`${base}/api/progress`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: Number(owner), malAnimeId: 5114, title: "Test anime", episode: ++episode, watchStatus: "watching" }),
        });
        assert.equal(response.status, 201);
        return (await response.json()).syncJobId;
    };
    try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        await db.query(await readFile(new URL("../db/init.sql", import.meta.url), "utf8"));
        const migration = await readFile(new URL("../db/migrations/002-mal-sync.sql", import.meta.url), "utf8");
        await db.query(migration); await db.query(migration);
        const historyMigration = await readFile(new URL("../db/migrations/003-transaction-history.sql", import.meta.url), "utf8");
        await db.query(historyMigration); await db.query(historyMigration);
        broker = await openRabbitMQ(queue);
        server = createApp(db, mal, fakeFetch).listen(0, "127.0.0.1");
        await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
        base = `http://127.0.0.1:${server.address().port}`;

        await t.test("OAuth identifies the actual MAL account and persists encrypted tokens", async () => {
            const existing = await db.query("INSERT INTO users (mal_user_id) VALUES (1001) RETURNING id");
            const response = await fetch(`${base}/api/auth/mal/callback`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code: "test-code", verifier: "test-verifier",
                    redirectUri: process.env.MAL_REDIRECT_URI ?? "http://localhost:8080/" }),
            });
            assert.equal(response.status, 200);
            const result = await response.json();
            userId = result.userId;
            assert.equal(userId, existing.rows[0].id);
            assert.equal(result.malUserId, 1001);
            assert.equal(result.access_token, undefined);
            const exchange = calls.find((call) => call.url === "https://myanimelist.net/v1/oauth2/token");
            assert.equal(exchange.init.body.get("redirect_uri"), process.env.MAL_REDIRECT_URI ?? "http://localhost:8080/");
            const saved = (await db.query("SELECT * FROM mal_accounts")).rows[0];
            assert.notEqual(saved.access_token, "access-0");
            assert.equal(decryptToken(saved.access_token), "access-0");
            assert.equal(decryptToken(saved.refresh_token), "refresh-0");
            const encrypted = encryptToken("same-value");
            assert.notEqual(encrypted, encryptToken("same-value"));
            assert.throws(() => decryptToken(encrypted.slice(0, -4) + "AAAA"));
        });

        await t.test("progress -> publisher -> RabbitMQ consumer -> MAL -> synced", async () => {
            const id = await createJob();
            await publishNextJob(db, broker.publish);
            consumer = await consumeSyncQueue(db, broker, mal, queue);
            await waitFor(async () => (await job(id)).state === "synced");
            await consumer.stop(); consumer = undefined;
            const saved = await job(id);
            assert.equal(saved.attempts, 1);
            assert.ok(saved.synced_at);
            const entries = await history(id);
            assert.equal(entries.length, 1);
            assert.equal(entries[0].user_id, userId);
            assert.equal(entries[0].mal_anime_id, "5114");
            assert.equal(entries[0].episode, 1);
            assert.equal(entries[0].watch_status, "watching");
            assert.equal(entries[0].progress_version, saved.progress_version);
            assert.equal(entries[0].synced_at.getTime(), saved.synced_at.getTime());
            assert.equal(updateCalls().at(-1).init.body.get("num_watched_episodes"), "1");
            assert.equal(updateCalls().at(-1).init.headers.Authorization, "Bearer access-0");
            const count = updateCalls().length;
            assert.deepEqual(await Promise.all([syncJob(db, id, mal), syncJob(db, id, mal)]), ["synced", "synced"]);
            assert.equal(updateCalls().length, count);
            assert.equal((await history(id)).length, 1);
        });

        await t.test("old progress is superseded without writing to MAL", async () => {
            const old = await createJob();
            const latest = await createJob();
            const count = updateCalls().length;
            assert.equal(await syncJob(db, old, mal), "superseded");
            assert.equal(updateCalls().length, count);
            assert.equal((await job(old)).synced_at, null);
            assert.equal((await history(old)).length, 0);
            assert.equal(await syncJob(db, latest, mal), "synced");
        });

        await t.test("duplicate concurrent deliveries only write to MAL once", async () => {
            const id = await createJob();
            const count = updateCalls().length;
            await Promise.all([syncJob(db, id, mal), syncJob(db, id, mal)]);
            assert.equal(updateCalls().length, count + 1);
            assert.equal((await history(id)).length, 1);
        });

        await t.test("queued local messages cannot undo an authoritative MAL import", async () => {
            const id = await createJob();
            assert.equal(await publishNextJob(db, broker.publish), id);
            const count = updateCalls().length;
            assert.equal((await importMalList(db, userId, mal)).state, "synced");
            assert.equal((await job(id)).state, "superseded");
            consumer = await consumeSyncQueue(db, broker, mal, queue);
            await waitFor(async () => (await broker.channel.checkQueue(queue)).messageCount === 0);
            await consumer.stop(); consumer = undefined;
            assert.equal(updateCalls().length, count);
            assert.equal((await history(id)).length, 0);
            const next = await createJob();
            assert.equal(await syncJob(db, next, mal), "synced");
        });

        await t.test("expired tokens are refreshed and rotated tokens persist", async () => {
            await db.query("UPDATE mal_accounts SET expires_at = now() - interval '1 minute'");
            const id = await createJob();
            const before = refreshes;
            assert.equal(await syncJob(db, id, mal), "synced");
            assert.equal(refreshes, before + 1);
            const saved = (await db.query("SELECT * FROM mal_accounts")).rows[0];
            assert.equal(decryptToken(saved.refresh_token), `refresh-${refreshes}`);
            assert.equal(updateCalls().at(-1).init.headers.Authorization, `Bearer access-${refreshes}`);
        });

        await t.test("a 401 refreshes once and retries the update", async () => {
            unauthorizedOnce = true;
            const id = await createJob();
            const before = refreshes, count = updateCalls().length;
            assert.equal(await syncJob(db, id, mal), "synced");
            assert.equal(refreshes, before + 1);
            assert.equal(updateCalls().length, count + 2);
        });

        await t.test("rate limits schedule a durable retry and honor Retry-After", async () => {
            apiStatus = 429;
            const id = await createJob();
            assert.equal(await syncJob(db, id, mal), "pending");
            const saved = await job(id);
            assert.equal(saved.attempts, 1);
            assert.equal(saved.published_at, null);
            assert.equal((await history(id)).length, 0);
            assert.match(saved.last_error, /429/);
            assert.ok(saved.next_attempt_at.getTime() > Date.now() + 18000);
            assert.equal(await publishNextJob(db, broker.publish), null);
            await db.query("UPDATE sync_jobs SET published_at = now() WHERE id = $1", [id]);
            const count = updateCalls().length;
            assert.equal(await syncJob(db, id, mal), "pending");
            assert.equal(updateCalls().length, count);
            assert.equal((await job(id)).published_at, null);
            apiStatus = 200; await ready(id);
            assert.equal(await syncJob(db, id, mal), "synced");
            assert.equal((await history(id)).length, 1);
        });

        await t.test("network failures are retried without logging private upstream details", async () => {
            networkDown = true;
            const id = await createJob();
            assert.equal(await syncJob(db, id, mal), "pending");
            assert.match((await job(id)).last_error, /timed out or could not connect/);
            networkDown = false; await ready(id);
            assert.equal(await syncJob(db, id, mal), "synced");
        });

        await t.test("permanent failures and exhausted retries become failed", async () => {
            apiStatus = 400;
            const permanent = await createJob();
            assert.equal(await syncJob(db, permanent, mal), "failed");
            assert.equal((await history(permanent)).length, 0);
            apiStatus = 503;
            const exhausted = await createJob();
            await db.query("UPDATE sync_jobs SET attempts = 4 WHERE id = $1", [exhausted]);
            assert.equal(await syncJob(db, exhausted, mal), "failed");
            assert.equal((await job(exhausted)).attempts, 5);
            assert.equal((await history(exhausted)).length, 0);
            apiStatus = 200;
        });

        await t.test("a success response that did not apply progress is not marked synced", async () => {
            mismatch = true;
            const id = await createJob();
            assert.equal(await syncJob(db, id, mal), "failed");
            assert.equal((await job(id)).synced_at, null);
            assert.equal((await history(id)).length, 0);
            mismatch = false;
        });

        await t.test("revoked credentials request reconnection; reconnect preserves user identity", async () => {
            refreshStatus = 400;
            await db.query("UPDATE mal_accounts SET expires_at = now() - interval '1 minute'");
            const id = await createJob();
            assert.equal(await syncJob(db, id, mal), "pending");
            assert.equal((await db.query("SELECT reauth_required FROM mal_accounts")).rows[0].reauth_required, true);
            assert.equal((await job(id)).attempts, 0);
            refreshStatus = 200;
            const connected = await connectMalAccount(db, "new-code", "new-verifier", undefined, fakeFetch);
            assert.equal(connected.userId, userId);
            await ready(id);
            assert.equal(await syncJob(db, id, mal), "superseded");
            const next = await createJob();
            assert.equal(await syncJob(db, next, mal), "synced");
        });

        await t.test("a user without OAuth remains pending with an actionable error", async () => {
            const other = (await db.query("INSERT INTO users (mal_user_id) VALUES (2002) RETURNING id")).rows[0].id;
            const id = await createJob(other);
            assert.equal(await syncJob(db, id, mal), "pending");
            assert.match((await job(id)).last_error, /mal:connect/);
            assert.equal((await job(id)).attempts, 0);
            assert.equal((await history(id)).length, 0);
        });

        await t.test("a history insert failure rolls back sync completion; redelivery records it once", async () => {
            const id = await createJob();
            await db.query(`CREATE FUNCTION reject_test_history() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN RAISE EXCEPTION 'Simulated history insert failure'; END; $$;
                CREATE TRIGGER reject_test_history BEFORE INSERT ON transactions
                FOR EACH ROW EXECUTE FUNCTION reject_test_history();`);
            try {
                await assert.rejects(syncJob(db, id, mal), /Simulated history insert failure/);
                const saved = await job(id);
                assert.equal(saved.state, "pending");
                assert.equal(saved.synced_at, null);
                assert.equal(saved.attempts, 0);
                assert.equal((await history(id)).length, 0);
            } finally {
                await db.query("DROP TRIGGER reject_test_history ON transactions; DROP FUNCTION reject_test_history()");
            }
            assert.equal(await syncJob(db, id, mal), "synced");
            assert.equal((await history(id)).length, 1);
        });

        await t.test("migration backfills previous successes once and preserves their timestamps", async () => {
            const saved = (await db.query("SELECT * FROM sync_jobs WHERE state = 'synced' ORDER BY id LIMIT 1")).rows[0];
            // Simulate a successful job from before transaction history existed.
            await db.query("DELETE FROM transactions WHERE sync_job_id = $1", [saved.id]);
            await db.query(historyMigration); await db.query(historyMigration);
            const entries = await history(saved.id);
            assert.equal(entries.length, 1);
            assert.equal(entries[0].episode, saved.episode);
            assert.equal(entries[0].synced_at.getTime(), saved.synced_at.getTime());
            // All and only synced jobs have a history entry.
            const mismatches = await db.query(`SELECT j.id FROM sync_jobs j
                LEFT JOIN transactions t ON t.sync_job_id = j.id
                WHERE (j.state = 'synced') <> (t.id IS NOT NULL)`);
            assert.equal(mismatches.rowCount, 0);
        });

        await t.test("job status and anime list use the explicitly selected account", async () => {
            const response = await fetch(`${base}/api/sync/jobs?userId=${userId}`);
            assert.equal(response.status, 200);
            assert.ok((await response.json()).jobs.some((j) => j.state === "synced"));
            const list = await fetch(`${base}/api/mal/animelist?userId=${userId}`);
            const listBody = await list.json();
            assert.equal(list.status, 200, JSON.stringify(listBody));
            assert.deepEqual(listBody.data, []);
            assert.equal((await fetch(`${base}/api/mal/animelist`)).status, 400);
            assert.equal((await fetch(`${base}/api/sync/jobs?userId=9223372036854775808`)).status, 400);
        });

        await t.test("malformed queue messages are quarantined", async () => {
            consumer = await consumeSyncQueue(db, broker, mal, queue);
            await new Promise((resolve, reject) => broker.channel.sendToQueue(queue, Buffer.from("broken JSON"), {}, (error) => error ? reject(error) : resolve()));
            await waitFor(async () => (await broker.channel.checkQueue(`${queue}.dead`)).messageCount === 1);
            await consumer.stop(); consumer = undefined;
        });
    } finally {
        await consumer?.stop();
        if (server) await new Promise((resolve) => server.close(resolve));
        if (broker) {
            await broker.channel.deleteQueue(queue).catch(() => {});
            await broker.channel.deleteQueue(`${queue}.dead`).catch(() => {});
            await broker.close();
        }
        await db.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
        if (previousKey === undefined) delete process.env.MAL_TOKEN_KEY; else process.env.MAL_TOKEN_KEY = previousKey;
        if (previousClient === undefined) delete process.env.MAL_CLIENT_ID; else process.env.MAL_CLIENT_ID = previousClient;
    }
});

test("local OAuth helper requires matching browser cookie and state", { timeout: 10000 }, async () => {
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const redirect = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ["dist/connect-mal.js"], {
        env: { ...process.env, MAL_REDIRECT_URI: redirect, MAL_CLIENT_ID: "test-client", MAL_TOKEN_KEY: randomBytes(32).toString("hex") },
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
        await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.stdout.once("data", resolve);
            child.stderr.once("data", () => reject(new Error("OAuth helper failed to start")));
        });
        const start = await fetch(redirect, { redirect: "manual" });
        assert.equal(start.status, 302);
        const target = new URL(start.headers.get("location"));
        assert.equal(target.origin, "https://myanimelist.net");
        assert.equal(target.searchParams.get("redirect_uri"), redirect);
        assert.equal(target.searchParams.get("code_challenge_method"), "plain");
        assert.ok(target.searchParams.get("code_challenge").length >= 43);
        const cookie = start.headers.get("set-cookie");
        assert.match(cookie, /HttpOnly; SameSite=Lax/);
        assert.equal((await fetch(`${redirect}?code=fake&state=wrong`, { headers: { Cookie: cookie.split(";")[0] } })).status, 400);
        assert.equal((await fetch(`${redirect}?code=fake&state=${target.searchParams.get("state")}`)).status, 400);
    } finally {
        child.kill();
        await exited;
    }
});
