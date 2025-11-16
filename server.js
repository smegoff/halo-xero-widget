
import express from "express";
import axios from "axios";
import NodeCache from "node-cache";
import dotenv from "dotenv";
import fs from "fs";
import crypto from "crypto";
import ejs from "ejs";
import puppeteer from "puppeteer";
import ExcelJS from "exceljs";

dotenv.config();

const app = express();
app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// -----------------------------------------------------
// CACHE
// -----------------------------------------------------
const cache = new NodeCache({ stdTTL: 120 });

// -----------------------------------------------------
// LOAD / SAVE XERO TOKENS
// -----------------------------------------------------
const TOKEN_PATH = "/opt/halo-xero-widget/tokens.json";

let tokens = {
  access_token: "",
  refresh_token: "",
  tenantId: "",
  tenantName: ""
};

if (fs.existsSync(TOKEN_PATH)) {
  try {
    tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    console.log("🔑 Loaded stored Xero tokens.");
  } catch (e) {
    console.error("⚠️ Failed to read tokens.json:", e.message);
  }
}

function saveTokens() {
  try {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log("💾 Xero tokens saved.");
  } catch (e) {
    console.error("⚠️ Failed to write tokens.json:", e.message);
  }
}

// -----------------------------------------------------
// XERO AUTH
// -----------------------------------------------------
app.get("/auth/connect", (req, res) => {
  const url =
    `https://login.xero.com/identity/connect/authorize?response_type=code` +
    `&client_id=${process.env.XERO_CLIENT_ID}` +
    `&redirect_uri=${process.env.XERO_REDIRECT_URI}` +
    `&scope=accounting.transactions accounting.contacts offline_access`;
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  try {
    const r = await axios.post(
      "https://identity.xero.com/connect/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code: req.query.code,
        redirect_uri: process.env.XERO_REDIRECT_URI,
        client_id: process.env.XERO_CLIENT_ID,
        client_secret: process.env.XERO_CLIENT_SECRET
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    tokens = { ...tokens, ...r.data };

    const tenants = await axios.get("https://api.xero.com/connections", {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });

    tokens.tenantId = tenants.data[0].tenantId;
    tokens.tenantName = tenants.data[0].tenantName;

    saveTokens();

    res.send("✅ Xero authenticated — you can close this tab.");
  } catch (e) {
    console.error("❌ OAuth callback error:", e.response?.data || e.message);
    res.status(500).send("Auth error — check logs.");
  }
});

// -----------------------------------------------------
// REFRESH TOKEN
// -----------------------------------------------------
async function ensureToken() {
  if (!tokens.refresh_token) throw new Error("Not authorised yet.");

  const r = await axios.post(
    "https://identity.xero.com/connect/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: process.env.XERO_CLIENT_ID,
      client_secret: process.env.XERO_CLIENT_SECRET
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  tokens = { ...tokens, ...r.data };
  saveTokens();

  return tokens.access_token;
}

// -----------------------------------------------------
// HALO HMAC VALIDATION (ONLY agentId is hashed now)
// -----------------------------------------------------
function validateHaloHmac(req) {
  const secret = process.env.HMAC_SECRET;
  if (!secret)
    return { valid: false, reason: "Missing HMAC secret", hasSecret: false };

  const received = req.query.hmac || req.query.HMAC;
  const agent = req.query.agentId || req.query.agentid;
  const area = req.query.area;

  if (!received)
    return { valid: false, reason: "Missing HMAC", hasSecret: true };
  if (!agent)
    return { valid: false, reason: "Missing agentId", hasSecret: true };

  const canonical = agent;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(canonical)
    .digest("base64");

  return {
    valid: expected === received,
    canonical,
    received,
    expected,
    area,
    agentId: agent,
    hasSecret: true
  };
}

// -----------------------------------------------------
// DEBUG HMAC
// -----------------------------------------------------
app.get("/debug-hmac", (req, res) => {
  const result = validateHaloHmac(req);
  res.json(result);
});

// -----------------------------------------------------
// FINANCE ROUTE (main widget)
// -----------------------------------------------------
app.get("/finance", async (req, res) => {
  try {
    const h = validateHaloHmac(req);
    if (!h.valid) {
      return res.status(401).json({ error: "Unauthorized (HMAC failed)", ...h });
    }

    const contactName = req.query.area;
    if (!contactName) return res.status(400).send("Missing area");

    const cached = cache.get(contactName);
    if (cached) {
      return res.render("finance", {
        ...cached,
        tenantName: tokens.tenantName,
        agentId: h.agentId,
        hmac: req.query.hmac || req.query.HMAC,
        area: contactName
      });
    }

    const token = await ensureToken();

    const headers = {
      Authorization: `Bearer ${token}`,
      "Xero-tenant-id": tokens.tenantId,
      Accept: "application/json"
    };

    const encodedName = encodeURIComponent(contactName);

    const contactResp = await axios.get(
      `https://api.xero.com/api.xro/2.0/Contacts?where=Name=="${encodedName}"`,
      { headers }
    );

    const found = contactResp.data?.Contacts?.[0];
    if (!found) return res.status(404).send("No matching contact found");

    const contactId = found.ContactID;

    // Exclude voided invoices and credit notes
    const invoiceWhere = `Contact.ContactID==Guid("${contactId}")&&Status!="VOIDED"`;
    const creditWhere = `Contact.ContactID==Guid("${contactId}")&&Status!="VOIDED"`;

    const inv = await axios.get(
      `https://api.xero.com/api.xro/2.0/Invoices?where=${encodeURIComponent(
        invoiceWhere
      )}&order=Date DESC`,
      { headers }
    );

    const crd = await axios.get(
      `https://api.xero.com/api.xro/2.0/CreditNotes?where=${encodeURIComponent(
        creditWhere
      )}&order=Date DESC`,
      { headers }
    );

    const rows = [];
    let accountBal = 0,
      overdueBal = 0;
    const today = new Date();

    function pushDocs(list, type) {
      for (const d of list) {
        const status = d.Status || "";
        if (status.toUpperCase() === "VOIDED") continue;

        const balance = d.AmountDue ?? d.RemainingCredit ?? 0;
        const total = d.Total ?? 0;

        if (type === "CreditNote") accountBal -= balance;
        else accountBal += balance;

        if (new Date(d.DueDate) < today && balance > 0) overdueBal += balance;

        rows.push({
          name: d.Contact?.Name,
          date: d.DateString?.slice(0, 10),
          type,
          number: d.InvoiceNumber || d.CreditNoteNumber,
          due: d.DueDateString?.slice(0, 10),
          total: total.toFixed(2),
          balance: balance.toFixed(2)
        });
      }
    }

    pushDocs(inv.data.Invoices || [], "Invoice");
    pushDocs(crd.data.CreditNotes || [], "CreditNote");

    const clientName = rows[0]?.name || contactName;

    const data = {
      accountBal: accountBal.toFixed(2),
      overdueBal: overdueBal.toFixed(2),
      rows,
      asAt: new Date().toLocaleString("en-NZ"),
      clientName,
      tenantName: tokens.tenantName
    };

    cache.set(contactName, data);

    res.render("finance", {
      ...data,
      agentId: h.agentId,
      hmac: req.query.hmac || req.query.HMAC,
      area: contactName
    });
  } catch (e) {
    console.error("❌ Finance error:", e.response?.data || e.message);
    res.status(500).send("Finance fetch error — see logs.");
  }
});

// -----------------------------------------------------
// EXPORT PDF
// -----------------------------------------------------
app.get("/finance/export-pdf", async (req, res) => {
  try {
    const area = req.query.area;
    const cached = cache.get(area);
    if (!cached) {
      return res
        .status(400)
        .send(
          `<html><body>No cached finance data to export.<br><button onclick="history.back()">Back</button></body></html>`
        );
    }

    const renderData = {
      ...cached,
      tenantName: tokens.tenantName || "Xero",
      totalAmount: cached.rows
        .reduce((a, r) => a + parseFloat(r.total), 0)
        .toFixed(2),
      totalBalance: cached.rows
        .reduce((a, r) => a + parseFloat(r.balance), 0)
        .toFixed(2)
    };

    const html = await ejs.renderFile(
      "/opt/halo-xero-widget/views/statement.ejs",
      renderData
    );

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" }
    });

    await browser.close();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${cached.clientName.replace(/\s+/g, "_")}_Statement.pdf"`
    );

    res.send(pdf);
  } catch (err) {
    console.error("❌ export-pdf error:", err);
    res
      .status(500)
      .send(
        `<html><body>Error generating PDF — see logs.<br><button onclick="history.back()">Back</button></body></html>`
      );
  }
});

// -----------------------------------------------------
// EXPORT EXCEL
// -----------------------------------------------------
app.get("/finance/export-excel", async (req, res) => {
  try {
    const area = req.query.area;
    const cached = cache.get(area);
    if (!cached) {
      return res
        .status(400)
        .send(
          `<html><body>No cached finance data to export.<br><button onclick="history.back()">Back</button></body></html>`
        );
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Statement");

    ws.columns = [
      { header: "Date", key: "date", width: 15 },
      { header: "Type", key: "type", width: 15 },
      { header: "Number", key: "number", width: 15 },
      { header: "Due Date", key: "due", width: 15 },
      { header: "Total ($)", key: "total", width: 15 },
      { header: "Balance ($)", key: "balance", width: 15 }
    ];

    cached.rows.forEach(r => ws.addRow(r));

    // Totals row
    const totalAmount = cached.rows.reduce(
      (a, r) => a + parseFloat(r.total),
      0
    );
    const totalBalance = cached.rows.reduce(
      (a, r) => a + parseFloat(r.balance),
      0
    );

    const totalsRow = ws.addRow({
      date: "",
      type: "",
      number: "",
      due: "Totals",
      total: totalAmount.toFixed(2),
      balance: totalBalance.toFixed(2)
    });
    totalsRow.font = { bold: true };

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
    res
      .status(500)
      .send(
        `<html><body>Error generating Excel — see logs.<br><button onclick="history.back()">Back</button></body></html>`
      );
  }
});

// -----------------------------------------------------
app.get("/", (_, res) => res.send("✅ Halo ↔ Xero Widget Online"));
app.listen(process.env.PORT, () =>
  console.log(`🚀 Widget running on port ${process.env.PORT}`)
);
