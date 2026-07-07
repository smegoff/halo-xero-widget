import { pgPool } from "./db.js";
import { getGoCardlessDirectDebitAlertSummary } from "./gocardless.js";
import { findHaloClientByXeroGuid } from "./halo-direct-debit.js";
import { haloPost } from "./halo.js";

const DEFAULT_TICKET_TYPE_ID = 38;
const DEFAULT_TEAM_ID = 2;
const DEFAULT_AGENT_ID = 43;
const DEFAULT_PRIORITY_ID = 2;
const DEFAULT_STATUS_ID = 1;
const DEFAULT_FALLBACK_CLIENT_ID = 1;
const DEFAULT_FALLBACK_SITE_ID = 1;
const DEFAULT_ADMIN_URL = "https://widget.engagetech.nz/admin/gocardless#unmapped-mandates";

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function ticketConfig() {
  return {
    ticketTypeId: envInt("HALO_DD_TICKET_TYPE_ID", DEFAULT_TICKET_TYPE_ID),
    teamId: envInt("HALO_DD_TICKET_TEAM_ID", DEFAULT_TEAM_ID),
    agentId: envInt("HALO_DD_TICKET_AGENT_ID", DEFAULT_AGENT_ID),
    priorityId: envInt("HALO_DD_TICKET_PRIORITY_ID", DEFAULT_PRIORITY_ID),
    statusId: envInt("HALO_DD_TICKET_STATUS_ID", DEFAULT_STATUS_ID),
    fallbackClientId: envInt("HALO_DD_TICKET_FALLBACK_CLIENT_ID", DEFAULT_FALLBACK_CLIENT_ID),
    fallbackSiteId: envInt("HALO_DD_TICKET_FALLBACK_SITE_ID", DEFAULT_FALLBACK_SITE_ID),
    adminUrl: String(process.env.HALO_DD_TICKET_ADMIN_URL || process.env.ADMIN_BASE_URL || DEFAULT_ADMIN_URL)
      .replace(/\/+$/g, "")
      .replace(/\/admin$/i, "/admin/gocardless#unmapped-mandates")
  };
}

function errorMessage(err) {
  const data = err.response?.data;
  if (typeof data === "string" && data.trim()) return data.trim();
  if (data && typeof data === "object") return JSON.stringify(data);
  return String(err.response?.status || err.message);
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normaliseGuid(value) {
  return clean(value).toLowerCase();
}

function statusSummary(item) {
  const counts = item.mandateStatusCounts || {};
  const parts = Object.entries(counts)
    .filter(([, count]) => Number(count || 0) > 0)
    .map(([status, count]) => `${status}: ${count}`);
  return parts.length ? parts.join(", ") : "unknown";
}

function mandateLines(mandates = []) {
  if (!mandates.length) return ["- No mandate records were included in the scan result."];

  return mandates.map(mandate => {
    const fields = [
      mandate.id,
      mandate.status ? `status ${mandate.status}` : "",
      mandate.reference ? `reference ${mandate.reference}` : "",
      mandate.dashboardUrl || ""
    ].filter(Boolean);
    return `- ${fields.join(" | ")}`;
  });
}

function candidateLines(candidates = []) {
  if (!candidates.length) return ["- No safe Halo/Xero candidate was found. Map manually in the GoCardless admin page."];

  return candidates.map(candidate => {
    const sources = Array.isArray(candidate.sources) && candidate.sources.length
      ? ` via ${candidate.sources.join(", ")}`
      : "";
    return `- ${candidate.haloClientName || "Halo client"} | Xero GUID ${candidate.xeroContactGuid}${sources}`;
  });
}

function buildUnmappedException(item) {
  const activeCount = Number(item.activeCount || 0);
  const customerName = clean(item.customerName) || item.customerId;
  const summary = activeCount > 0
    ? `Direct Debit mandate needs mapping - ${customerName}`
    : `Pending Direct Debit mandate needs review - ${customerName}`;

  return {
    key: `gocardless-unmapped:${item.customerId}`,
    type: activeCount > 0 ? "unmapped_active_mandate" : "unmapped_pending_mandate",
    gocardlessCustomerId: item.customerId,
    xeroContactGuid: item.suggestedXeroContactGuid || "",
    haloClientName: item.candidates?.[0]?.haloClientName || "",
    summary,
    details: [
      "A GoCardless customer has an eligible Direct Debit mandate but is not mapped to a Halo/Xero customer in the widget.",
      "",
      `GoCardless customer: ${customerName}`,
      `GoCardless customer ID: ${item.customerId}`,
      `Email: ${item.email || "Not provided"}`,
      `Mandate statuses: ${statusSummary(item)}`,
      "",
      "Mandates:",
      ...mandateLines(item.mandates),
      "",
      "Safe Halo/Xero candidates:",
      ...candidateLines(item.candidates),
      "",
      `Admin mapping page: ${ticketConfig().adminUrl}`,
      "",
      "Customer notification has been suppressed by the integration."
    ].join("\n"),
    raw: item
  };
}

function buildDuplicateException(item) {
  const customerId = item.gocardless_customer_id;
  return {
    key: `gocardless-duplicate-map:${customerId}`,
    type: "duplicate_mapping",
    gocardlessCustomerId: customerId,
    xeroContactGuid: item.xero_contact_guids?.[0] || "",
    haloClientName: item.halo_client_names?.find(Boolean) || "",
    summary: `Direct Debit mapping conflict - ${customerId}`,
    details: [
      "A GoCardless customer is mapped to more than one Xero Contact GUID in the widget.",
      "",
      `GoCardless customer ID: ${customerId}`,
      `Mapping count: ${item.mapping_count}`,
      `Xero Contact GUIDs: ${(item.xero_contact_guids || []).join(", ") || "None"}`,
      `Halo clients: ${(item.halo_client_names || []).filter(Boolean).join(", ") || "None"}`,
      "",
      `Admin mapping page: ${ticketConfig().adminUrl}`,
      "",
      "Customer notification has been suppressed by the integration."
    ].join("\n"),
    raw: item
  };
}

function buildMissingHaloException(item) {
  return {
    key: `gocardless-missing-halo:${item.xero_contact_guid}:${item.gocardless_customer_id}`,
    type: "missing_halo_client",
    gocardlessCustomerId: item.gocardless_customer_id,
    xeroContactGuid: item.xero_contact_guid,
    haloClientName: item.halo_client_name || "",
    summary: `Direct Debit mapping missing Halo client - ${item.gocardless_customer_id}`,
    details: [
      "A GoCardless mapping exists, but the Xero Contact GUID no longer resolves to a synced Halo client.",
      "",
      `GoCardless customer ID: ${item.gocardless_customer_id}`,
      `Mapped Xero Contact GUID: ${item.xero_contact_guid}`,
      `Stored Halo client name: ${item.halo_client_name || "None"}`,
      "",
      `Admin mapping page: ${ticketConfig().adminUrl}`,
      "",
      "Customer notification has been suppressed by the integration."
    ].join("\n"),
    raw: item
  };
}

function buildGuidMismatchException(item) {
  return {
    key: `gocardless-guid-mismatch:${item.goCardlessCustomerId}:${item.xeroContactGuid}`,
    type: "xero_guid_mismatch",
    gocardlessCustomerId: item.goCardlessCustomerId,
    xeroContactGuid: item.xeroContactGuid,
    haloClientName: item.haloClientName || "",
    summary: `Direct Debit Xero GUID mismatch - ${item.haloClientName || item.goCardlessCustomerId}`,
    details: [
      "A mapped GoCardless record exposes a different Xero GUID from the widget mapping.",
      "",
      `GoCardless customer ID: ${item.goCardlessCustomerId}`,
      `Mapped Xero Contact GUID: ${item.xeroContactGuid}`,
      `GoCardless exposed GUIDs: ${(item.exposedXeroContactGuids || []).join(", ") || "None"}`,
      `Halo client: ${item.haloClientName || "Unknown"}`,
      "",
      `Admin mapping page: ${ticketConfig().adminUrl}`,
      "",
      "Customer notification has been suppressed by the integration."
    ].join("\n"),
    raw: item
  };
}

function buildLookupFailureException(item) {
  return {
    key: `gocardless-api-lookup:${item.goCardlessCustomerId}`,
    type: "api_lookup_failure",
    gocardlessCustomerId: item.goCardlessCustomerId,
    xeroContactGuid: "",
    haloClientName: "",
    summary: `Direct Debit GoCardless lookup failed - ${item.goCardlessCustomerId}`,
    details: [
      "The Direct Debit exception scan could not query a mapped GoCardless customer.",
      "",
      `GoCardless customer ID: ${item.goCardlessCustomerId}`,
      `Error: ${item.error || "Unknown"}`,
      "",
      `Admin mapping page: ${ticketConfig().adminUrl}`,
      "",
      "Customer notification has been suppressed by the integration."
    ].join("\n"),
    raw: item
  };
}

export function buildDirectDebitTicketExceptions(summary) {
  if (!summary?.configured) return [];

  return [
    ...(summary.unmapped?.items || []).map(buildUnmappedException),
    ...(summary.duplicateMappings || []).map(buildDuplicateException),
    ...(summary.missingHaloClients || []).map(buildMissingHaloException),
    ...(summary.exposedGuidMismatches || []).map(buildGuidMismatchException),
    ...(summary.apiLookupFailures || []).map(buildLookupFailureException)
  ];
}

export async function ensureDirectDebitTicketTable() {
  await pgPool.query("CREATE SCHEMA IF NOT EXISTS halo");
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS halo.direct_debit_exception_ticket (
      exception_key text PRIMARY KEY,
      exception_type text NOT NULL,
      ticket_id integer,
      ticket_status text NOT NULL DEFAULT 'created',
      halo_client_id integer,
      halo_client_name text,
      xero_contact_guid text,
      gocardless_customer_id text,
      summary text NOT NULL,
      details text NOT NULL,
      raw_exception jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      last_error text
    )
  `);
}

async function getExistingTicketState(exceptionKey) {
  await ensureDirectDebitTicketTable();
  const { rows } = await pgPool.query(
    `
      SELECT exception_key, ticket_id, ticket_status
      FROM halo.direct_debit_exception_ticket
      WHERE exception_key = $1
      LIMIT 1
    `,
    [exceptionKey]
  );
  return rows[0] || null;
}

async function resolveHaloClient(exception) {
  const guid = normaliseGuid(exception.xeroContactGuid);
  if (!guid) return null;
  try {
    return await findHaloClientByXeroGuid(guid, exception.haloClientName);
  } catch (err) {
    console.warn("Halo client lookup failed for Direct Debit ticket:", guid, err.response?.status || err.message);
    return null;
  }
}

async function recordTicketState(exception, result) {
  await ensureDirectDebitTicketTable();
  await pgPool.query(
    `
      INSERT INTO halo.direct_debit_exception_ticket (
        exception_key,
        exception_type,
        ticket_id,
        ticket_status,
        halo_client_id,
        halo_client_name,
        xero_contact_guid,
        gocardless_customer_id,
        summary,
        details,
        raw_exception,
        last_error
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
      ON CONFLICT (exception_key)
      DO UPDATE SET
        ticket_id = COALESCE(EXCLUDED.ticket_id, halo.direct_debit_exception_ticket.ticket_id),
        ticket_status = EXCLUDED.ticket_status,
        halo_client_id = EXCLUDED.halo_client_id,
        halo_client_name = EXCLUDED.halo_client_name,
        xero_contact_guid = EXCLUDED.xero_contact_guid,
        gocardless_customer_id = EXCLUDED.gocardless_customer_id,
        summary = EXCLUDED.summary,
        details = EXCLUDED.details,
        raw_exception = EXCLUDED.raw_exception,
        last_error = EXCLUDED.last_error,
        last_seen_at = now(),
        updated_at = now()
    `,
    [
      exception.key,
      exception.type,
      result.ticketId || null,
      result.status,
      result.haloClient?.id || null,
      result.haloClient?.name || exception.haloClientName || null,
      normaliseGuid(exception.xeroContactGuid) || null,
      exception.gocardlessCustomerId || null,
      exception.summary,
      exception.details,
      JSON.stringify(exception.raw || {}),
      result.error || null
    ]
  );
}

async function createHaloExceptionTicket(exception, haloClient) {
  const config = ticketConfig();
  const payload = {
    summary: exception.summary,
    details: exception.details,
    tickettype_id: config.ticketTypeId,
    team_id: config.teamId,
    agent_id: config.agentId,
    status_id: config.statusId,
    priority_id: config.priorityId,
    sendack: false,
    emailuser: false,
    email_users: false,
    sendemail: false,
    dontsendemail: true
  };

  if (haloClient?.id) {
    payload.client_id = haloClient.id;
    if (haloClient.main_site_id) payload.site_id = haloClient.main_site_id;
  } else {
    payload.client_id = config.fallbackClientId;
    payload.site_id = config.fallbackSiteId;
  }

  const response = await haloPost("/Tickets", [payload]);
  const ticketId = response?.id || response?.tickets?.[0]?.id || null;
  if (!ticketId) {
    throw new Error("Halo ticket create response did not include a ticket ID.");
  }

  return ticketId;
}

export async function syncDirectDebitExceptionTicketsForSummary(summary) {
  const exceptions = buildDirectDebitTicketExceptions(summary);
  const result = {
    configured: Boolean(summary?.configured),
    scanned: exceptions.length,
    created: 0,
    existing: 0,
    failed: 0,
    tickets: [],
    failures: []
  };

  if (!result.configured) return result;

  await ensureDirectDebitTicketTable();

  for (const exception of exceptions) {
    try {
      const existing = await getExistingTicketState(exception.key);
      if (existing?.ticket_id) {
        await recordTicketState(exception, {
          ticketId: existing.ticket_id,
          status: "existing"
        });
        result.existing += 1;
        result.tickets.push({ key: exception.key, ticketId: existing.ticket_id, status: "existing" });
        continue;
      }

      const haloClient = await resolveHaloClient(exception);
      const ticketId = await createHaloExceptionTicket(exception, haloClient);
      await recordTicketState(exception, {
        ticketId,
        status: "created",
        haloClient
      });

      result.created += 1;
      result.tickets.push({
        key: exception.key,
        ticketId,
        status: "created",
        haloClientId: haloClient?.id || null,
        haloClientName: haloClient?.name || null
      });
    } catch (err) {
      await recordTicketState(exception, {
        status: "failed",
        error: errorMessage(err)
      });
      result.failed += 1;
      result.failures.push({
        key: exception.key,
        summary: exception.summary,
        error: errorMessage(err)
      });
    }
  }

  return result;
}

export async function syncDirectDebitExceptionTickets(options = {}) {
  const summary = await getGoCardlessDirectDebitAlertSummary({
    unmappedLimit: options.unmappedLimit,
    mismatchLimit: options.mismatchLimit,
    mappedCheckLimit: options.mappedCheckLimit,
    includeCandidates: true
  });

  return syncDirectDebitExceptionTicketsForSummary(summary);
}
