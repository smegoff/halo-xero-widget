import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const DEFAULT_ACTION_TOKEN_TTL_SECONDS = 24 * 60 * 60;

function getActionTokenSecret() {
  const secret =
    process.env.ADMIN_ACTION_TOKEN_SECRET ||
    process.env.ADMIN_SESSION_SECRET ||
    process.env.EXPORT_TOKEN_SECRET;

  if (!secret) {
    throw new Error("ADMIN_ACTION_TOKEN_SECRET, ADMIN_SESSION_SECRET, or EXPORT_TOKEN_SECRET is required for admin action links.");
  }

  return secret;
}

function getActionTokenTtlSeconds() {
  const value = Number.parseInt(process.env.ADMIN_ACTION_TOKEN_TTL_SECONDS || "", 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ACTION_TOKEN_TTL_SECONDS;
}

export function createGoCardlessMapActionToken(input) {
  const payload = {
    action: "gocardless_map",
    xeroContactGuid: String(input.xeroContactGuid || "").trim(),
    goCardlessCustomerId: String(input.goCardlessCustomerId || "").trim(),
    haloClientName: String(input.haloClientName || "").trim(),
    goCardlessCustomerName: String(input.goCardlessCustomerName || "").trim()
  };

  if (!/^[0-9a-fA-F-]{36}$/.test(payload.xeroContactGuid)) {
    throw new Error("Cannot create mapping action token without a valid Xero Contact GUID.");
  }
  if (!/^CU[0-9A-Z]+$/i.test(payload.goCardlessCustomerId)) {
    throw new Error("Cannot create mapping action token without a valid GoCardless customer ID.");
  }

  return jwt.sign(payload, getActionTokenSecret(), {
    expiresIn: getActionTokenTtlSeconds()
  });
}

export function verifyGoCardlessMapActionToken(token) {
  const payload = jwt.verify(String(token || ""), getActionTokenSecret());

  if (payload?.action !== "gocardless_map") {
    throw new Error("Action token is not valid for GoCardless mapping.");
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(payload.xeroContactGuid || "")) {
    throw new Error("Action token has an invalid Xero Contact GUID.");
  }
  if (!/^CU[0-9A-Z]+$/i.test(payload.goCardlessCustomerId || "")) {
    throw new Error("Action token has an invalid GoCardless customer ID.");
  }

  return {
    xeroContactGuid: payload.xeroContactGuid,
    goCardlessCustomerId: String(payload.goCardlessCustomerId).toUpperCase(),
    haloClientName: payload.haloClientName || "",
    goCardlessCustomerName: payload.goCardlessCustomerName || ""
  };
}
