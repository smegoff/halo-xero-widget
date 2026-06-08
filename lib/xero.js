// lib/xero.js
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const DEFAULT_SCOPES =
  "accounting.contacts.read accounting.invoices.read accounting.settings.read";

export let tokens = {
  access_token: "",
  expires_at: 0,
  scope: "",
  tenantId: process.env.XERO_TENANT_ID || "",
  tenantName: process.env.XERO_TENANT_NAME || "Xero Custom Connection",
  organisationShortCode: process.env.XERO_ORGANISATION_SHORTCODE || ""
};

export function saveTokens() {
  console.log("ℹ️ Custom Connection tokens are cached in memory only.");
}

export async function ensureToken() {
  if (!process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET) {
    throw new Error("Missing Xero client credentials");
  }

  if (tokens.access_token && tokens.expires_at > Date.now() + 60_000) {
    return tokens.access_token;
  }

  const scope = process.env.XERO_SCOPES || DEFAULT_SCOPES;

  const r = await axios.post(
    "https://identity.xero.com/connect/token",
    new URLSearchParams({
      grant_type: "client_credentials",
      scope
    }),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      auth: {
        username: process.env.XERO_CLIENT_ID,
        password: process.env.XERO_CLIENT_SECRET
      }
    }
  );

  tokens = {
    ...tokens,
    access_token: r.data.access_token,
    expires_at: Date.now() + Number(r.data.expires_in || 1800) * 1000,
    scope: r.data.scope || scope,
    token_type: r.data.token_type || "Bearer"
  };

  console.log("🔑 Xero Custom Connection access token refreshed.");
  return tokens.access_token;
}

export async function getXeroHeaders() {
  const token = await ensureToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json"
  };

  // Custom Connections do not require xero-tenant-id, but keep this
  // optional so the same code can still work if a tenant id is configured.
  if (tokens.tenantId) {
    headers["Xero-tenant-id"] = tokens.tenantId;
  }

  return headers;
}

export async function getXeroOrganisationShortCode() {
  if (tokens.organisationShortCode) {
    return tokens.organisationShortCode;
  }

  try {
    const headers = await getXeroHeaders();
    const response = await axios.get("https://api.xero.com/api.xro/2.0/Organisation", {
      headers,
      timeout: 10000
    });

    const organisation = response.data?.Organisations?.[0];
    if (organisation?.ShortCode) {
      tokens = {
        ...tokens,
        organisationShortCode: organisation.ShortCode,
        tenantName: process.env.XERO_TENANT_NAME || organisation.Name || tokens.tenantName,
        tenantId: process.env.XERO_TENANT_ID || organisation.OrganisationID || tokens.tenantId
      };
      return tokens.organisationShortCode;
    }
  } catch (err) {
    console.warn(
      "⚠️ Xero organisation shortcode lookup failed:",
      err.response?.status || err.message
    );
  }

  return "";
}
