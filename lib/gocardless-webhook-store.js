import { pgPool } from "./db.js";
import { statusLabel, statusTone } from "./gocardless-status.js";

let ensurePromise = null;

export function ensureGoCardlessWebhookTables() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await pgPool.query("CREATE SCHEMA IF NOT EXISTS halo");
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS halo.gocardless_webhook_event (
          event_id text PRIMARY KEY,
          webhook_id text,
          resource_type text NOT NULL,
          action text NOT NULL,
          mandate_id text,
          customer_id text,
          event_created_at timestamptz,
          received_at timestamptz NOT NULL DEFAULT now(),
          processed_at timestamptz,
          processing_status text NOT NULL DEFAULT 'received',
          processing_error text,
          raw_event jsonb NOT NULL
        )
      `);
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS halo.gocardless_mandate_state (
          mandate_id text PRIMARY KEY,
          gocardless_customer_id text,
          status text NOT NULL,
          status_source text NOT NULL,
          source_event_id text,
          event_created_at timestamptz,
          updated_at timestamptz NOT NULL DEFAULT now(),
          raw_event jsonb
        )
      `);
      await pgPool.query(`
        CREATE INDEX IF NOT EXISTS gocardless_webhook_event_received_idx
        ON halo.gocardless_webhook_event (received_at DESC)
      `);
      await pgPool.query(`
        CREATE INDEX IF NOT EXISTS gocardless_webhook_event_customer_idx
        ON halo.gocardless_webhook_event (customer_id)
      `);
      await pgPool.query(`
        CREATE INDEX IF NOT EXISTS gocardless_mandate_state_customer_idx
        ON halo.gocardless_mandate_state (gocardless_customer_id)
      `);
    })();
  }

  return ensurePromise;
}

export async function insertGoCardlessWebhookEvent(input) {
  await ensureGoCardlessWebhookTables();

  const { rowCount } = await pgPool.query(
    `
      INSERT INTO halo.gocardless_webhook_event (
        event_id,
        webhook_id,
        resource_type,
        action,
        mandate_id,
        customer_id,
        event_created_at,
        raw_event
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (event_id) DO NOTHING
    `,
    [
      input.eventId,
      input.webhookId || null,
      input.resourceType,
      input.action,
      input.mandateId || null,
      input.customerId || null,
      input.eventCreatedAt || null,
      input.rawEvent
    ]
  );

  return rowCount === 1;
}

export async function updateGoCardlessWebhookEventStatus(eventId, status, error = null) {
  await ensureGoCardlessWebhookTables();

  await pgPool.query(
    `
      UPDATE halo.gocardless_webhook_event
      SET processing_status = $2,
          processing_error = $3,
          processed_at = now()
      WHERE event_id = $1
    `,
    [eventId, status, error ? String(error).slice(0, 1000) : null]
  );
}

export async function updateGoCardlessWebhookEventCustomer(eventId, customerId) {
  await ensureGoCardlessWebhookTables();
  if (!eventId || !customerId) return;

  await pgPool.query(
    `
      UPDATE halo.gocardless_webhook_event
      SET customer_id = COALESCE(customer_id, $2)
      WHERE event_id = $1
    `,
    [eventId, customerId]
  );
}

export async function upsertGoCardlessMandateState(input) {
  await ensureGoCardlessWebhookTables();

  await pgPool.query(
    `
      INSERT INTO halo.gocardless_mandate_state AS existing (
        mandate_id,
        gocardless_customer_id,
        status,
        status_source,
        source_event_id,
        event_created_at,
        updated_at,
        raw_event
      )
      VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
      ON CONFLICT (mandate_id)
      DO UPDATE SET
        gocardless_customer_id = COALESCE(EXCLUDED.gocardless_customer_id, existing.gocardless_customer_id),
        status = EXCLUDED.status,
        status_source = EXCLUDED.status_source,
        source_event_id = EXCLUDED.source_event_id,
        event_created_at = EXCLUDED.event_created_at,
        updated_at = now(),
        raw_event = EXCLUDED.raw_event
      WHERE
        existing.event_created_at IS NULL
        OR EXCLUDED.event_created_at IS NULL
        OR EXCLUDED.event_created_at >= existing.event_created_at
    `,
    [
      input.mandateId,
      input.customerId || null,
      input.status,
      input.statusSource,
      input.sourceEventId || null,
      input.eventCreatedAt || null,
      input.rawEvent || null
    ]
  );
}

export async function upsertGoCardlessMandateStateFromApi(input) {
  await ensureGoCardlessWebhookTables();

  await pgPool.query(
    `
      INSERT INTO halo.gocardless_mandate_state AS existing (
        mandate_id,
        gocardless_customer_id,
        status,
        status_source,
        event_created_at,
        updated_at,
        raw_event
      )
      VALUES ($1, $2, $3, 'api', $4, now(), $5)
      ON CONFLICT (mandate_id)
      DO UPDATE SET
        gocardless_customer_id = COALESCE(EXCLUDED.gocardless_customer_id, existing.gocardless_customer_id),
        status = EXCLUDED.status,
        status_source = 'api',
        event_created_at = EXCLUDED.event_created_at,
        updated_at = now(),
        raw_event = EXCLUDED.raw_event
      WHERE existing.status_source = 'api'
    `,
    [
      input.mandateId,
      input.customerId || null,
      input.status,
      input.eventCreatedAt || null,
      input.rawEvent || null
    ]
  );
}

export async function listGoCardlessMandateStatesForCustomer(customerId) {
  await ensureGoCardlessWebhookTables();
  if (!customerId) return [];

  const { rows } = await pgPool.query(
    `
      SELECT
        mandate_id,
        gocardless_customer_id,
        status,
        status_source,
        source_event_id,
        event_created_at,
        updated_at
      FROM halo.gocardless_mandate_state
      WHERE gocardless_customer_id = $1
      ORDER BY updated_at DESC
    `,
    [customerId]
  );

  return rows;
}

export function summariseStoredMandateState(row, dashboardUrl) {
  return {
    id: row.mandate_id,
    reference: null,
    status: row.status,
    statusLabel: statusLabel(row.status),
    statusTone: statusTone(row.status),
    scheme: null,
    nextPossibleChargeDate: "",
    bankAccountId: null,
    dashboardUrl,
    source: row.status_source,
    updatedAt: row.updated_at,
    eventCreatedAt: row.event_created_at
  };
}

export async function getGoCardlessWebhookAdminOverview() {
  await ensureGoCardlessWebhookTables();

  const [{ rows: latestRows }, { rows: recentEvents }, { rows: failedEvents }] = await Promise.all([
    pgPool.query(`
      SELECT received_at
      FROM halo.gocardless_webhook_event
      ORDER BY received_at DESC
      LIMIT 1
    `),
    pgPool.query(`
      SELECT
        event_id,
        webhook_id,
        resource_type,
        action,
        mandate_id,
        customer_id,
        event_created_at,
        received_at,
        processing_status,
        processing_error
      FROM halo.gocardless_webhook_event
      WHERE resource_type = 'mandates'
      ORDER BY received_at DESC
      LIMIT 10
    `),
    pgPool.query(`
      SELECT
        event_id,
        resource_type,
        action,
        mandate_id,
        customer_id,
        received_at,
        processing_error
      FROM halo.gocardless_webhook_event
      WHERE processing_status = 'failed'
      ORDER BY received_at DESC
      LIMIT 10
    `)
  ]);

  return {
    lastReceivedAt: latestRows[0]?.received_at || null,
    recentEvents,
    failedEvents
  };
}
