import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const DEFAULT_FINANCE_CACHE_TTL_SECONDS = 300;
const DEFAULT_EXPORT_TOKEN_TTL_SECONDS = 900;
const DEFAULT_GOCARDLESS_AUTO_MAP_INTERVAL_SECONDS = 21_600;
const DEFAULT_GOCARDLESS_WEBHOOK_URL = "https://widget.engagetech.nz/webhooks/gocardless";
const MIN_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 86_400;

function getConfigPath() {
  return process.env.RUNTIME_CONFIG_PATH || path.join(process.cwd(), "data", "runtime-config.json");
}

function positiveIntegerEnv(name, defaultValue) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

function parseTtlSeconds(value, fieldName) {
  const rawValue = String(value || "").trim();

  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${fieldName} must be a whole number of seconds.`);
  }

  const ttl = Number.parseInt(rawValue, 10);

  if (!Number.isFinite(ttl)) {
    throw new Error(`${fieldName} must be a whole number of seconds.`);
  }

  if (ttl < MIN_TTL_SECONDS || ttl > MAX_TTL_SECONDS) {
    throw new Error(`${fieldName} must be between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS} seconds.`);
  }

  return ttl;
}

function readRuntimeOverrides() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return {};

  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    console.error("Failed to read runtime config:", err.message);
    return {};
  }
}

function writeRuntimeOverrides(nextConfig) {
  const configPath = getConfigPath();

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(nextConfig, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  fs.renameSync(tempPath, configPath);
}

function getBaseConfig() {
  return {
    financeCacheTtlSeconds: positiveIntegerEnv(
      "FINANCE_CACHE_TTL_SECONDS",
      DEFAULT_FINANCE_CACHE_TTL_SECONDS
    ),
    exportTokenTtlSeconds: positiveIntegerEnv(
      "EXPORT_TOKEN_TTL_SECONDS",
      DEFAULT_EXPORT_TOKEN_TTL_SECONDS
    ),
    goCardlessAutoMapIntervalSeconds: positiveIntegerEnv(
      "GOCARDLESS_AUTO_MAP_INTERVAL_SECONDS",
      DEFAULT_GOCARDLESS_AUTO_MAP_INTERVAL_SECONDS
    )
  };
}

function readTtlOverride(overrides, key, fieldName, fallback) {
  if (!overrides[key]) {
    return { value: fallback, source: ".env default" };
  }

  try {
    return { value: parseTtlSeconds(overrides[key], fieldName), source: "admin override" };
  } catch (err) {
    console.error(`Invalid runtime config value for ${key}:`, err.message);
    return { value: fallback, source: ".env default" };
  }
}

function trimConfigValue(value) {
  return String(value || "").trim();
}

function trimConfigUrl(value) {
  return trimConfigValue(value).replace(/\/+$/, "");
}

function readConfigValue(overrides, key, envName, fallback = "") {
  if (Object.prototype.hasOwnProperty.call(overrides, key)) {
    return { value: trimConfigValue(overrides[key]), source: "admin override" };
  }

  const envValue = trimConfigValue(process.env[envName]);
  if (envValue) {
    return { value: envValue, source: envName };
  }

  return { value: fallback, source: fallback ? "default" : "not configured" };
}

function parseRequiredUrl(value, fieldName) {
  const url = trimConfigUrl(value);
  if (!url) {
    throw new Error(`${fieldName} cannot be blank.`);
  }

  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("invalid protocol");
    }
  } catch {
    throw new Error(`${fieldName} must be a valid HTTP or HTTPS URL.`);
  }

  return url;
}

function parseOptionalUrl(value, fieldName) {
  const url = trimConfigUrl(value);
  if (!url) return "";

  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("invalid protocol");
    }
  } catch {
    throw new Error(`${fieldName} must be a valid HTTP or HTTPS URL.`);
  }

  return url;
}

function parseRequiredText(value, fieldName) {
  const text = trimConfigValue(value);
  if (!text) {
    throw new Error(`${fieldName} cannot be blank.`);
  }
  return text;
}

export function formatDuration(seconds) {
  if (seconds < 60) return `${seconds} seconds`;

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;

  if (remainder === 0) {
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }

  return `${minutes} min ${remainder} sec`;
}

export function getRuntimeConfig() {
  const configPath = getConfigPath();
  const baseConfig = getBaseConfig();
  const overrides = readRuntimeOverrides();

  const financeCacheTtl = readTtlOverride(
    overrides,
    "financeCacheTtlSeconds",
    "Finance cache TTL",
    baseConfig.financeCacheTtlSeconds
  );
  const exportTokenTtl = readTtlOverride(
    overrides,
    "exportTokenTtlSeconds",
    "Export link TTL",
    baseConfig.exportTokenTtlSeconds
  );
  const goCardlessAutoMapInterval = readTtlOverride(
    overrides,
    "goCardlessAutoMapIntervalSeconds",
    "GoCardless auto-map interval",
    baseConfig.goCardlessAutoMapIntervalSeconds
  );

  const hasGoCardlessOverride = Boolean(overrides.gocardlessAccessToken);
  const hasGoCardlessEnv = Boolean(process.env.GOCARDLESS_ACCESS_TOKEN);
  const hasGoCardlessWebhookOverride = Boolean(overrides.gocardlessWebhookSecret);
  const hasGoCardlessWebhookEnv = Boolean(process.env.GOCARDLESS_WEBHOOK_SECRET);

  return {
    financeCacheTtlSeconds: financeCacheTtl.value,
    financeCacheTtlHuman: formatDuration(financeCacheTtl.value),
    financeCacheTtlSource: financeCacheTtl.source,
    exportTokenTtlSeconds: exportTokenTtl.value,
    exportTokenTtlHuman: formatDuration(exportTokenTtl.value),
    exportTokenTtlSource: exportTokenTtl.source,
    goCardlessAutoMapIntervalSeconds: goCardlessAutoMapInterval.value,
    goCardlessAutoMapIntervalHuman: formatDuration(goCardlessAutoMapInterval.value),
    goCardlessAutoMapIntervalSource: goCardlessAutoMapInterval.source,
    exportTokenSecretConfigured: Boolean(process.env.EXPORT_TOKEN_SECRET),
    exportTokenSecretSource: process.env.EXPORT_TOKEN_SECRET ? "EXPORT_TOKEN_SECRET" : "HMAC_SECRET fallback",
    goCardlessAccessTokenConfigured: hasGoCardlessOverride || hasGoCardlessEnv,
    goCardlessAccessTokenSource: hasGoCardlessOverride
      ? "admin override"
      : hasGoCardlessEnv
        ? "GOCARDLESS_ACCESS_TOKEN"
        : "not configured",
    goCardlessEnvironment: process.env.GOCARDLESS_ENVIRONMENT || "live",
    goCardlessTokenUpdatedAt: overrides.gocardlessAccessTokenUpdatedAt || null,
    goCardlessWebhookUrl: DEFAULT_GOCARDLESS_WEBHOOK_URL,
    goCardlessWebhookSecretConfigured: hasGoCardlessWebhookOverride || hasGoCardlessWebhookEnv,
    goCardlessWebhookSecretSource: hasGoCardlessWebhookOverride
      ? "admin override"
      : hasGoCardlessWebhookEnv
        ? "GOCARDLESS_WEBHOOK_SECRET"
        : "not configured",
    goCardlessWebhookSecretUpdatedAt: overrides.gocardlessWebhookSecretUpdatedAt || null,
    configPath,
    updatedAt: overrides.updatedAt || null,
    minTtlSeconds: MIN_TTL_SECONDS,
    maxTtlSeconds: MAX_TTL_SECONDS
  };
}

export function updateRuntimeConfig(input) {
  const previousConfig = readRuntimeOverrides();
  const nextConfig = {
    ...previousConfig,
    financeCacheTtlSeconds: parseTtlSeconds(input.financeCacheTtlSeconds, "Finance cache TTL"),
    exportTokenTtlSeconds: parseTtlSeconds(input.exportTokenTtlSeconds, "Export link TTL"),
    goCardlessAutoMapIntervalSeconds: parseTtlSeconds(
      input.goCardlessAutoMapIntervalSeconds,
      "GoCardless auto-map interval"
    ),
    updatedAt: new Date().toISOString()
  };

  writeRuntimeOverrides(nextConfig);

  return getRuntimeConfig();
}

export function getGoCardlessAccessToken() {
  const overrides = readRuntimeOverrides();
  return String(overrides.gocardlessAccessToken || process.env.GOCARDLESS_ACCESS_TOKEN || "").trim();
}

export function updateGoCardlessAccessToken(accessToken) {
  const token = String(accessToken || "").trim();
  if (!token) {
    throw new Error("GoCardless access token cannot be blank.");
  }

  const previousConfig = readRuntimeOverrides();
  writeRuntimeOverrides({
    ...previousConfig,
    gocardlessAccessToken: token,
    gocardlessAccessTokenUpdatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  return getRuntimeConfig();
}

export function clearGoCardlessAccessTokenOverride() {
  const previousConfig = readRuntimeOverrides();
  const nextConfig = { ...previousConfig };
  delete nextConfig.gocardlessAccessToken;
  nextConfig.gocardlessAccessTokenUpdatedAt = null;
  nextConfig.updatedAt = new Date().toISOString();
  writeRuntimeOverrides(nextConfig);

  return getRuntimeConfig();
}

export function getGoCardlessWebhookSecret() {
  const overrides = readRuntimeOverrides();
  return String(overrides.gocardlessWebhookSecret || process.env.GOCARDLESS_WEBHOOK_SECRET || "").trim();
}

export function updateGoCardlessWebhookSecret(webhookSecret) {
  const secret = String(webhookSecret || "").trim();
  if (!secret) {
    throw new Error("GoCardless webhook secret cannot be blank.");
  }

  const previousConfig = readRuntimeOverrides();
  writeRuntimeOverrides({
    ...previousConfig,
    gocardlessWebhookSecret: secret,
    gocardlessWebhookSecretUpdatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  return getRuntimeConfig();
}

export function clearGoCardlessWebhookSecretOverride() {
  const previousConfig = readRuntimeOverrides();
  const nextConfig = { ...previousConfig };
  delete nextConfig.gocardlessWebhookSecret;
  nextConfig.gocardlessWebhookSecretUpdatedAt = null;
  nextConfig.updatedAt = new Date().toISOString();
  writeRuntimeOverrides(nextConfig);

  return getRuntimeConfig();
}

export function getHaloApiConfig() {
  const overrides = readRuntimeOverrides();
  const resourceServerUrl = readConfigValue(
    overrides,
    "haloResourceServerUrl",
    "HALO_RESOURCE_SERVER_URL"
  );
  const authServerUrl = readConfigValue(overrides, "haloAuthServerUrl", "HALO_AUTH_SERVER_URL");
  const tenant = readConfigValue(overrides, "haloTenant", "HALO_TENANT");
  const clientId = readConfigValue(overrides, "haloClientId", "HALO_CLIENT_ID");
  const clientSecret = readConfigValue(overrides, "haloClientSecret", "HALO_CLIENT_SECRET");
  const scopes = readConfigValue(overrides, "haloScopes", "HALO_SCOPES", "all");

  return {
    resourceServerUrl: trimConfigUrl(resourceServerUrl.value),
    resourceServerUrlSource: resourceServerUrl.source,
    authServerUrl: trimConfigUrl(authServerUrl.value),
    authServerUrlSource: authServerUrl.source,
    tenant: tenant.value,
    tenantSource: tenant.source,
    clientId: clientId.value,
    clientIdSource: clientId.source,
    clientSecret: clientSecret.value,
    clientSecretSource: clientSecret.source,
    scopes: scopes.value || "all",
    scopesSource: scopes.source,
    updatedAt: overrides.haloApiUpdatedAt || null
  };
}

export function getHaloApiSettings() {
  const config = getHaloApiConfig();
  const configured = Boolean(
    config.resourceServerUrl &&
      config.authServerUrl &&
      config.clientId &&
      config.clientSecret
  );

  return {
    configured,
    resourceServerUrl: config.resourceServerUrl,
    resourceServerUrlSource: config.resourceServerUrlSource,
    authServerUrl: config.authServerUrl,
    authServerUrlSource: config.authServerUrlSource,
    tenant: config.tenant,
    tenantSource: config.tenantSource,
    clientId: config.clientId,
    clientIdSuffix: config.clientId ? config.clientId.slice(-8) : null,
    clientIdSource: config.clientIdSource,
    clientSecretConfigured: Boolean(config.clientSecret),
    clientSecretSource: config.clientSecretSource,
    scopes: config.scopes,
    scopesSource: config.scopesSource,
    updatedAt: config.updatedAt,
    configPath: getConfigPath()
  };
}

export function updateHaloApiConfig(input) {
  const previousConfig = readRuntimeOverrides();
  const currentConfig = getHaloApiConfig();
  const clientSecret = trimConfigValue(input.clientSecret);

  const nextConfig = {
    ...previousConfig,
    haloResourceServerUrl: parseRequiredUrl(input.resourceServerUrl, "Resource Server"),
    haloAuthServerUrl: parseRequiredUrl(input.authServerUrl, "Authorisation Server"),
    haloTenant: trimConfigValue(input.tenant),
    haloClientId: parseRequiredText(input.clientId, "Client ID"),
    haloScopes: trimConfigValue(input.scopes) || "all",
    haloApiUpdatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (clientSecret) {
    nextConfig.haloClientSecret = clientSecret;
  } else if (previousConfig.haloClientSecret) {
    nextConfig.haloClientSecret = previousConfig.haloClientSecret;
  } else if (!currentConfig.clientSecret) {
    throw new Error("Client Secret cannot be blank because no existing secret is configured.");
  }

  writeRuntimeOverrides(nextConfig);

  return getHaloApiSettings();
}

export function clearHaloApiConfigOverride() {
  const previousConfig = readRuntimeOverrides();
  const nextConfig = { ...previousConfig };

  delete nextConfig.haloResourceServerUrl;
  delete nextConfig.haloAuthServerUrl;
  delete nextConfig.haloTenant;
  delete nextConfig.haloClientId;
  delete nextConfig.haloClientSecret;
  delete nextConfig.haloScopes;
  nextConfig.haloApiUpdatedAt = null;
  nextConfig.updatedAt = new Date().toISOString();

  writeRuntimeOverrides(nextConfig);

  return getHaloApiSettings();
}

export function getAlertConfig() {
  const overrides = readRuntimeOverrides();
  const teamsWebhookUrl = readConfigValue(overrides, "teamsWebhookUrl", "TEAMS_WEBHOOK_URL");
  const hasEnabledOverride = Object.prototype.hasOwnProperty.call(overrides, "alertsEnabled");
  const enabled = hasEnabledOverride
    ? Boolean(overrides.alertsEnabled)
    : String(process.env.ALERTS_ENABLED || "false").trim().toLowerCase() === "true";

  return {
    enabled,
    enabledSource: hasEnabledOverride ? "admin override" : process.env.ALERTS_ENABLED ? "ALERTS_ENABLED" : "default",
    teamsWebhookUrl: teamsWebhookUrl.value,
    teamsWebhookUrlSource: teamsWebhookUrl.source,
    teamsConfigured: Boolean(teamsWebhookUrl.value),
    updatedAt: overrides.alertsUpdatedAt || null,
    configPath: getConfigPath()
  };
}

export function getAlertSettings() {
  const config = getAlertConfig();

  return {
    enabled: config.enabled,
    enabledSource: config.enabledSource,
    teamsConfigured: config.teamsConfigured,
    teamsWebhookUrlSource: config.teamsWebhookUrlSource,
    updatedAt: config.updatedAt,
    configPath: config.configPath
  };
}

export function updateAlertConfig(input) {
  const previousConfig = readRuntimeOverrides();
  const currentConfig = getAlertConfig();
  const enabled = input.alertsEnabled === "true" || input.alertsEnabled === true;
  const teamsWebhookUrl = parseOptionalUrl(input.teamsWebhookUrl, "Teams webhook URL");

  if (enabled && !teamsWebhookUrl && !currentConfig.teamsWebhookUrl) {
    throw new Error("Teams webhook URL is required before alerts can be enabled.");
  }

  const nextConfig = {
    ...previousConfig,
    alertsEnabled: enabled,
    alertsUpdatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (teamsWebhookUrl) {
    nextConfig.teamsWebhookUrl = teamsWebhookUrl;
  } else if (previousConfig.teamsWebhookUrl) {
    nextConfig.teamsWebhookUrl = previousConfig.teamsWebhookUrl;
  }

  writeRuntimeOverrides(nextConfig);

  return getAlertSettings();
}

export function clearAlertConfigOverride() {
  const previousConfig = readRuntimeOverrides();
  const nextConfig = { ...previousConfig };

  delete nextConfig.alertsEnabled;
  delete nextConfig.teamsWebhookUrl;
  nextConfig.alertsUpdatedAt = null;
  nextConfig.updatedAt = new Date().toISOString();

  writeRuntimeOverrides(nextConfig);

  return getAlertSettings();
}
