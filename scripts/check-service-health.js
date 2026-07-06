import { execFile } from "child_process";
import { promisify } from "util";
import { pgPool } from "../lib/db.js";
import { sendAdminAlert } from "../lib/alerts.js";

const execFileAsync = promisify(execFile);
const REQUIRED_PM2_APPS = ["halo-xero", "halo-xero-admin"];
const SYNC_STALE_MINUTES = Number.parseInt(process.env.SERVICE_ALERT_SYNC_STALE_MINUTES || "20", 10);
const ALERT_COOLDOWN_MINUTES = Number.parseInt(process.env.SERVICE_ALERT_COOLDOWN_MINUTES || "60", 10);

async function ensureAlertStateTable() {
  await pgPool.query("CREATE SCHEMA IF NOT EXISTS halo");
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS halo.alert_state (
      key text PRIMARY KEY,
      fingerprint text NOT NULL,
      sent_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function getPm2Issues() {
  try {
    const { stdout } = await execFileAsync("pm2", ["jlist"], { timeout: 10000 });
    const processes = JSON.parse(stdout);
    const byName = new Map(processes.map(proc => [proc.name, proc]));

    return REQUIRED_PM2_APPS.flatMap(name => {
      const proc = byName.get(name);
      if (!proc) {
        return [`PM2 service ${name} is missing`];
      }
      const status = proc.pm2_env?.status;
      if (status !== "online") {
        return [`PM2 service ${name} is ${status || "unknown"}`];
      }
      return [];
    });
  } catch (err) {
    return [`PM2 status check failed: ${err.message}`];
  }
}

async function getSyncIssues() {
  const { rows } = await pgPool.query(`
    SELECT value
    FROM halo.sync_state
    WHERE key = 'xero_contact_sync'
    LIMIT 1
  `);
  const lastSync = rows[0]?.value ? new Date(rows[0].value) : null;
  if (!lastSync || Number.isNaN(lastSync.getTime())) {
    return ["Xero contact sync has never completed"];
  }

  const minutesOld = (Date.now() - lastSync.getTime()) / 1000 / 60;
  if (minutesOld > SYNC_STALE_MINUTES) {
    return [`Xero contact sync is stale (${Math.round(minutesOld)} minutes old)`];
  }

  return [];
}

async function getWebhookIssues() {
  const table = await pgPool.query(`
    SELECT to_regclass('halo.gocardless_webhook_event') AS table_name
  `);
  if (!table.rows[0]?.table_name) return [];

  const { rows } = await pgPool.query(`
    SELECT count(*)::int AS failed_count
    FROM halo.gocardless_webhook_event
    WHERE processing_status = 'failed'
      AND processed_at >= now() - interval '1 hour'
  `);
  const failedCount = rows[0]?.failed_count || 0;
  return failedCount > 0
    ? [`${failedCount} GoCardless webhook event(s) failed in the last hour`]
    : [];
}

async function shouldSendAlert(fingerprint) {
  await ensureAlertStateTable();
  const { rows } = await pgPool.query(
    `
      SELECT fingerprint, sent_at
      FROM halo.alert_state
      WHERE key = 'service_health'
      LIMIT 1
    `
  );
  const previous = rows[0];
  if (previous?.fingerprint === fingerprint) {
    const minutesSince = (Date.now() - new Date(previous.sent_at).getTime()) / 1000 / 60;
    if (minutesSince < ALERT_COOLDOWN_MINUTES) {
      return false;
    }
  }

  await pgPool.query(
    `
      INSERT INTO halo.alert_state (key, fingerprint, sent_at, updated_at)
      VALUES ('service_health', $1, now(), now())
      ON CONFLICT (key)
      DO UPDATE SET
        fingerprint = EXCLUDED.fingerprint,
        sent_at = now(),
        updated_at = now()
    `,
    [fingerprint]
  );
  return true;
}

async function main() {
  const issues = [
    ...(await getPm2Issues()),
    ...(await getSyncIssues()),
    ...(await getWebhookIssues())
  ];

  if (!issues.length) {
    console.log("Service health OK");
    return;
  }

  const fingerprint = issues.slice().sort().join("|");
  if (!(await shouldSendAlert(fingerprint))) {
    console.log("Service health alert suppressed by cooldown");
    return;
  }

  await sendAdminAlert({
    severity: "error",
    title: "Halo Xero Widget service health issue",
    summary: "One or more production service checks failed.",
    facts: issues.slice(0, 10).map((issue, index) => ({
      title: `Issue ${index + 1}`,
      value: issue
    }))
  });
  console.log(`Service health alert sent: ${issues.join("; ")}`);
}

main()
  .catch(err => {
    console.error("Service health check failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgPool.end();
  });
