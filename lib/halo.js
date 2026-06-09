import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const TOKEN_REFRESH_BUFFER_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;

let cachedToken = {
  accessToken: null,
  expiresAt: 0,
  scope: null
};

function trimTrailingSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function getHaloConfig() {
  return {
    resourceServerUrl: trimTrailingSlash(process.env.HALO_RESOURCE_SERVER_URL),
    authServerUrl: trimTrailingSlash(process.env.HALO_AUTH_SERVER_URL),
    tenant: String(process.env.HALO_TENANT || "").trim(),
    clientId: String(process.env.HALO_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.HALO_CLIENT_SECRET || "").trim(),
    scopes: String(process.env.HALO_SCOPES || "all").trim()
  };
}

function requireHaloConfig() {
  const config = getHaloConfig();
  const missing = [];

  if (!config.resourceServerUrl) missing.push("HALO_RESOURCE_SERVER_URL");
  if (!config.authServerUrl) missing.push("HALO_AUTH_SERVER_URL");
  if (!config.clientId) missing.push("HALO_CLIENT_ID");
  if (!config.clientSecret) missing.push("HALO_CLIENT_SECRET");

  if (missing.length > 0) {
    throw new Error(`Halo API is not configured. Missing: ${missing.join(", ")}`);
  }

  return config;
}

function normalisePath(path) {
  return String(path || "").startsWith("/") ? path : `/${path}`;
}

export function getHaloConfigStatus() {
  const config = getHaloConfig();

  return {
    configured: Boolean(
      config.resourceServerUrl &&
      config.authServerUrl &&
      config.clientId &&
      config.clientSecret
    ),
    resourceServerUrl: config.resourceServerUrl || null,
    authServerUrl: config.authServerUrl || null,
    tenant: config.tenant || null,
    clientIdSuffix: config.clientId ? config.clientId.slice(-8) : null,
    scopes: config.scopes || null
  };
}

export async function getHaloAccessToken() {
  const config = requireHaloConfig();

  if (
    cachedToken.accessToken &&
    cachedToken.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS
  ) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret
  });

  if (config.scopes) {
    body.set("scope", config.scopes);
  }

  const response = await axios.post(`${config.authServerUrl}/token`, body, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    timeout: DEFAULT_TIMEOUT_MS
  });

  const accessToken = response.data?.access_token;
  if (!accessToken) {
    throw new Error("Halo auth response did not include an access token.");
  }

  const expiresInSeconds = Number(response.data.expires_in || 3600);
  cachedToken = {
    accessToken,
    expiresAt: Date.now() + expiresInSeconds * 1000,
    scope: response.data.scope || config.scopes || null
  };

  console.log("Halo API access token refreshed.", {
    expiresInSeconds,
    scope: cachedToken.scope
  });

  return accessToken;
}

export async function getHaloHeaders() {
  const accessToken = await getHaloAccessToken();

  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json"
  };
}

export async function haloGet(path, params = {}) {
  const config = requireHaloConfig();
  const headers = await getHaloHeaders();

  const response = await axios.get(`${config.resourceServerUrl}${normalisePath(path)}`, {
    headers,
    params,
    timeout: DEFAULT_TIMEOUT_MS
  });

  return response.data;
}

export async function testHaloConnection() {
  const configStatus = getHaloConfigStatus();
  const data = await haloGet("/Client", { count: 1 });
  const clients = Array.isArray(data?.clients) ? data.clients : [];

  return {
    ok: true,
    tenant: configStatus.tenant,
    resourceServerUrl: configStatus.resourceServerUrl,
    authServerUrl: configStatus.authServerUrl,
    clientIdSuffix: configStatus.clientIdSuffix,
    scope: cachedToken.scope,
    recordCount: Number(data?.record_count || 0),
    clientCountVisible: clients.length
  };
}
