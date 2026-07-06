import crypto from "crypto";

function timingSafeHexEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "hex");
  const rightBuffer = Buffer.from(String(right || ""), "hex");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyGoCardlessWebhookSignature(rawBody, signature, secret) {
  if (!secret) return false;
  if (!signature) return false;

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  try {
    return timingSafeHexEqual(expectedSignature, signature);
  } catch {
    return false;
  }
}

export function normaliseGoCardlessWebhookEvent(event, webhookId = null) {
  return {
    eventId: String(event?.id || "").trim(),
    webhookId,
    resourceType: String(event?.resource_type || "").trim(),
    action: String(event?.action || "").trim(),
    mandateId: String(event?.links?.mandate || "").trim() || null,
    customerId:
      String(event?.links?.customer || "").trim() ||
      String(event?.resource_metadata?.customer_id || "").trim() ||
      String(event?.resource_metadata?.customer || "").trim() ||
      null,
    eventCreatedAt: event?.created_at || null,
    rawEvent: event
  };
}
