import "dotenv/config";
import { connect } from "amqplib";

export const syncQueue = process.env.RABBITMQ_QUEUE ?? "mal.sync";

export interface SyncMessage {
    schemaVersion: 1;
    syncJobId: string;
    userId: string;
    malAnimeId: string;
    episode: number;
    watchStatus: string;
    progressVersion: number;
}

export async function openRabbitMQ(queue = syncQueue) {
    if (!process.env.RABBITMQ_PASSWORD) {
        throw new Error("RABBITMQ_PASSWORD is missing from .env");
    }
    const connection = await connect({
        hostname: process.env.RABBITMQ_HOST ?? "127.0.0.1",
        port: Number(process.env.RABBITMQ_PORT ?? 5672),
        username: process.env.RABBITMQ_USER ?? "tracker",
        password: process.env.RABBITMQ_PASSWORD,
        vhost: process.env.RABBITMQ_VHOST ?? "/",
        heartbeat: 10,
    }, { timeout: 5000 });
    connection.on("error", (error: Error) => {
        console.error("RabbitMQ connection error:", error.message);
    });

    try {
        const channel = await connection.createConfirmChannel();
        channel.on("error", (error: Error) => {
            console.error("RabbitMQ channel error:", error.message);
        });
        await channel.assertQueue(queue, { durable: true });

        return {
            connection,
            channel,
            // Publish one message at a time, waiting for the broker's confirmation.
            publish(message: SyncMessage): Promise<void> {
                return new Promise((resolve, reject) => {
                    const finish = (error?: Error | null) => {
                        clearTimeout(timer);
                        channel.off("return", onReturn);
                        channel.off("close", onClose);
                        if (error) reject(error);
                        else resolve();
                    };
                    const onReturn = () => finish(new Error("Sync queue is unavailable"));
                    const onClose = () => finish(new Error("RabbitMQ channel closed"));
                    const timer = setTimeout(() => finish(new Error("RabbitMQ confirmation timed out")), 10000);
                    channel.once("return", onReturn);
                    channel.once("close", onClose);
                    try {
                        channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)), {
                            persistent: true,
                            mandatory: true,
                            contentType: "application/json",
                            type: "mal.progress.sync",
                            messageId: message.syncJobId,
                        }, finish);
                    } catch (error) {
                        finish(error instanceof Error ? error : new Error(String(error)));
                    }
                });
            },
            async close() {
                await channel.close().catch(() => {});
                await connection.close().catch(() => {});
            },
        };
    } catch (error) {
        await connection.close().catch(() => {});
        throw error;
    }
}
