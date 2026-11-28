import { pool } from "./db.js";
import { createApp } from "./app.js";

createApp(pool).listen(3000, "127.0.0.1", () => {
    console.log("Tracker API running on http://localhost:3000");
});
