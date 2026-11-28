import type { Pool } from "pg";
import { publishNextJob } from "./outbox.js";
import { openRabbitMQ } from "./rabbitmq.js";

export async function publishSyncJob(pool: Pool, jobId: string): Promise<boolean> {
    let broker: Awaited<ReturnType<typeof openRabbitMQ>> | undefined;
    try {
        broker = await openRabbitMQ();
        return Boolean(await publishNextJob(pool, broker.publish, jobId));
    } catch {
        console.error(`Immediate delivery of sync job ${jobId} failed; the publisher will retry`);
        return false;
    } finally { await broker?.close(); }
}
