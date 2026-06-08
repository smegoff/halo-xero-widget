// lib/db.js
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

export const pgPool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: String(process.env.DB_PASSWORD),
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === "true"
});

pgPool.on("connect", () => {
  console.log("🟣 Postgres connected");
});

pgPool.on("error", err => {
  console.error("❌ Postgres pool error", err);
});
