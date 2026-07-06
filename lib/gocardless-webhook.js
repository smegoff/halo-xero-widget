import { getGoCardlessWebhookSecret } from "./config.js";
import { getGoCardlessMandateById } from "./gocardless.js";
import { getGoCardlessMappingsForCustomerId } from "./gocardless-map.js";
import { updateHaloDirectDebitFieldForMapping } from "./halo-direct-debit.js";
import {
  normaliseGoCardlessWebhookEvent,
  verifyGoCardlessWebhookSignature
} from "./gocardless-webhook-utils.js";
import {
  insertGoCardlessWebhookEvent,
  updateGoCardlessWebhookEventCustomer,
  updateGoCardlessWebhookEventStatus,
  upsertGoCardlessMandateState
} from "./gocardless-webhook-store.js";

export class GoCardlessWebhookError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "GoCardlessWebhookError";
    this.statusCode = statusCode;
  }
}

function parseWebhookBody(rawBody) {
  try {
    return JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || ""));
  } catch {
    throw new GoCardlessWebhookError("Invalid GoCardless webhook JSON.", 400);
  }
}

async function resolveMandateCustomerId(eventInfo) {
  if (eventInfo.customerId || !eventInfo.mandateId) {
    return eventInfo.customerId;
  }

  const mandate = await getGoCardlessMandateById(eventInfo.mandateId);
  return mandate?.links?.customer || null;
}

async function processMandateEvent(eventInfo) {
  if (!eventInfo.mandateId) {
    await updateGoCardlessWebhookEventStatus(eventInfo.eventId, "ignored", "Mandate event had no mandate link.");
    return { status: "ignored", reason: "missing_mandate_id" };
  }

  const customerId = await resolveMandateCustomerId(eventInfo);
  if (customerId) {
    await updateGoCardlessWebhookEventCustomer(eventInfo.eventId, customerId);
  }

  await upsertGoCardlessMandateState({
    mandateId: eventInfo.mandateId,
    customerId,
    status: eventInfo.action,
    statusSource: "webhook",
    sourceEventId: eventInfo.eventId,
    eventCreatedAt: eventInfo.eventCreatedAt,
    rawEvent: eventInfo.rawEvent
  });

  let haloSync = { mappings: 0, updated: 0, failed: 0 };
  if (customerId) {
    const mappings = await getGoCardlessMappingsForCustomerId(customerId);
    haloSync.mappings = mappings.length;

    for (const mapping of mappings) {
      try {
        const result = await updateHaloDirectDebitFieldForMapping(mapping);
        if (result.updated) haloSync.updated += 1;
      } catch (err) {
        haloSync.failed += 1;
        console.warn(
          "Halo Direct Debit sync failed after GoCardless webhook:",
          customerId,
          err.response?.status || err.message
        );
      }
    }
  }

  await updateGoCardlessWebhookEventStatus(
    eventInfo.eventId,
    haloSync.failed > 0 ? "processed_with_sync_errors" : "processed"
  );

  return { status: "processed", customerId, haloSync };
}

async function processWebhookEvent(event, webhookId) {
  const eventInfo = normaliseGoCardlessWebhookEvent(event, webhookId);
  if (!eventInfo.eventId || !eventInfo.resourceType || !eventInfo.action) {
    return { status: "ignored", reason: "missing_required_event_fields" };
  }

  const inserted = await insertGoCardlessWebhookEvent(eventInfo);
  if (!inserted) {
    return { status: "duplicate", eventId: eventInfo.eventId };
  }

  try {
    if (eventInfo.resourceType !== "mandates") {
      await updateGoCardlessWebhookEventStatus(eventInfo.eventId, "ignored");
      return { status: "ignored", eventId: eventInfo.eventId, reason: "unsupported_resource_type" };
    }

    return {
      eventId: eventInfo.eventId,
      ...(await processMandateEvent(eventInfo))
    };
  } catch (err) {
    await updateGoCardlessWebhookEventStatus(eventInfo.eventId, "failed", err.response?.status || err.message);
    return {
      status: "failed",
      eventId: eventInfo.eventId,
      error: err.response?.status || err.message
    };
  }
}

export async function processGoCardlessWebhookRequest(rawBody, signature) {
  const secret = getGoCardlessWebhookSecret();
  if (!secret) {
    throw new GoCardlessWebhookError("GoCardless webhook secret is not configured.", 503);
  }

  if (!verifyGoCardlessWebhookSignature(rawBody, signature, secret)) {
    throw new GoCardlessWebhookError("Invalid GoCardless webhook signature.", 401);
  }

  const body = parseWebhookBody(rawBody);
  const webhookId = body?.meta?.webhook_id || null;
  const events = Array.isArray(body?.events) ? body.events : [];

  const results = [];
  for (const event of events) {
    results.push(await processWebhookEvent(event, webhookId));
  }

  return {
    webhookId,
    eventCount: events.length,
    processed: results.filter(result => result.status === "processed").length,
    duplicates: results.filter(result => result.status === "duplicate").length,
    ignored: results.filter(result => result.status === "ignored").length,
    failed: results.filter(result => result.status === "failed").length,
    results
  };
}
