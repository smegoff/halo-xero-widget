// lib/hmac.js
import crypto from "crypto";

export function validateHaloHmac(req) {
  const secret = process.env.HMAC_SECRET;
  const received = req.query.hmac;
  const agent = req.query.agentId;

  if (!secret || !received || !agent) {
    return { valid: false };
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(agent)
    .digest("base64");

  return { valid: expected === received, agent };
}
