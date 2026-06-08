import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const DEFAULT_FINANCE_CACHE_TTL_SECONDS = 300;
const DEFAULT_EXPORT_TOKEN_TTL_SECONDS = 900;
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

function getBaseConfig() {
  return {
    financeCacheTtlSeconds: positiveIntegerEnv(
      "FINANCE_CACHE_TTL_SECONDS",
      DEFAULT_FINANCE_CACHE_TTL_SECONDS
    ),
    exportTokenTtlSeconds: positiveIntegerEnv(
      "EXPORT_TOKEN_TTL_SECONDS",
      DEFAULT_EXPORT_TOKEN_TTL_SECONDS
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

  return {
    financeCacheTtlSeconds: financeCacheTtl.value,
    financeCacheTtlHuman: formatDuration(financeCacheTtl.value),
    financeCacheTtlSource: financeCacheTtl.source,
    exportTokenTtlSeconds: exportTokenTtl.value,
    exportTokenTtlHuman: formatDuration(exportTokenTtl.value),
    exportTokenTtlSource: exportTokenTtl.source,
    exportTokenSecretConfigured: Boolean(process.env.EXPORT_TOKEN_SECRET),
    exportTokenSecretSource: process.env.EXPORT_TOKEN_SECRET ? "EXPORT_TOKEN_SECRET" : "HMAC_SECRET fallback",
    configPath,
    updatedAt: overrides.updatedAt || null,
    minTtlSeconds: MIN_TTL_SECONDS,
    maxTtlSeconds: MAX_TTL_SECONDS
  };
}

export function updateRuntimeConfig(input) {
  const configPath = getConfigPath();
  const nextConfig = {
    financeCacheTtlSeconds: parseTtlSeconds(input.financeCacheTtlSeconds, "Finance cache TTL"),
    exportTokenTtlSeconds: parseTtlSeconds(input.exportTokenTtlSeconds, "Export link TTL"),
    updatedAt: new Date().toISOString()
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(nextConfig, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  fs.renameSync(tempPath, configPath);

  return getRuntimeConfig();
}
