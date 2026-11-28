import { setTimeout as delay } from "node:timers/promises";
import { pool } from "./db.js";
import { consumeSyncQueue } from "./consumer.js";
import { openRabbitMQ, syncQueue } from "./rabbitmq.js";
import { checkTokenKey } from "./token-crypto.js";
import { runListSyncLoop, listSyncPollIntervalMs } from "./list-sync-loop.js";
import { listSyncIntervalSeconds } from "./mal-list.js";

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());
async function main() {
    checkTokenKey();
    const listIntervalSeconds = listSyncIntervalSeconds();
    console.log(`MAL-to-local progress sync enabled: refresh each account every ${listIntervalSeconds} seconds; check for due imports every ${listSyncPollIntervalMs / 1000} seconds`);
    const listSync = runListSyncLoop(pool, shutdown.signal);
    const stopped = new Promise<void>((resolve) => shutdown.signal.addEventListener("abort", () => resolve(), { once: true }));
    while (!shutdown.signal.aborted) {
        let broker: Awaited<ReturnType<typeof openRabbitMQ>> | undefined;
        let consumer: Awaited<ReturnType<typeof consumeSyncQueue>> | undefined;
        try {
            broker = await openRabbitMQ();
            consumer = await consumeSyncQueue(pool, broker);
            console.log(`MAL Sync worker consuming ${syncQueue}`);
            await Promise.race([consumer.done, stopped]);
        } catch (error) {
            console.error("MAL Sync worker will reconnect:", error instanceof Error ? error.message : String(error));
        } finally {
            await consumer?.stop();
            await broker?.close();
        }
        if (!shutdown.signal.aborted) await delay(5000, undefined, { signal: shutdown.signal }).catch(() => {});
    }
    await listSync;
    await pool.end();
}
main().catch(async (error: unknown) => {
    shutdown.abort();
    console.error("MAL Sync worker stopped:", error instanceof Error ? error.message : String(error));
    await pool.end();
    process.exitCode = 1;
});
