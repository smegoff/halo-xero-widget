export const ACTIVE_MANDATE_STATUSES = new Set(["active"]);
export const WARNING_MANDATE_STATUSES = new Set([
  "pending_customer_approval",
  "pending_submission",
  "submitted"
]);
export const MAPPABLE_MANDATE_STATUSES = new Set([
  ...ACTIVE_MANDATE_STATUSES,
  ...WARNING_MANDATE_STATUSES
]);
export const PROBLEM_MANDATE_STATUSES = new Set(["cancelled", "failed", "expired"]);

export function isGoCardlessActiveMandateStatus(status) {
  return ACTIVE_MANDATE_STATUSES.has(String(status || ""));
}

export function isMappableMandateStatus(status) {
  return MAPPABLE_MANDATE_STATUSES.has(String(status || ""));
}

export function statusLabel(status) {
  return String(status || "unknown").replace(/_/g, " ");
}

export function statusTone(status) {
  if (ACTIVE_MANDATE_STATUSES.has(status)) return "ok";
  if (WARNING_MANDATE_STATUSES.has(status)) return "warn";
  if (PROBLEM_MANDATE_STATUSES.has(status)) return "error";
  return "neutral";
}
