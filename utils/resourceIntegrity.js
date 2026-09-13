const IN_FLIGHT_STATES = [
  "PENDING",
  "PROCESSING",
  "RETRYABLE",
  "REFUND_REQUIRED",
  "REFUND_PROCESSING",
  "RECONCILIATION_REQUIRED",
];

function pendingReferenceQuery(field, id) {
  return {
    status: "pending",
    $or: [
      { finalizationState: { $in: IN_FLIGHT_STATES } },
      { finalizationState: { $exists: false } },
    ],
    [`payload.${field}`]: { $in: [id, String(id)] },
  };
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

module.exports = { IN_FLIGHT_STATES, pendingReferenceQuery, parseBoolean };
