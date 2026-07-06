import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  normaliseGoCardlessWebhookEvent,
  verifyGoCardlessWebhookSignature
} from "../lib/gocardless-webhook-utils.js";
import { isGoCardlessActiveMandateStatus } from "../lib/gocardless-status.js";

const secret = "test-webhook-secret";
const rawBody = Buffer.from(JSON.stringify({
  events: [
    {
      id: "EV123",
      created_at: "2026-07-07T00:00:00.000Z",
      resource_type: "mandates",
      action: "active",
      links: { mandate: "MD123" },
      resource_metadata: { customer_id: "CU123" }
    }
  ],
  meta: { webhook_id: "WB123" }
}));
const validSignature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

assert.equal(verifyGoCardlessWebhookSignature(rawBody, validSignature, secret), true);
assert.equal(verifyGoCardlessWebhookSignature(rawBody, "00", secret), false);
assert.equal(verifyGoCardlessWebhookSignature(rawBody, validSignature, ""), false);

const eventInfo = normaliseGoCardlessWebhookEvent(JSON.parse(rawBody.toString("utf8")).events[0], "WB123");
assert.equal(eventInfo.eventId, "EV123");
assert.equal(eventInfo.webhookId, "WB123");
assert.equal(eventInfo.resourceType, "mandates");
assert.equal(eventInfo.action, "active");
assert.equal(eventInfo.mandateId, "MD123");
assert.equal(eventInfo.customerId, "CU123");

assert.equal(isGoCardlessActiveMandateStatus("active"), true);
assert.equal(isGoCardlessActiveMandateStatus("pending_submission"), false);
assert.equal(isGoCardlessActiveMandateStatus("submitted"), false);
assert.equal(isGoCardlessActiveMandateStatus("failed"), false);

console.log("GoCardless webhook unit checks passed.");
