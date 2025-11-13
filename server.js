import express from "express";
import axios from "axios";
import NodeCache from "node-cache";
import dotenv from "dotenv";
import fs from "fs";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

// -----------------------------
// Paths & basic setup
// -----------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOKEN_PATH = path.join(__dirname, "tokens.json");

const app = express();
app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const cache = new NodeCache({ stdTTL: 120 }); // 2-minute cache

// -----------------------------
// Xero token state
// -----------------------------
let tokens = {
  access_token: "",
  refresh_token: "",
  tenantId: process.env.TENANT_ID || "",
  tenantName: "",
};

let tenantId = tokens.tenantId || process.env.TENANT_ID || "";

// Load tokens from disk if present
if (fs.existsSync(TOKEN_PATH)) {
  try {
    const stored = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    tokens = { ...tokens, ...stored };
    if (tokens.tenantId) tenantId = tokens.tenantId;
    console.log("🔑 Loaded stored Xero tokens.");
  } catch (err) {
    console.error("⚠️ Failed to read tokens.json:", err.message);
  }
}

function saveTokens() {
  try {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log("💾 Xero tokens saved.");
  } catch (err) {
    console.error("⚠️ Failed to write tokens.json:", err.message);
  }
}

// -----------------------------
// HMAC validation (Halo iframe)
// -----------------------------
const HMAC_SECRET = process.env.HMAC_SECRET;

function validateHaloHmac(req) {
  const area = req.query.area || null;
  const agentId = req.query.agentId || req.query.agentid || null;
  const received = req.query.hmac || null;
  const hasSecret = !!HMAC_SECRET;

  if (!hasSecret) {
    return {
      valid: false,
      reason: "Missing HMAC secret",
      area,
      agentId,
      hasSecret,
    };
  }

  if (!received || !agentId) {
    return {
      valid: false,
      reason: "Missing HMAC param or agentId",
      area,
      agentId,
      hasSecret,
    };
  }

  // ✅ Halo generates HMAC over just the agentId string
  const canonical = agentId;
  const expected = crypto
    .createHmac("sha256", HMAC_SECRET)
    .update(canonical)
    .digest("base64");

  const valid =
    Buffer.from(received).length === Buffer.from(expected).length &&
    crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));

  return {
    valid,
    canonical,
    received,
    expected,
    area,
    agentId,
    hasSecret,
  };
}

// Debug route to inspect HMAC behaviour from Halo
app.get("/debug-hmac", (req, res) => {
  const result = validateHaloHmac(req);
  console.log("----- DEBUG HMAC REQUEST -----");
  console.log("RAW QUERY:", req.query);
  console.log("FULL URL:", req.originalUrl);
  console.log("HMAC CHECK RESULT:", result);
  console.log("-------------------------------");
  res.json(result);
});

// -----------------------------
// Xero OAuth Handshake
// -----------------------------
app.get("/auth/connect", (req, res) => {
  const url =
    "https://login.xero.com/identity/connect/authorize" +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(process.env.XERO_CLIENT_ID || "")}` +
    `&redirect_uri=${encodeURIComponent(process.env.XERO_REDIRECT_URI || "")}` +
    `&scope=${encodeURIComponent(
      "accounting.transactions accounting.contacts offline_access"
    )}`;

  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) {
      return res.status(400).send("Missing 'code' from Xero");
    }

    const tokenResp = await axios.post(
      "https://identity.xero.com/connect/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.XERO_REDIRECT_URI,
        client_id: process.env.XERO_CLIENT_ID,
        client_secret: process.env.XERO_CLIENT_SECRET,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    tokens = { ...tokens, ...tokenResp.data };

    // Get tenant info
    const tenants = await axios.get("https://api.xero.com/connections", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!tenants.data || tenants.data.length === 0) {
      throw new Error("No Xero tenants returned from /connections");
    }

    const t = tenants.data[0];
    tenantId = t.tenantId;
    tokens.tenantId = t.tenantId;
    tokens.tenantName = t.tenantName;
    saveTokens();

    console.log("✅ Connected to Xero tenant:", tokens.tenantName, tenantId);
    res.send("✅ Xero authorised – you can close this tab.");
  } catch (err) {
    console.error(
      "❌ OAuth callback error:",
      err.response?.data || err.message
    );
    res.status(500).send("Error during Xero OAuth callback – see logs.");
  }
});

// Ensure we always have a fresh access token
async function ensureToken() {
  if (!tokens.refresh_token) {
    throw new Error("Not authorised with Xero yet (no refresh token).");
  }

  const r = await axios.post(
    "https://identity.xero.com/connect/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: process.env.XERO_CLIENT_ID,
      client_secret: process.env.XERO_CLIENT_SECRET,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  tokens = { ...tokens, ...r.data };
  saveTokens();
  return tokens.access_token;
}

async function ensureTenantId(accessToken) {
  if (tenantId) return tenantId;

  const tenants = await axios.get("https://api.xero.com/connections", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!tenants.data || tenants.data.length === 0) {
    throw new Error("No Xero tenants returned from /connections");
  }

  const t = tenants.data[0];
  tenantId = t.tenantId;
  tokens.tenantId = t.tenantId;
  tokens.tenantName = t.tenantName;
  saveTokens();

  console.log("✅ Refreshed Xero tenant:", tokens.tenantName, tenantId);
  return tenantId;
}

// -----------------------------
// Finance View (Halo iframe)
// -----------------------------
app.get("/finance", async (req, res) => {
  try {
    // 1) Validate HMAC from Halo
    const hmacResult = validateHaloHmac(req);
    if (!hmacResult.valid) {
      console.warn("⚠️ Invalid HMAC from Halo:", hmacResult);
      return res.status(401).send("Unauthorized");
    }

    // 2) Determine which contact to look up in Xero
    const area = req.query.area || null; // Halo client name
    let contactId = req.query.contactId || null;
    const contactName = area || req.query.contactName || null;

    if (!contactId && !contactName) {
      return res
        .status(400)
        .send("Missing contactId or area/contactName for Xero lookup.");
    }

    const cacheKey = contactId || contactName;
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.render("finance", cached);
    }

    // 3) Xero auth
    const accessToken = await ensureToken();
    const tenant = await ensureTenantId(accessToken);

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Xero-tenant-id": tenant,
      Accept: "application/json",
    };

    // 4) If we only have the name, resolve it to a ContactID
    if (!contactId && contactName) {
      console.log("🔍 Looking up Xero contact by name:", contactName);
      const safeName = contactName.replace(/"/g, '\\"');
      const contactResp = await axios.get(
        `https://api.xero.com/api.xro/2.0/Contacts?where=Name=="${safeName}"`,
        { headers }
      );
      const found = contactResp.data?.Contacts?.[0];
      if (!found) {
        console.warn("⚠️ No contact found in Xero for name:", contactName);
        return res.status(404).send(`No Xero contact found for ${contactName}`);
      }
      contactId = found.ContactID;
      console.log(`✅ Found ContactID ${contactId} for ${contactName}`);
    }

    // 5) Fetch invoices & credit notes
    const invResp = await axios.get(
      `https://api.xero.com/api.xro/2.0/Invoices?where=Contact.ContactID==Guid("${contactId}")&order=Date DESC`,
      { headers }
    );
    const crdResp = await axios.get(
      `https://api.xero.com/api.xro/2.0/CreditNotes?where=Contact.ContactID==Guid("${contactId}")&order=Date DESC`,
      { headers }
    );

    const rows = [];
    let accountBal = 0;
    let overdueBal = 0;
    const today = new Date();

    function pushDocs(list, type) {
      for (const d of list) {
        const balance = d.AmountDue ?? d.RemainingCredit ?? 0;
        const total = d.Total ?? 0;

        if (type === "CreditNote") accountBal -= balance;
        else accountBal += balance;

        if (new Date(d.DueDate) < today && balance > 0) {
          overdueBal += balance;
        }

        rows.push({
          name: d.Contact?.Name,
          date: d.DateString?.slice(0, 10),
          type,
          number: d.InvoiceNumber || d.CreditNoteNumber,
          due: d.DueDateString?.slice(0, 10),
          total: total.toFixed(2),
          balance: balance.toFixed(2),
        });
      }
    }

    pushDocs(invResp.data.Invoices || [], "Invoice");
    pushDocs(crdResp.data.CreditNotes || [], "CreditNote");

    const data = {
      accountBal: accountBal.toFixed(2),
      overdueBal: overdueBal.toFixed(2),
      rows,
      asAt: new Date().toLocaleString("en-NZ"),
    };

    cache.set(cacheKey, data);
    res.render("finance", data);
  } catch (err) {
    console.error(
      "❌ Finance route error:",
      err.response?.data || err.message
    );
    res.status(500).send("Error fetching Xero data – see logs.");
  }
});

// -----------------------------
// Health check
// -----------------------------
app.get("/", (_, res) => {
  res.send("✅ Halo ↔ Xero widget online");
});

// -----------------------------
// Start server
// -----------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Widget running on port ${port}`);
});
