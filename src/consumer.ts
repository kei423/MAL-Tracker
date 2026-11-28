import type { Pool } from "pg";
import type { ConsumeMessage } from "amqplib";
import { MalClient } from "./mal.js";
import { openRabbitMQ, syncQueue } from "./rabbitmq.js";
import { syncJob } from "./sync.js";

export async function consumeSyncQueue(
    pool: Pool, broker: Awaited<ReturnType<typeof openRabbitMQ>>, mal = new MalClient(), queue = syncQueue,
) {
    const { channel, connection } = broker;
    const deadQueue = `${queue}.dead`;
    await channel.assertQueue(deadQueue, { durable: true });
    await channel.prefetch(1);
    let active: Promise<void> = Promise.resolve();
    let complete!: () => void;
    const done = new Promise<void>((resolve) => { complete = resolve; });
    channel.once("close", complete);
    connection.once("close", complete);
    const quarantine = async (message: ConsumeMessage) => {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Dead-letter confirmation timed out")), 10000);
            channel.sendToQueue(deadQueue, message.content, { persistent: true, contentType: "application/json" },
                (error) => { clearTimeout(timer); if (error) reject(error); else resolve(); });
        });
    };
    const result = await channel.consume(queue, (message) => {
        if (!message) { complete(); return; }
        active = (async () => {
            let data: { schemaVersion?: unknown; syncJobId?: unknown } | null = null;
            try { data = JSON.parse(message.content.toString()); } catch { /* Quarantine malformed messages. */ }
            const id = data?.syncJobId;
            if (data?.schemaVersion !== 1 || typeof id !== "string" ||
                !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
                await quarantine(message);
                console.error(`Invalid sync message moved to ${deadQueue}`);
            } else {
                const state = await syncJob(pool, id, mal);
                console.log(`Sync job ${id}: ${state}`);
            }
            // Commit succeeded (including a durable scheduled retry) before ack.
            channel.ack(message);
        })().catch(async (error: unknown) => {
            console.error("Sync consumer could not commit; reconnecting to redeliver the message:",
                error instanceof Error ? error.message : "Unknown error");
            complete();
            await broker.close();
        });
    }, { noAck: false });
    return {
        done,
        async stop() {
            await channel.cancel(result.consumerTag).catch(() => {});
            await active;
            channel.off("close", complete);
            connection.off("close", complete);
        },
    };
}
