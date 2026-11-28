import type { PoolClient } from "pg";

// Hold only during the local merge/update, never while fetching a remote list.
export async function lockUser(client: PoolClient, userId: string) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':' || $1, 0))", [`mal-user:${userId}`]);
}
