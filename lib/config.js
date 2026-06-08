import dotenv from "dotenv";

dotenv.config();

function positiveIntegerEnv(name, defaultValue) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

export const FINANCE_CACHE_TTL_SECONDS = positiveIntegerEnv("FINANCE_CACHE_TTL_SECONDS", 300);
export const EXPORT_TOKEN_TTL_SECONDS = positiveIntegerEnv("EXPORT_TOKEN_TTL_SECONDS", 900);

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
  return {
    financeCacheTtlSeconds: FINANCE_CACHE_TTL_SECONDS,
    financeCacheTtlHuman: formatDuration(FINANCE_CACHE_TTL_SECONDS),
    exportTokenTtlSeconds: EXPORT_TOKEN_TTL_SECONDS,
    exportTokenTtlHuman: formatDuration(EXPORT_TOKEN_TTL_SECONDS),
    exportTokenSecretConfigured: Boolean(process.env.EXPORT_TOKEN_SECRET),
    exportTokenSecretSource: process.env.EXPORT_TOKEN_SECRET ? "EXPORT_TOKEN_SECRET" : "HMAC_SECRET fallback"
  };
}
