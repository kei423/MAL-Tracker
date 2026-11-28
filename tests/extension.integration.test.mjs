import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { Pool } from "pg";
import { createApp } from "../dist/app.js";
import { connectMalAccount, MalClient } from "../dist/mal.js";
import { importMalList } from "../dist/mal-list.js";
import { openRabbitMQ } from "../dist/rabbitmq.js";
import { publishNextJob } from "../dist/outbox.js";
import { consumeSyncQueue } from "../dist/consumer.js";
import { API_BASE, TrackerBridge, parseEpisode, isSupportedUrl, exactAnimeMatches } from "../extension/tracker.js";

const sourceUrl = "https://anikototv.bz/watch/streaming-show/ep-1";
const contentSource = await readFile(new URL("../content.js", import.meta.url), "utf8");
const until = async (check) => {
  const deadline = Date.now() + 5000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Timed out waiting for extension sync"); await delay(20); }
};

class MemoryStorage {
  data = {};
  async get(keys) {
    const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(this.data);
    return structuredClone(Object.fromEntries(list.filter((key) => this.data[key] !== undefined).map((key) => [key, this.data[key]])));
  }
  async set(values) { Object.assign(this.data, structuredClone(values)); }
}

function contentHarness(sendMessage = async () => {}, url = sourceUrl, malLinks = []) {
  const messages = [], pending = [], mutations = [], events = {};
  const playerEvents = {};
  const frameWindow = {};
  const video = { currentTime: 0, duration: 1000, networkState: 2, error: null,
    addEventListener: (name, callback) => { (playerEvents[name] ??= []).push(callback); } };
  const document = {
    documentElement: {}, videos: [video],
    querySelector: (selector) => selector.includes("h1") ? { textContent: "Streaming Show" }
      : selector.includes(".ep-item") ? { getAttribute: () => "1", textContent: "1" } : null,
    querySelectorAll: (selector) => selector === "video" ? document.videos : selector === "iframe" ? [{ contentWindow: frameWindow }]
      : selector.startsWith("a[href") ? malLinks.map((href) => ({ href })) : [],
  };
  const window = { addEventListener: (name, callback) => { events[name] = callback; } };
  window.self = window; window.top = window;
  const context = { window, document, location: new URL(url),
    chrome: { runtime: { id: "test-extension", sendMessage: (message) => {
      messages.push(message); const task = Promise.resolve(sendMessage(message)); pending.push(task); return task;
    } } },
    MutationObserver: class { constructor(callback) { mutations.push(callback); } observe() {} },
    URL, WeakSet, Date, Number, Boolean, console,
  };
  runInNewContext(contentSource, context);
  return { messages, video, playerEvents, events, frameWindow, document, mutations,
    drain: async () => { await Promise.all(pending); },
    rerun: () => runInNewContext(contentSource, context),
  };
}

test("content capture handles inline video, child frames, duplicates, and unrelated pages", async () => {
  const page = contentHarness();
  page.rerun();
  assert.equal(page.playerEvents.timeupdate.length, 1);
  page.mutations[0]();
  assert.equal(page.playerEvents.timeupdate.length, 1);
  page.video.currentTime = 900;
  page.playerEvents.timeupdate[0]();
  assert.equal(page.messages.at(-1).media.currentTime, 900);
  assert.equal(page.messages.at(-1).media.episode, "Episode 1");
  const count = page.messages.length;
  page.events.message({ source: {}, data: { type: "ANIME_PROGRESS_UPDATE", currentTime: 1000, duration: 1000 } });
  assert.equal(page.messages.length, count);
  assert.equal(contentHarness(undefined, "https://example.com/").messages.length, 0);
  assert.equal(parseEpisode("Episode 12"), 12);
  assert.equal(parseEpisode("Episode 12.5"), null);
  assert.equal(parseEpisode("Unknown Episode"), null);
  assert.equal(isSupportedUrl("https://anikototv.bz.evil.example/watch"), false);
  assert.equal(contentHarness(undefined, sourceUrl, ["https://myanimelist.net/anime/5114/Test_Show"]).messages[0].media.malAnimeId, 5114);
  assert.equal(contentHarness(undefined, sourceUrl, ["https://myanimelist.net/anime/1", "https://myanimelist.net/anime/2"]).messages[0].media.malAnimeId, null);
  assert.equal(contentHarness(undefined, sourceUrl, ["https://evil.example/?url=myanimelist.net/anime/5114"]).messages[0].media.malAnimeId, null);
  assert.equal(exactAnimeMatches("Show: Season 2 (Dub)", [{ id: 1, title: "Show Season 1" }, { id: 2, title: "Show Season 2" }])[0].id, 2);
});

test("extension -> Tracker API -> RabbitMQ -> MAL (simulated MAL only)", { timeout: 30000 }, async (t) => {
  const schema = `extension_test_${randomUUID().replaceAll("-", "")}`;
  const queue = `mal.sync.extension.test.${randomUUID()}`;
  const savedKey = process.env.MAL_TOKEN_KEY, savedClient = process.env.MAL_CLIENT_ID;
  const originalChrome = globalThis.chrome, originalFetch = globalThis.fetch;
  process.env.MAL_TOKEN_KEY = randomBytes(32).toString("hex"); process.env.MAL_CLIENT_ID = "test-client";
  const config = { host: process.env.DB_HOST ?? "127.0.0.1", port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? "tracker", password: process.env.DB_PASSWORD, database: process.env.DB_NAME ?? "tracker", connectionTimeoutMillis: 5000 };
  const admin = new Pool(config), db = new Pool({ ...config, options: `-c search_path=${schema}` });
  const storage = new MemoryStorage();
  const listeners = {}, alarms = new Map();
  const event = (name) => ({ addListener: (callback) => { (listeners[name] ??= []).push(callback); } });
  const fakeChrome = {
    storage: { local: storage },
    runtime: { id: "test-extension", getURL: (path) => `chrome-extension://test-extension/${path}`,
      onMessage: event("message"), onInstalled: event("install"), onStartup: event("startup") },
    alarms: { get: async (name) => alarms.get(name), create: async (name, value) => { alarms.set(name, value); }, onAlarm: event("alarm") },
  };
  let server, broker, consumer, base, apiOffline = false, brokerAvailable = true, apiRequests = 0, malWrites = 0, userId;
  let malEpisode = 0, searchNodes = [], malSearches = 0;
  const anime = { id: 5114, title: "Test Show Season 1", num_episodes: 12 };
  const fakeMalFetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/v1/oauth2/token") return Response.json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600 });
    if (path === "/v2/users/@me") return Response.json({ id: 1001 });
    if (path === "/v2/users/@me/animelist") return Response.json({ data: [{ node: anime, list_status: { status: "watching", num_episodes_watched: malEpisode } }], paging: {} });
    if (path === "/v2/anime") { malSearches++; return Response.json({ data: searchNodes.map((node) => ({ node })) }); }
    if (path === "/v2/anime/5114") return Response.json(anime);
    if (path === "/v2/anime/999") return Response.json({ ...anime, id: 999, title: "Other Season" });
    if (path === "/v2/anime/5114/my_list_status") {
      assert.equal(init.method, "PUT");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer private-access");
      malWrites++; malEpisode = Number(init.body.get("num_watched_episodes"));
      return Response.json({ status: init.body.get("status"), num_episodes_watched: malEpisode });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  const mal = new MalClient(fakeMalFetch);
  function apiFetch(url, init) {
    assert.equal(this, globalThis, "Chrome native fetch must be called with the worker global as receiver");
    apiRequests++;
    if (apiOffline) return Promise.reject(new Error("API is offline"));
    return originalFetch(String(url).replace(API_BASE, base), init);
  }
  const popupSender = { id: "test-extension", url: fakeChrome.runtime.getURL("popup.html") };
  const videoSender = { id: "test-extension", frameId: 0, tab: { id: 1 }, url: sourceUrl };
  const send = (message, sender = popupSender) => new Promise((resolve) => {
    const accepted = listeners.message[0](message, sender, resolve);
    if (accepted !== true) resolve({ ignored: true });
  });
  const popup = async (type, body = {}) => {
    const result = await send({ type, ...body });
    if (!result.ok) throw new Error(result.error);
    return result.data;
  };
  const observe = (episode = "Episode 1", currentTime = 900, flags = {}) =>
    send({ type: "TRACKER_MEDIA_UPDATE", media: { title: "Streaming Show", episode, currentTime, duration: 1000, ...flags } }, videoSender);
  const authorize = async () => {
    await popup("TRACKER_INITIALIZE");
    await popup("TRACKER_PERMISSION", { userId, malUserId: "1001", allowed: true });
  };
  const setup = async () => {
    await authorize();
    await observe("Episode 1", 100);
    assert.equal((await popup("TRACKER_SEARCH", { query: "Streaming Show" }))[0].id, 5114);
    await popup("TRACKER_BIND", { sourceTitle: "Streaming Show", animeId: 5114 });
  };
  const countJobs = async () => Number((await db.query("SELECT count(*) FROM sync_jobs")).rows[0].count);
  const scenario = async (name, run) => t.test(name, async () => {
    await consumer?.stop(); consumer = undefined;
    await broker.channel.purgeQueue(queue);
    await db.query("TRUNCATE transactions, sync_jobs, progress, mal_list_entries, mal_accounts, users, anime RESTART IDENTITY");
    storage.data = {}; apiOffline = false; brokerAvailable = true; apiRequests = 0; malWrites = 0; malEpisode = 0;
    searchNodes = [anime]; malSearches = 0;
    userId = (await connectMalAccount(db, "code", "verifier", undefined, fakeMalFetch)).userId;
    await run();
  });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await db.query(await readFile(new URL("../db/init.sql", import.meta.url), "utf8"));
    broker = await openRabbitMQ(queue);
    await broker.channel.assertQueue(`${queue}.dead`, { durable: true });
    server = createApp(db, mal, fakeMalFetch, { publishJob: async (id) => brokerAvailable && Boolean(await publishNextJob(db, broker.publish, id)) }).listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    base = `http://127.0.0.1:${server.address().port}`;
    globalThis.chrome = fakeChrome; globalThis.fetch = apiFetch;
    await import(`../background.js?test=${randomUUID()}`);

    await scenario("a captured 90% episode reaches MAL and history exactly once", async () => {
      const page = contentHarness((message) => send(message, videoSender));
      await page.drain();
      await authorize();
      await popup("TRACKER_BIND", { sourceTitle: "Streaming Show", animeId: 5114 });
      page.video.currentTime = 900; page.playerEvents.timeupdate[0](); await page.drain();
      assert.equal(await countJobs(), 1);
      assert.equal(storage.data.trackerSyncStatus.phase, "pending");
      assert.equal((await broker.channel.checkQueue(queue)).messageCount, 1);
      consumer = await consumeSyncQueue(db, broker, mal, queue);
      await until(async () => (await db.query("SELECT state FROM sync_jobs")).rows[0].state === "synced");
      const state = await popup("TRACKER_STATUS");
      assert.equal(state.trackerSyncStatus.phase, "synced");
      assert.equal(malWrites, 1);
      assert.equal((await db.query("SELECT episode, watch_status FROM progress")).rows[0].watch_status, "watching");
      assert.equal((await db.query("SELECT count(*) FROM transactions")).rows[0].count, "1");
      await observe(); await observe();
      assert.equal(await countJobs(), 1);
      assert.equal(malWrites, 1);
    });

    await scenario("the final episode marks progress, MAL, and history completed at 90% exactly once", async () => {
      await authorize();
      await observe("Episode 12", 899, { malAnimeId: 5114 });
      assert.equal(await countJobs(), 0);
      await observe("Episode 12", 900, { malAnimeId: 5114 });
      assert.deepEqual((await db.query("SELECT episode, watch_status FROM sync_jobs")).rows, [
        { episode: 12, watch_status: "completed" },
      ]);
      consumer = await consumeSyncQueue(db, broker, mal, queue);
      await until(async () => (await db.query("SELECT state FROM sync_jobs")).rows[0].state === "synced");
      assert.equal((await popup("TRACKER_STATUS")).trackerSyncStatus.phase, "synced");
      assert.equal((await db.query("SELECT watch_status FROM progress")).rows[0].watch_status, "completed");
      assert.deepEqual((await db.query("SELECT episode, watch_status FROM transactions")).rows, [
        { episode: 12, watch_status: "completed" },
      ]);
      assert.equal(malEpisode, 12);
      assert.equal(malWrites, 1);
      await observe("Episode 12", 900, { malAnimeId: 5114 });
      await observe("Episode 12", 1000, { malAnimeId: 5114 });
      assert.equal(await countJobs(), 1);
      assert.equal(malWrites, 1);
    });

    await scenario("the penultimate episode keeps the anime watching", async () => {
      await authorize();
      await observe("Episode 11", 900, { malAnimeId: 5114 });
      assert.deepEqual((await db.query("SELECT episode, watch_status FROM sync_jobs")).rows, [
        { episode: 11, watch_status: "watching" },
      ]);
    });

    await scenario("unknown episode counts stay watching and can later upgrade the same episode to completed", async () => {
      searchNodes = [{ ...anime, num_episodes: 0, alternative_titles: { en: "Streaming Show" } }];
      await authorize(); await observe("Episode 12");
      assert.equal(storage.data.trackerMappings["1001:streaming show"].numEpisodes, 0);
      assert.equal((await db.query("SELECT watch_status FROM sync_jobs")).rows[0].watch_status, "watching");
      consumer = await consumeSyncQueue(db, broker, mal, queue);
      await until(async () => (await db.query("SELECT state FROM sync_jobs")).rows[0].state === "synced");

      searchNodes = [{ ...anime, alternative_titles: { en: "Streaming Show" } }];
      await popup("TRACKER_RETRY");
      await until(async () => (await db.query("SELECT count(*) FROM sync_jobs WHERE state = 'synced'")).rows[0].count === "2");
      assert.deepEqual((await db.query("SELECT episode, watch_status FROM transactions ORDER BY id")).rows, [
        { episode: 12, watch_status: "watching" },
        { episode: 12, watch_status: "completed" },
      ]);
      assert.equal((await db.query("SELECT watch_status FROM progress")).rows[0].watch_status, "completed");
      await observe("Episode 12"); await observe("Episode 12");
      assert.equal(await countJobs(), 2);
      assert.equal(malWrites, 2);
    });

    await scenario("completion replaces an unsent watching update after the episode count becomes known", async () => {
      searchNodes = [{ ...anime, num_episodes: 0, alternative_titles: { en: "Streaming Show" } }];
      await authorize(); await observe("Episode 12", 100);
      apiOffline = true; await observe("Episode 12");
      assert.equal(Object.values(storage.data.trackerOutbox)[0].watchStatus, "watching");
      assert.equal(await countJobs(), 0);

      apiOffline = false;
      searchNodes = [{ ...anime, alternative_titles: { en: "Streaming Show" } }];
      await storage.set({ trackerRetryAt: 0 });
      await popup("TRACKER_RETRY");
      assert.equal(Object.keys(storage.data.trackerOutbox).length, 0);
      assert.deepEqual((await db.query("SELECT episode, watch_status FROM sync_jobs")).rows, [
        { episode: 12, watch_status: "completed" },
      ]);
    });

    await scenario("a known single-episode anime is completed after watching its only episode", async () => {
      searchNodes = [{ ...anime, num_episodes: 1, alternative_titles: { en: "Streaming Show" } }];
      await authorize(); await observe();
      assert.deepEqual((await db.query("SELECT episode, watch_status FROM sync_jobs")).rows, [
        { episode: 1, watch_status: "completed" },
      ]);
    });

    await scenario("the page's MAL ID automatically identifies and submits an episode without manual selection", async () => {
      await authorize();
      const page = contentHarness((message) => send(message, videoSender), sourceUrl, ["https://myanimelist.net/anime/5114/Test_Show"]);
      await page.drain();
      assert.equal(storage.data.trackerMappings["1001:streaming show"].source, "automatic");
      assert.equal(storage.data.trackerMappings["1001:streaming show"].matchMethod, "page");
      assert.equal(malSearches, 0);
      page.video.currentTime = 900; page.playerEvents.timeupdate[0](); await page.drain();
      assert.equal(await countJobs(), 1);
      consumer = await consumeSyncQueue(db, broker, mal, queue);
      await until(async () => (await db.query("SELECT state FROM sync_jobs")).rows[0].state === "synced");
      assert.equal(malWrites, 1);
    });

    await scenario("a later page MAL ID corrects a cached automatic title match", async () => {
      searchNodes = [{ ...anime, alternative_titles: { en: "Streaming Show" } }];
      await authorize(); await observe("Episode 1", 100);
      assert.equal(storage.data.trackerMappings["1001:streaming show"].malAnimeId, 5114);
      await observe("Episode 1", 100, { malAnimeId: 999 });
      assert.equal(storage.data.trackerMappings["1001:streaming show"].malAnimeId, 999);
      await observe("Episode 1", 900, { malAnimeId: 999 });
      assert.equal((await db.query("SELECT mal_anime_id FROM sync_jobs")).rows[0].mal_anime_id, "999");
    });

    await scenario("explicit manual corrections take priority over conflicting page hints", async () => {
      await setup();
      await observe("Episode 1", 900, { malAnimeId: 999 });
      assert.equal(storage.data.trackerMappings["1001:streaming show"].source, "manual");
      assert.equal((await db.query("SELECT mal_anime_id FROM sync_jobs")).rows[0].mal_anime_id, "5114");
    });

    await scenario("an exact alternate title is detected automatically and cached across episodes", async () => {
      searchNodes = [{ ...anime, alternative_titles: { en: "Streaming Show", synonyms: ["Other Name"] } }];
      await authorize(); await observe("Episode 1", 100);
      assert.equal(storage.data.trackerMappings["1001:streaming show"].malAnimeId, 5114);
      assert.equal(storage.data.trackerMappings["1001:streaming show"].matchMethod, "title");
      assert.equal(malSearches, 1);
      await observe(); await observe("Episode 2");
      assert.equal(malSearches, 1);
      assert.equal(await countJobs(), 2);
      assert.equal((await db.query("SELECT title FROM anime WHERE mal_anime_id = 5114")).rows[0].title, anime.title);
    });

    await scenario("matching starts after consent when playback was already detected", async () => {
      searchNodes = [{ ...anime, alternative_titles: { en: "Streaming Show" } }];
      await popup("TRACKER_INITIALIZE"); await observe();
      assert.equal(malSearches, 0);
      assert.equal(await countJobs(), 0);
      await popup("TRACKER_PERMISSION", { userId, malUserId: "1001", allowed: true });
      assert.equal(malSearches, 1);
      assert.equal(await countJobs(), 1);
    });

    await scenario("ambiguous aliases never select the first season or hammer MAL search", async () => {
      searchNodes = [{ ...anime, alternative_titles: { synonyms: ["Streaming Show"] } },
        { ...anime, id: 999, title: "Other Season", alternative_titles: { synonyms: ["Streaming Show"] } }];
      await authorize(); await observe(); await observe();
      assert.equal(await countJobs(), 0);
      assert.equal(malSearches, 1);
      assert.equal(storage.data.trackerSyncStatus.phase, "needs_mapping");
      assert.match(storage.data.trackerSyncStatus.message, /Multiple MAL entries/);
      await popup("TRACKER_BIND", { sourceTitle: "Streaming Show", animeId: 5114 });
      assert.equal(await countJobs(), 1);
      assert.equal(storage.data.trackerMappings["1001:streaming show"].source, "manual");
    });

    await scenario("an earlier unmatched title can resolve when a page MAL link becomes available", async () => {
      await authorize(); await observe("Episode 1", 100);
      assert.equal(storage.data.trackerSyncStatus.phase, "needs_mapping");
      await observe("Episode 1", 900, { malAnimeId: 5114 });
      assert.equal(storage.data.trackerMappings["1001:streaming show"].matchMethod, "page");
      assert.equal(await countJobs(), 1);
    });

    await scenario("a failed automatic lookup retries after API recovery without a manual anime choice", async () => {
      searchNodes = [{ ...anime, alternative_titles: { en: "Streaming Show" } }];
      await authorize(); apiOffline = true; await observe();
      assert.equal(await countJobs(), 0);
      assert.equal(storage.data.trackerSyncStatus.phase, "detection_retry");
      const count = apiRequests; await observe(); assert.equal(apiRequests, count);
      apiOffline = false;
      await popup("TRACKER_RETRY");
      assert.equal(await countJobs(), 1);
      assert.equal(storage.data.trackerMappings["1001:streaming show"].source, "automatic");
    });

    await scenario("immediate publication works even with a single database connection", async () => {
      const limited = new Pool({ ...config, max: 1, options: `-c search_path=${schema}` });
      const app = createApp(limited, mal, fakeMalFetch, {
        publishJob: async (id) => Boolean(await publishNextJob(limited, broker.publish, id)),
      }).listen(0, "127.0.0.1");
      await new Promise((resolve, reject) => { app.once("listening", resolve); app.once("error", reject); });
      try {
        const response = await originalFetch(`http://127.0.0.1:${app.address().port}/api/extension/progress`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(3000),
          body: JSON.stringify({ userId: Number(userId), malUserId: "1001", malAnimeId: 5114, title: anime.title, episode: 1, watchStatus: "watching" }),
        });
        assert.equal(response.status, 201);
        assert.equal((await response.json()).queued, true);
      } finally { await new Promise((resolve) => app.close(resolve)); await limited.end(); }
    });

    await scenario("account APIs expose no tokens and anime mapping uses MAL's canonical title", async () => {
      const accounts = await popup("TRACKER_ACCOUNTS");
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0].malUserId, "1001");
      assert.ok(!JSON.stringify(accounts).includes("private-"));
      await setup();
      const mapping = storage.data.trackerMappings["1001:streaming show"];
      assert.equal(mapping.title, anime.title);
      assert.equal(mapping.numEpisodes, 12);
      assert.equal((await popup("TRACKER_SEARCH", { query: "https://myanimelist.net/anime/5114/Test_Show" }))[0].id, 5114);
    });

    await scenario("unlinked, incomplete, idle, broken, fractional, and out-of-range episodes never submit", async () => {
      await authorize();
      await observe(); assert.equal(storage.data.trackerSyncStatus.phase, "needs_mapping");
      assert.equal(await countJobs(), 0);
      await observe("Episode 1", 100);
      await popup("TRACKER_BIND", { sourceTitle: "Streaming Show", animeId: 5114 });
      await observe("Episode 1", 899);
      await observe("Episode 1", 900, { isIdle: true });
      await observe("Episode 1", 900, { isBroken: true });
      await observe("Episode 1.5");
      await observe("Episode 13");
      assert.equal(await countJobs(), 0);
      assert.equal(malWrites, 0);
    });

    await scenario("background rejects foreign senders, player subframes, and privileged content-script requests", async () => {
      const payload = { type: "TRACKER_MEDIA_UPDATE", media: { title: "Streaming Show", episode: "Episode 1", currentTime: 900, duration: 1000 } };
      assert.ok((await send(payload, { ...videoSender, id: "other-extension" })).ignored);
      assert.ok((await send(payload, { ...videoSender, frameId: 1 })).ignored);
      assert.ok((await send(payload, { ...videoSender, url: "https://example.com/" })).ignored);
      assert.ok((await send({ type: "TRACKER_SETTINGS", userId, enabled: true }, videoSender)).ignored);
      assert.ok((await send({ type: "TRACKER_PERMISSION", userId, malUserId: "1001", allowed: true }, videoSender)).ignored);
      assert.equal(storage.data.lastWatchedAnime, undefined);
      assert.equal(apiRequests, 0);
    });

    await scenario("the sole account is selected automatically without granting write permission", async () => {
      const state = await popup("TRACKER_INITIALIZE");
      assert.equal(state.trackerSettings.userId, userId);
      assert.equal(state.trackerSettings.malUserId, "1001");
      assert.equal(state.trackerSettings.enabled, false);
      assert.equal(state.needsPermission, true);
      await observe("Episode 1", 100);
      await popup("TRACKER_BIND", { sourceTitle: "Streaming Show", animeId: 5114 });
      await observe();
      assert.equal(await countJobs(), 0);
      await assert.rejects(popup("TRACKER_SETTINGS", { userId, enabled: true }), /Allow this extension/);
      await popup("TRACKER_PERMISSION", { userId, malUserId: "1001", allowed: true });
      assert.equal(storage.data.trackerPermissions["1001"].allowed, true);
      assert.equal(await countJobs(), 1);
      const reopened = await popup("TRACKER_INITIALIZE");
      assert.equal(reopened.needsPermission, false);
      assert.equal(reopened.trackerSettings.enabled, true);
      assert.equal(await countJobs(), 1);
    });

    await scenario("declining is remembered and cannot be bypassed by cached enabled settings", async () => {
      await popup("TRACKER_INITIALIZE");
      await popup("TRACKER_PERMISSION", { userId, malUserId: "1001", allowed: false });
      assert.equal((await popup("TRACKER_INITIALIZE")).needsPermission, false);
      assert.equal(storage.data.trackerSettings.enabled, false);
      // Simulate an old extension's enabled flag and saved retry queue.
      await storage.set({ trackerSettings: { userId, malUserId: "1001", enabled: true },
        trackerMappings: { "1001:streaming show": { malAnimeId: 5114, title: anime.title, numEpisodes: 12 } },
        trackerOutbox: { stale: { userId: Number(userId), malUserId: "1001", malAnimeId: 5114, title: anime.title, episode: 1, watchStatus: "watching" } } });
      await observe();
      await popup("TRACKER_RETRY");
      assert.equal(await countJobs(), 0);
      assert.equal((await popup("TRACKER_INITIALIZE")).trackerSettings.enabled, false);
    });

    await scenario("legacy enabled settings without a permission decision cannot send saved requests", async () => {
      await storage.set({ trackerSettings: { userId, malUserId: "1001", enabled: true },
        trackerOutbox: { stale: { userId: Number(userId), malUserId: "1001", malAnimeId: 5114, title: anime.title, episode: 1, watchStatus: "watching" } } });
      await popup("TRACKER_RETRY");
      assert.equal(await countJobs(), 0);
      const state = await popup("TRACKER_INITIALIZE");
      assert.equal(state.needsPermission, true);
      assert.equal(state.trackerSettings.enabled, false);
    });

    await scenario("revoking permission offline clears unsent requests and blocks later retries", async () => {
      await setup(); apiOffline = true; await observe();
      assert.equal(Object.keys(storage.data.trackerOutbox).length, 1);
      await popup("TRACKER_PERMISSION", { userId, malUserId: "1001", allowed: false });
      assert.equal(storage.data.trackerSettings.enabled, false);
      assert.equal(Object.keys(storage.data.trackerOutbox).length, 0);
      apiOffline = false;
      await popup("TRACKER_RETRY"); await observe();
      assert.equal(await countJobs(), 0);
    });

    await scenario("multiple accounts require a choice; a valid saved account is retained", async () => {
      const other = (await db.query("INSERT INTO users (mal_user_id) VALUES (2002) RETURNING id")).rows[0].id;
      await db.query(`INSERT INTO mal_accounts (user_id, access_token, refresh_token, expires_at)
        SELECT $1, access_token, refresh_token, expires_at FROM mal_accounts WHERE user_id = $2`, [other, userId]);
      assert.equal((await popup("TRACKER_INITIALIZE")).trackerSettings, null);
      await popup("TRACKER_SETTINGS", { userId: other, enabled: false });
      const state = await popup("TRACKER_INITIALIZE");
      assert.equal(state.trackerSettings.userId, other);
      assert.equal(state.needsPermission, true);
      await db.query("UPDATE mal_accounts SET reauth_required = true WHERE user_id = $1", [other]);
      const onlyValid = await popup("TRACKER_INITIALIZE");
      assert.equal(onlyValid.trackerSettings.userId, userId);
      assert.equal(onlyValid.trackerSettings.enabled, false);
    });

    await scenario("permission never transfers to a different MAL account with a reused local ID", async () => {
      await authorize();
      await db.query("UPDATE users SET mal_user_id = 2002 WHERE id = $1", [userId]);
      const state = await popup("TRACKER_INITIALIZE");
      assert.equal(state.trackerSettings.malUserId, "2002");
      assert.equal(state.trackerSettings.enabled, false);
      assert.equal(state.needsPermission, true);
      await assert.rejects(popup("TRACKER_PERMISSION", { userId, malUserId: "1001", allowed: true }), /selected account changed/);
      assert.equal(await countJobs(), 0);
    });

    await scenario("API outages keep a durable retry without spamming requests; a new worker can recover it", async () => {
      await setup(); apiOffline = true;
      await observe();
      assert.equal(Object.keys(storage.data.trackerOutbox).length, 1);
      assert.equal(storage.data.trackerSyncStatus.phase, "retrying");
      const count = apiRequests; await observe(); assert.equal(apiRequests, count);
      apiOffline = false; await storage.set({ trackerRetryAt: 0 });
      const restarted = new TrackerBridge(storage, apiFetch);
      await restarted.run(() => restarted.flush());
      assert.equal(Object.keys(storage.data.trackerOutbox).length, 0);
      assert.equal(await countJobs(), 1);
    });

    await scenario("RabbitMQ outages preserve the database job for the periodic publisher", async () => {
      await setup(); brokerAvailable = false; await observe();
      assert.equal(await countJobs(), 1);
      assert.equal((await db.query("SELECT published_at FROM sync_jobs")).rows[0].published_at, null);
      assert.equal(storage.data.trackerSyncStatus.phase, "pending");
      brokerAvailable = true;
      assert.ok(await publishNextJob(db, broker.publish));
      consumer = await consumeSyncQueue(db, broker, mal, queue);
      await until(async () => (await db.query("SELECT state FROM sync_jobs")).rows[0].state === "synced");
      assert.equal((await popup("TRACKER_STATUS")).trackerSyncStatus.phase, "synced");
    });

    await scenario("stale account identity after a reset cannot update another MAL account", async () => {
      await setup();
      await db.query("UPDATE users SET mal_user_id = 2002 WHERE id = $1", [userId]);
      await observe();
      assert.equal(await countJobs(), 0);
      assert.equal(storage.data.trackerSettings.enabled, false);
      assert.equal(storage.data.trackerSyncStatus.phase, "blocked");
    });

    await scenario("superseded jobs are shown honestly and are never replayed by the extension", async () => {
      await setup(); await observe();
      await importMalList(db, userId, mal);
      assert.equal((await popup("TRACKER_STATUS")).trackerSyncStatus.phase, "superseded");
      await observe();
      consumer = await consumeSyncQueue(db, broker, mal, queue);
      await until(async () => (await broker.channel.checkQueue(queue)).messageCount === 0);
      await consumer.stop(); consumer = undefined;
      assert.equal(malWrites, 0);
      assert.equal(await countJobs(), 1);
    });

    await scenario("unconnected or revoked accounts are rejected before progress changes", async () => {
      const other = (await db.query("INSERT INTO users (mal_user_id) VALUES (2002) RETURNING id")).rows[0].id;
      const post = (id, malUserId) => originalFetch(`${base}/api/extension/progress`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: Number(id), malUserId, malAnimeId: 5114, title: anime.title, episode: 1, watchStatus: "watching" }) });
      assert.equal((await post(other, "2002")).status, 409);
      await db.query("UPDATE mal_accounts SET reauth_required = true");
      assert.equal((await post(userId, "1001")).status, 409);
      assert.equal(await countJobs(), 0);
    });
  } finally {
    await consumer?.stop();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (broker) {
      await broker.channel.deleteQueue(queue).catch(() => {});
      await broker.channel.deleteQueue(`${queue}.dead`).catch(() => {});
      await broker.close();
    }
    await db.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
    if (savedKey === undefined) delete process.env.MAL_TOKEN_KEY; else process.env.MAL_TOKEN_KEY = savedKey;
    if (savedClient === undefined) delete process.env.MAL_CLIENT_ID; else process.env.MAL_CLIENT_ID = savedClient;
  }
});
