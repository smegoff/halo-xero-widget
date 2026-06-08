// server.js — Halo ↔ Xero Widget (DB-backed GUID, invoices only)
// -------------------------------------------------------------

import express from "express";
import axios from "axios";
import NodeCache from "node-cache";
import dotenv from "dotenv";
import ejs from "ejs";
import crypto from "crypto";
import puppeteer from "puppeteer";
import ExcelJS from "exceljs";

import { validateHaloHmac } from "./lib/hmac.js";
import { getXeroHeaders, tokens } from "./lib/xero.js";
import { resolveXeroContactGuid } from "./lib/resolver.js";
import { getRuntimeConfig } from "./lib/config.js";

dotenv.config();
console.log("🔥 SERVER.JS LOADED — WIDGET STABLE BUILD —", new Date().toISOString());

// -------------------------------------------------
// APP SETUP
// -------------------------------------------------
const app = express();
app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// -------------------------------------------------
// CACHE (used by finance view + PDF / Excel exports)
// -------------------------------------------------
const cache = new NodeCache({
  stdTTL: 0,
  useClones: false
});
const inFlightFinanceRequests = new Map();

// -------------------------------------------------
// ROOT
// -------------------------------------------------
app.get("/", (_req, res) => {
  res.send("✅ Halo ↔ Xero Widget Online");
});

// -------------------------------------------------
// XERO SAFE FETCH (handles 429 rate limiting)
// -------------------------------------------------
async function fetchWithRetry(fn, retries = 1, delayMs = 2000) {
  try {
    return await fn();
  } catch (err) {
    if (err.response?.status === 429 && retries > 0) {
      console.warn("⏳ Xero rate limit hit — retrying in 2s");
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return fetchWithRetry(fn, retries - 1, delayMs);
    }
    throw err;
  }
}

function getExportSecret() {
  return process.env.EXPORT_TOKEN_SECRET || process.env.HMAC_SECRET;
}

function safeEqual(a, b) {
  const aBuffer = Buffer.from(String(a));
  const bBuffer = Buffer.from(String(b));
  return aBuffer.length === bBuffer.length && crypto.timingSafeEqual(aBuffer, bBuffer);
}

function signExportToken(cacheKey, agentId) {
  const secret = getExportSecret();
  if (!secret) return null;

  const runtimeConfig = getRuntimeConfig();
  const payload = Buffer.from(
    JSON.stringify({
      key: cacheKey,
      agentId: String(agentId || ""),
      exp: Date.now() + runtimeConfig.exportTokenTtlSeconds * 1000
    })
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function verifyExportToken(req) {
  const secret = getExportSecret();
  const token = req.query.token;
  const cacheKey = req.query.key;
  const agentId = req.query.agentId;

  if (!secret || !token || !cacheKey || !agentId) return false;

  const [payload, receivedSignature] = String(token).split(".");
  if (!payload || !receivedSignature) return false;

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  if (!safeEqual(receivedSignature, expectedSignature)) return false;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return (
      parsed.key === cacheKey &&
      String(parsed.agentId) === String(agentId) &&
      Number(parsed.exp) > Date.now()
    );
  } catch {
    return false;
  }
}

function getFinanceCacheKey(contactId) {
  return `finance:${contactId}`;
}

function isFinanceCacheEntryFresh(cached, ttlSeconds) {
  if (!cached?.fetchedAt) return false;

  const fetchedAt = new Date(cached.fetchedAt).getTime();
  if (!Number.isFinite(fetchedAt)) return false;

  return Date.now() - fetchedAt <= ttlSeconds * 1000;
}

function parseDateOnlyUtc(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function getTodayUtcDateOnly() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function getAgeBucket(dueDate, balance, today) {
  if (!dueDate || balance <= 0) return "";

  const daysOverdue = Math.floor((today - dueDate) / 86_400_000);
  if (daysOverdue <= 0) return "Current";
  if (daysOverdue <= 30) return "1-30";
  if (daysOverdue <= 60) return "31-60";
  if (daysOverdue <= 90) return "61-90";
  return "90+";
}

function safeDownloadName(clientName, extension) {
  const base = String(clientName || "Xero_Statement")
    .replace(/[^\w\s.-]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 120);

  return `${base || "Xero_Statement"}${extension}`;
}

function logFinanceRequest(req, haloClientName, cacheStatus) {
  console.log("🟢 /finance", {
    area: haloClientName || null,
    agentId: req.query.agentId || null,
    hasHmac: Boolean(req.query.hmac),
    refresh: req.query.refresh === "1",
    cache: cacheStatus
  });
}

async function fetchFinanceData(contactId, haloClientName) {
  const headers = await getXeroHeaders();

  const inv = await fetchWithRetry(() =>
    axios.get("https://api.xero.com/api.xro/2.0/Invoices", {
      headers,
      params: {
        where: `Contact.ContactID==Guid("${contactId}")`,
        order: "Date DESC"
      }
    })
  );

  const rows = [];
  let accountBal = 0;
  let overdueBal = 0;
  const today = getTodayUtcDateOnly();

  for (const d of inv.data.Invoices || []) {
    const balance = Number(d.AmountDue ?? 0);
    const total = Number(d.Total ?? 0);
    const dueDateStr = d.DueDateString?.slice(0, 10);
    const dueDate = parseDateOnlyUtc(dueDateStr);

    accountBal += balance;
    if (dueDate && balance > 0 && dueDate < today) overdueBal += balance;

    rows.push({
      name: d.Contact?.Name,
      date: d.DateString?.slice(0, 10),
      type: "Invoice",
      number: d.InvoiceNumber,
      due: dueDateStr,
      ageBucket: getAgeBucket(dueDate, balance, today),
      total,
      balance
    });
  }

  return {
    clientName: haloClientName,
    rows,
    accountBal: accountBal.toFixed(2),
    overdueBal: overdueBal.toFixed(2),
    asAt: new Date().toLocaleString("en-NZ"),
    fetchedAt: new Date().toISOString()
  };
}

async function getCachedFinanceData(contactId, haloClientName, forceRefresh = false) {
  const cacheKey = getFinanceCacheKey(contactId);
  const runtimeConfig = getRuntimeConfig();

  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (isFinanceCacheEntryFresh(cached, runtimeConfig.financeCacheTtlSeconds)) {
      return { data: cached, cacheKey, cacheStatus: "hit" };
    } else if (cached) {
      cache.del(cacheKey);
    }

    if (inFlightFinanceRequests.has(cacheKey)) {
      const data = await inFlightFinanceRequests.get(cacheKey);
      return { data, cacheKey, cacheStatus: "shared" };
    }
  }

  const request = fetchFinanceData(contactId, haloClientName)
    .then(data => {
      cache.set(cacheKey, data, runtimeConfig.financeCacheTtlSeconds);
      return data;
    })
    .finally(() => {
      if (inFlightFinanceRequests.get(cacheKey) === request) {
        inFlightFinanceRequests.delete(cacheKey);
      }
    });

  inFlightFinanceRequests.set(cacheKey, request);
  const data = await request;
  return { data, cacheKey, cacheStatus: forceRefresh ? "refresh" : "miss" };
}

// -------------------------------------------------
// HALO "AREA" FIXER
// If Halo sends: area=Leanne & Stu Christensen
// Express parses: { area:"Leanne ", " Stu Christensen":"", ... }
// This rebuilds area into "Leanne & Stu Christensen".
// -------------------------------------------------
function getHaloArea(req) {
  const q = req.query || {};
  let area = q.area;

  // If area is missing entirely, return null
  if (!area) return null;

  // If Halo failed to URL-encode '&', Express splits the query into extra keys.
  // We detect "unknown" keys with empty values and treat them as a continuation of area.
  const ignoreKeys = new Set(["area", "agentId", "hmac", "haloClientId", "clientId"]);
  const extraParts = [];

  for (const [k, v] of Object.entries(q)) {
    if (ignoreKeys.has(k)) continue;

    // Halo split values show up as " <rest of name>": "" (empty)
    if ((v === "" || v === null || typeof v === "undefined") && typeof k === "string") {
      const cleaned = k.trim();
      if (cleaned) extraParts.push(cleaned);
    }
  }

  // Rebuild: "Leanne " + " & " + "Stu Christensen"
  if (extraParts.length > 0) {
    area = `${String(area).trim()} & ${extraParts.join(" & ")}`;
  }

  // Normalise whitespace + unicode
  area = String(area)
    .replace(/\u00A0/g, " ")  // NBSP → space
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFKC");

  return area;
}

// -------------------------------------------------
// FINANCE ROUTE (INVOICES ONLY)
// -------------------------------------------------
app.get("/finance", async (req, res) => {
  try {
    // ---- HMAC VALIDATION ----
    const hmac = validateHaloHmac(req);
    if (!hmac.valid) {
      return res.status(401).send("Invalid HMAC");
    }

    // ---- HALO CLIENT NAME (AREA) ----
    const haloClientName = getHaloArea(req);
    if (!haloClientName) {
      return res.status(400).send("Missing Halo client name (area)");
    }

    // ---- RESOLVE GUID FROM DB ----
    const contactId = await resolveXeroContactGuid(haloClientName);
    console.log("🧩 contactId RESOLVED:", contactId);

    if (!contactId || !/^[0-9a-fA-F-]{36}$/.test(contactId)) {
      return res.status(400).json({
        error: "Invalid or missing Xero contact GUID",
        haloClientName,
        contactId
      });
    }

    const forceRefresh = req.query.refresh === "1";
    const runtimeConfig = getRuntimeConfig();
    const { data, cacheKey, cacheStatus } = await getCachedFinanceData(
      contactId,
      haloClientName,
      forceRefresh
    );
    const exportToken = signExportToken(cacheKey, hmac.agent);

    logFinanceRequest(req, haloClientName, cacheStatus);

    // ---- RENDER ----
    res.render("finance", {
      ...data,
      tenantName: tokens.tenantName || "Xero",
      agentId: hmac.agent,
      hmac: req.query.hmac,
      area: haloClientName,
      cacheStatus,
      cacheTtlSeconds: runtimeConfig.financeCacheTtlSeconds,
      cacheTtlHuman: runtimeConfig.financeCacheTtlHuman,
      cacheKey,
      exportToken
    });
  } catch (err) {
    const status = err.response?.status;
    console.error("❌ Finance error:", status || "", err.response?.data || err.message);

    if (status === 429) return res.status(429).send("Xero rate limit hit — try again shortly.");
    res.status(500).send("Finance error");
  }
});

// -------------------------------------------------
// EXPORT PDF
// -------------------------------------------------
app.get("/finance/export-pdf", async (req, res) => {
  let browser;

  try {
    if (!verifyExportToken(req)) {
      return res.status(401).send("Invalid or expired export token");
    }

    const cached = cache.get(req.query.key);
    if (!cached) return res.status(400).send("No cached finance data. Open widget first.");

    const html = await ejs.renderFile(
      "/opt/halo-xero-widget/views/statement.ejs",
      {
        ...cached,
        tenantName: tokens.tenantName || "Xero",
        totalAmount: cached.rows.reduce((a, r) => a + Number(r.total || 0), 0).toFixed(2),
        totalBalance: cached.rows.reduce((a, r) => a + Number(r.balance || 0), 0).toFixed(2)
      }
    );

    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdf = await page.pdf({ format: "A4", printBackground: true });
    await browser.close();
    browser = null;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeDownloadName(cached.clientName, "_Statement.pdf")}"`
    );

    res.send(pdf);
  } catch (err) {
    console.error("❌ export-pdf error:", err);
    res.status(500).send("PDF export failed");
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// -------------------------------------------------
// EXPORT EXCEL
// -------------------------------------------------
app.get("/finance/export-excel", async (req, res) => {
  try {
    if (!verifyExportToken(req)) {
      return res.status(401).send("Invalid or expired export token");
    }

    const cached = cache.get(req.query.key);
    if (!cached) return res.status(400).send("No cached finance data. Open widget first.");

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Statement");

    ws.columns = [
      { header: "Date", key: "date", width: 15 },
      { header: "Type", key: "type", width: 15 },
      { header: "Number", key: "number", width: 20 },
      { header: "Due", key: "due", width: 15 },
      { header: "Total", key: "total", width: 15 },
      { header: "Balance", key: "balance", width: 15 }
    ];

    cached.rows.forEach(r => ws.addRow(r));

    const buffer = await wb.xlsx.writeBuffer();

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeDownloadName(cached.clientName, "_Statement.xlsx")}"`
    );

    res.send(buffer);
  } catch (err) {
    console.error("❌ export-excel error:", err);
    res.status(500).send("Excel export failed");
  }
});

// -------------------------------------------------
// START
// -------------------------------------------------
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Widget running on port", process.env.PORT || 3000);
});
