import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { createApp } from "../dist/app.js";
import { connectMalAccount, MalClient } from "../dist/mal.js";
import { importMalList } from "../dist/mal-list.js";
import { runListSyncLoop, syncDueLists } from "../dist/list-sync-loop.js";
import { decryptToken } from "../dist/token-crypto.js";
import { syncJob } from "../dist/sync.js";

const entry = (id, episode, status = "watching") => ({
    node: { id, title: `Anime ${id}` },
    list_status: { status, num_episodes_watched: episode, score: 7, updated_at: "2026-11-01T12:00:00+00:00" },
});
const nextPage = "https://api.myanimelist.net/v2/users/@me/animelist?fields=list_status&limit=1000&offset=1000&nsfw=true";

test("MAL list imports (all MAL responses simulated)", { timeout: 30000 }, async (t) => {
    const schema = `list_test_${randomUUID().replaceAll("-", "")}`;
    const savedKey = process.env.MAL_TOKEN_KEY;
    const savedClient = process.env.MAL_CLIENT_ID;
    const savedInterval = process.env.MAL_LIST_SYNC_INTERVAL_SECONDS;
    process.env.MAL_TOKEN_KEY = randomBytes(32).toString("hex");
    process.env.MAL_CLIENT_ID = "test-client";
    process.env.MAL_LIST_SYNC_INTERVAL_SECONDS = "10";
    const config = {
        host: process.env.DB_HOST ?? "127.0.0.1", port: Number(process.env.DB_PORT ?? 5432),
        user: process.env.DB_USER ?? "tracker", password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME ?? "tracker", connectionTimeoutMillis: 5000,
    };
    const admin = new Pool(config);
    const db = new Pool({ ...config, options: `-c search_path=${schema}` });
    let server, base, userId;
    let pages, failPage, failedStatus, onFetch, tokenVersion, listCalls, writes, unauthorizedPage;
    const fakeFetch = async (url, init = {}) => {
        url = String(url);
        if (url === "https://myanimelist.net/v1/oauth2/token") {
            tokenVersion++;
            return Response.json({ access_token: `access-${tokenVersion}`, refresh_token: `refresh-${tokenVersion}`, expires_in: 3600 });
        }
        if (url === "https://api.myanimelist.net/v2/users/@me") return Response.json({ id: 1001 });
        if (url.includes("/animelist")) {
            const parsed = new URL(url);
            assert.equal(parsed.origin, "https://api.myanimelist.net");
            listCalls++;
            const index = parsed.searchParams.has("offset") ? 1 : 0;
            if (index === unauthorizedPage) { unauthorizedPage = -1; return new Response(null, { status: 401 }); }
            if (index === failPage) return new Response(null, { status: failedStatus, headers: { "Retry-After": "120" } });
            const snapshot = structuredClone(pages[index]);
            if (onFetch) { const hook = onFetch; onFetch = undefined; await hook(); }
            return Response.json(snapshot);
        }
        if (url.includes("/my_list_status")) {
            writes++;
            return Response.json({ status: init.body.get("status"), num_episodes_watched: Number(init.body.get("num_watched_episodes")) });
        }
        throw new Error("Unexpected MAL request in test");
    };
    const mal = new MalClient(fakeFetch);
    const connect = async () => {
        const connected = await connectMalAccount(db, "code", "verifier", undefined, fakeFetch);
        userId = connected.userId;
        return connected;
    };
    const progress = async () => (await db.query("SELECT mal_anime_id, episode, watch_status, version FROM progress WHERE user_id = $1 ORDER BY mal_anime_id", [userId])).rows;
    const snapshot = async () => (await db.query("SELECT mal_anime_id, episode, watch_status, list_status FROM mal_list_entries WHERE user_id = $1 ORDER BY mal_anime_id", [userId])).rows;
    const account = async () => (await db.query("SELECT * FROM mal_accounts WHERE user_id = $1", [userId])).rows[0];
    const edit = async (anime, episode) => {
        const response = await fetch(`${base}/api/progress`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: Number(userId), malAnimeId: anime, title: `Anime ${anime}`, episode, watchStatus: "watching" }),
        });
        assert.equal(response.status, 201);
        return (await response.json()).syncJobId;
    };
    const scenario = async (name, run) => t.test(name, async () => {
        await db.query("TRUNCATE transactions, sync_jobs, progress, mal_list_entries, mal_accounts, users, anime RESTART IDENTITY");
        pages = [{ data: [entry(1, 1)], paging: {} }];
        failPage = -1; failedStatus = 503; unauthorizedPage = -1; onFetch = undefined;
        tokenVersion = 0; listCalls = 0; writes = 0;
        await run();
    });

    try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        await db.query(await readFile(new URL("../db/init.sql", import.meta.url), "utf8"));
        const migration = await readFile(new URL("../db/migrations/004-mal-list-import.sql", import.meta.url), "utf8");
        await db.query(migration); await db.query(migration);
        server = createApp(db, mal, fakeFetch).listen(0, "127.0.0.1");
        await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
        base = `http://127.0.0.1:${server.address().port}`;

        await scenario("login imports every page, keeps list metadata, and does not enqueue outbound updates", async () => {
            pages = [{ data: [entry(1, 3)], paging: { next: nextPage } }, { data: [entry(2, 12, "completed")], paging: {} }];
            const connected = await connect();
            assert.equal(connected.listSync.state, "synced");
            assert.equal(connected.listSync.imported, 2);
            assert.equal(listCalls, 2);
            assert.deepEqual((await progress()).map((p) => [p.mal_anime_id, p.episode, p.watch_status]), [["1", 3, "watching"], ["2", 12, "completed"]]);
            assert.equal((await snapshot())[0].list_status.score, 7);
            assert.ok((await account()).list_synced_at);
            assert.equal((await db.query("SELECT count(*) FROM sync_jobs")).rows[0].count, "0");
            assert.equal((await db.query("SELECT count(*) FROM transactions")).rows[0].count, "0");
            assert.equal(writes, 0);
            await importMalList(db, userId, mal);
            assert.ok((await progress()).every((p) => p.version === 1));
        });

        await scenario("MAL edits replace clean local values, including episode decreases", async () => {
            pages = [{ data: [entry(1, 8)], paging: {} }]; await connect();
            pages = [{ data: [entry(1, 3, "on_hold")], paging: {} }];
            assert.equal((await importMalList(db, userId, mal)).state, "synced");
            assert.deepEqual((await progress()).map((p) => [p.episode, p.watch_status, p.version]), [[3, "on_hold", 2]]);
        });

        await scenario("MAL overwrites pending and failed local edits and supersedes their jobs", async () => {
            await connect();
            const jobId = await edit(1, 9);
            pages = [{ data: [entry(1, 2)], paging: {} }];
            await importMalList(db, userId, mal);
            assert.equal((await progress())[0].episode, 2);
            assert.equal((await snapshot())[0].episode, 2);
            assert.equal((await db.query("SELECT state FROM sync_jobs WHERE id = $1", [jobId])).rows[0].state, "superseded");
            const failed = await edit(1, 9);
            await db.query("UPDATE sync_jobs SET state = 'failed' WHERE id = $1", [failed]);
            pages = [{ data: [entry(1, 3)], paging: {} }];
            await importMalList(db, userId, mal);
            assert.equal((await progress())[0].episode, 3);
            assert.equal((await snapshot())[0].episode, 3);
            assert.equal((await db.query("SELECT state FROM sync_jobs WHERE id = $1", [failed])).rows[0].state, "superseded");
            assert.equal(await syncJob(db, jobId, mal), "superseded");
            assert.equal(await syncJob(db, failed, mal), "superseded");
            assert.equal(writes, 0);
        });

        await scenario("matching MAL values still supersede queued jobs and allow later local updates", async () => {
            await connect();
            const id = await edit(1, 2);
            pages = [{ data: [entry(1, 2)], paging: {} }];
            await importMalList(db, userId, mal);
            assert.equal(await syncJob(db, id, mal), "superseded");
            assert.equal(writes, 0);
            const later = await edit(1, 3);
            assert.equal(await syncJob(db, later, mal), "synced");
            assert.equal(writes, 1);
        });

        await scenario("an empty MAL list clears all local entries, including unsent changes", async () => {
            pages = [{ data: [entry(1, 1), entry(2, 1), entry(3, 1)], paging: {} }]; await connect();
            await edit(2, 2);
            const failed = await edit(3, 3);
            await db.query("UPDATE sync_jobs SET state = 'failed' WHERE id = $1", [failed]);
            pages = [{ data: [], paging: {} }];
            await importMalList(db, userId, mal);
            assert.deepEqual(await snapshot(), []);
            assert.deepEqual(await progress(), []);
            assert.ok((await db.query("SELECT state FROM sync_jobs")).rows.every((j) => j.state === "superseded"));
        });

        await scenario("a later-page failure leaves the last complete snapshot untouched", async () => {
            await connect();
            const pending = await edit(1, 9);
            const before = await snapshot();
            const syncedAt = (await account()).list_synced_at.getTime();
            pages = [{ data: [entry(1, 5)], paging: { next: nextPage } }, { data: [entry(2, 2)], paging: {} }];
            failPage = 1;
            const result = await importMalList(db, userId, mal);
            assert.equal(result.state, "pending");
            assert.deepEqual(await snapshot(), before);
            assert.equal((await progress())[0].episode, 9);
            assert.equal((await db.query("SELECT state FROM sync_jobs WHERE id = $1", [pending])).rows[0].state, "pending");
            const saved = await account();
            assert.equal(saved.list_synced_at.getTime(), syncedAt);
            assert.match(saved.list_sync_error, /503/);
            assert.ok(saved.list_sync_next_attempt_at.getTime() > Date.now() + 110000);
        });

        await scenario("a local edit after a remote removal does not reuse historical job versions", async () => {
            await connect();
            const first = await edit(1, 2);
            assert.equal(await syncJob(db, first, mal), "synced");
            const firstVersion = (await progress())[0].version;
            pages = [{ data: [], paging: {} }];
            await importMalList(db, userId, mal);
            assert.deepEqual(await progress(), []);
            const second = await edit(1, 3);
            assert.ok((await progress())[0].version > firstVersion);
            assert.equal(await syncJob(db, second, mal), "synced");
            assert.equal((await db.query("SELECT count(*) FROM transactions")).rows[0].count, "2");
        });

        await scenario("reimporting a removed anime preserves version uniqueness for later local edits", async () => {
            await connect();
            const first = await edit(1, 2);
            assert.equal(await syncJob(db, first, mal), "synced");
            const firstVersion = (await progress())[0].version;
            pages = [{ data: [], paging: {} }]; await importMalList(db, userId, mal);
            pages = [{ data: [entry(1, 0, "plan_to_watch")], paging: {} }];
            await importMalList(db, userId, mal);
            assert.ok((await progress())[0].version > firstVersion);
            const second = await edit(1, 3);
            assert.equal(await syncJob(db, second, mal), "synced");
        });

        await scenario("a failed initial download preserves login and can be retried", async () => {
            failPage = 0;
            const connected = await connect();
            assert.equal(connected.listSync.state, "pending");
            assert.equal(decryptToken((await account()).access_token), "access-1");
            assert.equal((await account()).list_synced_at, null);
            failPage = -1;
            await db.query("UPDATE mal_accounts SET list_sync_next_attempt_at = now()");
            await syncDueLists(db, mal);
            assert.equal((await progress())[0].episode, 1);
        });

        await scenario("unsafe pagination and invalid entries never replace saved rows", async () => {
            await connect();
            const before = await snapshot();
            pages = [{ data: [entry(1, 2)], paging: { next: "https://example.com/steal-token" } }];
            assert.equal((await importMalList(db, userId, mal)).state, "pending");
            assert.deepEqual(await snapshot(), before);
            pages = [{ data: [entry(1, -1)], paging: {} }];
            assert.equal((await importMalList(db, userId, mal)).state, "pending");
            assert.deepEqual(await snapshot(), before);
        });

        await scenario("token refresh requests a new import without waiting for the periodic interval", async () => {
            await connect();
            const generation = BigInt((await account()).list_sync_generation);
            await db.query("UPDATE mal_accounts SET expires_at = now() - interval '1 minute'");
            const client = await db.connect();
            try {
                await client.query("BEGIN"); await mal.request(client, userId, "/v2/users/@me"); await client.query("COMMIT");
            } finally { client.release(); }
            assert.equal(BigInt((await account()).list_sync_generation), generation + 1n);
            pages = [{ data: [entry(1, 6)], paging: {} }];
            await syncDueLists(db, mal);
            assert.equal((await progress())[0].episode, 6);
            assert.equal(decryptToken((await account()).refresh_token), "refresh-2");
            const before = listCalls;
            await syncDueLists(db, mal);
            assert.equal(listCalls, before);
        });

        await scenario("a refresh during pagination is saved without creating an immediate import loop", async () => {
            await connect();
            pages = [{ data: [entry(1, 2)], paging: { next: nextPage } }, { data: [entry(2, 2)], paging: {} }];
            unauthorizedPage = 1;
            assert.equal((await importMalList(db, userId, mal)).state, "synced");
            assert.equal(decryptToken((await account()).refresh_token), "refresh-2");
            const nextImport = (await account()).list_sync_next_attempt_at.getTime();
            assert.ok(nextImport > Date.now() + 8000);
            assert.ok(nextImport <= Date.now() + 10000);
        });

        await scenario("rotated tokens survive a list download failure", async () => {
            await connect();
            await db.query("UPDATE mal_accounts SET expires_at = now() - interval '1 minute'");
            failPage = 0;
            assert.equal((await importMalList(db, userId, mal)).state, "pending");
            assert.equal(decryptToken((await account()).refresh_token), "refresh-2");
            assert.equal((await snapshot())[0].episode, 1);
        });

        await scenario("MAL also overwrites edits and removes local-only rows created during a download", async () => {
            await connect();
            pages = [{ data: [entry(1, 2), entry(2, 2)], paging: {} }];
            onFetch = async () => { await edit(1, 12); await edit(2, 7); await edit(3, 8); };
            await importMalList(db, userId, mal);
            assert.deepEqual((await progress()).map((p) => [p.mal_anime_id, p.episode]), [["1", 2], ["2", 2]]);
            assert.deepEqual((await snapshot()).map((p) => p.episode), [2, 2]);
            assert.ok((await db.query("SELECT state FROM sync_jobs")).rows.every((j) => j.state === "superseded"));
        });

        await scenario("the retrieved MAL snapshot wins over a local job completed before the import commits", async () => {
            await connect();
            const id = await edit(1, 10);
            pages = [{ data: [entry(1, 1)], paging: {} }];
            let completed = false;
            const wrappedPool = { connect: async () => {
                const client = await db.connect();
                return {
                    query: async (...args) => {
                        const result = await client.query(...args);
                        if (args[0] === "COMMIT" && !completed) {
                            completed = true;
                            assert.equal(await syncJob(db, id, mal), "synced");
                        }
                        return result;
                    },
                    release: (...args) => client.release(...args),
                };
            } };
            await importMalList(wrappedPool, userId, mal);
            assert.equal((await progress())[0].episode, 1);
            assert.equal((await snapshot())[0].episode, 1);
            assert.equal((await db.query("SELECT episode FROM transactions WHERE sync_job_id = $1", [id])).rows[0].episode, 10);
        });

        await scenario("simultaneous imports use one per-account lease", async () => {
            await connect();
            let release, entered;
            const blocked = new Promise((resolve) => { release = resolve; });
            const started = new Promise((resolve) => { entered = resolve; });
            onFetch = async () => { entered(); await blocked; };
            const first = importMalList(db, userId, mal);
            await started;
            try {
                const second = await importMalList(db, userId, mal);
                assert.equal(second.state, "pending");
                assert.match(second.error, /already running/);
            } finally { release(); }
            assert.equal((await first).state, "synced");
        });

        await scenario("an apply failure rolls back the entire snapshot", async () => {
            await connect();
            const pending = await edit(1, 9);
            const before = await snapshot();
            await db.query(`CREATE FUNCTION reject_import() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN RAISE EXCEPTION 'Simulated apply failure'; END; $$;
                CREATE TRIGGER reject_import BEFORE INSERT OR UPDATE ON progress
                FOR EACH ROW EXECUTE FUNCTION reject_import();`);
            try {
                pages = [{ data: [entry(1, 4), entry(2, 2)], paging: {} }];
                assert.equal((await importMalList(db, userId, mal)).state, "pending");
                assert.deepEqual(await snapshot(), before);
                assert.equal((await progress())[0].episode, 9);
                assert.equal((await db.query("SELECT state FROM sync_jobs WHERE id = $1", [pending])).rows[0].state, "pending");
            } finally { await db.query("DROP TRIGGER reject_import ON progress; DROP FUNCTION reject_import()"); }
            assert.equal((await importMalList(db, userId, mal)).state, "synced");
            assert.equal((await progress())[0].episode, 4);
            assert.equal((await db.query("SELECT state FROM sync_jobs WHERE id = $1", [pending])).rows[0].state, "superseded");
        });

        await scenario("an authoritative import affects only the selected user", async () => {
            await connect();
            const owner = userId;
            const other = (await db.query("INSERT INTO users (mal_user_id) VALUES (2002) RETURNING id")).rows[0].id;
            userId = other;
            const pending = await edit(2, 9);
            userId = owner;
            pages = [{ data: [], paging: {} }];
            await importMalList(db, owner, mal);
            assert.deepEqual(await progress(), []);
            assert.equal((await db.query("SELECT episode FROM progress WHERE user_id = $1", [other])).rows[0].episode, 9);
            assert.equal((await db.query("SELECT state FROM sync_jobs WHERE id = $1", [pending])).rows[0].state, "pending");
        });

        await scenario("the periodic scheduler refreshes due accounts even with unexpired tokens", async () => {
            await connect();
            const before = listCalls;
            await syncDueLists(db, mal); assert.equal(listCalls, before);
            pages = [{ data: [entry(1, 5)], paging: {} }];
            await db.query("UPDATE mal_accounts SET list_sync_next_attempt_at = now() - interval '1 minute'");
            await syncDueLists(db, mal);
            assert.equal(listCalls, before + 1);
            assert.equal((await progress())[0].episode, 5);
            assert.equal(tokenVersion, 1);
        });

        await scenario("the worker loop applies manual MAL changes to progress without an API request or outbound write", async () => {
            pages = [{ data: [entry(1, 8), entry(2, 3)], paging: {} }];
            await connect();
            const pending = await edit(1, 9);
            const failed = await edit(2, 7);
            await db.query("UPDATE sync_jobs SET state = 'failed' WHERE id = $1", [failed]);

            // Simulate changing episode/status on MAL, deleting anime 2, and
            // adding a completed anime. An old 15-minute schedule must not
            // delay the restarted worker's new 10-second import interval.
            pages = [{ data: [entry(1, 3, "on_hold"), entry(3, 12, "completed")], paging: {} }];
            await db.query(`UPDATE mal_accounts SET list_synced_at = now() - interval '1 minute',
                list_sync_next_attempt_at = now() + interval '15 minutes'`);
            const shutdown = new AbortController();
            const worker = runListSyncLoop(db, shutdown.signal, mal);
            try {
                const deadline = Date.now() + 5000;
                while (true) {
                    const current = await progress();
                    if (current.length === 2 && current[0].episode === 3 && current[1].mal_anime_id === "3") break;
                    if (Date.now() > deadline) throw new Error("Worker did not apply manual MAL changes to progress");
                    await delay(20);
                }
                assert.deepEqual((await progress()).map((p) => [p.mal_anime_id, p.episode, p.watch_status]),
                    [["1", 3, "on_hold"], ["3", 12, "completed"]]);
                assert.deepEqual((await snapshot()).map((p) => [p.mal_anime_id, p.episode, p.watch_status]),
                    [["1", 3, "on_hold"], ["3", 12, "completed"]]);
                assert.ok((await db.query("SELECT state FROM sync_jobs WHERE id = ANY($1::bigint[])", [[pending, failed]])).rows
                    .every((j) => j.state === "superseded"));
                assert.equal((await db.query("SELECT count(*) FROM sync_jobs")).rows[0].count, "2");
                assert.equal((await db.query("SELECT count(*) FROM transactions")).rows[0].count, "0");
                assert.equal(writes, 0);
                assert.equal((await account()).list_sync_error, null);
            } finally {
                shutdown.abort();
                await worker;
            }
        });

        await scenario("local reads make no MAL calls and manual refresh imports new values", async () => {
            await connect();
            const before = listCalls;
            const local = await fetch(`${base}/api/mal/animelist/local?userId=${userId}`);
            assert.equal(local.status, 200);
            assert.equal((await local.json()).data[0].list_status.num_episodes_watched, 1);
            assert.equal(listCalls, before);
            pages = [{ data: [entry(1, 7)], paging: {} }];
            const refreshed = await fetch(`${base}/api/mal/animelist/sync`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId }),
            });
            assert.equal(refreshed.status, 200);
            assert.equal((await progress())[0].episode, 7);
        });
    } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
        await db.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
        for (const [key, value] of [["MAL_TOKEN_KEY", savedKey], ["MAL_CLIENT_ID", savedClient], ["MAL_LIST_SYNC_INTERVAL_SECONDS", savedInterval]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
});
