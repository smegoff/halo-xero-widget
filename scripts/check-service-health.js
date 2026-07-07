import { execFile } from "child_process";
import { promisify } from "util";
import { pgPool } from "../lib/db.js";
import { sendAdminAlert } from "../lib/alerts.js";
import { syncDirectDebitExceptionTickets } from "../lib/halo-direct-debit-tickets.js";

const execFileAsync = promisify(execFile);
const REQUIRED_PM2_APPS = ["halo-xero", "halo-xero-admin"];
const SYNC_STALE_MINUTES = Number.parseInt(process.env.SERVICE_ALERT_SYNC_STALE_MINUTES || "20", 10);
const ALERT_COOLDOWN_MINUTES = Number.parseInt(process.env.SERVICE_ALERT_COOLDOWN_MINUTES || "60", 10);
const DD_ALERT_SCAN_INTERVAL_MINUTES = Number.parseInt(process.env.DD_ALERT_SCAN_INTERVAL_MINUTES || "60", 10);
const DD_ALERT_UNMAPPED_LIMIT = Number.parseInt(process.env.DD_ALERT_UNMAPPED_LIMIT || "25", 10);
const DD_ALERT_MISMATCH_LIMIT = Number.parseInt(process.env.DD_ALERT_MISMATCH_LIMIT || "25", 10);
const DD_ALERT_MAPPED_CHECK_LIMIT = Number.parseInt(process.env.DD_ALERT_MAPPED_CHECK_LIMIT || "500", 10);
const ADMIN_BASE_URL = String(process.env.ADMIN_BASE_URL || "https://widget.engagetech.nz/admin").replace(/\/+$/g, "");

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
        return [{ title: "PM2 service", value: `${name} is missing` }];
      }
      const status = proc.pm2_env?.status;
      if (status !== "online") {
        return [{ title: "PM2 service", value: `${name} is ${status || "unknown"}` }];
      }
      return [];
    });
  } catch (err) {
    return [{ title: "PM2 status", value: `Check failed: ${err.message}` }];
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
    return [{ title: "Xero contact sync", value: "Has never completed" }];
  }

  const minutesOld = (Date.now() - lastSync.getTime()) / 1000 / 60;
  if (minutesOld > SYNC_STALE_MINUTES) {
    return [{ title: "Xero contact sync", value: `Stale (${Math.round(minutesOld)} minutes old)` }];
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
    ? [{ title: "GoCardless webhooks", value: `${failedCount} event(s) failed in the last hour` }]
    : [];
}

async function shouldRunDirectDebitExceptionScan() {
  await ensureAlertStateTable();
  const { rows } = await pgPool.query(
    `
      SELECT sent_at
      FROM halo.alert_state
      WHERE key = 'direct_debit_exception_scan'
      LIMIT 1
    `
  );
  const previous = rows[0];
  if (previous?.sent_at) {
    const minutesSince = (Date.now() - new Date(previous.sent_at).getTime()) / 1000 / 60;
    if (minutesSince < DD_ALERT_SCAN_INTERVAL_MINUTES) return false;
  }

  await pgPool.query(
    `
      INSERT INTO halo.alert_state (key, fingerprint, sent_at, updated_at)
      VALUES ('direct_debit_exception_scan', 'last_scan', now(), now())
      ON CONFLICT (key)
      DO UPDATE SET
        fingerprint = 'last_scan',
        sent_at = now(),
        updated_at = now()
    `
  );
  return true;
}

async function getDirectDebitMandateIssues() {
  if (!(await shouldRunDirectDebitExceptionScan())) {
    return [];
  }

  try {
    const result = await syncDirectDebitExceptionTickets({
      unmappedLimit: DD_ALERT_UNMAPPED_LIMIT,
      mismatchLimit: DD_ALERT_MISMATCH_LIMIT,
      mappedCheckLimit: DD_ALERT_MAPPED_CHECK_LIMIT
    });

    if (result.scanned > 0) {
      console.log(
        `Direct Debit exception ticket sync complete: ${result.created} created, ${result.existing} existing, ${result.failed} failed, ${result.scanned} scanned`
      );
    }

    if (result.failed > 0) {
      return [{
        title: "Direct Debit Halo ticket creation",
        value: `${result.failed} Direct Debit exception ticket(s) failed to create`
      }];
    }

    return [];
  } catch (err) {
    return [{ title: "Direct Debit scan", value: `Failed: ${err.response?.status || err.message}` }];
  }
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
    ...(await getWebhookIssues()),
    ...(await getDirectDebitMandateIssues())
  ];

  if (!issues.length) {
    console.log("Service health OK");
    return;
  }

  const fingerprint = issues
    .map(issue => `${issue.title}:${issue.value}`)
    .sort()
    .join("|");
  if (!(await shouldSendAlert(fingerprint))) {
    console.log("Service health alert suppressed by cooldown");
    return;
  }

  await sendAdminAlert({
    severity: "error",
    title: "Halo Xero Widget service health issue",
    summary: "One or more production service checks failed.",
    facts: issues.slice(0, 10),
    actionUrl: ADMIN_BASE_URL,
    actionTitle: "Open Admin"
  });
  console.log(`Service health alert sent: ${issues.map(issue => `${issue.title}: ${issue.value}`).join("; ")}`);
}

main()
  .catch(err => {
    console.error("Service health check failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgPool.end();
  });
