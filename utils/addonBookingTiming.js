const TIME_ZONE = "Asia/Kolkata";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const SAME_DAY_CUTOFF_MINUTES = 45;

function dateKeyInTimeZone(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function addCalendarDays(dateKey, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey || "");
  if (!match) return null;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function parsePickupTime(value) {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i.exec(
    String(value || "").trim(),
  );
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toUpperCase();
  if (minute < 0 || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "AM") hour = hour === 12 ? 0 : hour;
    if (meridiem === "PM") hour = hour === 12 ? 12 : hour + 12;
  } else if (hour < 0 || hour > 23) {
    return null;
  }
  return {
    hour,
    minute,
    normalized: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function istLocalToUtcMs(dateKey, time) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey || "");
  if (!match || !time) return NaN;
  return (
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      time.hour,
      time.minute,
    ) - IST_OFFSET_MS
  );
}

function getTripStartDate(booking) {
  return (
    booking?.batchId?.startDate ||
    booking?.flexStartDate ||
    booking?.snapshot?.startDate ||
    booking?.tripStartDate ||
    null
  );
}

function getItineraryDateKey(booking, dayIdx) {
  const startKey = dateKeyInTimeZone(getTripStartDate(booking));
  return startKey ? addCalendarDays(startKey, dayIdx) : null;
}

function createValidationError(message, code) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
}

/**
 * Validates every requested itinerary day against the real IST calendar date.
 * Same-day entries get a fixed, server-built operator schedule and instant mode;
 * future entries remain scheduled. Past entries are never purchasable.
 */
function buildAddonBookingPlan({ booking, pkg, addonDays, now = new Date() }) {
  const todayKey = dateKeyInTimeZone(now);
  const nowMs = now.getTime();
  const schedule = {};
  const bookingTypes = {};
  const instantEntries = [];

  if (!todayKey || !getTripStartDate(booking)) {
    throw createValidationError(
      "Trip start date is unavailable.",
      "TRIP_DATE_UNAVAILABLE",
    );
  }

  for (const [addonName, days] of Object.entries(addonDays || {})) {
    for (const dayIdx of days || []) {
      const dateKey = getItineraryDateKey(booking, dayIdx);
      const dayInfo = pkg?.itinerary?.[dayIdx];
      if (!dateKey || !dayInfo) {
        throw createValidationError(
          `Day ${Number(dayIdx) + 1} is invalid.`,
          "INVALID_ITINERARY_DAY",
        );
      }
      if (dateKey < todayKey) {
        throw createValidationError(
          `Day ${Number(dayIdx) + 1} has already passed.`,
          "ADDON_DAY_PASSED",
        );
      }

      const key = `${addonName}_${dayIdx}`;
      if (dateKey > todayKey) {
        bookingTypes[key] = "scheduled";
        continue;
      }

      const pickupTime = parsePickupTime(dayInfo.pickupTime);
      const pickupPoint = String(dayInfo.pickupPoint || "").trim();
      const lat = Number(dayInfo.pickupLat);
      const lng = Number(dayInfo.pickupLng);
      if (
        !pickupTime ||
        !pickupPoint ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        lat === 0 ||
        lng === 0
      ) {
        throw createValidationError(
          `Day ${Number(dayIdx) + 1} cannot be booked today because the operator pickup time or location is incomplete.`,
          "INCOMPLETE_OPERATOR_SCHEDULE",
        );
      }

      const pickupAtMs = istLocalToUtcMs(dateKey, pickupTime);
      const cutoffAtMs = pickupAtMs - SAME_DAY_CUTOFF_MINUTES * 60 * 1000;
      // The exact boundary is allowed by product contract: for a 10:00 pickup,
      // checkout remains available through 09:15:00 and closes immediately after.
      if (nowMs > cutoffAtMs) {
        throw createValidationError(
          `Same-day add-ons close ${SAME_DAY_CUTOFF_MINUTES} minutes before the operator pickup time (${pickupTime.normalized}).`,
          "SAME_DAY_CUTOFF_PASSED",
        );
      }

      schedule[addonName] = schedule[addonName] || {};
      schedule[addonName][dayIdx] = {
        time: pickupTime.normalized,
        placeName: pickupPoint,
        lat,
        lng,
        fixedByOperator: true,
      };
      bookingTypes[key] = "instant";
      instantEntries.push({
        addonName,
        dayIdx,
        date: dateKey,
        cutoffAt: new Date(cutoffAtMs).toISOString(),
        schedule: schedule[addonName][dayIdx],
      });
    }
  }

  return { schedule, bookingTypes, instantEntries };
}

module.exports = {
  TIME_ZONE,
  SAME_DAY_CUTOFF_MINUTES,
  dateKeyInTimeZone,
  getItineraryDateKey,
  buildAddonBookingPlan,
};
