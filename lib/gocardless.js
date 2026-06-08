import axios from "axios";

import { getGoCardlessAccessToken } from "./config.js";
import { getGoCardlessMappingForXeroGuid } from "./gocardless-map.js";

const GOCARDLESS_VERSION = "2015-07-06";
const LIVE_API_BASE_URL = "https://api.gocardless.com";
const SANDBOX_API_BASE_URL = "https://api-sandbox.gocardless.com";
const ACTIVE_MANDATE_STATUSES = new Set(["active"]);
const WARNING_MANDATE_STATUSES = new Set([
  "pending_customer_approval",
  "pending_submission",
  "submitted"
]);
const PROBLEM_MANDATE_STATUSES = new Set(["cancelled", "failed", "expired"]);

function getApiBaseUrl() {
  return process.env.GOCARDLESS_ENVIRONMENT === "sandbox"
    ? SANDBOX_API_BASE_URL
    : LIVE_API_BASE_URL;
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

function customerName(customer) {
  return (
    customer?.company_name ||
    [customer?.given_name, customer?.family_name].filter(Boolean).join(" ") ||
    customer?.email ||
    customer?.id ||
    ""
  );
}

function formatDate(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function formatMinorAmount(amount, currency) {
  const numeric = Number(amount || 0) / 100;
  return new Intl.NumberFormat("en-NZ", {
    style: "currency",
    currency: currency || "NZD"
  }).format(numeric);
}

function statusLabel(status) {
  return String(status || "unknown").replace(/_/g, " ");
}

function statusTone(status) {
  if (ACTIVE_MANDATE_STATUSES.has(status)) return "ok";
  if (WARNING_MANDATE_STATUSES.has(status)) return "warn";
  if (PROBLEM_MANDATE_STATUSES.has(status)) return "error";
  return "neutral";
}

function paymentTone(status) {
  if (["confirmed", "paid_out"].includes(status)) return "ok";
  if (["pending_customer_approval", "pending_submission", "submitted"].includes(status)) return "warn";
  if (["failed", "cancelled", "customer_approval_denied", "charged_back"].includes(status)) return "error";
  return "neutral";
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
    bankAccountId: mandate.links?.customer_bank_account || null
  }));
}

function summariseBankAccounts(bankAccounts) {
  return bankAccounts.map(account => ({
    id: account.id,
    accountHolderName: account.account_holder_name,
    accountNumberEnding: account.account_number_ending,
    bankName: account.bank_name,
    countryCode: account.country_code,
    currency: account.currency,
    enabled: Boolean(account.enabled)
  }));
}

function summarisePayments(payments) {
  return payments.map(payment => ({
    id: payment.id,
    description: payment.description || payment.reference || payment.id,
    chargeDate: formatDate(payment.charge_date),
    amount: formatMinorAmount(payment.amount, payment.currency),
    status: payment.status,
    statusLabel: statusLabel(payment.status),
    statusTone: paymentTone(payment.status)
  }));
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
          metadata: customer.metadata || {}
        });
      }

      if (matches.length >= limit) break;
    }

    after = data.meta?.cursors?.after;
    if (!after || customers.length === 0) break;
  }

  return matches;
}

export async function getGoCardlessSummaryForXeroGuid(xeroContactGuid) {
  if (!getGoCardlessAccessToken()) {
    return { configured: false, mapped: false, state: "not_configured" };
  }

  const mapping = await getGoCardlessMappingForXeroGuid(xeroContactGuid);
  if (!mapping) {
    return { configured: true, mapped: false, state: "not_mapped" };
  }

  try {
    const customerId = mapping.gocardless_customer_id;
    const [customerData, mandateData, bankAccountData, paymentData] = await Promise.all([
      goCardlessGet(`/customers/${customerId}`),
      goCardlessGet("/mandates", { customer: customerId, limit: 20 }),
      goCardlessGet("/customer_bank_accounts", { customer: customerId, limit: 10 }),
      goCardlessGet("/payments", {
        customer: customerId,
        limit: 5,
        sort_field: "charge_date",
        sort_direction: "desc"
      })
    ]);

    const mandates = summariseMandates(mandateData.mandates || []);
    const bankAccounts = summariseBankAccounts(bankAccountData.customer_bank_accounts || []);
    const payments = summarisePayments(paymentData.payments || []);
    const primaryMandate =
      mandates.find(mandate => mandate.status === "active") ||
      mandates.find(mandate => mandate.statusTone === "warn") ||
      mandates[0] ||
      null;
    const primaryBankAccount =
      bankAccounts.find(account => account.id === primaryMandate?.bankAccountId) ||
      bankAccounts.find(account => account.enabled) ||
      bankAccounts[0] ||
      null;

    return {
      configured: true,
      mapped: true,
      state: "ok",
      mapping,
      customer: {
        id: customerData.customers?.id || customerId,
        name: customerName(customerData.customers),
        email: customerData.customers?.email || null
      },
      primaryMandate,
      primaryBankAccount,
      mandates,
      payments
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
