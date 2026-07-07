import { getGoCardlessSummaryForXeroGuid } from "./gocardless.js";
import { listGoCardlessMappings } from "./gocardless-map.js";
import { haloGet, haloPost } from "./halo.js";

export const HALO_DIRECT_DEBIT_FIELD = {
  id: 278,
  name: "CFDirectDebitActive",
  label: "Active Direct Debit Mandate",
  table: "Area",
  values: {
    active: "Active",
    notActive: "Not active",
    cancelled: "Cancelled"
  }
};

function normaliseGuid(value) {
  return String(value || "").trim().toLowerCase();
}

function normaliseName(value) {
  return String(value || "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function chooseDirectDebitValue(goCardlessSummary) {
  if (!goCardlessSummary?.mapped) {
    return HALO_DIRECT_DEBIT_FIELD.values.notActive;
  }

  if (goCardlessSummary.hasActiveMandate) {
    return HALO_DIRECT_DEBIT_FIELD.values.active;
  }

  const mandates = goCardlessSummary.mandates || [];
  const latestMandate = mandates
    .filter(mandate => mandate.status)
    .sort((a, b) => String(b.nextPossibleChargeDate || "").localeCompare(String(a.nextPossibleChargeDate || "")))[0];

  if (
    latestMandate?.status === "cancelled" ||
    mandates.some(mandate => mandate.status === "cancelled")
  ) {
    return HALO_DIRECT_DEBIT_FIELD.values.cancelled;
  }

  return HALO_DIRECT_DEBIT_FIELD.values.notActive;
}

export async function findHaloClientByXeroGuid(xeroContactGuid, fallbackName) {
  const guid = normaliseGuid(xeroContactGuid);
  const searches = [...new Set([fallbackName, guid].map(value => String(value || "").trim()).filter(Boolean))];

  for (const search of searches) {
    const data = await haloGet("/Client", {
      search,
      include_custom_fields: String(HALO_DIRECT_DEBIT_FIELD.id)
    });
    const clients = data.clients || [];
    const exactXeroMatch = clients.find(client => normaliseGuid(client.xeroid) === guid);
    if (exactXeroMatch) return exactXeroMatch;

    const exactNameMatches = clients.filter(
      client => normaliseName(client.name) === normaliseName(fallbackName)
    );
    if (exactNameMatches.length === 1) return exactNameMatches[0];
  }

  return null;
}

function upsertDirectDebitCustomField(customfields, value) {
  const nextCustomFields = Array.isArray(customfields) ? [...customfields] : [];
  const existingIndex = nextCustomFields.findIndex(
    field =>
      Number(field.id) === HALO_DIRECT_DEBIT_FIELD.id ||
      String(field.name || "").toLowerCase() === HALO_DIRECT_DEBIT_FIELD.name.toLowerCase()
  );
  const nextField = {
    id: HALO_DIRECT_DEBIT_FIELD.id,
    name: HALO_DIRECT_DEBIT_FIELD.name,
    value
  };

  if (existingIndex >= 0) {
    nextCustomFields[existingIndex] = {
      ...nextCustomFields[existingIndex],
      ...nextField
    };
  } else {
    nextCustomFields.push(nextField);
  }

  return nextCustomFields;
}

export async function updateHaloDirectDebitFieldForMapping(mapping, options = {}) {
  const xeroContactGuid = normaliseGuid(mapping.xero_contact_guid);
  const haloClient = await findHaloClientByXeroGuid(xeroContactGuid, mapping.halo_client_name);

  if (!haloClient?.id) {
    return {
      updated: false,
      skipped: true,
      reason: "halo_client_not_found",
      xeroContactGuid,
      haloClientName: mapping.halo_client_name || null
    };
  }

  const goCardlessSummary = await getGoCardlessSummaryForXeroGuid(
    xeroContactGuid,
    mapping.halo_client_name || haloClient.name || ""
  );

  if (goCardlessSummary.state === "error") {
    return {
      updated: false,
      skipped: true,
      reason: "gocardless_lookup_failed",
      xeroContactGuid,
      haloClientId: haloClient.id,
      haloClientName: haloClient.name
    };
  }

  const value = chooseDirectDebitValue(goCardlessSummary);
  const existingCustomFields = haloClient.customfields || [];
  const existingField = existingCustomFields.find(
    field =>
      Number(field.id) === HALO_DIRECT_DEBIT_FIELD.id ||
      String(field.name || "").toLowerCase() === HALO_DIRECT_DEBIT_FIELD.name.toLowerCase()
  );
  const existingValue = existingField?.display || existingField?.value || null;

  if (String(existingValue || "") === value) {
    return {
      updated: false,
      skipped: false,
      reason: "already_current",
      xeroContactGuid,
      haloClientId: haloClient.id,
      haloClientName: haloClient.name,
      value
    };
  }

  if (options.dryRun) {
    return {
      updated: false,
      skipped: false,
      dryRun: true,
      reason: "would_update",
      xeroContactGuid,
      haloClientId: haloClient.id,
      haloClientName: haloClient.name,
      previousValue: existingValue,
      value
    };
  }

  await haloPost("/Client", [
    {
      id: haloClient.id,
      name: haloClient.name,
      customfields: upsertDirectDebitCustomField(existingCustomFields, value)
    }
  ]);

  return {
    updated: true,
    skipped: false,
    reason: "updated",
    xeroContactGuid,
    haloClientId: haloClient.id,
    haloClientName: haloClient.name,
    previousValue: existingValue,
    value
  };
}

export async function syncHaloDirectDebitFields(options = {}) {
  const limit = Number.parseInt(options.limit || "", 10);
  const mappings = await listGoCardlessMappings(Number.isFinite(limit) && limit > 0 ? limit : 1000);
  const results = [];
  const summary = {
    totalMappings: mappings.length,
    updated: 0,
    wouldUpdate: 0,
    alreadyCurrent: 0,
    skipped: 0,
    failed: 0,
    dryRun: Boolean(options.dryRun),
    field: HALO_DIRECT_DEBIT_FIELD
  };

  for (const mapping of mappings) {
    try {
      const result = await updateHaloDirectDebitFieldForMapping(mapping, options);
      results.push(result);

      if (result.updated) summary.updated += 1;
      else if (result.reason === "would_update") summary.wouldUpdate += 1;
      else if (result.reason === "already_current") summary.alreadyCurrent += 1;
      else if (result.skipped) summary.skipped += 1;
    } catch (err) {
      summary.failed += 1;
      results.push({
        updated: false,
        skipped: false,
        reason: "failed",
        xeroContactGuid: normaliseGuid(mapping.xero_contact_guid),
        haloClientName: mapping.halo_client_name || null,
        error: err.response?.status || err.message
      });
    }
  }

  return {
    ...summary,
    results
  };
}
