import "dotenv/config";
import { Pool } from "pg";

if (!process.env.DB_PASSWORD) {
    throw new Error("DB_PASSWORD is missing from .env");
}

export const pool = new Pool({
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME ?? "tracker",
    user: process.env.DB_USER ?? "tracker",
    password: process.env.DB_PASSWORD,
});

pool.on("error", (error) => {
    console.error("Unexpected PostgreSQL connection error:", error);
});
