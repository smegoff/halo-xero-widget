import express from "express";
import axios from "axios";
import NodeCache from "node-cache";
import dotenv from "dotenv";
import fs from "fs";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---------- Local cache ----------
const cache = new NodeCache({ stdTTL: 120 }); // 2-minute cache

// ---------- Persistent Xero token handling ----------
const TOKEN_PATH = "/opt/halo-xero-widget/tokens.json";
let tokens = { access_token: "", refresh_token: "" };
let tenantId = process.env.TENANT_ID;

// Load existing tokens
if (fs.existsSync(TOKEN_PATH)) {
  try {
    tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    console.log("🔑 Loaded stored Xero tokens.");
  } catch (err) {
    console.error("⚠️ Failed to read tokens.json:", err.message);
  }
}

// Save tokens whenever they update
function saveTokens() {
  try {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log("💾 Xero tokens saved.");
  } catch (err) {
    console.error("⚠️ Failed to write tokens.json:", err.message);
  }
}

// ---------- Helper: verify Halo token ----------
function verifyHaloToken(req) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : req.query.token;

  if (!token) throw new Error("Missing authorization token");

  try {
    const decoded = jwt.verify(token, process.env.HALO_JWT_SECRET);
    return decoded.clientName || decoded.clientId || null;
  } catch (err) {
    console.error("❌ Invalid JWT:", err.message);
    throw new Error("Unauthorized");
  }
}

// ---------- OAuth handshake ----------
app.get("/auth/connect", (req, res) => {
  const url = `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${process.env.XERO_CLIENT_ID}&redirect_uri=${process.env.XERO_REDIRECT_URI}&scope=accounting.transactions accounting.contacts offline_access`;
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const r = await axios.post(
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
    tokens = r.data;
    saveTokens();

    const tenants = await axios.get("https://api.xero.com/connections", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    tenantId = tenants.data[0].tenantId;
    console.log("✅ Connected to Xero tenant:", tenantId);
    res.send("✅ Authorised – you can close this tab.");
  } catch (err) {
    console.error("❌ OAuth callback error:", err.response?.data || err.message);
    res.status(500).send("Error during OAuth callback – see logs.");
  }
});

// ---------- Helper: ensure access token ----------
async function ensureToken() {
  if (!tokens.refresh_token) throw new Error("Not authorised yet.");

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
  tokens = r.data;
  saveTokens();
  return tokens.access_token;
}

// ---------- Finance view ----------
app.get("/finance", async (req, res) => {
  try {
    const clientName = verifyHaloToken(req);
    const contactName = req.query.contactName || clientName;
    if (!contactName)
      return res.status(400).send("Missing contactName or token payload");

    const cacheKey = contactName;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log(`💾 Using cached data for ${cacheKey}`);
      return res.render("finance", cached);
    }

    const token = await ensureToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      "Xero-tenant-id": tenantId,
      Accept: "application/json",
    };

    // Lookup contact ID
    console.log(`🔍 Looking up Xero contact by name: ${contactName}`);
    const encodedName = encodeURIComponent(contactName);
    const contactResp = await axios.get(
      `https://api.xero.com/api.xro/2.0/Contacts?where=Name=="${encodedName}"`,
      { headers }
    );

    const found = contactResp.data?.Contacts?.[0];
    if (!found) {
      console.warn(`⚠️ No contact found for name: ${contactName}`);
      return res.status(404).send(`No contact found for name ${contactName}`);
    }

    const contactId = found.ContactID;
    console.log(`✅ Found ContactID ${contactId} for ${contactName}`);

    // Fetch invoices & credit notes
    const inv = await axios.get(
      `https://api.xero.com/api.xro/2.0/Invoices?where=Contact.ContactID==Guid("${contactId}")&order=Date DESC`,
      { headers }
    );
    const crd = await axios.get(
      `https://api.xero.com/api.xro/2.0/CreditNotes?where=Contact.ContactID==Guid("${contactId}")&order=Date DESC`,
      { headers }
    );

    // Process
    const rows = [];
    let accountBal = 0, overdueBal = 0;
    const today = new Date();

    function pushDocs(list, type) {
      for (const d of list) {
        const balance = d.AmountDue ?? d.RemainingCredit ?? 0;
        const total = d.Total ?? 0;
        if (type === "CreditNote") accountBal -= balance;
        else accountBal += balance;
        if (new Date(d.DueDate) < today && balance > 0) overdueBal += balance;
        rows.push({
          name: d.Contact?.Name,
          date: d.DateString?.slice(0,10),
          type,
          number: d.InvoiceNumber || d.CreditNoteNumber,
          due: d.DueDateString?.slice(0,10),
          total: total.toFixed(2),
          balance: balance.toFixed(2),
        });
      }
    }

    pushDocs(inv.data.Invoices || [], "Invoice");
    pushDocs(crd.data.CreditNotes || [], "CreditNote");

    const data = {
      accountBal: accountBal.toFixed(2),
      overdueBal: overdueBal.toFixed(2),
      rows,
      asAt: new Date().toLocaleString("en-NZ"),
    };

    cache.set(cacheKey, data);
    res.render("finance", data);

  } catch (e) {
    console.error("❌ Finance route error:", e.response?.data || e.message);
    res.status(401).send("Unauthorized or data fetch error – see logs.");
  }
});

// ---------- Root / Health ----------
app.get("/", (_, res) => res.send("✅ Halo↔Xero widget online"));

// ---------- Start Server ----------
app.listen(process.env.PORT, () =>
  console.log(`🚀 Widget running on port ${process.env.PORT}`)
);
