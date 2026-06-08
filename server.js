// server.js — Halo ↔ Xero Widget (DB-backed GUID, invoices only)
// -------------------------------------------------------------

import express from "express";
import axios from "axios";
import NodeCache from "node-cache";
import dotenv from "dotenv";
import ejs from "ejs";
import puppeteer from "puppeteer";
import ExcelJS from "exceljs";

import { pgPool } from "./lib/db.js";
import { validateHaloHmac } from "./lib/hmac.js";
import { getXeroHeaders, tokens } from "./lib/xero.js";
import { resolveXeroContactGuid } from "./lib/resolver.js";

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
// CACHE (used by PDF / Excel exports)
// -------------------------------------------------
const cache = new NodeCache({ stdTTL: 120 });

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
  console.log("🟢 /finance ROUTE ENTERED");
  console.log("🧪 RAW QUERY:", req.query);

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

    // ---- XERO TOKEN ----
    const headers = await getXeroHeaders();

    // ---- FETCH INVOICES ----
    const inv = await fetchWithRetry(() =>
      axios.get(
        `https://api.xero.com/api.xro/2.0/Invoices?where=Contact.ContactID==Guid("${contactId}")`,
        { headers }
      )
    );

    let rows = [];
    let accountBal = 0;
    let overdueBal = 0;
    const today = new Date();

    for (const d of inv.data.Invoices || []) {
      const balance = Number(d.AmountDue ?? 0);
      const total = Number(d.Total ?? 0);
      const dueDateStr = d.DueDateString?.slice(0, 10);
      const dueDate = dueDateStr ? new Date(dueDateStr) : null;

      accountBal += balance;
      if (dueDate && balance > 0 && dueDate < today) overdueBal += balance;

      rows.push({
        name: d.Contact?.Name,
        date: d.DateString?.slice(0, 10),
        type: "Invoice",
        number: d.InvoiceNumber,
        due: dueDateStr,
        ageBucket: "",
        total,
        balance
      });
    }

    const asAt = new Date().toLocaleString("en-NZ");

    // ---- CACHE FOR EXPORTS ----
    cache.set(haloClientName, {
      clientName: haloClientName,
      rows,
      accountBal: accountBal.toFixed(2),
      overdueBal: overdueBal.toFixed(2),
      asAt
    });

    // ---- RENDER ----
    res.render("finance", {
      rows,
      accountBal: accountBal.toFixed(2),
      overdueBal: overdueBal.toFixed(2),
      clientName: haloClientName,
      tenantName: tokens.tenantName || "Xero",
      asAt,
      agentId: hmac.agent,
      hmac: req.query.hmac,
      area: haloClientName
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
  try {
    const area = getHaloArea(req) || req.query.area;
    if (!area) return res.status(400).send("Missing area");

    const cached = cache.get(area);
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

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdf = await page.pdf({ format: "A4", printBackground: true });
    await browser.close();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${cached.clientName.replace(/\s+/g, "_")}_Statement.pdf"`
    );

    res.send(pdf);
  } catch (err) {
    console.error("❌ export-pdf error:", err);
    res.status(500).send("PDF export failed");
  }
});

// -------------------------------------------------
// EXPORT EXCEL
// -------------------------------------------------
app.get("/finance/export-excel", async (req, res) => {
  try {
    const area = getHaloArea(req) || req.query.area;
    if (!area) return res.status(400).send("Missing area");

    const cached = cache.get(area);
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
      `attachment; filename="${cached.clientName.replace(/\s+/g, "_")}_Statement.xlsx"`
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
