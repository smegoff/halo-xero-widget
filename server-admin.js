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
import {
  clearAlertConfigOverride,
  clearHaloApiConfigOverride,
  clearGoCardlessAccessTokenOverride,
  getAlertSettings,
  getHaloApiSettings,
  getRuntimeConfig,
  updateAlertConfig,
  updateHaloApiConfig,
  updateGoCardlessAccessToken,
  updateRuntimeConfig
} from "./lib/config.js";
import {
  autoMapGoCardlessCustomersByXeroGuid,
  getGoCardlessAdminAnomalies,
  searchGoCardlessCustomersWithMandates,
  testGoCardlessConnection
} from "./lib/gocardless.js";
import { syncHaloDirectDebitFields } from "./lib/halo-direct-debit.js";
import { clearHaloTokenCache, getHaloConfigStatus, testHaloConnection } from "./lib/halo.js";
import {
  authenticateAdminLogin,
  createAdminUser,
  ensureAdminAuthTables,
  getAdminSecurityConfig,
  listAdminLoginAudits,
  listAdminUsers,
  setAdminUserActive,
  unlockAdminUser,
  updateAdminUserPassword
} from "./lib/admin-auth.js";
import { sendAdminAlert } from "./lib/alerts.js";
import {
  deleteGoCardlessMapping,
  listGoCardlessMappings,
  searchMappedHaloClients,
  upsertGoCardlessMapping
} from "./lib/gocardless-map.js";

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

app.use((req, res, next) => {
  res.locals.currentAdmin = req.session?.admin
    ? {
        id: req.session.adminUserId || null,
        username: req.session.adminUsername || "Admin"
      }
    : null;
  next();
});

// -------------------------------------------------
// AUTH MIDDLEWARE
// -------------------------------------------------
function requireAdminAuth(req, res, next) {
  if (req.session?.admin === true) return next();
  res.redirect("/admin/login");
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(err => {
      if (err) reject(err);
      else resolve();
    });
  });
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

const METRIC_RANGE_PRESETS = [
  { value: "7d", label: "7 days", days: 7 },
  { value: "30d", label: "30 days", days: 30 },
  { value: "90d", label: "90 days", days: 90 },
  { value: "1y", label: "1 year", days: 365 },
  { value: "all", label: "All time", days: null }
];

function toDateInputValue(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function isValidDateInput(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && toDateInputValue(parsed) === value;
}

function parseMetricsRange(query) {
  const today = new Date();
  const requestedRange = typeof query.range === "string" ? query.range : "";
  const knownPreset = METRIC_RANGE_PRESETS.find(preset => preset.value === requestedRange);
  const fromInput = typeof query.from === "string" ? query.from.trim() : "";
  const toInput = typeof query.to === "string" ? query.to.trim() : "";
  let customRangeError = null;

  if (requestedRange === "custom" || fromInput || toInput) {
    const from = isValidDateInput(fromInput) ? fromInput : "";
    const to = isValidDateInput(toInput) ? toInput : "";
    const error =
      (fromInput && !from) || (toInput && !to)
        ? "Use dates in YYYY-MM-DD format."
        : from && to && from > to
          ? "The start date must be before the end date."
          : null;
    customRangeError = error;

    if (!error) {
      return {
        range: "custom",
        label: "Custom range",
        from,
        to,
        error: null
      };
    }
  }

  const preset = knownPreset || METRIC_RANGE_PRESETS[1];
  if (preset.value === "all") {
    return {
      range: "all",
      label: "All time",
      from: "",
      to: "",
      error: null
    };
  }

  const to = toDateInputValue(today);
  const from = toDateInputValue(addDays(today, -(preset.days - 1)));

  return {
    range: preset.value,
    label: preset.label,
    from,
    to,
    error:
      requestedRange === "custom" || fromInput || toInput
        ? `${customRangeError || "Invalid custom range."} Showing the default 30 days.`
        : null
  };
}

function getMetricsBucket(filter) {
  if (filter.range === "7d") return { unit: "hour", label: "Hourly" };
  if (filter.range === "30d" || filter.range === "90d") return { unit: "day", label: "Daily" };
  if (filter.range === "1y") return { unit: "week", label: "Weekly" };
  if (filter.range === "all") return { unit: "month", label: "Monthly" };

  if (filter.from && filter.to) {
    const from = new Date(`${filter.from}T00:00:00.000Z`);
    const to = new Date(`${filter.to}T00:00:00.000Z`);
    const days = Math.floor((to.getTime() - from.getTime()) / 86400000) + 1;

    if (days <= 7) return { unit: "hour", label: "Hourly" };
    if (days <= 120) return { unit: "day", label: "Daily" };
    if (days <= 730) return { unit: "week", label: "Weekly" };
  }

  return { unit: "month", label: "Monthly" };
}

function buildMetricsSummary(rows, rawSamples = rows.length) {
  if (!rows.length) {
    return {
      samples: 0,
      rawSamples,
      firstRecordedAt: null,
      latestRecordedAt: null,
      latestTotalClients: null,
      latestMappedClients: null,
      totalClientDelta: null,
      mappedClientDelta: null,
      latestMappedPercent: null
    };
  }

  const first = rows[0];
  const latest = rows[rows.length - 1];
  const latestTotal = Number(latest.total_clients || 0);
  const latestMapped = Number(latest.mapped_clients || 0);

  return {
    samples: rows.length,
    rawSamples,
    firstRecordedAt: first.recorded_at,
    latestRecordedAt: latest.recorded_at,
    latestTotalClients: latestTotal,
    latestMappedClients: latestMapped,
    totalClientDelta: latestTotal - Number(first.total_clients || 0),
    mappedClientDelta: latestMapped - Number(first.mapped_clients || 0),
    latestMappedPercent: latestTotal > 0 ? (latestMapped / latestTotal) * 100 : null
  };
}

function popAdminFlash(req) {
  const flash = req.session?.flash || {};
  if (req.session) delete req.session.flash;
  return {
    success: flash.success || null,
    error: flash.error || null
  };
}

function popDirectDebitSyncResult(req) {
  const result = req.session?.directDebitSyncResult || null;
  if (req.session) delete req.session.directDebitSyncResult;
  return result;
}

let goCardlessAutoMapRunning = false;

async function notifyAdminAlert(alert) {
  try {
    await sendAdminAlert(alert);
  } catch (err) {
    console.warn("Admin alert delivery failed:", err.response?.status || err.message);
  }
}

async function runGoCardlessAutoMap(reason = "scheduled") {
  const runtimeConfig = getRuntimeConfig();
  if (!runtimeConfig.goCardlessAccessTokenConfigured) {
    console.log("GoCardless auto-map skipped: token is not configured.");
    return;
  }

  if (goCardlessAutoMapRunning) {
    console.log("GoCardless auto-map skipped: previous run is still active.");
    return;
  }

  goCardlessAutoMapRunning = true;
  try {
    const result = await autoMapGoCardlessCustomersByXeroGuid();
    console.log("GoCardless auto-map complete", {
      reason,
      activeMandatesScanned: result.activeMandatesScanned,
      candidatesFound: result.candidatesFound,
      mappingsCreated: result.mappingsCreated,
      skipped: result.skipped
    });

    try {
      const directDebitResult = await syncHaloDirectDebitFields();
      console.log("Halo Direct Debit custom-field sync complete", {
        reason,
        totalMappings: directDebitResult.totalMappings,
        updated: directDebitResult.updated,
        alreadyCurrent: directDebitResult.alreadyCurrent,
        skipped: directDebitResult.skipped,
        failed: directDebitResult.failed
      });
      if (directDebitResult.failed > 0) {
        await notifyAdminAlert({
          severity: "warning",
          title: "Halo Direct Debit field sync completed with failures",
          summary: "The scheduled Direct Debit custom-field sync completed but some rows failed.",
          facts: [
            { title: "Reason", value: reason },
            { title: "Failed", value: directDebitResult.failed },
            { title: "Skipped", value: directDebitResult.skipped }
          ]
        });
      }
    } catch (err) {
      console.warn("Halo Direct Debit custom-field sync failed:", err.response?.status || err.message);
      await notifyAdminAlert({
        severity: "error",
        title: "Halo Direct Debit field sync failed",
        summary: "The scheduled Direct Debit custom-field sync failed after GoCardless auto-map.",
        facts: [
          { title: "Reason", value: reason },
          { title: "Error", value: err.response?.status || err.message }
        ]
      });
    }
  } catch (err) {
    console.warn("GoCardless auto-map failed:", err.response?.status || err.message);
    await notifyAdminAlert({
      severity: "error",
      title: "GoCardless auto-map failed",
      summary: "The scheduled GoCardless active mandate auto-map failed.",
      facts: [
        { title: "Reason", value: reason },
        { title: "Error", value: err.response?.status || err.message }
      ]
    });
  } finally {
    goCardlessAutoMapRunning = false;
  }
}

function scheduleGoCardlessAutoMap(delaySeconds, reason) {
  const timer = setTimeout(async () => {
    await runGoCardlessAutoMap(reason);
    const runtimeConfig = getRuntimeConfig();
    scheduleGoCardlessAutoMap(runtimeConfig.goCardlessAutoMapIntervalSeconds, "scheduled");
  }, delaySeconds * 1000);

  timer.unref();
}

const LOG_RANGE_PRESETS = [
  { value: "1h", label: "1 hour", milliseconds: 60 * 60 * 1000 },
  { value: "6h", label: "6 hours", milliseconds: 6 * 60 * 60 * 1000 },
  { value: "24h", label: "24 hours", milliseconds: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "7 days", milliseconds: 7 * 24 * 60 * 60 * 1000 },
  { value: "all", label: "All time", milliseconds: null }
];

const LOG_SOURCES = {
  all: "All",
  widget: "Widget",
  admin: "Admin",
  sync: "Sync"
};

const LOG_SEVERITIES = {
  all: "All",
  error: "Errors",
  warning: "Warnings",
  info: "Info"
};

function readLogTail(filePath, maxBytes = 2_000_000) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }

    let raw = buffer.toString("utf8");
    if (start > 0) {
      const firstNewline = raw.indexOf("\n");
      raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
    }

    return raw.split(/\r?\n/).filter(Boolean);
  } catch (err) {
    return [`Failed to read ${filePath}: ${err.message}`];
  }
}

function getLogSources() {
  return {
    all: [
      {
        label: "halo-xero-out.log",
        path: "/home/engageadmin/.pm2/logs/halo-xero-out.log"
      },
      {
        label: "halo-xero-error.log",
        path: "/home/engageadmin/.pm2/logs/halo-xero-error.log"
      },
      {
        label: "halo-xero-admin-out.log",
        path: "/home/engageadmin/.pm2/logs/halo-xero-admin-out.log"
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
        label: "halo-xero-out.log",
        path: "/home/engageadmin/.pm2/logs/halo-xero-out.log"
      },
      {
        label: "halo-xero-error.log",
        path: "/home/engageadmin/.pm2/logs/halo-xero-error.log"
      }
    ],
    admin: [
      {
        label: "halo-xero-admin-out.log",
        path: "/home/engageadmin/.pm2/logs/halo-xero-admin-out.log"
      },
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

function parseLogLineTimestamp(line) {
  const patterns = [
    /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\]\s*(.*)$/,
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?):?\s*(.*)$/,
    /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:\s+[+-]\d{4})?)\s*(.*)$/
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (!match) continue;

    const parsed = new Date(match[1]);
    if (!Number.isNaN(parsed.getTime())) {
      return {
        timestamp: parsed,
        message: match[2] || ""
      };
    }
  }

  return {
    timestamp: null,
    message: line
  };
}

function getLogSeverity(message) {
  if (/error|failed|exception|forbidden|unauthorized|authenticationunsuccessful|tokenexpired|❌/i.test(message)) {
    return "error";
  }

  if (/warn|warning|⚠️/i.test(message)) {
    return "warning";
  }

  return "info";
}

function parseLogRange(query) {
  const requestedRange = typeof query.range === "string" ? query.range : "";
  const range = LOG_RANGE_PRESETS.some(preset => preset.value === requestedRange)
    ? requestedRange
    : "all";
  const fromInput = typeof query.from === "string" ? query.from.trim() : "";
  const toInput = typeof query.to === "string" ? query.to.trim() : "";
  const hasCustom = requestedRange === "custom" || fromInput || toInput;

  if (hasCustom) {
    const from = isValidDateInput(fromInput) ? fromInput : "";
    const to = isValidDateInput(toInput) ? toInput : "";
    const error =
      (fromInput && !from) || (toInput && !to)
        ? "Use dates in YYYY-MM-DD format."
        : from && to && from > to
          ? "The start date must be before the end date."
          : null;

    if (!error) {
      return {
        range: "custom",
        label: "Custom range",
        from,
        to,
        fromTime: from ? new Date(`${from}T00:00:00.000Z`) : null,
        toTime: to ? addDays(new Date(`${to}T00:00:00.000Z`), 1) : null,
        error: null
      };
    }

    if (requestedRange === "custom" && !fromInput && !toInput) {
      return {
        range: "custom",
        label: "Custom range",
        from: "",
        to: "",
        fromTime: null,
        toTime: null,
        error: null
      };
    }
  }

  const preset = LOG_RANGE_PRESETS.find(item => item.value === range) || LOG_RANGE_PRESETS.at(-1);
  if (preset.value === "all") {
    return {
      range: "all",
      label: preset.label,
      from: "",
      to: "",
      fromTime: null,
      toTime: null,
      error: hasCustom ? "Invalid custom range. Showing all time." : null
    };
  }

  const now = new Date();
  return {
    range: preset.value,
    label: preset.label,
    from: "",
    to: "",
    fromTime: new Date(now.getTime() - preset.milliseconds),
    toTime: now,
    error: null
  };
}

function parseLogFilters(query) {
  return {
    source: Object.hasOwn(LOG_SOURCES, query.source) ? query.source : "all",
    severity: Object.hasOwn(LOG_SEVERITIES, query.severity) ? query.severity : "all",
    q: typeof query.q === "string" ? query.q.trim().slice(0, 120) : "",
    includeLegacy: query.includeLegacy === "1" || !query.range || query.range === "all",
    range: parseLogRange(query)
  };
}

function collectLogEntries(filters) {
  const sources = getLogSources()[filters.source] || getLogSources().all;
  const query = filters.q.toLowerCase();
  const entries = [];
  let sequence = 0;
  let scannedLines = 0;

  for (const sourceDef of sources) {
    const lines = readLogTail(sourceDef.path);
    const stat = fs.existsSync(sourceDef.path) ? fs.statSync(sourceDef.path) : null;

    lines.forEach((line, index) => {
      scannedLines += 1;
      const parsed = parseLogLineTimestamp(line);
      const severity = getLogSeverity(parsed.message);
      const searchable = `${sourceDef.label} ${severity} ${parsed.message}`.toLowerCase();

      if (filters.severity !== "all" && filters.severity !== severity) return;
      if (query && !searchable.includes(query)) return;

      if (filters.range.fromTime || filters.range.toTime) {
        if (!parsed.timestamp) {
          if (!filters.includeLegacy) return;
        } else {
          if (filters.range.fromTime && parsed.timestamp < filters.range.fromTime) return;
          if (filters.range.toTime && parsed.timestamp >= filters.range.toTime) return;
        }
      }

      entries.push({
        id: `${sourceDef.label}-${index}`,
        source: sourceDef.label,
        sourcePath: sourceDef.path,
        sourceModifiedAt: stat?.mtime || null,
        lineNumber: index + 1,
        sequence: sequence++,
        timestamp: parsed.timestamp,
        hasTimestamp: Boolean(parsed.timestamp),
        severity,
        message: parsed.message
      });
    });
  }

  entries.sort((a, b) => {
    if (a.timestamp && b.timestamp) return b.timestamp - a.timestamp;
    if (a.timestamp) return -1;
    if (b.timestamp) return 1;
    return b.sequence - a.sequence;
  });

  return {
    entries: entries.slice(0, 500),
    totalMatches: entries.length,
    scannedLines
  };
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
    goCardless: { state: "unknown", label: "Unknown" },
    halo: { state: "unknown", label: "Unknown" },
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

  // GoCardless
  try {
    const runtimeConfig = getRuntimeConfig();
    if (!runtimeConfig.goCardlessAccessTokenConfigured) {
      status.goCardless = { state: "warn", label: "Not Configured" };
    } else {
      await testGoCardlessConnection();
      status.goCardless = { state: "ok", label: "Live API OK" };
    }
  } catch {
    status.goCardless = { state: "error", label: "API Check Failed" };
  }

  // Halo
  try {
    const haloConfig = getHaloConfigStatus();
    if (!haloConfig.configured) {
      status.halo = { state: "warn", label: "Not Configured" };
    } else {
      await testHaloConnection();
      status.halo = { state: "ok", label: "API OK" };
    }
  } catch {
    status.halo = { state: "error", label: "API Check Failed" };
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

app.post("/admin/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await authenticateAdminLogin({
      username,
      password,
      ipAddress: req.ip,
      userAgent: req.get("user-agent")
    });

    if (!result.ok) {
      return res.render("admin/login", {
        error: result.message || "Invalid username or password"
      });
    }

    await regenerateSession(req);
    req.session.admin = true;
    req.session.adminUserId = result.user.id;
    req.session.adminUsername = result.user.username;
    return res.redirect("/admin");
  } catch (err) {
    console.error("❌ admin/login error", err);
    return res.render("admin/login", {
      error: "Login is temporarily unavailable."
    });
  }
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
// ADMIN USERS AND AUDIT
// -------------------------------------------------
app.get("/admin/users", requireAdminAuth, async (req, res) => {
  try {
    const [users, audits] = await Promise.all([
      listAdminUsers(),
      listAdminLoginAudits(100)
    ]);

    res.render("admin/users", {
      users,
      audits,
      securityConfig: getAdminSecurityConfig(),
      currentAdminUserId: req.session.adminUserId || null,
      flash: popAdminFlash(req)
    });
  } catch (err) {
    console.error("❌ admin/users error", err);
    res.status(500).send("Failed to load admin users");
  }
});

app.post("/admin/users", requireAdminAuth, async (req, res) => {
  try {
    await createAdminUser({
      username: req.body.username,
      password: req.body.password
    });
    req.session.flash = { success: "Admin user created." };
  } catch (err) {
    req.session.flash = {
      error: err.message || "Admin user could not be created."
    };
  }

  res.redirect("/admin/users");
});

app.post("/admin/users/:id/password", requireAdminAuth, async (req, res) => {
  try {
    await updateAdminUserPassword({
      userId: req.params.id,
      password: req.body.password
    });
    req.session.flash = { success: "Admin password updated and account lockout cleared." };
  } catch (err) {
    req.session.flash = {
      error: err.message || "Admin password could not be updated."
    };
  }

  res.redirect("/admin/users");
});

app.post("/admin/users/:id/unlock", requireAdminAuth, async (req, res) => {
  try {
    await unlockAdminUser(req.params.id);
    req.session.flash = { success: "Admin user unlocked." };
  } catch (err) {
    req.session.flash = {
      error: err.message || "Admin user could not be unlocked."
    };
  }

  res.redirect("/admin/users");
});

app.post("/admin/users/:id/active", requireAdminAuth, async (req, res) => {
  try {
    const targetUserId = Number.parseInt(req.params.id, 10);
    const isActive = req.body.isActive === "true";
    if (targetUserId === req.session.adminUserId && !isActive) {
      throw new Error("You cannot disable your own active admin account.");
    }

    await setAdminUserActive({
      userId: targetUserId,
      isActive
    });
    req.session.flash = { success: isActive ? "Admin user enabled." : "Admin user disabled." };
  } catch (err) {
    req.session.flash = {
      error: err.message || "Admin user status could not be changed."
    };
  }

  res.redirect("/admin/users");
});

// -------------------------------------------------
// ADMIN ALERTS
// -------------------------------------------------
app.get("/admin/alerts", requireAdminAuth, async (req, res) => {
  res.render("admin/alerts", {
    alertSettings: getAlertSettings(),
    flash: popAdminFlash(req)
  });
});

app.post("/admin/alerts/config", requireAdminAuth, async (req, res) => {
  try {
    updateAlertConfig({
      alertsEnabled: req.body.alertsEnabled,
      teamsWebhookUrl: req.body.teamsWebhookUrl
    });
    req.session.flash = {
      success: "Alert settings saved."
    };
  } catch (err) {
    req.session.flash = {
      error: err.message || "Alert settings could not be saved."
    };
  }

  res.redirect("/admin/alerts");
});

app.post("/admin/alerts/config/clear", requireAdminAuth, async (req, res) => {
  try {
    clearAlertConfigOverride();
    req.session.flash = {
      success: "Alert admin override cleared. The app will use .env values if present."
    };
  } catch (err) {
    req.session.flash = {
      error: err.message || "Alert settings could not be cleared."
    };
  }

  res.redirect("/admin/alerts");
});

app.post("/admin/alerts/test", requireAdminAuth, async (req, res) => {
  try {
    const result = await sendAdminAlert({
      severity: "info",
      title: "Halo Xero Widget test alert",
      summary: "This is a test alert from the admin console.",
      facts: [
        { title: "Triggered by", value: req.session.adminUsername || "Admin" },
        { title: "Time", value: new Date().toISOString() }
      ]
    });

    req.session.flash = {
      success: result.sent
        ? "Test alert sent to Teams."
        : `Test alert skipped: ${result.reason}.`
    };
  } catch (err) {
    req.session.flash = {
      error: `Test alert failed: ${err.response?.status || err.message}`
    };
  }

  res.redirect("/admin/alerts");
});

async function getAdminOverview() {
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
  const runtimeConfig = getRuntimeConfig();

  return {
    mappedCount,
    lastSync,
    lastSyncHuman: formatLocalDate(lastSync),
    lastSyncUpdatedAt,
    tokenMeta,
    dashboardStatus,
    syncStatus,
    runtimeConfig,
    haloConfig: getHaloConfigStatus()
  };
}

// -------------------------------------------------
// HEALTH CHECK
// -------------------------------------------------
app.get("/admin/health.json", requireAdminAuth, async (_req, res) => {
  try {
    const overview = await getAdminOverview();
    const health = {
      status: Object.values({
        db: overview.dashboardStatus.db,
        xero: overview.dashboardStatus.auth,
        goCardless: overview.dashboardStatus.goCardless,
        halo: overview.dashboardStatus.halo,
        sync: overview.syncStatus
      }).some(item => item.state === "error")
        ? "error"
        : "ok",
      checks: {
        database: overview.dashboardStatus.db,
        xero: overview.dashboardStatus.auth,
        goCardless: overview.dashboardStatus.goCardless,
        halo: overview.dashboardStatus.halo,
        sync: overview.syncStatus
      },
      lastSync: overview.lastSync,
      mappedClients: overview.mappedCount
    };

    res.status(health.status === "ok" ? 200 : 500).json(health);
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

app.get("/admin/health", requireAdminAuth, async (req, res) => {
  try {
    const overview = await getAdminOverview();
    res.render("admin/health", {
      checks: [
        {
          name: "Database",
          status: overview.dashboardStatus.db,
          detail: "PostgreSQL connection and admin session storage."
        },
        {
          name: "Xero",
          status: overview.dashboardStatus.auth,
          detail: `Tenant: ${overview.tokenMeta.tenantName || "Not available"}`
        },
        {
          name: "GoCardless",
          status: overview.dashboardStatus.goCardless,
          detail: `Token source: ${overview.runtimeConfig.goCardlessAccessTokenSource}`
        },
        {
          name: "Halo API",
          status: overview.dashboardStatus.halo,
          detail: `Tenant: ${overview.haloConfig.tenant || "Not available"}`
        },
        {
          name: "Xero Contact Sync",
          status: overview.syncStatus,
          detail: `Last sync: ${overview.lastSyncHuman || "Not available"}`
        }
      ],
      mappedCount: overview.mappedCount,
      lastSyncHuman: overview.lastSyncHuman,
      lastSyncUpdatedAt: overview.lastSyncUpdatedAt,
      runtimeConfig: overview.runtimeConfig,
      flash: popAdminFlash(req)
    });
  } catch (err) {
    console.error("❌ admin/health error", err);
    res.status(500).send("Failed to load health check");
  }
});

// -------------------------------------------------
// ADMIN HOME
// -------------------------------------------------
app.get("/admin", requireAdminAuth, async (_req, res) => {
  try {
    const overview = await getAdminOverview();

    res.render("admin/index", {
      mappedCount: overview.mappedCount,
      lastSync: overview.lastSync,
      lastSyncHuman: overview.lastSyncHuman,
      lastSyncUpdatedAt: overview.lastSyncUpdatedAt,
      tenantName: overview.tokenMeta.tenantName,
      tenantId: overview.tokenMeta.tenantId,
      obtainedAt: overview.tokenMeta.obtainedAt,
      obtainedAtHuman: formatLocalDate(overview.tokenMeta.obtainedAt),
      dbStatus: overview.dashboardStatus.db,
      authStatus: overview.dashboardStatus.auth,
      goCardlessStatus: overview.dashboardStatus.goCardless,
      haloStatus: overview.dashboardStatus.halo,
      haloConfig: overview.haloConfig,
      syncStatus: overview.syncStatus,
      runtimeConfig: overview.runtimeConfig,
      flash: popAdminFlash(_req)
    });
  } catch (err) {
    console.error("❌ admin/index error", err);
    res.status(500).send("Failed to load admin dashboard");
  }
});

// -------------------------------------------------
// RUNTIME CONFIGURATION
// -------------------------------------------------
app.post("/admin/config/runtime", requireAdminAuth, async (req, res) => {
  try {
    const runtimeConfig = updateRuntimeConfig({
      financeCacheTtlSeconds: req.body.financeCacheTtlSeconds,
      exportTokenTtlSeconds: req.body.exportTokenTtlSeconds,
      goCardlessAutoMapIntervalSeconds: req.body.goCardlessAutoMapIntervalSeconds
    });

    req.session.flash = {
      success: `Runtime configuration saved. Finance cache TTL is ${runtimeConfig.financeCacheTtlHuman}; export links expire after ${runtimeConfig.exportTokenTtlHuman}; GoCardless auto-map runs every ${runtimeConfig.goCardlessAutoMapIntervalHuman}.`
    };
  } catch (err) {
    req.session.flash = {
      error: err.message || "Runtime configuration could not be saved."
    };
  }

  res.redirect("/admin#runtime-config");
});

// -------------------------------------------------
// GOCARDLESS
// -------------------------------------------------
app.get("/admin/gocardless", requireAdminAuth, async (req, res) => {
  try {
    const runtimeConfig = getRuntimeConfig();
    const [mappings, haloMatches, goCardlessMatches] = await Promise.all([
      listGoCardlessMappings(),
      searchMappedHaloClients(req.query.halo || ""),
      runtimeConfig.goCardlessAccessTokenConfigured
        ? searchGoCardlessCustomersWithMandates(req.query.gc || "")
        : Promise.resolve([])
    ]);

    res.render("admin/gocardless", {
      runtimeConfig,
      mappings,
      haloMatches,
      goCardlessMatches,
      haloQuery: req.query.halo || "",
      goCardlessQuery: req.query.gc || "",
      flash: popAdminFlash(req)
    });
  } catch (err) {
    console.error("❌ admin/gocardless error", err);
    res.status(500).send("Failed to load GoCardless settings");
  }
});

// -------------------------------------------------
// HALO PSA API
// -------------------------------------------------
app.get("/admin/PSA", requireAdminAuth, async (req, res) => {
  try {
    const haloConfig = getHaloApiSettings();
    let haloTest = null;

    if (haloConfig.configured) {
      try {
        haloTest = await testHaloConnection();
      } catch (err) {
        haloTest = {
          ok: false,
          status: err.response?.status || null,
          message: err.message
        };
      }
    }

    res.render("admin/psa", {
      haloConfig,
      haloTest,
      flash: popAdminFlash(req),
      directDebitSyncResult: popDirectDebitSyncResult(req)
    });
  } catch (err) {
    console.error("❌ admin/PSA error", err);
    res.status(500).send("Failed to load Halo PSA settings");
  }
});

app.post("/admin/PSA/config", requireAdminAuth, async (req, res) => {
  try {
    updateHaloApiConfig({
      resourceServerUrl: req.body.resourceServerUrl,
      authServerUrl: req.body.authServerUrl,
      tenant: req.body.tenant,
      clientId: req.body.clientId,
      clientSecret: req.body.clientSecret,
      scopes: req.body.scopes
    });
    clearHaloTokenCache();
    req.session.flash = {
      success: "Halo API configuration saved. The new settings will be used immediately."
    };
  } catch (err) {
    req.session.flash = {
      error: err.message || "Halo API configuration could not be saved."
    };
  }

  res.redirect("/admin/PSA");
});

app.post("/admin/PSA/config/clear", requireAdminAuth, async (req, res) => {
  try {
    clearHaloApiConfigOverride();
    clearHaloTokenCache();
    req.session.flash = {
      success: "Halo API admin override cleared. The app will use .env values if present."
    };
  } catch (err) {
    req.session.flash = {
      error: err.message || "Halo API admin override could not be cleared."
    };
  }

  res.redirect("/admin/PSA");
});

app.get("/admin/PSA/test", requireAdminAuth, async (req, res) => {
  try {
    const result = await testHaloConnection();
    req.session.flash = {
      success: `Halo API check passed. ${result.recordCount} clients visible to this API application.`
    };
  } catch (err) {
    req.session.flash = {
      error: `Halo API check failed: ${err.response?.status || err.message}`
    };
  }

  res.redirect("/admin/PSA");
});

app.post("/admin/PSA/direct-debit-sync", requireAdminAuth, async (req, res) => {
  try {
    const dryRun = req.body.mode !== "apply";
    const result = await syncHaloDirectDebitFields({ dryRun });
    req.session.directDebitSyncResult = {
      dryRun,
      totalMappings: result.totalMappings,
      updated: result.updated,
      wouldUpdate: result.wouldUpdate,
      alreadyCurrent: result.alreadyCurrent,
      skipped: result.skipped,
      failed: result.failed,
      skippedItems: result.results
        .filter(item => item.skipped || item.reason === "failed")
        .slice(0, 10)
        .map(item => ({
          reason: item.reason,
          haloClientName: item.haloClientName,
          xeroContactGuid: item.xeroContactGuid,
          error: item.error
        }))
    };
    req.session.flash = {
      success: dryRun
        ? `Direct Debit dry run complete. ${result.wouldUpdate} would be updated; ${result.alreadyCurrent} already current; ${result.skipped} skipped; ${result.failed} failed.`
        : `Direct Debit sync complete. ${result.updated} updated; ${result.alreadyCurrent} already current; ${result.skipped} skipped; ${result.failed} failed.`
    };
  } catch (err) {
    req.session.flash = {
      error: `Direct Debit sync failed: ${err.response?.status || err.message}`
    };
    await notifyAdminAlert({
      severity: "error",
      title: "Manual Direct Debit sync failed",
      summary: "A manually triggered Halo Direct Debit custom-field sync failed.",
      facts: [
        { title: "Error", value: err.response?.status || err.message }
      ]
    });
  }

  res.redirect("/admin/PSA");
});

app.get("/admin/gocardless/exceptions", requireAdminAuth, async (req, res) => {
  try {
    const runtimeConfig = getRuntimeConfig();
    const goCardlessAnomalies = runtimeConfig.goCardlessAccessTokenConfigured
      ? await getGoCardlessAdminAnomalies()
      : {
          configured: false,
          problemMandates: [],
          problemPayments: [],
          duplicateCustomerGroups: []
        };

    res.render("admin/gocardless-exceptions", {
      runtimeConfig,
      goCardlessAnomalies,
      flash: popAdminFlash(req)
    });
  } catch (err) {
    console.error("❌ admin/gocardless/exceptions error", err.response?.status || err.message);
    res.status(500).send("Failed to load GoCardless exceptions");
  }
});

app.post("/admin/gocardless/token", requireAdminAuth, async (req, res) => {
  try {
    updateGoCardlessAccessToken(req.body.goCardlessAccessToken);
    req.session.flash = {
      success: "GoCardless access token saved. The widget will use it immediately."
    };
  } catch (err) {
    req.session.flash = {
      error: err.message || "GoCardless access token could not be saved."
    };
  }

  res.redirect("/admin/gocardless");
});

app.post("/admin/gocardless/token/clear", requireAdminAuth, async (req, res) => {
  try {
    clearGoCardlessAccessTokenOverride();
    req.session.flash = {
      success: "GoCardless admin token override cleared. The app will use .env if present."
    };
  } catch (err) {
    req.session.flash = {
      error: err.message || "GoCardless token override could not be cleared."
    };
  }

  res.redirect("/admin/gocardless");
});

app.get("/admin/gocardless/test", requireAdminAuth, async (req, res) => {
  try {
    await testGoCardlessConnection();
    req.session.flash = { success: "GoCardless live API check passed." };
  } catch (err) {
    req.session.flash = {
      error: `GoCardless live API check failed: ${err.response?.status || err.message}`
    };
  }

  res.redirect("/admin/gocardless");
});

app.post("/admin/gocardless/auto-map", requireAdminAuth, async (req, res) => {
  try {
    const result = await autoMapGoCardlessCustomersByXeroGuid();
    req.session.flash = {
      success: `Auto-map complete. ${result.mappingsCreated} new mappings created from ${result.activeMandatesScanned} active mandates; ${result.candidatesFound} safe candidates found.`
    };
  } catch (err) {
    req.session.flash = {
      error: `GoCardless auto-map failed: ${err.response?.status || err.message}`
    };
    await notifyAdminAlert({
      severity: "error",
      title: "Manual GoCardless auto-map failed",
      summary: "A manually triggered GoCardless active mandate auto-map failed.",
      facts: [
        { title: "Error", value: err.response?.status || err.message }
      ]
    });
  }

  res.redirect("/admin/gocardless");
});

app.post("/admin/gocardless/mappings", requireAdminAuth, async (req, res) => {
  try {
    await upsertGoCardlessMapping({
      xeroContactGuid: req.body.xeroContactGuid,
      goCardlessCustomerId: req.body.goCardlessCustomerId,
      haloClientName: req.body.haloClientName,
      notes: req.body.notes
    });
    req.session.flash = { success: "GoCardless customer mapping saved." };
  } catch (err) {
    req.session.flash = {
      error: err.message || "GoCardless customer mapping could not be saved."
    };
  }

  res.redirect("/admin/gocardless");
});

app.post("/admin/gocardless/mappings/delete", requireAdminAuth, async (req, res) => {
  try {
    await deleteGoCardlessMapping(req.body.xeroContactGuid);
    req.session.flash = { success: "GoCardless customer mapping removed." };
  } catch (err) {
    req.session.flash = {
      error: err.message || "GoCardless customer mapping could not be removed."
    };
  }

  res.redirect("/admin/gocardless");
});

// -------------------------------------------------
// LOG VIEW
// -------------------------------------------------
app.get("/admin/logs", requireAdminAuth, async (req, res) => {
  try {
    const filters = parseLogFilters(req.query);
    const result = collectLogEntries(filters);

    res.render("admin/logs", {
      logs: result.entries,
      totalMatches: result.totalMatches,
      scannedLines: result.scannedLines,
      filters,
      sourceOptions: LOG_SOURCES,
      severityOptions: LOG_SEVERITIES,
      rangeOptions: LOG_RANGE_PRESETS
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
    await notifyAdminAlert({
      severity: "error",
      title: "Manual Xero sync failed",
      summary: "A manually triggered Xero contact sync failed.",
      facts: [
        { title: "Error", value: err.response?.status || err.message }
      ]
    });
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
    await notifyAdminAlert({
      severity: "error",
      title: "Full Xero resync failed",
      summary: "A manually triggered full Xero contact resync failed.",
      facts: [
        { title: "Error", value: err.response?.status || err.message }
      ]
    });
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
// HALO API CHECK
// -------------------------------------------------
app.get("/admin/halo/test", requireAdminAuth, async (req, res) => {
  try {
    const result = await testHaloConnection();
    req.session.flash = {
      success: `Halo API check passed. ${result.recordCount} clients visible to this API application.`
    };
  } catch (err) {
    req.session.flash = {
      error: `Halo API check failed: ${err.response?.status || err.message}`
    };
  }

  res.redirect("/admin/PSA");
});

// -------------------------------------------------
// START
// -------------------------------------------------
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 3001);

app.listen(ADMIN_PORT, () => {
  console.log(`🚀 Admin portal running on port ${ADMIN_PORT}`);
  ensureAdminAuthTables().catch(err => {
    console.error("❌ Admin auth initialisation failed:", err.message);
  });
  scheduleGoCardlessAutoMap(60, "startup");
});

// -------------------------------------------------
// METRICS GRAPH
// -------------------------------------------------
app.get("/admin/metrics", requireAdminAuth, async (req, res) => {
  try {
    const filter = parseMetricsRange(req.query);
    const params = [];
    const where = [];

    if (filter.from) {
      params.push(filter.from);
      where.push(`recorded_at >= $${params.length}::date`);
    }

    if (filter.to) {
      params.push(filter.to);
      where.push(`recorded_at < ($${params.length}::date + INTERVAL '1 day')`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const bucket = getMetricsBucket(filter);
    const { rows: filteredCountRows } = await pgPool.query(
      `SELECT COUNT(*)::int AS filtered_samples FROM halo.sync_metrics ${whereSql}`,
      params
    );
    const filteredSamples = filteredCountRows[0]?.filtered_samples || 0;
    const bucketedParams = [...params, bucket.unit];
    const bucketParam = `$${bucketedParams.length}`;
    const { rows } = await pgPool.query(`
      WITH filtered_metrics AS (
        SELECT
          recorded_at,
          total_clients,
          mapped_clients
        FROM halo.sync_metrics
        ${whereSql}
      ),
      bucketed_metrics AS (
        SELECT
          date_trunc(${bucketParam}, recorded_at) AS bucket_start,
          recorded_at,
          total_clients,
          mapped_clients,
          row_number() OVER (
            PARTITION BY date_trunc(${bucketParam}, recorded_at)
            ORDER BY recorded_at DESC
          ) AS bucket_rank
        FROM filtered_metrics
      )
      SELECT
        bucket_start,
        recorded_at,
        total_clients,
        mapped_clients
      FROM bucketed_metrics
      WHERE bucket_rank = 1
      ORDER BY recorded_at ASC
      LIMIT 5000
    `, bucketedParams);

    const { rows: allStatsRows } = await pgPool.query(`
      SELECT
        COUNT(*)::int AS total_samples,
        MIN(recorded_at) AS first_recorded_at,
        MAX(recorded_at) AS latest_recorded_at
      FROM halo.sync_metrics
    `);

    res.render("admin/metrics", {
      data: rows,
      filter,
      bucket,
      presets: METRIC_RANGE_PRESETS,
      summary: buildMetricsSummary(rows, filteredSamples),
      allStats: allStatsRows[0] || {
        total_samples: 0,
        first_recorded_at: null,
        latest_recorded_at: null
      },
      maxSamples: 5000
    });
  } catch (err) {
    console.error("❌ metrics error", err);
    res.status(500).send("Failed to load metrics");
  }
});
