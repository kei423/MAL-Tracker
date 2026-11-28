import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { MalClient } from "./mal.js";
import { importMalList, listSyncIntervalSeconds } from "./mal-list.js";

export const listSyncPollIntervalMs = 10_000;

export async function syncDueLists(pool: Pool, mal = new MalClient(), signal?: AbortSignal) {
    const accounts = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM mal_accounts WHERE NOT reauth_required AND list_sync_next_attempt_at <= now()
         ORDER BY list_sync_next_attempt_at LIMIT 10`);
    for (const { user_id: userId } of accounts.rows) {
        if (signal?.aborted) return;
        const result = await importMalList(pool, userId, mal);
        console.log(`MAL list for user ${userId}: ${result.state} (${result.imported} entries)${result.error ? `: ${result.error}` : ""}`);
    }
}

export async function runListSyncLoop(pool: Pool, signal: AbortSignal, mal = new MalClient()) {
    let initialized = false;
    while (!signal.aborted) {
        try {
            if (!initialized) {
                // Shorten schedules saved before restart without bypassing
                // backoff for failed or rate-limited imports.
                await pool.query(
                    `UPDATE mal_accounts SET list_sync_next_attempt_at = LEAST(list_sync_next_attempt_at,
                         COALESCE(list_synced_at, now()) + $1 * interval '1 second')
                     WHERE NOT reauth_required AND list_sync_error IS NULL`, [listSyncIntervalSeconds()]);
                initialized = true;
            }
            await syncDueLists(pool, mal, signal);
        }
        catch (error) { console.error("MAL list scheduler will retry:", error instanceof Error ? error.message : "Unknown error"); }
        await delay(listSyncPollIntervalMs, undefined, { signal }).catch(() => {});
    }
}
