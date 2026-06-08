// server-admin.js — Halo ↔ Xero Admin Portal
// ------------------------------------------

import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import axios from "axios";
import fs from "fs";

import { pgPool } from "./lib/db.js";
import { getXeroHeaders, tokens } from "./lib/xero.js";
import { runSync } from "./scripts/sync-xero-contacts.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PgSession = connectPgSimple(session);

console.log("🛠️ ADMIN SERVER LOADED —", new Date().toISOString());

// -------------------------------------------------
// APP SETUP
// -------------------------------------------------
const app = express();

app.set("trust proxy", 1);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// -------------------------------------------------
// SESSION
// -------------------------------------------------
app.use(
  session({
    store: new PgSession({
      pool: pgPool,
      tableName: "admin_session",
      createTableIfMissing: true
    }),
    name: "halo-xero-admin",
    secret: process.env.ADMIN_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

// -------------------------------------------------
// AUTH MIDDLEWARE
// -------------------------------------------------
function requireAdminAuth(req, res, next) {
  if (req.session?.admin === true) return next();
  res.redirect("/admin/login");
}

// -------------------------------------------------
// HELPERS
// -------------------------------------------------
function formatLocalDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString("en-NZ", {
      dateStyle: "medium",
      timeStyle: "medium"
    });
  } catch {
    return iso;
  }
}

function tailLines(filePath, maxLines = 200) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch (err) {
    return [`Failed to read ${filePath}: ${err.message}`];
  }
}

function getLogSources() {
  return {
    all: [
      {
        label: "halo-xero-error.log",
        path: "/home/engageadmin/.pm2/logs/halo-xero-error.log"
      },
      {
        label: "halo-xero-admin-error.log",
        path: "/home/engageadmin/.pm2/logs/halo-xero-admin-error.log"
      },
      {
        label: "halo-xero-sync.log",
        path: "/var/log/halo-xero-sync.log"
      }
    ],
    widget: [
      {
        label: "halo-xero-error.log",
        path: "/home/engageadmin/.pm2/logs/halo-xero-error.log"
      }
    ],
    admin: [
      {
        label: "halo-xero-admin-error.log",
        path: "/home/engageadmin/.pm2/logs/halo-xero-admin-error.log"
      }
    ],
    sync: [
      {
        label: "halo-xero-sync.log",
        path: "/var/log/halo-xero-sync.log"
      }
    ]
  };
}

function collectInterestingLogLines(source = "all") {
  const sources = getLogSources()[source] || getLogSources().all;

  const interestingPatterns = [
    /error/i,
    /failed/i,
    /exception/i,
    /forbidden/i,
    /unauthorized/i,
    /authenticationunsuccessful/i,
    /tokenexpired/i,
    /no xero mapping found/i,
    /finance error/i,
    /❌/,
    /⚠️/
  ];

  const items = [];

  for (const sourceDef of sources) {
    const lines = tailLines(sourceDef.path, 400);

    for (const line of lines) {
      if (interestingPatterns.some((pattern) => pattern.test(line))) {
        items.push({
          source: sourceDef.label,
          line
        });
      }
    }
  }

  return items.slice(-15).reverse();
}

function readTokensMeta() {
  return {
    exists: true,
    mode: "Custom Connection",
    tenantName: process.env.XERO_TENANT_NAME || tokens.tenantName || "Xero Custom Connection",
    tenantId: process.env.XERO_TENANT_ID || tokens.tenantId || null,
    obtainedAt: tokens.expires_at ? new Date(Date.now()).toISOString() : null
  };
}

async function getDashboardStatus() {
  const status = {
    db: { state: "ok", label: "Healthy" },
    auth: { state: "unknown", label: "Unknown" },
    sync: { state: "unknown", label: "Unknown" }
  };

  // DB
  try {
    await pgPool.query("SELECT 1");
    status.db = { state: "ok", label: "Healthy" };
  } catch {
    status.db = { state: "error", label: "Database Error" };
  }

  // Auth
  try {
    const headers = await getXeroHeaders();
    await axios.get("https://api.xero.com/api.xro/2.0/Contacts", {
      headers,
      params: { where: 'Name=="__halo_xero_healthcheck__"' },
      timeout: 10000
    });
    status.auth = { state: "ok", label: "Custom Connection OK" };
  } catch (err) {
    const httpStatus = err.response?.status;
    if (httpStatus === 401 || httpStatus === 403) {
      status.auth = { state: "error", label: "Auth Broken" };
    } else {
      status.auth = { state: "warn", label: "Auth Check Failed" };
    }
  }

  return status;
}

function getSyncStatus(lastSyncIso) {
  if (!lastSyncIso) {
    return { state: "error", label: "Never Synced" };
  }

  const last = new Date(lastSyncIso).getTime();
  if (Number.isNaN(last)) {
    return { state: "warn", label: "Invalid Timestamp" };
  }

  const minutesOld = (Date.now() - last) / 1000 / 60;

  if (minutesOld <= 10) return { state: "ok", label: "Fresh" };
  if (minutesOld <= 20) return { state: "warn", label: "Aging" };
  return { state: "error", label: "Stale" };
}

// -------------------------------------------------
// LOGIN
// -------------------------------------------------
app.get("/admin/login", (_req, res) => {
  res.render("admin/login", { error: null });
});

app.post("/admin/login", (req, res) => {
  const { username, password } = req.body;

  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    req.session.admin = true;
    return res.redirect("/admin");
  }

  res.render("admin/login", {
    error: "Invalid username or password"
  });
});

// -------------------------------------------------
// LOGOUT
// -------------------------------------------------
app.get("/admin/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/admin/login");
  });
});

// -------------------------------------------------
// HEALTH CHECK
// -------------------------------------------------
app.get("/admin/health", requireAdminAuth, async (_req, res) => {
  try {
    await pgPool.query("SELECT 1");
    res.json({ status: "ok", db: "connected" });
  } catch {
    res.status(500).json({ status: "error" });
  }
});

// -------------------------------------------------
// ADMIN HOME
// -------------------------------------------------
app.get("/admin", requireAdminAuth, async (_req, res) => {
  try {
    const mappedResult = await pgPool.query(
      "SELECT COUNT(*)::int AS count FROM halo.halo_client WHERE xero_contact_guid IS NOT NULL"
    );

    const syncResult = await pgPool.query(`
      SELECT value, updated_at
      FROM halo.sync_state
      WHERE key = 'xero_contact_sync'
      LIMIT 1
    `);

    const mappedCount = mappedResult.rows[0]?.count || 0;
    const lastSync = syncResult.rows[0]?.value || null;
    const lastSyncUpdatedAt = syncResult.rows[0]?.updated_at || null;

    const tokenMeta = readTokensMeta();
    const dashboardStatus = await getDashboardStatus();
    const syncStatus = getSyncStatus(lastSync);

    res.render("admin/index", {
      mappedCount,
      lastSync,
      lastSyncHuman: formatLocalDate(lastSync),
      lastSyncUpdatedAt,
      tenantName: tokenMeta.tenantName,
      tenantId: tokenMeta.tenantId,
      obtainedAt: tokenMeta.obtainedAt,
      obtainedAtHuman: formatLocalDate(tokenMeta.obtainedAt),
      dbStatus: dashboardStatus.db,
      authStatus: dashboardStatus.auth,
      syncStatus
    });
  } catch (err) {
    console.error("❌ admin/index error", err);
    res.status(500).send("Failed to load admin dashboard");
  }
});

// -------------------------------------------------
// LOG VIEW
// -------------------------------------------------
app.get("/admin/logs", requireAdminAuth, async (req, res) => {
  try {
    const source = ["all", "widget", "admin", "sync"].includes(req.query.source)
      ? req.query.source
      : "all";

    const logs = collectInterestingLogLines(source);

    res.render("admin/logs", {
      logs,
      source
    });
  } catch (err) {
    console.error("❌ admin/logs error", err);
    res.status(500).send("Failed to load logs");
  }
});

// -------------------------------------------------
// EXCEPTIONS
// -------------------------------------------------
app.get("/admin/exceptions", requireAdminAuth, async (_req, res) => {
  try {
    const { rows: unmapped } = await pgPool.query(`
      SELECT
        halo_client_name,
        updated_at
      FROM halo.halo_client
      WHERE xero_contact_guid IS NULL
      ORDER BY halo_client_name
    `);

    const { rows: mapped } = await pgPool.query(`
      SELECT 1
      FROM halo.halo_client
      WHERE xero_contact_guid IS NOT NULL
    `);

    res.render("admin/exceptions", {
      unmapped,
      unmappedCount: unmapped.length,
      mappedCount: mapped.length
    });
  } catch (err) {
    console.error("❌ admin/exceptions error", err);
    res.status(500).send("Failed to load exceptions");
  }
});

// -------------------------------------------------
// DRIFT VIEW (DB-ONLY, FAST)
// -------------------------------------------------
app.get("/admin/drift", requireAdminAuth, async (_req, res) => {
  const { rows } = await pgPool.query(`
    SELECT
      halo_client_name,
      xero_client_name,
      xero_contact_guid,
      detected_at
    FROM halo.xero_drift
    ORDER BY detected_at DESC
    LIMIT 500
  `);

  res.render("admin/drift", {
    drifted: rows,
    driftCount: rows.length
  });
});

// -------------------------------------------------
// MANUAL SYNC BUTTON (TRIGGER)
// -------------------------------------------------
app.post("/admin/sync", requireAdminAuth, async (_req, res) => {
  try {
    console.log("🔁 Manual sync triggered");
    await runSync();
    console.log("✅ Manual sync completed");
  } catch (err) {
    console.error("❌ Manual sync failed:", err);
  }

  res.redirect("/admin");
});

// -------------------------------------------------
// FULL RESYNC
// -------------------------------------------------
app.post("/admin/sync/full", requireAdminAuth, async (_req, res) => {
  try {
    console.log("♻️ Full resync triggered");
    await pgPool.query(`
      UPDATE halo.sync_state
      SET value = '2000-01-01T00:00:00.000Z',
          updated_at = now()
      WHERE key = 'xero_contact_sync'
    `);

    await runSync();
    console.log("✅ Full resync completed");
  } catch (err) {
    console.error("❌ Full resync failed:", err);
  }

  res.redirect("/admin");
});

// -------------------------------------------------
// XERO CUSTOM CONNECTION CHECK
// -------------------------------------------------
app.get("/admin/xero/connect", requireAdminAuth, async (_req, res) => {
  try {
    console.log("🔐 Testing Xero Custom Connection", {
      clientIdSuffix: process.env.XERO_CLIENT_ID
        ? process.env.XERO_CLIENT_ID.slice(-6)
        : null
    });

    const headers = await getXeroHeaders();
    await axios.get("https://api.xero.com/api.xro/2.0/Contacts", {
      headers,
      params: { where: 'Name=="__halo_xero_healthcheck__"' },
      timeout: 10000
    });

    console.log("✅ Xero Custom Connection test complete.");
    return res.redirect("/admin");
  } catch (err) {
    console.error("❌ Xero Custom Connection test failed:", err.response?.data || err.message);
    return res.status(500).send("Xero Custom Connection test failed");
  }
});

app.get("/admin/xero/callback", requireAdminAuth, (_req, res) => {
  res.status(410).send("Xero Custom Connections do not use an OAuth callback.");
});

// -------------------------------------------------
// START
// -------------------------------------------------
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 3001);

app.listen(ADMIN_PORT, () => {
  console.log(`🚀 Admin portal running on port ${ADMIN_PORT}`);
});

// -------------------------------------------------
// METRICS GRAPH
// -------------------------------------------------
app.get("/admin/metrics", requireAdminAuth, async (_req, res) => {
  try {
    const { rows } = await pgPool.query(`
      SELECT
        recorded_at,
        total_clients,
        mapped_clients
      FROM halo.sync_metrics
      ORDER BY recorded_at ASC
      LIMIT 500
    `);

    res.render("admin/metrics", { data: rows });
  } catch (err) {
    console.error("❌ metrics error", err);
    res.status(500).send("Failed to load metrics");
  }
});
