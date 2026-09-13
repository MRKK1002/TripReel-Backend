const { isDateKeyPastInclusiveEnd, storedDateKey } = require("./businessDate");

const HISTORY = "history";
const CURRENT = "current";

function normalizeView(query = {}) {
  const raw = String(query.view || query.scope || CURRENT).toLowerCase();
  return [CURRENT, HISTORY, "all"].includes(raw) ? raw : CURRENT;
}

function packageLifecycle(pkg) {
  const status = String(pkg?.status || "DRAFT").toUpperCase();
  if (status === "ARCHIVED") return "Archived";
  if (status === "REJECTED") return "Rejected";
  if (status === "EXPIRED") return "Expired";
  if (status === "PENDING") return "Under Review";
  if (status === "NEEDS_REVISION") return "Needs Changes";
  if (status === "DRAFT") return "Draft";
  if (status === "APPROVED" && pkg?.isActive === false) return "Paused";
  return "Live";
}

function batchLifecycle(batch, now = new Date()) {
  if (batch?.isArchived) return "Archived";
  if (batch?.isCancelled) return "Cancelled";
  if (isDateKeyPastInclusiveEnd(batch?.endDate, now)) return "Completed";
  if (batch?.isActive === false) return "Paused";
  if (
    Number(batch?.totalSeats) > 0 &&
    Number(batch?.bookedSeats) >= Number(batch?.totalSeats)
  )
    return "Full";
  if (
    batch?.bookingDeadline &&
    isDateKeyPastInclusiveEnd(batch.bookingDeadline, now)
  )
    return "Booking Closed";
  const startKey = storedDateKey(batch?.startDate);
  if (
    startKey &&
    !isDateKeyPastInclusiveEnd(startKey, now) &&
    now < require("./businessDate").dateKeyToISTStart(startKey)
  )
    return "Upcoming";
  return "Running";
}

function flexLifecycle(item, now = new Date()) {
  if (item?.isArchived) return "Archived";
  if (isDateKeyPastInclusiveEnd(item?.endDate, now)) return "Expired";
  if (item?.isClosed) return "Closed";
  if (item?.isActive === false) return "Paused";
  const startKey = storedDateKey(item?.startDate);
  if (startKey && now < require("./businessDate").dateKeyToISTStart(startKey))
    return "Upcoming";
  if (item?.allDatesFull === true) return "Full";
  return "Available";
}

function couponLifecycle(coupon, now = new Date()) {
  if (coupon?.isArchived) return "Archived";
  if (
    Number(coupon?.usageLimit) > 0 &&
    Number(coupon?.usedCount) >= Number(coupon?.usageLimit)
  )
    return "Exhausted";
  if (isDateKeyPastInclusiveEnd(coupon?.validUntil, now)) return "Expired";
  if (coupon?.isActive === false) return "Paused";
  const from = coupon?.validFrom ? new Date(coupon.validFrom) : null;
  if (from && from > now) return "Scheduled";
  return "Active";
}

const HISTORY_LABELS = {
  package: new Set(["Archived", "Rejected", "Expired"]),
  batch: new Set(["Completed", "Cancelled", "Archived"]),
  flex: new Set(["Expired", "Closed", "Archived"]),
  coupon: new Set(["Exhausted", "Expired", "Archived"]),
};

function isHistory(kind, lifecycle) {
  return HISTORY_LABELS[kind]?.has(lifecycle) === true;
}

function applyLifecycleView(items, kind, derive, view, now = new Date()) {
  const serialized = items.map((item) => {
    const raw = item?.toObject ? item.toObject() : { ...item };
    const lifecycle = derive(raw, now);
    return { ...raw, lifecycle };
  });
  const currentTotal = serialized.filter(
    (item) => !isHistory(kind, item.lifecycle),
  ).length;
  const historyTotal = serialized.length - currentTotal;
  const filtered =
    view === "all"
      ? serialized
      : serialized.filter((item) =>
          view === HISTORY
            ? isHistory(kind, item.lifecycle)
            : !isHistory(kind, item.lifecycle),
        );
  return { items: filtered, currentTotal, historyTotal };
}

module.exports = {
  normalizeView,
  packageLifecycle,
  batchLifecycle,
  flexLifecycle,
  couponLifecycle,
  isHistory,
  applyLifecycleView,
};
