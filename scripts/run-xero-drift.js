// scripts/run-xero-drift.js
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { pgPool } from "../lib/db.js";
import { getXeroHeaders } from "../lib/xero.js";
import { installTimestampedConsole } from "../lib/timestamp-console.js";

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) installTimestampedConsole();

dotenv.config();

const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log("🔍 Starting Xero drift scan", new Date().toISOString());

async function run() {
  const headers = await getXeroHeaders();

  const { rows: clients } = await pgPool.query(`
    SELECT halo_client_name, xero_contact_guid
    FROM halo.halo_client
    WHERE xero_contact_guid IS NOT NULL
    ORDER BY halo_client_name
  `);

  console.log(`📦 Checking ${clients.length} contacts`);

  for (const c of clients) {
    try {
      const resp = await axios.get(
        `https://api.xero.com/api.xro/2.0/Contacts/${c.xero_contact_guid}`,
        { headers }
      );

      const xeroName = resp.data?.Contacts?.[0]?.Name;
      if (!xeroName) continue;

      const haloNorm = c.halo_client_name.trim().toLowerCase();
      const xeroNorm = xeroName.trim().toLowerCase();

      // ✅ Only real drift
      if (haloNorm !== xeroNorm) {
        await pgPool.query(
          `
          INSERT INTO halo.xero_drift
            (halo_client_name, xero_client_name, xero_contact_guid)
          VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING
          `,
          [c.halo_client_name, xeroName, c.xero_contact_guid]
        );
      }

      // Gentle rate limiting
      await sleep(200);
    } catch (err) {
      const status = err.response?.status;

      if (status === 404) {
        console.warn(
          `⚠️ Contact deleted in Xero: ${c.halo_client_name} ${c.xero_contact_guid}`
        );
        continue;
      }

      if (status === 429) {
        console.error("🚦 Xero rate limit hit — stopping scan");
        break;
      }

      console.warn(
        `⚠️ Xero lookup failed for ${c.halo_client_name}`,
        c.xero_contact_guid
      );
    }
  }

  console.log("✅ Drift scan complete");
  process.exit(0);
}

run().catch(err => {
  console.error("❌ Drift scan failed", err);
  process.exit(1);
});
