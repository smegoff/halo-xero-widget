import axios from "axios";

import { getGoCardlessAccessToken } from "./config.js";
import { pgPool } from "./db.js";
import { getXeroHeaders } from "./xero.js";
import {
  getGoCardlessMappingForXeroGuid,
  getGoCardlessMappingsForCustomerId,
  getHaloClientByXeroGuid,
  getHaloClientsByExactName,
  getUniqueHaloClientByName,
  insertAutoGoCardlessMapping,
  listGoCardlessMappings
} from "./gocardless-map.js";
import {
  isGoCardlessActiveMandateStatus,
  isMappableMandateStatus,
  MAPPABLE_MANDATE_STATUSES,
  PROBLEM_MANDATE_STATUSES,
  statusLabel,
  statusTone,
  WARNING_MANDATE_STATUSES
} from "./gocardless-status.js";
import {
  listGoCardlessMandateStatesForCustomer,
  summariseStoredMandateState,
  upsertGoCardlessMandateStateFromApi
} from "./gocardless-webhook-store.js";

const GOCARDLESS_VERSION = "2015-07-06";
const XERO_API_BASE_URL = "https://api.xero.com/api.xro/2.0";
const LIVE_API_BASE_URL = "https://api.gocardless.com";
const SANDBOX_API_BASE_URL = "https://api-sandbox.gocardless.com";
const LIVE_DASHBOARD_BASE_URL = "https://manage.gocardless.com";
const SANDBOX_DASHBOARD_BASE_URL = "https://manage-sandbox.gocardless.com";
const PROBLEM_PAYMENT_STATUSES = new Set([
  "failed",
  "cancelled",
  "customer_approval_denied",
  "charged_back"
]);
const XERO_GUID_PATTERN =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

function getApiBaseUrl() {
  return process.env.GOCARDLESS_ENVIRONMENT === "sandbox"
    ? SANDBOX_API_BASE_URL
    : LIVE_API_BASE_URL;
}

function getDashboardBaseUrl() {
  return process.env.GOCARDLESS_ENVIRONMENT === "sandbox"
    ? SANDBOX_DASHBOARD_BASE_URL
    : LIVE_DASHBOARD_BASE_URL;
}

function goCardlessCustomerUrl(customerId) {
  return customerId ? `${getDashboardBaseUrl()}/customers/${encodeURIComponent(customerId)}` : null;
}

function goCardlessMandateUrl(mandateId) {
  return mandateId ? `${getDashboardBaseUrl()}/mandates/${encodeURIComponent(mandateId)}` : null;
}

function getGoCardlessHeaders() {
  const token = getGoCardlessAccessToken();
  if (!token) {
    throw new Error("GoCardless access token is not configured.");
  }

  return {
    Authorization: `Bearer ${token}`,
    "GoCardless-Version": GOCARDLESS_VERSION,
    Accept: "application/json"
  };
}

async function goCardlessGet(path, params = {}) {
  const response = await axios.get(`${getApiBaseUrl()}${path}`, {
    headers: getGoCardlessHeaders(),
    params,
    timeout: 10000
  });

  return response.data;
}

async function xeroGet(path, params = {}) {
  const response = await axios.get(`${XERO_API_BASE_URL}${path}`, {
    headers: await getXeroHeaders(),
    params,
    timeout: 10000
  });

  return response.data;
}

function customerName(customer) {
  return (
    customer?.company_name ||
    [customer?.given_name, customer?.family_name].filter(Boolean).join(" ") ||
    customer?.email ||
    customer?.id ||
    ""
  );
}

function normaliseName(value) {
  return String(value || "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normaliseEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function escapeXeroWhereString(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatDate(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function incrementCount(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

function extractGuidsFromValue(value, found = new Set()) {
  if (value === null || typeof value === "undefined") return found;

  if (typeof value === "string" || typeof value === "number") {
    const matches = String(value).match(XERO_GUID_PATTERN) || [];
    matches.forEach(match => found.add(match.toLowerCase()));
    return found;
  }

  if (Array.isArray(value)) {
    value.forEach(item => extractGuidsFromValue(item, found));
    return found;
  }

  if (typeof value === "object") {
    Object.values(value).forEach(item => extractGuidsFromValue(item, found));
  }

  return found;
}

async function getUniqueXeroContactByEmail(email, cache = new Map()) {
  const normalisedEmail = normaliseEmail(email);
  if (!normalisedEmail) return { contact: null, matchCount: 0 };
  if (cache.has(normalisedEmail)) return cache.get(normalisedEmail);

  try {
    const data = await xeroGet("/Contacts", {
      where: `EmailAddress=="${escapeXeroWhereString(normalisedEmail)}"`
    });
    const matches = (data.Contacts || []).filter(
      contact => normaliseEmail(contact.EmailAddress) === normalisedEmail && contact.ContactID
    );
    const result = {
      contact: matches.length === 1 ? matches[0] : null,
      matchCount: matches.length
    };
    cache.set(normalisedEmail, result);
    return result;
  } catch (err) {
    console.warn("⚠️ Xero contact email lookup failed:", err.response?.status || err.message);
    const result = { contact: null, matchCount: 0 };
    cache.set(normalisedEmail, result);
    return result;
  }
}

async function getXeroContactByGuid(xeroContactGuid) {
  if (!xeroContactGuid) return null;

  const data = await xeroGet(`/Contacts/${encodeURIComponent(xeroContactGuid)}`);
  return data.Contacts?.[0] || null;
}

export async function getGoCardlessMandateById(mandateId) {
  if (!mandateId) return null;

  const data = await goCardlessGet(`/mandates/${encodeURIComponent(mandateId)}`);
  return data.mandates || null;
}

async function getUniqueMappableGoCardlessCustomerByEmail(email) {
  const normalisedEmail = normaliseEmail(email);
  if (!normalisedEmail) return { customer: null, matchCount: 0 };

  const matches = await searchGoCardlessCustomersWithMandates(normalisedEmail, 20);
  const exactMappableMatches = matches.filter(customer =>
    normaliseEmail(customer.email) === normalisedEmail &&
    Number(customer.mandateStatus?.mappableCount || 0) > 0
  );

  return {
    customer: exactMappableMatches.length === 1 ? exactMappableMatches[0] : null,
    matchCount: exactMappableMatches.length
  };
}

async function listMappableMandates() {
  const mandates = [];
  let after = null;

  for (let page = 0; page < 20; page += 1) {
    const params = {
      limit: 500
    };
    if (after) params.after = after;

    const data = await goCardlessGet("/mandates", params);
    mandates.push(...(data.mandates || []).filter(mandate => isMappableMandateStatus(mandate.status)));

    after = data.meta?.cursors?.after;
    if (!after || !data.mandates?.length) break;
  }

  return mandates;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

async function getCustomersForMandates(mandates) {
  const customerIds = [...new Set(mandates.map(mandate => mandate.links?.customer).filter(Boolean))];
  const customers = new Map();

  await mapWithConcurrency(customerIds, 8, async customerId => {
    try {
      const data = await goCardlessGet(`/customers/${customerId}`);
      if (data.customers) customers.set(customerId, data.customers);
    } catch (err) {
      console.warn(
        "⚠️ GoCardless customer lookup failed during auto-map:",
        customerId,
        err.response?.status || err.message
      );
    }
  });

  return customers;
}

async function getMandateStatusCountsForCustomer(customerId) {
  const counts = {};
  let latestStatus = null;
  let latestCreatedAt = null;
  let latestReference = null;
  let after = null;

  do {
    const params = {
      customer: customerId,
      limit: 500
    };
    if (after) params.after = after;

    const data = await goCardlessGet("/mandates", params);
    for (const mandate of data.mandates || []) {
      incrementCount(counts, mandate.status || "unknown");
      const createdAt = mandate.created_at || "";
      if (!latestCreatedAt || createdAt > latestCreatedAt) {
        latestCreatedAt = createdAt;
        latestStatus = mandate.status || "unknown";
        latestReference = mandate.reference || null;
      }
    }

    after = data.meta?.cursors?.after;
  } while (after);

  return {
    counts,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    activeCount: counts.active || 0,
    mappableCount: [...MAPPABLE_MANDATE_STATUSES].reduce((sum, status) => sum + (counts[status] || 0), 0),
    problemCount: [...PROBLEM_MANDATE_STATUSES].reduce((sum, status) => sum + (counts[status] || 0), 0),
    latestStatus,
    latestStatusLabel: statusLabel(latestStatus),
    latestReference
  };
}

function summariseMandates(mandates) {
  return mandates.map(mandate => ({
    id: mandate.id,
    reference: mandate.reference,
    status: mandate.status,
    statusLabel: statusLabel(mandate.status),
    statusTone: statusTone(mandate.status),
    scheme: mandate.scheme,
    nextPossibleChargeDate: formatDate(mandate.next_possible_charge_date),
    bankAccountId: mandate.links?.customer_bank_account || null,
    dashboardUrl: goCardlessMandateUrl(mandate.id)
  }));
}

function mergeStoredAndApiMandates(apiMandates, storedStates) {
  const merged = new Map();

  for (const mandate of apiMandates) {
    if (mandate.id) merged.set(mandate.id, mandate);
  }

  for (const state of storedStates) {
    if (!state.mandate_id) continue;
    merged.set(
      state.mandate_id,
      summariseStoredMandateState(state, goCardlessMandateUrl(state.mandate_id))
    );
  }

  return [...merged.values()];
}

function choosePrimaryMandate(mandates) {
  return (
    mandates.find(mandate => mandate.status === "active") ||
    mandates.find(mandate => mandate.statusTone === "warn") ||
    mandates[0] ||
    null
  );
}

function addCandidate(candidates, client, source) {
  if (!client?.xero_contact_guid) return;
  const guid = String(client.xero_contact_guid).toLowerCase();
  const existing = candidates.get(guid);
  if (existing) {
    existing.sources = [...new Set([...existing.sources, source])];
    return;
  }

  candidates.set(guid, {
    xeroContactGuid: guid,
    haloClientName: client.halo_client_name,
    xeroContactNumber: client.xero_contact_number || null,
    sources: [source]
  });
}

async function getUnmappedCandidateMatches(customer, xeroEmailCache) {
  const candidates = new Map();
  const notes = [];
  const name = customerName(customer);

  const exactNameMatches = await getHaloClientsByExactName(name);
  exactNameMatches.forEach(client => addCandidate(candidates, client, "Exact Halo name"));

  const emailMatch = await getUniqueXeroContactByEmail(customer.email, xeroEmailCache);
  if (emailMatch.matchCount === 1) {
    const haloClient = await getHaloClientByXeroGuid(emailMatch.contact.ContactID);
    if (haloClient) {
      addCandidate(candidates, haloClient, "Unique Xero email");
    } else {
      notes.push("Email matched one Xero contact, but no Halo client has that Xero GUID.");
    }
  } else if (emailMatch.matchCount > 1) {
    notes.push("Email matched multiple Xero contacts.");
  } else if (customer.email) {
    notes.push("Email did not match a Xero contact.");
  }

  const candidateList = [...candidates.values()].sort((a, b) =>
    String(a.haloClientName || "").localeCompare(String(b.haloClientName || ""))
  );

  return {
    candidates: candidateList,
    candidateCount: candidateList.length,
    suggestedXeroContactGuid: candidateList.length === 1 ? candidateList[0].xeroContactGuid : "",
    notes
  };
}

export async function testGoCardlessConnection() {
  const data = await goCardlessGet("/customers", { limit: 1 });
  return {
    ok: true,
    customerCountVisible: Array.isArray(data.customers) ? data.customers.length : 0
  };
}

export async function searchGoCardlessCustomers(query, limit = 20) {
  const normalisedQuery = String(query || "").trim().toLowerCase();
  if (!normalisedQuery) return [];

  const matches = [];
  let after = null;

  for (let page = 0; page < 10 && matches.length < limit; page += 1) {
    const params = {
      limit: 500,
      sort_field: "company_name",
      sort_direction: "asc"
    };
    if (after) params.after = after;

    const data = await goCardlessGet("/customers", params);
    const customers = data.customers || [];

    for (const customer of customers) {
      const metadataText = Object.entries(customer.metadata || {})
        .map(([key, value]) => `${key} ${value}`)
        .join(" ");
      const haystack = [
        customer.id,
        customerName(customer),
        customer.email,
        metadataText
      ].join(" ").toLowerCase();

      if (haystack.includes(normalisedQuery)) {
        matches.push({
          id: customer.id,
          name: customerName(customer),
          email: customer.email,
          countryCode: customer.country_code,
          metadata: customer.metadata || {},
          mandateStatus: null
        });
      }

      if (matches.length >= limit) break;
    }

    after = data.meta?.cursors?.after;
    if (!after || customers.length === 0) break;
  }

  return matches;
}

export async function searchGoCardlessCustomersWithMandates(query, limit = 20) {
  const customers = await searchGoCardlessCustomers(query, limit);
  const mandateSummaries = await mapWithConcurrency(customers, 6, customer =>
    getMandateStatusCountsForCustomer(customer.id)
  );

  return customers.map((customer, index) => ({
    ...customer,
    mandateStatus: mandateSummaries[index]
  }));
}

async function listProblemMandates(limit = 15) {
  const items = [];
  let after = null;

  try {
    for (let page = 0; page < 20 && items.length < limit; page += 1) {
      const params = {
        limit: 500
      };
      if (after) params.after = after;

      const data = await goCardlessGet("/mandates", params);
      for (const mandate of data.mandates || []) {
        if (!PROBLEM_MANDATE_STATUSES.has(mandate.status)) continue;

        items.push({
          type: "Mandate",
          severity: mandate.status === "failed" ? "error" : "warn",
          status: mandate.status,
          statusLabel: statusLabel(mandate.status),
          customerId: mandate.links?.customer || null,
          mandateId: mandate.id,
          reference: mandate.reference || null,
          date: formatDate(mandate.created_at),
          detail: "Problem mandate status"
        });

        if (items.length >= limit) break;
      }

      after = data.meta?.cursors?.after;
      if (!after || !data.mandates?.length) break;
    }
  } catch (err) {
    console.warn(
      "⚠️ GoCardless problem mandate scan failed:",
      err.response?.status || err.message
    );
  }

  return items;
}

async function listProblemPayments(limit = 15) {
  const items = [];
  let after = null;

  try {
    for (let page = 0; page < 20 && items.length < limit; page += 1) {
      const params = {
        limit: 500
      };
      if (after) params.after = after;

      const data = await goCardlessGet("/payments", params);
      for (const payment of data.payments || []) {
        if (!PROBLEM_PAYMENT_STATUSES.has(payment.status)) continue;

        items.push({
          type: "Payment",
          severity: ["failed", "charged_back"].includes(payment.status) ? "error" : "warn",
          status: payment.status,
          statusLabel: statusLabel(payment.status),
          customerId: payment.links?.customer || null,
          paymentId: payment.id,
          mandateId: payment.links?.mandate || null,
          reference: payment.reference || null,
          date: formatDate(payment.charge_date || payment.created_at),
          detail: payment.description || "Problem payment status"
        });

        if (items.length >= limit) break;
      }

      after = data.meta?.cursors?.after;
      if (!after || !data.payments?.length) break;
    }
  } catch (err) {
    console.warn(
      "⚠️ GoCardless problem payment scan failed:",
      err.response?.status || err.message
    );
  }

  return items;
}

function findDuplicateCustomerGroups(customers, limit = 10) {
  const groups = new Map();

  for (const customer of customers) {
    const name = customerName(customer).trim().toLowerCase();
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({
      id: customer.id,
      name: customerName(customer),
      emailSet: Boolean(customer.email),
      metadataKeys: Object.keys(customer.metadata || {})
    });
  }

  return [...groups.values()]
    .filter(group => group.length > 1)
    .slice(0, limit);
}

async function listRecentCustomers(limit = 500) {
  const data = await goCardlessGet("/customers", {
    limit,
    sort_field: "created_at",
    sort_direction: "desc"
  });

  return data.customers || [];
}

async function listDuplicateGoCardlessMappings(limit = 25) {
  const { rows } = await pgPool.query(
    `
      SELECT
        gocardless_customer_id,
        count(*)::int AS mapping_count,
        array_agg(xero_contact_guid::text ORDER BY xero_contact_guid::text) AS xero_contact_guids,
        array_agg(COALESCE(halo_client_name, '') ORDER BY xero_contact_guid::text) AS halo_client_names
      FROM halo.gocardless_customer_map
      GROUP BY gocardless_customer_id
      HAVING count(*) > 1
      ORDER BY mapping_count DESC, gocardless_customer_id
      LIMIT $1
    `,
    [limit]
  );
  return rows;
}

async function listGoCardlessMappingsMissingHaloClients(limit = 25) {
  const { rows } = await pgPool.query(
    `
      SELECT
        m.xero_contact_guid::text AS xero_contact_guid,
        m.gocardless_customer_id,
        m.halo_client_name,
        m.updated_at
      FROM halo.gocardless_customer_map m
      LEFT JOIN halo.halo_client h ON h.xero_contact_guid = m.xero_contact_guid
      WHERE h.xero_contact_guid IS NULL
      ORDER BY m.updated_at DESC
      LIMIT $1
    `,
    [limit]
  );
  return rows;
}

export async function getGoCardlessAdminAnomalies() {
  if (!getGoCardlessAccessToken()) {
    return {
      configured: false,
      problemMandates: [],
      problemPayments: [],
      duplicateCustomerGroups: []
    };
  }

  const [problemMandates, problemPayments, recentCustomers] = await Promise.all([
    listProblemMandates(),
    listProblemPayments(),
    listRecentCustomers()
  ]);

  return {
    configured: true,
    problemMandates,
    problemPayments,
    duplicateCustomerGroups: findDuplicateCustomerGroups(recentCustomers)
  };
}

export async function getUnmappedGoCardlessMandateCustomers(limit = 100, options = {}) {
  if (!getGoCardlessAccessToken()) {
    return {
      configured: false,
      items: [],
      totals: {
        eligibleCustomers: 0,
        unmappedCustomers: 0,
        activeUnmappedCustomers: 0
      }
    };
  }

  const mandates = await listMappableMandates();
  const customers = await getCustomersForMandates(mandates);
  const mappings = await listGoCardlessMappings(2000);
  const mappedCustomerIds = new Set(mappings.map(mapping => mapping.gocardless_customer_id));
  const byCustomer = new Map();

  for (const mandate of mandates) {
    const customerId = mandate.links?.customer;
    if (!customerId || mappedCustomerIds.has(customerId)) continue;
    if (!byCustomer.has(customerId)) byCustomer.set(customerId, []);
    byCustomer.get(customerId).push(mandate);
  }

  const includeCandidates = options.includeCandidates !== false;
  const xeroEmailCache = new Map();
  const items = [];
  for (const [customerId, customerMandates] of byCustomer.entries()) {
    const customer = customers.get(customerId) || { id: customerId };
    const mandateStatusCounts = {};
    customerMandates.forEach(mandate => incrementCount(mandateStatusCounts, mandate.status || "unknown"));
    const candidateInfo = includeCandidates
      ? await getUnmappedCandidateMatches(customer, xeroEmailCache)
      : {
          candidates: [],
          candidateCount: 0,
          suggestedXeroContactGuid: "",
          requiresManualGuid: true
        };

    items.push({
      customerId,
      customerName: customerName(customer),
      email: customer.email || null,
      countryCode: customer.country_code || null,
      mandateStatusCounts,
      mandates: summariseMandates(customerMandates),
      activeCount: mandateStatusCounts.active || 0,
      pendingCount: [...WARNING_MANDATE_STATUSES].reduce((sum, status) => sum + (mandateStatusCounts[status] || 0), 0),
      ...candidateInfo
    });
  }

  items.sort((a, b) => {
    if (b.activeCount !== a.activeCount) return b.activeCount - a.activeCount;
    return String(a.customerName || "").localeCompare(String(b.customerName || ""));
  });

  return {
    configured: true,
    items: items.slice(0, limit),
    totals: {
      eligibleCustomers: new Set(mandates.map(mandate => mandate.links?.customer).filter(Boolean)).size,
      unmappedCustomers: items.length,
      activeUnmappedCustomers: items.filter(item => item.activeCount > 0).length
    }
  };
}

export async function getGoCardlessDirectDebitAlertSummary(options = {}) {
  if (!getGoCardlessAccessToken()) {
    return {
      configured: false,
      unmapped: { totals: { unmappedCustomers: 0, activeUnmappedCustomers: 0 }, items: [] },
      duplicateMappings: [],
      missingHaloClients: [],
      exposedGuidMismatches: [],
      apiLookupFailures: []
    };
  }

  const unmappedLimit = Number.parseInt(options.unmappedLimit || "", 10);
  const mismatchLimit = Number.parseInt(options.mismatchLimit || "", 10);
  const mappedCheckLimit = Number.parseInt(options.mappedCheckLimit || "", 10);
  const safeUnmappedLimit = Number.isFinite(unmappedLimit) && unmappedLimit > 0 ? unmappedLimit : 25;
  const safeMismatchLimit = Number.isFinite(mismatchLimit) && mismatchLimit > 0 ? mismatchLimit : 25;
  const safeMappedCheckLimit = Number.isFinite(mappedCheckLimit) && mappedCheckLimit > 0 ? mappedCheckLimit : 500;

  const includeCandidates = options.includeCandidates === true;
  const [unmapped, duplicateResult, missingHaloResult, mappings] = await Promise.all([
    getUnmappedGoCardlessMandateCustomers(safeUnmappedLimit, { includeCandidates }),
    listDuplicateGoCardlessMappings(safeMismatchLimit),
    listGoCardlessMappingsMissingHaloClients(safeMismatchLimit),
    listGoCardlessMappings(safeMappedCheckLimit)
  ]);

  const exposedGuidMismatches = [];
  const apiLookupFailures = [];

  for (const mapping of mappings) {
    if (exposedGuidMismatches.length >= safeMismatchLimit) break;
    const goCardlessCustomerId = mapping.gocardless_customer_id;
    const mappedGuid = String(mapping.xero_contact_guid || "").toLowerCase();
    if (!goCardlessCustomerId || !mappedGuid) continue;

    try {
      const [customerData, mandateData] = await Promise.all([
        goCardlessGet(`/customers/${encodeURIComponent(goCardlessCustomerId)}`),
        goCardlessGet("/mandates", { customer: goCardlessCustomerId, limit: 20 })
      ]);
      const exposedGuids = extractGuidsFromValue({
        customer: customerData.customers
          ? {
              id: customerData.customers.id,
              companyName: customerData.customers.company_name,
              metadata: customerData.customers.metadata
            }
          : null,
        mandates: (mandateData.mandates || []).map(mandate => ({
          id: mandate.id,
          reference: mandate.reference,
          metadata: mandate.metadata
        }))
      });

      if (exposedGuids.size > 0 && !exposedGuids.has(mappedGuid)) {
        exposedGuidMismatches.push({
          haloClientName: mapping.halo_client_name || null,
          xeroContactGuid: mappedGuid,
          goCardlessCustomerId,
          exposedXeroContactGuids: [...exposedGuids].sort()
        });
      }
    } catch (err) {
      apiLookupFailures.push({
        goCardlessCustomerId,
        error: String(err.response?.status || err.message)
      });
    }
  }

  return {
    configured: true,
    unmapped,
    duplicateMappings: duplicateResult,
    missingHaloClients: missingHaloResult,
    exposedGuidMismatches,
    apiLookupFailures
  };
}

export async function reconcileGoCardlessMandateStatesForMappings(options = {}) {
  if (!getGoCardlessAccessToken()) {
    throw new Error("GoCardless access token is not configured.");
  }

  const limit = Number.parseInt(options.limit || "", 10);
  const mappings = await listGoCardlessMappings(Number.isFinite(limit) && limit > 0 ? limit : 1000);
  const uniqueCustomerIds = [...new Set(mappings.map(mapping => mapping.gocardless_customer_id).filter(Boolean))];
  const summary = {
    customersScanned: 0,
    mandatesSeen: 0,
    storedFromApi: 0,
    failed: 0
  };

  for (const customerId of uniqueCustomerIds) {
    try {
      const data = await goCardlessGet("/mandates", { customer: customerId, limit: 500 });
      summary.customersScanned += 1;

      for (const mandate of data.mandates || []) {
        if (!mandate.id || !mandate.status) continue;
        summary.mandatesSeen += 1;
        await upsertGoCardlessMandateStateFromApi({
          mandateId: mandate.id,
          customerId,
          status: mandate.status,
          eventCreatedAt: mandate.created_at || null,
          rawEvent: mandate
        });
        summary.storedFromApi += 1;
      }
    } catch (err) {
      summary.failed += 1;
      console.warn("GoCardless mandate reconciliation failed:", customerId, err.response?.status || err.message);
    }
  }

  return summary;
}

export async function autoMapGoCardlessCustomersByXeroGuid() {
  if (!getGoCardlessAccessToken()) {
    throw new Error("GoCardless access token is not configured.");
  }

  const mandates = await listMappableMandates();
  const customers = await getCustomersForMandates(mandates);
  const xeroEmailCache = new Map();
  const candidates = new Map();
  const matched = [];
  const skipped = {
    noXeroGuid: 0,
    noNameMatch: 0,
    ambiguousName: 0,
    noEmailMatch: 0,
    ambiguousEmail: 0,
    missingHaloClient: 0,
    customerAlreadyMapped: 0,
    alreadyMapped: 0
  };

  for (const mandate of mandates) {
    const customerId = mandate.links?.customer;
    const customer = customerId ? customers.get(customerId) : null;
    const guids = extractGuidsFromValue({
      mandate: {
        reference: mandate.reference,
        metadata: mandate.metadata
      },
      customer: customer
        ? {
            id: customer.id,
            companyName: customer.company_name,
            metadata: customer.metadata
          }
        : null
    });

    if (!customerId) {
      skipped.noXeroGuid += 1;
      continue;
    }

    if (guids.size > 0) {
      for (const xeroContactGuid of guids) {
        candidates.set(xeroContactGuid, {
          xeroContactGuid,
          goCardlessCustomerId: customerId,
          goCardlessCustomerName: customerName(customer),
          source: mandate.metadata && Object.keys(mandate.metadata).length
            ? "eligible mandate metadata"
            : "eligible mandate/customer fields"
        });
      }
      continue;
    }

    if (!customer) {
      skipped.noXeroGuid += 1;
      continue;
    }

    const haloClientMatch = await getUniqueHaloClientByName(customerName(customer));
    if (haloClientMatch.matchCount === 1) {
      const xeroContactGuid = String(haloClientMatch.client.xero_contact_guid).toLowerCase();
      if (!candidates.has(xeroContactGuid)) {
        candidates.set(xeroContactGuid, {
          xeroContactGuid,
          goCardlessCustomerId: customerId,
          goCardlessCustomerName: customerName(customer),
          haloClient: haloClientMatch.client,
          source: "exact eligible mandate customer name"
        });
      }
      continue;
    }

    if (haloClientMatch.matchCount === 0) {
      skipped.noNameMatch += 1;
    } else {
      skipped.ambiguousName += 1;
    }

    const xeroEmailMatch = await getUniqueXeroContactByEmail(customer.email, xeroEmailCache);
    if (xeroEmailMatch.matchCount === 0) {
      skipped.noEmailMatch += 1;
      continue;
    }
    if (xeroEmailMatch.matchCount > 1) {
      skipped.ambiguousEmail += 1;
      continue;
    }

    const xeroContactGuid = String(xeroEmailMatch.contact.ContactID).toLowerCase();
    if (!candidates.has(xeroContactGuid)) {
      candidates.set(xeroContactGuid, {
        xeroContactGuid,
        goCardlessCustomerId: customerId,
        goCardlessCustomerName: customerName(customer),
        source: "unique Xero contact email match"
      });
    }
  }

  for (const candidate of candidates.values()) {
    const existingCustomerMappings = await getGoCardlessMappingsForCustomerId(
      candidate.goCardlessCustomerId
    );
    if (
      existingCustomerMappings.some(
        mapping => String(mapping.xero_contact_guid).toLowerCase() !== candidate.xeroContactGuid
      )
    ) {
      skipped.customerAlreadyMapped += 1;
      continue;
    }

    const haloClient = candidate.haloClient || await getHaloClientByXeroGuid(candidate.xeroContactGuid);
    if (!haloClient) {
      skipped.missingHaloClient += 1;
      continue;
    }

    const inserted = await insertAutoGoCardlessMapping({
      xeroContactGuid: candidate.xeroContactGuid,
      goCardlessCustomerId: candidate.goCardlessCustomerId,
      haloClientName: haloClient.halo_client_name,
      notes: `Auto-mapped from GoCardless ${candidate.source}`
    });

    if (!inserted) {
      skipped.alreadyMapped += 1;
      continue;
    }

    matched.push({
      haloClientName: haloClient.halo_client_name,
      xeroContactGuid: candidate.xeroContactGuid,
      goCardlessCustomerId: candidate.goCardlessCustomerId,
      goCardlessCustomerName: candidate.goCardlessCustomerName
    });
  }

  return {
    mappableMandatesScanned: mandates.length,
    activeMandatesScanned: mandates.filter(mandate => mandate.status === "active").length,
    pendingMandatesScanned: mandates.filter(mandate => WARNING_MANDATE_STATUSES.has(mandate.status)).length,
    candidatesFound: candidates.size,
    mappingsCreated: matched.length,
    matched,
    skipped
  };
}

export async function autoMapGoCardlessCustomerByHaloName(xeroContactGuid, haloClientName) {
  if (!getGoCardlessAccessToken() || !xeroContactGuid || !haloClientName) {
    return { mapped: false, reason: "missing_input" };
  }

  const existing = await getGoCardlessMappingForXeroGuid(xeroContactGuid);
  if (existing) return { mapped: false, reason: "already_mapped" };

  const matches = await searchGoCardlessCustomersWithMandates(haloClientName, 10);
  const exactMappableMatches = matches.filter(customer =>
    normaliseName(customer.name) === normaliseName(haloClientName) &&
    Number(customer.mandateStatus?.mappableCount || 0) > 0
  );

  if (exactMappableMatches.length === 0) return { mapped: false, reason: "no_exact_eligible_match" };
  if (exactMappableMatches.length > 1) return { mapped: false, reason: "ambiguous_exact_eligible_match" };

  const match = exactMappableMatches[0];
  const existingCustomerMappings = await getGoCardlessMappingsForCustomerId(match.id);
  if (
    existingCustomerMappings.some(
      mapping => String(mapping.xero_contact_guid).toLowerCase() !== String(xeroContactGuid).toLowerCase()
    )
  ) {
    return { mapped: false, reason: "customer_already_mapped" };
  }

  const inserted = await insertAutoGoCardlessMapping({
    xeroContactGuid,
    goCardlessCustomerId: match.id,
    haloClientName,
    notes: "Auto-mapped from exact eligible GoCardless customer name"
  });

  return {
    mapped: inserted,
    reason: inserted ? "mapped" : "already_mapped",
    goCardlessCustomerId: match.id
  };
}

export async function autoMapGoCardlessCustomerByXeroEmail(xeroContactGuid, haloClientName = "") {
  if (!getGoCardlessAccessToken() || !xeroContactGuid) {
    return { mapped: false, reason: "missing_input" };
  }

  const existing = await getGoCardlessMappingForXeroGuid(xeroContactGuid);
  if (existing) return { mapped: false, reason: "already_mapped" };

  let xeroContact = null;
  try {
    xeroContact = await getXeroContactByGuid(xeroContactGuid);
  } catch (err) {
    console.warn("⚠️ Xero contact lookup failed during GoCardless auto-map:", err.response?.status || err.message);
    return { mapped: false, reason: "xero_lookup_failed" };
  }

  const xeroEmail = normaliseEmail(xeroContact?.EmailAddress);
  if (!xeroEmail) return { mapped: false, reason: "xero_contact_has_no_email" };

  const goCardlessMatch = await getUniqueMappableGoCardlessCustomerByEmail(xeroEmail);
  if (goCardlessMatch.matchCount === 0) return { mapped: false, reason: "no_exact_eligible_email_match" };
  if (goCardlessMatch.matchCount > 1) return { mapped: false, reason: "ambiguous_exact_eligible_email_match" };

  const match = goCardlessMatch.customer;
  const existingCustomerMappings = await getGoCardlessMappingsForCustomerId(match.id);
  if (
    existingCustomerMappings.some(
      mapping => String(mapping.xero_contact_guid).toLowerCase() !== String(xeroContactGuid).toLowerCase()
    )
  ) {
    return { mapped: false, reason: "customer_already_mapped" };
  }

  const inserted = await insertAutoGoCardlessMapping({
    xeroContactGuid,
    goCardlessCustomerId: match.id,
    haloClientName: haloClientName || xeroContact.Name || "",
    notes: "Auto-mapped from unique Xero/GoCardless email match with eligible mandate"
  });

  return {
    mapped: inserted,
    reason: inserted ? "mapped" : "already_mapped",
    goCardlessCustomerId: match.id,
    xeroEmail
  };
}

export async function getGoCardlessSummaryForXeroGuid(xeroContactGuid, haloClientName = "") {
  if (!getGoCardlessAccessToken()) {
    return { configured: false, mapped: false, state: "not_configured" };
  }

  let mapping = await getGoCardlessMappingForXeroGuid(xeroContactGuid);
  if (!mapping && haloClientName) {
    await autoMapGoCardlessCustomerByHaloName(xeroContactGuid, haloClientName);
    mapping = await getGoCardlessMappingForXeroGuid(xeroContactGuid);
  }
  if (!mapping) {
    await autoMapGoCardlessCustomerByXeroEmail(xeroContactGuid, haloClientName);
    mapping = await getGoCardlessMappingForXeroGuid(xeroContactGuid);
  }

  if (!mapping) {
    return { configured: true, mapped: false, state: "not_mapped" };
  }

  try {
    const customerId = mapping.gocardless_customer_id;
    const storedStates = await listGoCardlessMandateStatesForCustomer(customerId);
    let customerData = { customers: null };
    let mandateData = { mandates: [] };

    try {
      [customerData, mandateData] = await Promise.all([
        goCardlessGet(`/customers/${customerId}`),
        goCardlessGet("/mandates", { customer: customerId, limit: 20 })
      ]);
    } catch (err) {
      if (!storedStates.length) throw err;
      console.warn(
        "⚠️ GoCardless API fallback lookup failed; using stored mandate state:",
        customerId,
        err.response?.status || err.message
      );
    }

    const apiMandates = summariseMandates(mandateData.mandates || []);
    const mandates = mergeStoredAndApiMandates(apiMandates, storedStates);
    const primaryMandate = choosePrimaryMandate(mandates);
    const activeMandate = mandates.find(mandate => isGoCardlessActiveMandateStatus(mandate.status)) || null;
    const customerHasActiveMandates = Boolean(customerData.customers?.active_mandates);

    return {
      configured: true,
      mapped: true,
      state: "ok",
      mapping,
      customer: {
        id: customerData.customers?.id || customerId,
        name: customerName(customerData.customers) || mapping.halo_client_name || customerId,
        email: customerData.customers?.email || null,
        activeMandates: customerHasActiveMandates,
        dashboardUrl: goCardlessCustomerUrl(customerData.customers?.id || customerId)
      },
      hasActiveMandate: Boolean(activeMandate) || customerHasActiveMandates,
      activeMandateSource: activeMandate ? "mandate_status" : customerHasActiveMandates ? "customer_active_mandates" : null,
      activeMandateUrl: activeMandate?.dashboardUrl || (customerHasActiveMandates ? primaryMandate?.dashboardUrl : null) || null,
      customerUrl: goCardlessCustomerUrl(customerData.customers?.id || customerId),
      primaryMandate,
      mandates
    };
  } catch (err) {
    console.warn(
      "⚠️ GoCardless summary lookup failed:",
      mapping.gocardless_customer_id,
      err.response?.status || err.message
    );

    return {
      configured: true,
      mapped: true,
      state: "error",
      mapping,
      error: err.response?.status || err.message
    };
  }
}
