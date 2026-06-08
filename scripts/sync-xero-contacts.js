#!/usr/bin/env node
/**
 * Xero → Halo Contact Delta Sync
 * ----------------------------------------
 * - Uses UpdatedDateUTC delta sync
 * - Upserts into halo.halo_client
 * - Advances sync_state ONLY on success
 */

import "dotenv/config";
import axios from "axios";
import { Pool } from "pg";
import { getXeroHeaders, tokens } from "../lib/xero.js";

// -----------------------------------------------------
// ENV VALIDATION
// -----------------------------------------------------
[
  "DB_HOST",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
  "XERO_CLIENT_ID",
  "XERO_CLIENT_SECRET"
].forEach(k => {
  if (!process.env[k]) {
    throw new Error(`Missing required env var: ${k}`);
  }
});

// -----------------------------------------------------
// POSTGRES
// -----------------------------------------------------
const pg = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT || 5432),
  ssl: process.env.DB_SSL === "true"
});

// -----------------------------------------------------
// HELPERS
// -----------------------------------------------------
function toXeroDateTime(date) {
  return `DateTime(${[
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds()
  ].join(",")})`;
}

async function getLastSync() {
  const r = await pg.query(
    `SELECT value FROM halo.sync_state WHERE key = 'xero_contact_sync'`
  );
  return r.rows[0]?.value;
}

async function setLastSync(iso) {
  await pg.query(
    `
    UPDATE halo.sync_state
    SET value = $1, updated_at = now()
    WHERE key = 'xero_contact_sync'
    `,
    [iso]
  );
}

// -----------------------------------------------------
// MAIN LOGIC
// -----------------------------------------------------
async function main() {
  console.log("🔄 Starting Xero → Halo client sync");

  const headers = await getXeroHeaders();

  await pg.query("SELECT 1");
  console.log("🟣 Postgres connected");

  const lastSyncIso = await getLastSync();
  if (!lastSyncIso) {
    throw new Error("sync_state.xero_contact_sync missing");
  }

  const since = new Date(new Date(lastSyncIso).getTime() - 60_000);
  const where = `UpdatedDateUTC>=${toXeroDateTime(since)}`;

  console.log("⏱ Delta where:", where);

  const resp = await axios.get(
    "https://api.xero.com/api.xro/2.0/Contacts",
    {
      headers,
      params: { where }
    }
  );

  const contacts = resp.data?.Contacts || [];

  let processed = 0;

  for (const c of contacts) {
    if (!c.ContactID || !c.Name) continue;

    await pg.query(
      `
      INSERT INTO halo.halo_client
        (halo_client_name, xero_contact_guid, xero_contact_number, xero_tenant_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (halo_client_name)
      DO UPDATE SET
        xero_contact_guid = EXCLUDED.xero_contact_guid,
        xero_contact_number = EXCLUDED.xero_contact_number,
        xero_tenant_id = EXCLUDED.xero_tenant_id,
        updated_at = now()
      `,
      [
        c.Name.trim(),
        c.ContactID,
        c.ContactNumber || null,
        tokens.tenantId || null
      ]
    );

    processed++;
  }

  const nowIso = new Date().toISOString();
  await setLastSync(nowIso);

  console.log(`✅ Sync complete — ${processed} contacts processed`);
}

// -----------------------------------------------------
// EXPORT FOR ADMIN PANEL
// -----------------------------------------------------
export async function runSync() {
  await main();
}

// -----------------------------------------------------
// CLI EXECUTION (cron support)
// -----------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch(err => {
      console.error(
        "❌ Sync failed:",
        err.response?.data || err.message
      );
      process.exit(1);
    })
    .finally(async () => {
      await pg.end();
    });
}

// 📊 Metrics snapshot
try {
  const total = await pg.query(`
    SELECT COUNT(*)::int AS count FROM halo.halo_client
  `);

  const mapped = await pg.query(`
    SELECT COUNT(*)::int AS count
    FROM halo.halo_client
    WHERE xero_contact_guid IS NOT NULL
  `);

  await pg.query(`
    INSERT INTO halo.sync_metrics (total_clients, mapped_clients)
    VALUES ($1, $2)
  `, [
    total.rows[0].count,
    mapped.rows[0].count
  ]);

  console.log("📊 Metrics snapshot recorded");
} catch (err) {
  console.error("❌ Metrics snapshot failed:", err.message);
}
