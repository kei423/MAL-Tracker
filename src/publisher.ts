import { setTimeout as delay } from "node:timers/promises";
import { pool } from "./db.js";
import { publishNextJob } from "./outbox.js";
import { openRabbitMQ, syncQueue } from "./rabbitmq.js";

const pollIntervalMs = 10_000;
const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

async function pause(milliseconds: number) {
    await delay(milliseconds, undefined, { signal: shutdown.signal }).catch(() => {});
}

async function main() {
    while (!shutdown.signal.aborted) {
        let broker: Awaited<ReturnType<typeof openRabbitMQ>> | undefined;
        try {
            broker = await openRabbitMQ();
            let disconnected = false;
            broker.connection.once("close", () => { disconnected = true; });
            broker.channel.once("close", () => { disconnected = true; });
            console.log(`Checking for pending MAL updates every ${pollIntervalMs / 1000} seconds; publishing to ${syncQueue}`);
            while (!shutdown.signal.aborted) {
                if (disconnected) throw new Error("RabbitMQ disconnected");
                const jobId = await publishNextJob(pool, broker.publish);
                if (jobId) console.log(`Published sync job ${jobId}`);
                else await pause(pollIntervalMs);
            }
        } catch (error) {
            console.error("Sync publisher will retry in 5 seconds:",
                error instanceof Error ? error.message : String(error));
        } finally {
            await broker?.close();
        }
        if (!shutdown.signal.aborted) await pause(5000);
    }
    await pool.end();
}

main().catch((error: unknown) => {
    console.error("Sync publisher stopped:", error);
    process.exitCode = 1;
});
