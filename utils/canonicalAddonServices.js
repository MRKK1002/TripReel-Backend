const {
  SAME_DAY_CUTOFF_MINUTES,
  dateKeyInTimeZone,
  getItineraryDateKey,
} = require("./addonBookingTiming");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MAX_CUSTOMER_DISTANCE_KM = 25;
const SERVICE_TYPES = Object.freeze({
  photographer: "photographer",
  reelmaker: "reelmaker",
});

function validationError(message, code = "INVALID_ADDON_SELECTION") {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
}

function canonicalServiceType(displayName) {
  const value = String(displayName || "")
    .trim()
    .toLowerCase();
  const photographer = value.includes("photographer");
  const reelmaker = value.includes("reel") || value.includes("video");
  if (!value || photographer === reelmaker) {
    throw validationError(
      `Unsupported add-on service "${String(displayName || "").trim()}".`,
      "UNKNOWN_ADDON_SERVICE",
    );
  }
  return photographer ? SERVICE_TYPES.photographer : SERVICE_TYPES.reelmaker;
}

function parseStrictTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute, normalized: `${match[1]}:${match[2]}` };
}

function validCoordinates(latValue, lngValue) {
  const lat = Number(latValue);
  const lng = Number(lngValue);
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat !== 0 &&
    lng !== 0 &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const radians = (degrees) => (Number(degrees) * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = radians(Number(lat2) - Number(lat1));
  const dLng = radians(Number(lng2) - Number(lng1));
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLng / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function istLocalToUtcMs(dateKey, parsedTime) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  if (!match || !parsedTime) return NaN;
  return (
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      parsedTime.hour,
      parsedTime.minute,
    ) - IST_OFFSET_MS
  );
}

function requestedScheduleFor(
  addonSchedule,
  displayName,
  serviceType,
  dayIndex,
) {
  if (!addonSchedule || typeof addonSchedule !== "object") return undefined;
  const byDisplay = addonSchedule[displayName];
  const byCanonical = addonSchedule[serviceType];
  return byDisplay?.[dayIndex] ?? byCanonical?.[dayIndex];
}

function resolveSchedule({ dayInfo, requested, dayNumber }) {
  const operatorPlace = String(dayInfo?.pickupPoint || "").trim();
  const operatorTime = parseStrictTime(dayInfo?.pickupTime);
  const operatorLat = Number(dayInfo?.pickupLat);
  const operatorLng = Number(dayInfo?.pickupLng);
  if (
    !operatorPlace ||
    !operatorTime ||
    !validCoordinates(operatorLat, operatorLng)
  ) {
    throw validationError(
      `Day ${dayNumber}: operator pickup point, HH:mm time, and valid coordinates are required.`,
      "INVALID_OPERATOR_PICKUP",
    );
  }

  const operatorLocation = {
    placeName: operatorPlace,
    time: operatorTime.normalized,
    lat: operatorLat,
    lng: operatorLng,
    source: "operator",
    placeSource: "operator",
    timeSource: "operator",
    fixedByOperator: true,
  };
  if (dayInfo?.isOutsideCity || requested == null) return operatorLocation;
  if (typeof requested !== "object" || Array.isArray(requested)) {
    throw validationError(
      `Day ${dayNumber}: the customer pickup override is invalid.`,
      "PARTIAL_CUSTOMER_PICKUP",
    );
  }

  const requestedPlace = String(requested.placeName || "").trim();
  const hasLatitude = requested.lat !== "" && requested.lat != null;
  const hasLongitude = requested.lng !== "" && requested.lng != null;
  const customPlaceRequested =
    Boolean(requestedPlace) || hasLatitude || hasLongitude;
  const requestedTimeText = String(requested.time || "").trim();
  const customTimeRequested = Boolean(requestedTimeText);

  if (!customPlaceRequested && !customTimeRequested) return operatorLocation;

  const resolvedTime = customTimeRequested
    ? parseStrictTime(requestedTimeText)
    : operatorTime;
  if (!resolvedTime) {
    throw validationError(
      `Day ${dayNumber}: customer pickup time must use HH:mm (24-hour) format.`,
      "PARTIAL_CUSTOMER_PICKUP",
    );
  }

  let placeName = operatorPlace;
  let lat = operatorLat;
  let lng = operatorLng;
  let distanceKm = 0;
  if (customPlaceRequested) {
    if (
      !requestedPlace ||
      !hasLatitude ||
      !hasLongitude ||
      !validCoordinates(requested.lat, requested.lng)
    ) {
      throw validationError(
        `Day ${dayNumber}: a custom meeting point requires a verified place, latitude, and longitude.`,
        "PARTIAL_CUSTOMER_PICKUP",
      );
    }
    placeName = requestedPlace;
    lat = Number(requested.lat);
    lng = Number(requested.lng);
    distanceKm = haversineKm(operatorLat, operatorLng, lat, lng);
    if (distanceKm > MAX_CUSTOMER_DISTANCE_KM) {
      throw validationError(
        `Day ${dayNumber}: customer pickup must be within ${MAX_CUSTOMER_DISTANCE_KM} km of the operator pickup point.`,
        "CUSTOMER_PICKUP_TOO_FAR",
      );
    }
  }

  return {
    placeName,
    time: resolvedTime.normalized,
    lat,
    lng,
    source: "customer",
    placeSource: customPlaceRequested ? "customer" : "operator",
    timeSource: customTimeRequested ? "customer" : "operator",
    fixedByOperator: false,
    distanceFromOperatorKm: Math.round(distanceKm * 100) / 100,
  };
}

function timingForEntry({ booking, dayIndex, schedule, now }) {
  const date = getItineraryDateKey(booking, dayIndex);
  const today = dateKeyInTimeZone(now);
  if (!date || !today) {
    throw validationError(
      "Trip start date is unavailable.",
      "TRIP_DATE_UNAVAILABLE",
    );
  }
  if (date < today) {
    throw validationError(
      `Day ${dayIndex + 1} has already passed.`,
      "ADDON_DAY_PASSED",
    );
  }
  const bookingType = date === today ? "instant" : "scheduled";
  if (bookingType === "instant") {
    const pickupAt = istLocalToUtcMs(date, parseStrictTime(schedule.time));
    const cutoffAt = pickupAt - SAME_DAY_CUTOFF_MINUTES * 60 * 1000;
    if (now.getTime() > cutoffAt) {
      throw validationError(
        `Same-day add-ons close ${SAME_DAY_CUTOFF_MINUTES} minutes before pickup (${schedule.time}).`,
        "SAME_DAY_CUTOFF_PASSED",
      );
    }
    return { date, bookingType, cutoffAt: new Date(cutoffAt).toISOString() };
  }
  return { date, bookingType, cutoffAt: null };
}

function allocateGst(entries, gstPercent) {
  const totalBeforeGst = entries.reduce(
    (sum, entry) => sum + entry.basePrice + entry.surcharge + entry.extras,
    0,
  );
  const target = Math.round((totalBeforeGst * Number(gstPercent || 0)) / 100);
  let allocated = 0;
  return entries.map((entry, index) => {
    const beforeGst = entry.basePrice + entry.surcharge + entry.extras;
    const gstAllocation =
      index === entries.length - 1
        ? target - allocated
        : Math.floor((beforeGst * Number(gstPercent || 0)) / 100);
    allocated += gstAllocation;
    return Object.freeze({
      ...entry,
      gstPercent: Number(gstPercent || 0),
      gstAllocation,
      totalBeforeGst: beforeGst,
      total: beforeGst + gstAllocation,
    });
  });
}

function buildCanonicalAddonEntries({
  booking,
  pkg,
  addonDays,
  addonSchedule,
  photographerPrice,
  reelmakerPrice,
  gstPercent,
  paymentSource,
  existingEntryKeys = [],
  now = new Date(),
}) {
  if (addonDays == null)
    return { entries: [], addonDays: {}, schedule: {}, bookingTypes: {} };
  if (
    typeof addonDays !== "object" ||
    Array.isArray(addonDays) ||
    !Array.isArray(pkg?.itinerary) ||
    pkg.itinerary.length === 0
  ) {
    throw validationError(
      "A valid itinerary and add-on selection are required.",
      "MISSING_ITINERARY",
    );
  }
  if (
    !Number.isFinite(Number(photographerPrice)) ||
    Number(photographerPrice) <= 0 ||
    !Number.isFinite(Number(reelmakerPrice)) ||
    Number(reelmakerPrice) <= 0 ||
    !Number.isFinite(Number(gstPercent)) ||
    Number(gstPercent) < 0
  ) {
    throw validationError(
      "Creator pricing settings are invalid.",
      "INVALID_ADDON_PRICING",
    );
  }

  const seen = new Set(existingEntryKeys.map(String));
  const rawEntries = [];
  for (const [rawName, rawDays] of Object.entries(addonDays)) {
    const displayName = String(rawName || "").trim();
    const serviceType = canonicalServiceType(displayName);
    if (!Array.isArray(rawDays) || rawDays.length === 0) {
      throw validationError(
        `Add-on "${displayName}" must contain selected itinerary days.`,
      );
    }
    const localDays = new Set();
    for (const rawDayIndex of rawDays) {
      if (!Number.isInteger(rawDayIndex)) {
        throw validationError(
          `Add-on "${displayName}" contains a non-integer day index.`,
        );
      }
      const dayIndex = rawDayIndex;
      if (dayIndex < 0 || dayIndex >= pkg.itinerary.length) {
        throw validationError(
          `Day ${dayIndex + 1} is outside the itinerary.`,
          "INVALID_ITINERARY_DAY",
        );
      }
      if (localDays.has(dayIndex)) {
        throw validationError(
          `Add-on "${displayName}" contains duplicate day ${dayIndex + 1}.`,
          "DUPLICATE_ADDON_DAY",
        );
      }
      localDays.add(dayIndex);
      const key = `${serviceType}:${dayIndex}`;
      if (seen.has(key)) {
        throw validationError(
          `${serviceType === "photographer" ? "Photographer" : "Reel-maker"} is already selected for day ${dayIndex + 1}.`,
          "DUPLICATE_CANONICAL_ADDON",
        );
      }
      seen.add(key);

      const dayInfo = pkg.itinerary[dayIndex];
      if (!dayInfo) {
        throw validationError(
          `Day ${dayIndex + 1} is missing from the itinerary.`,
          "INVALID_ITINERARY_DAY",
        );
      }
      const requested = requestedScheduleFor(
        addonSchedule,
        displayName,
        serviceType,
        dayIndex,
      );
      const schedule = resolveSchedule({
        dayInfo,
        requested,
        dayNumber: dayIndex + 1,
      });
      const timing = timingForEntry({ booking, dayIndex, schedule, now });
      const extras = dayInfo.isOutsideCity
        ? (dayInfo.extraCharges || []).reduce(
            (sum, item) => sum + (Number(item?.amount) || 0),
            0,
          )
        : 0;
      const surcharge = dayInfo.isOutsideCity
        ? Number(dayInfo.outsideCityCharge) ||
          Number(pkg.outsideCityCharge) ||
          0
        : 0;
      rawEntries.push({
        key,
        displayName,
        serviceType,
        dayIndex,
        date: timing.date,
        time: schedule.time,
        location: {
          placeName: schedule.placeName,
          lat: schedule.lat,
          lng: schedule.lng,
        },
        scheduleSource: schedule.source,
        fixedByOperator: schedule.fixedByOperator,
        bookingType: timing.bookingType,
        cutoffAt: timing.cutoffAt,
        basePrice:
          serviceType === SERVICE_TYPES.photographer
            ? Number(photographerPrice)
            : Number(reelmakerPrice),
        surcharge,
        extras,
        isOutsideCity: Boolean(dayInfo.isOutsideCity),
        paymentSource: { ...(paymentSource || {}) },
      });
    }
  }

  const entries = allocateGst(rawEntries, gstPercent);
  return { entries, ...entriesToLegacy(entries) };
}

function entriesToLegacy(entries) {
  const addonDays = {};
  const schedule = {};
  const bookingTypes = {};
  for (const entry of entries || []) {
    const name = entry.displayName;
    addonDays[name] = addonDays[name] || [];
    addonDays[name].push(entry.dayIndex);
    schedule[name] = schedule[name] || {};
    schedule[name][entry.dayIndex] = {
      time: entry.time,
      placeName: entry.location?.placeName,
      lat: entry.location?.lat,
      lng: entry.location?.lng,
      fixedByOperator: Boolean(entry.fixedByOperator),
      source: entry.scheduleSource,
    };
    bookingTypes[`${name}_${entry.dayIndex}`] = entry.bookingType;
  }
  return { addonDays, schedule, bookingTypes };
}

function summarizeAddonEntries(entries) {
  return (entries || []).reduce(
    (summary, entry) => {
      summary.addonSurcharge += Number(entry.surcharge) + Number(entry.extras);
      summary.addonTotalPrice += Number(entry.totalBeforeGst);
      summary.gstOnAddon += Number(entry.gstAllocation);
      return summary;
    },
    { addonSurcharge: 0, addonTotalPrice: 0, gstOnAddon: 0 },
  );
}

function revalidateFrozenEntryTiming(entries, now = new Date()) {
  const today = dateKeyInTimeZone(now);
  for (const entry of entries || []) {
    if (!entry?.date || entry.date < today) {
      throw validationError(
        `Day ${Number(entry?.dayIndex) + 1} has already passed.`,
        "ADDON_DAY_PASSED",
      );
    }
    if (entry.date === today) {
      const parsedTime = parseStrictTime(entry.time);
      const cutoffAt =
        istLocalToUtcMs(entry.date, parsedTime) -
        SAME_DAY_CUTOFF_MINUTES * 60 * 1000;
      if (!parsedTime || now.getTime() > cutoffAt) {
        throw validationError(
          `Same-day add-ons close ${SAME_DAY_CUTOFF_MINUTES} minutes before pickup (${entry.time}).`,
          "SAME_DAY_CUTOFF_PASSED",
        );
      }
    }
  }
  return true;
}

module.exports = {
  MAX_CUSTOMER_DISTANCE_KM,
  SERVICE_TYPES,
  canonicalServiceType,
  parseStrictTime,
  validCoordinates,
  haversineKm,
  buildCanonicalAddonEntries,
  entriesToLegacy,
  summarizeAddonEntries,
  revalidateFrozenEntryTiming,
};
