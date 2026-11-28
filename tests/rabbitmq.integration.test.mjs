import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import express from "express";
import { Pool } from "pg";
import { openRabbitMQ } from "../dist/rabbitmq.js";
import { publishNextJob } from "../dist/outbox.js";

test("RabbitMQ delivers progress jobs and preserves jobs after failures", { timeout: 30000 }, async (t) => {
    const suffix = randomUUID().replaceAll("-", "");
    const schema = `queue_test_${suffix}`;
    const queue = `mal.sync.test.${suffix}`;
    const database = {
        host: process.env.DB_HOST ?? "127.0.0.1",
        port: Number(process.env.DB_PORT ?? 5432),
        user: process.env.DB_USER ?? "tracker",
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME ?? "tracker",
        connectionTimeoutMillis: 5000,
    };
    const admin = new Pool(database);
    const isolated = new Pool({ ...database, options: `-c search_path=${schema}` });
    let broker;
    let apiPool;
    let server;
    const originalOptions = process.env.PGOPTIONS;
    try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        await isolated.query(await readFile(new URL("../db/init.sql", import.meta.url), "utf8"));
        // Check that the upgrade is safe to apply repeatedly.
        const migration = await readFile(new URL("../db/migrations/001-rabbitmq.sql", import.meta.url), "utf8");
        await isolated.query(migration);
        await isolated.query(migration);
        broker = await openRabbitMQ(queue);

        process.env.PGOPTIONS = `-c search_path=${schema}`;
        const { progressRouter } = await import("../dist/progress.js");
        const { pool } = await import("../dist/db.js");
        apiPool = pool;
        const app = express();
        app.use(express.json());
        app.use("/api", progressRouter);
        server = app.listen(0, "127.0.0.1");
        await new Promise((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
        });
        const { rows: [user] } = await isolated.query(
            "INSERT INTO users (mal_user_id) VALUES (12345) RETURNING id",
        );
        const body = {
            userId: Number(user.id), malAnimeId: 5114,
            title: "Fullmetal Alchemist: Brotherhood", episode: 1, watchStatus: "watching",
        };
        const postProgress = async (episode) => {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/progress`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...body, episode }),
            });
            return { status: response.status, body: await response.json() };
        };
        const job = async (id) => (await isolated.query("SELECT * FROM sync_jobs WHERE id = $1", [id])).rows[0];
        let firstJob;

        await t.test("HTTP progress update reaches a durable queue with a confirmed persistent message", async () => {
            const response = await postProgress(1);
            assert.equal(response.status, 201);
            firstJob = response.body.syncJobId;
            assert.equal(await publishNextJob(isolated, broker.publish), firstJob);
            const message = await broker.channel.get(queue, { noAck: false });
            assert.ok(message);
            assert.equal(message.properties.deliveryMode, 2);
            assert.equal(message.properties.messageId, firstJob);
            assert.deepEqual(JSON.parse(message.content.toString()), {
                schemaVersion: 1, syncJobId: firstJob, userId: user.id,
                malAnimeId: "5114", episode: 1, watchStatus: "watching", progressVersion: 1,
            });
            broker.channel.ack(message);
            const saved = await job(firstJob);
            assert.ok(saved.published_at);
            assert.equal(saved.state, "pending");
            assert.equal(saved.synced_at, null);
        });

        await t.test("duplicate HTTP progress does not add or republish a job", async () => {
            assert.equal((await postProgress(1)).status, 200);
            assert.equal((await isolated.query("SELECT count(*) FROM sync_jobs")).rows[0].count, "1");
            assert.equal(await publishNextJob(isolated, broker.publish), null);
            assert.equal(await broker.channel.get(queue), false);
        });

        await t.test("failed publish leaves the saved job available for retry", async () => {
            const response = await postProgress(2);
            const id = response.body.syncJobId;
            await assert.rejects(publishNextJob(isolated, async () => {
                throw new Error("Simulated broker outage");
            }), /Simulated broker outage/);
            assert.equal((await job(id)).published_at, null);
            assert.equal(await publishNextJob(isolated, broker.publish), id);
            const message = await broker.channel.get(queue);
            assert.ok(message);
            assert.equal(JSON.parse(message.content.toString()).episode, 2);
            broker.channel.ack(message);
        });

        await t.test("an unroutable message is not marked published", async () => {
            const response = await postProgress(3);
            await broker.channel.deleteQueue(queue);
            await assert.rejects(publishNextJob(isolated, broker.publish), /Sync queue is unavailable/);
            assert.equal((await job(response.body.syncJobId)).published_at, null);
            await broker.channel.assertQueue(queue, { durable: true });
            assert.equal(await publishNextJob(isolated, broker.publish), response.body.syncJobId);
            const message = await broker.channel.get(queue);
            assert.ok(message);
            broker.channel.ack(message);
        });

        await t.test("concurrent publishers lock different jobs", async () => {
            await postProgress(4);
            await postProgress(5);
            const otherBroker = await openRabbitMQ(queue);
            try {
                const ids = await Promise.all([
                    publishNextJob(isolated, broker.publish),
                    publishNextJob(isolated, otherBroker.publish),
                ]);
                assert.ok(ids.every(Boolean));
                assert.equal(new Set(ids).size, 2);
                assert.equal(await publishNextJob(isolated, broker.publish), null);
                assert.equal((await broker.channel.checkQueue(queue)).messageCount, 2);
            } finally {
                await otherBroker.close();
            }
        });
    } finally {
        if (originalOptions === undefined) delete process.env.PGOPTIONS;
        else process.env.PGOPTIONS = originalOptions;
        if (server) await new Promise((resolve) => server.close(resolve));
        await apiPool?.end();
        if (broker) {
            await broker.channel.deleteQueue(queue).catch(() => {});
            await broker.close();
        }
        await isolated.end();
        // Only remove the random schema created by this test.
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
    }
});
