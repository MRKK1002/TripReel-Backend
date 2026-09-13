const { randomUUID } = require("crypto");
const TripBooking = require("../models/TripBooking");
const Batch = require("../models/Batch");
const Package = require("../models/Package");
const OperatorWallet = require("../models/OperatorWallet");
const WalletTransaction = require("../models/WalletTransaction");
const {
  creditOperatorWalletIdempotent,
} = require("../utils/idempotentWalletCredit");
const { notifyUser } = require("./notificationController");
const { getSetting } = require("./platformSettingsController");
const escapeRegex = require("../utils/escapeRegex");
const { getPagination, paginationMeta } = require("../utils/pagination");
const {
  parseDateKey,
  dateKeyToISTStart,
  getISTDateKey,
  storedDateKey,
  addDaysToDateKey,
  isDateKeyPastInclusiveEnd,
  isDateKeyStarted,
  getISTDayRange,
} = require("../utils/businessDate");
const { batchLifecycle, isHistory } = require("../utils/lifecycle");
const FlexibleDateInventory = require("../models/FlexibleDateInventory");
const {
  acquireFlexCapacityLease,
  releaseFlexCapacityLease,
  materializeDateInventory,
} = require("../utils/flexibleInventory");
const {
  buildReservationClaimFilter,
  buildReservationClaimPipeline,
  buildReservationReleaseFilter,
  buildReservationReleasePipeline,
} = require("../utils/inventoryClaims");
const {
  buildPlatformCouponClaim,
  buildPlatformCouponRelease,
} = require("../utils/platformCouponClaims");
const {
  buildCanonicalAddonEntries,
  summarizeAddonEntries,
} = require("../utils/canonicalAddonServices");

// Parse a canonical business date at IST midnight independent of server TZ.
function parseLocalDateStr(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const key = raw.split("T")[0];
  if (!parseDateKey(key)) return null;
  if (raw.includes("T") && Number.isNaN(Date.parse(raw))) return null;
  return dateKeyToISTStart(key);
}

function isBookingFinalizationPending(booking) {
  return (
    Number(booking?.requiredEffectsVersion) === 1 &&
    booking?.requiredEffectsState !== "COMPLETED"
  );
}
exports.isBookingFinalizationPending = isBookingFinalizationPending;

// Most bookings an operator may cancel in one batch-cancel request. Each one
// issues a synchronous Razorpay refund, so a bigger batch cannot finish inside a
// single HTTP request and is handed to admin instead.
const MAX_BULK_CANCEL = 25;

// Determine the per-day base price for an addon based on its name.
// Reel maker / videographer uses one price, photographer uses another.
function pickAddonBasePrice(addonName, photographerPrice, videographerPrice) {
  const n = (addonName || "").toLowerCase();
  if (n.includes("reel") || n.includes("video")) return videographerPrice;
  return photographerPrice; // default to photographer
}

// A traveler aged 1–7 is a child; age 0 (unknown) or 8+ is charged as an adult.
// Must match CHILD_MAX_AGE on the app (BookingScreen.jsx).
const CHILD_MAX_AGE = 7;

// Derive the authoritative adult/child split from traveler ages. The client's
// self-declared adults/children counts are NEVER trusted for pricing — a
// modified app could declare adults as children to pay a lower child fare.
function deriveSplitFromTravelers(travelers) {
  const list = Array.isArray(travelers) ? travelers : [];
  let adults = 0;
  let children = 0;
  for (const t of list) {
    const age = Number(t?.age) || 0;
    if (age > 0 && age <= CHILD_MAX_AGE) children += 1;
    else adults += 1;
  }
  return { adults, children, total: list.length };
}
exports.deriveSplitFromTravelers = deriveSplitFromTravelers;
exports.CHILD_MAX_AGE = CHILD_MAX_AGE;

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcPricing({
  adultPrice,
  childPrice = 0,
  seats,
  adults,
  children = 0,
  platformFeePercent,
  gstPercent,
  addonAmount = 0,
  addonSurcharge = 0,
  discountAmount = 0, // operator coupon — reduces operator earnings
  platformDiscountAmount = 0, // admin coupon — absorbed by platform, operator unaffected
}) {
  // Backward compatible: if an explicit adults count isn't given, treat every
  // seat as an adult (legacy behaviour). Otherwise price adults + children.
  const numAdults = adults != null ? Number(adults) : Number(seats) || 0;
  const numChildren = adults != null ? Number(children) || 0 : 0;
  const totalSeats = numAdults + numChildren;

  const fareSubtotal = Math.round(
    adultPrice * numAdults + (childPrice || 0) * numChildren,
  );
  // Operator coupon reduces the fare the operator is paid on.
  const netFare = Math.max(0, fareSubtotal - discountAmount);
  const subtotal = fareSubtotal + addonAmount;
  // GST charged on (operator-discounted fare + addon)
  const gstAmount = Math.round(((netFare + addonAmount) * gstPercent) / 100);
  // Platform fee is taken on the operator's fare only (not GST, not Snapja base)
  const platformFeeAmount = Math.round((netFare * platformFeePercent) / 100);

  // Platform (admin) coupon is applied on the final bill — the platform pays it
  // on the user's behalf. It NEVER touches netFare, so the operator's earnings
  // are unaffected. Cap it so the user total can't go below the addon+GST portion.
  const grossTotal = netFare + addonAmount + gstAmount;
  const cappedPlatformDiscount = Math.min(
    Math.max(0, platformDiscountAmount),
    netFare, // platform can at most gift the entire fare portion
  );
  const totalAmount = Math.max(0, grossTotal - cappedPlatformDiscount);

  // Operator earns: net fare minus platform fee, plus their outside-city surcharge.
  // (The Snapja base and the GST are NOT operator earnings. Platform coupon does
  // NOT reduce this — the platform absorbs that discount from its own margin.)
  const operatorAmount = netFare - platformFeeAmount + addonSurcharge;
  return {
    adultPrice,
    childPrice: childPrice || 0,
    seats: totalSeats,
    adults: numAdults,
    children: numChildren,
    fareSubtotal,
    addonAmount,
    subtotal,
    platformFeePercent,
    platformFeeAmount,
    gstPercent,
    gstAmount,
    totalAmount,
    discountAmount,
    platformDiscountAmount: cappedPlatformDiscount,
    operatorAmount,
  };
}

// Read-only: compute the authoritative booking total server-side (no DB mutation).
// Used by payment createOrder so the charged amount can NEVER be set by the client.
async function computeAuthoritativePricing({
  packageId,
  batchId,
  bookingMode,
  flexAvailabilityId,
  flexStartDate,
  seats,
  adults,
  children,
  couponCode,
  platformCouponCode,
  userId,
  addonDays,
  addonSchedule,
}) {
  if (!["batch", "flexible"].includes(bookingMode)) {
    throw new Error("bookingMode must be exactly 'batch' or 'flexible'");
  }

  const numSeats = Math.max(1, Number(seats) || 1);
  const pkg = await Package.findById(packageId);
  if (!pkg || !pkg.isActive || pkg.status !== "APPROVED") {
    throw new Error("Package not found or not available");
  }
  if (pkg.bookingMode !== bookingMode) {
    throw new Error(`This package only supports ${pkg.bookingMode} bookings.`);
  }

  let adultPrice, childPrice, operatorId;
  let flexInventoryId = null;
  let addonTimingBooking = null;

  if (bookingMode === "flexible") {
    if (!flexAvailabilityId) {
      throw new Error("flexAvailabilityId is required for flexible bookings");
    }
    if (!flexStartDate) {
      throw new Error("Please select a valid start date.");
    }

    // Flexible booking — get pricing from FlexibleAvailability record
    const FlexibleAvailability = require("../models/FlexibleAvailability");
    const flex = await FlexibleAvailability.findById(flexAvailabilityId);
    if (!flex || !flex.isActive || flex.isArchived)
      throw new Error("Flexible availability not found or inactive");
    if (String(flex.packageId) !== String(packageId))
      throw new Error("Flexible availability does not belong to this package");

    // Validate chosen start date up-front (before charging) — future + in-window
    const chosenKey = String(flexStartDate).trim().split("T")[0];
    const chosen = parseLocalDateStr(chosenKey);
    const winStartKey = storedDateKey(flex.startDate);
    const winEndKey = storedDateKey(flex.endDate);
    if (!chosen || !parseDateKey(chosenKey))
      throw new Error("Please select a valid start date.");
    if (chosenKey < getISTDateKey())
      throw new Error("The selected start date is in the past.");
    if (chosenKey < winStartKey || chosenKey > winEndKey)
      throw new Error("The selected date is outside the available range.");

    const lease = await acquireFlexCapacityLease(flex._id);
    let inventory;
    try {
      inventory = await materializeDateInventory(lease.item, chosenKey, {
        syncCapacity: true,
      });
    } finally {
      await releaseFlexCapacityLease(flex._id, lease.token);
    }
    flexInventoryId = inventory._id;
    if (
      inventory.capacity > 0 &&
      numSeats > inventory.capacity - (inventory.bookedSeats || 0)
    ) {
      const remaining = Math.max(
        0,
        inventory.capacity - (inventory.bookedSeats || 0),
      );
      throw new Error(
        remaining > 0
          ? `Only ${remaining} seat${remaining > 1 ? "s" : ""} left for this start date.`
          : "This start date is fully booked.",
      );
    }

    adultPrice = flex.adultPrice;
    childPrice = flex.childPrice || 0;
    operatorId = flex.operatorId;
    addonTimingBooking = { flexStartDate: chosen };
  } else {
    if (!batchId) throw new Error("batchId is required for batch bookings");

    // Batch booking — existing flow
    const batch = await Batch.findById(batchId);
    if (!batch || !batch.isActive || batch.isArchived)
      throw new Error("Batch not found or inactive");
    if (String(batch.packageId) !== String(packageId))
      throw new Error("Batch does not belong to this package");

    const now = new Date();
    if (isDateKeyPastInclusiveEnd(batch.bookingDeadline, now))
      throw new Error("Booking deadline has passed for this batch");
    if (batch.startDate <= now)
      throw new Error("This trip has already started");

    const available = Math.max(
      0,
      (batch.totalSeats || 0) - (batch.bookedSeats || 0),
    );
    if (numSeats > available) {
      throw new Error(
        `Only ${available} seat${available !== 1 ? "s" : ""} available`,
      );
    }

    adultPrice = batch.adultPrice;
    childPrice = batch.childPrice || 0;
    operatorId = batch.operatorId;
    addonTimingBooking = { batchId: { startDate: batch.startDate } };
  }

  // Resolve adult / child split (backward compatible — default all to adults)
  const numAdults = adults != null ? Math.max(0, Number(adults)) : numSeats;
  const numChildren = adults != null ? Math.max(0, Number(children) || 0) : 0;

  const platformFeePercent = (await getSetting("platform_fee_percent")) ?? 10;
  const gstPercent = (await getSetting("gst_percent")) ?? 5;

  // Freeze one canonical immutable entry per service/day. This is the only
  // add-on representation trusted after checkout creation.
  const photographerPrice =
    (await getSetting("photographer_base_price")) ?? 2000;
  const videographerPrice =
    (await getSetting("videographer_base_price")) ?? 2000;
  let addonPlan = {
    entries: [],
    addonDays: {},
    schedule: {},
    bookingTypes: {},
  };
  if (addonDays && Object.keys(addonDays).length > 0) {
    addonPlan = buildCanonicalAddonEntries({
      booking: addonTimingBooking,
      pkg,
      addonDays,
      addonSchedule,
      photographerPrice,
      reelmakerPrice: videographerPrice,
      gstPercent,
      paymentSource: { kind: "initial" },
    });
  }
  const addonSummary = summarizeAddonEntries(addonPlan.entries);
  const addonSurcharge = addonSummary.addonSurcharge;
  const addonTotalPrice = addonSummary.addonTotalPrice;

  // Coupon (read-only — no usage increment here)
  const code = (couponCode || "").trim().toUpperCase();
  let discountAmount = 0;
  let operatorCouponId = null;
  // When a code was supplied but cannot be honoured, the caller must be told
  // instead of silently charging full price.
  let couponIssue = null;
  const fareSubtotalRaw = Math.round(
    adultPrice * numAdults + (childPrice || 0) * numChildren,
  );
  if (code) {
    const Coupon = require("../models/Coupon");
    const now = new Date();
    const dayStart = getISTDayRange(getISTDateKey(now)).start;
    // Flexible coupons are keyed by packageId, batch coupons by batchId
    const couponMatch =
      bookingMode === "flexible" ? { packageId, batchId: null } : { batchId };
    const coupon = await Coupon.findOne({
      ...couponMatch,
      code,
      isActive: true,
      isArchived: { $ne: true },
      validFrom: { $lte: now },
      validUntil: { $gte: dayStart },
    });
    if (!coupon) {
      couponIssue = "This coupon is no longer valid.";
    } else {
      const withinUsage =
        coupon.usageLimit === 0 || coupon.usedCount < coupon.usageLimit;
      const meetsGuests =
        coupon.minGuests === 0 || numSeats >= coupon.minGuests;
      const meetsOrder =
        coupon.minOrderAmount === 0 || fareSubtotalRaw >= coupon.minOrderAmount;
      if (withinUsage && meetsGuests && meetsOrder) {
        operatorCouponId = coupon._id;
        if (coupon.type === "percentage") {
          discountAmount = Math.round((fareSubtotalRaw * coupon.value) / 100);
          if (coupon.maxDiscount > 0 && discountAmount > coupon.maxDiscount)
            discountAmount = coupon.maxDiscount;
        } else {
          discountAmount = Math.min(coupon.value, fareSubtotalRaw);
        }
      } else if (!withinUsage) {
        couponIssue = "This coupon has reached its usage limit.";
      } else if (!meetsGuests) {
        couponIssue = `This coupon needs at least ${coupon.minGuests} travellers.`;
      } else {
        couponIssue = `This coupon needs a minimum order of ₹${coupon.minOrderAmount.toLocaleString(
          "en-IN",
        )}.`;
      }
    }
  }

  // ── Platform (admin) coupon — only if NO operator coupon was applied ─────────
  // A booking may carry ONE coupon. Operator coupon takes precedence if both a
  // valid operator coupon and a platform code were somehow sent.
  let platformDiscountAmount = 0;
  let platformCouponId = null;
  const platformCode = (platformCouponCode || "").trim().toUpperCase();
  if (platformCode && discountAmount === 0) {
    const { resolvePlatformCoupon } = require("../utils/platformCoupon");
    const res = await resolvePlatformCoupon({
      code: platformCode,
      userId,
      pkg,
      fareSubtotal: fareSubtotalRaw,
      numSeats,
    });
    if (res.ok) {
      platformDiscountAmount = res.discount;
      platformCouponId = res.coupon?._id || null;
      couponIssue = null;
    } else {
      couponIssue = res.reason || "This coupon is no longer valid.";
    }
  }

  const pricing = calcPricing({
    adultPrice,
    childPrice: childPrice || 0,
    adults: numAdults,
    children: numChildren,
    seats: numSeats,
    platformFeePercent,
    gstPercent,
    addonAmount: addonTotalPrice,
    addonSurcharge,
    discountAmount,
    platformDiscountAmount,
  });
  if (discountAmount > 0) pricing.couponCode = code;
  if (platformDiscountAmount > 0) pricing.platformCouponCode = platformCode;
  // `couponIssue` is set only when a code was supplied and could not be applied.
  return {
    totalAmount: pricing.totalAmount,
    couponIssue,
    pricing,
    addonSurcharge,
    addonTotalPrice,
    addonServiceEntries: addonPlan.entries,
    addonDays: addonPlan.addonDays,
    addonSchedule: addonPlan.schedule,
    addonBookingTypes: addonPlan.bookingTypes,
    addonNames: [
      ...new Set(addonPlan.entries.map((entry) => entry.displayName)),
    ],
    operatorCouponId,
    platformCouponId,
    source: {
      adultPrice,
      childPrice: childPrice || 0,
      operatorId,
      bookingMode,
      packageId,
      batchId: bookingMode === "batch" ? batchId : null,
      flexAvailabilityId:
        bookingMode === "flexible" ? flexAvailabilityId : null,
      flexStartDateKey:
        bookingMode === "flexible"
          ? String(flexStartDate).trim().split("T")[0]
          : null,
      flexInventoryId: bookingMode === "flexible" ? flexInventoryId : null,
      seats: numSeats,
      adults: numAdults,
      children: numChildren,
    },
  };
}
exports.computeAuthoritativePricing = computeAuthoritativePricing;

// ── Authoritative add-on pricing for a given package + addonDays ──────────────
// Reused by both booking creation and the post-booking add-on top-up flow.
// Returns { addonSurcharge, addonTotalPrice, gstOnAddon, gstPercent }.
//   addonTotalPrice = base (Snapja) + surcharge (operator), summed per day
//   addonSurcharge  = operator's outside-city + extra-charge portion
//   gstOnAddon      = GST charged on the add-on total
async function computeAddonPricing({ pkg, addonDays }) {
  const photographerPrice =
    (await getSetting("photographer_base_price")) ?? 2000;
  const videographerPrice =
    (await getSetting("videographer_base_price")) ?? 2000;
  const gstPercent = (await getSetting("gst_percent")) ?? 5;

  let addonSurcharge = 0;
  let addonTotalPrice = 0;
  if (addonDays) {
    for (const name of Object.keys(addonDays)) {
      const basePrice = pickAddonBasePrice(
        name,
        photographerPrice,
        videographerPrice,
      );
      for (const dayIdx of addonDays[name] || []) {
        const dayInfo = pkg?.itinerary?.[dayIdx];
        let sc = 0;
        if (dayInfo?.isOutsideCity) {
          sc =
            Number(dayInfo.outsideCityCharge) ||
            Number(pkg?.outsideCityCharge) ||
            0;
          if (Array.isArray(dayInfo.extraCharges)) {
            for (const ec of dayInfo.extraCharges) sc += Number(ec.amount) || 0;
          }
        }
        addonSurcharge += sc;
        addonTotalPrice += basePrice + sc;
      }
    }
  }
  const gstOnAddon = Math.round((addonTotalPrice * gstPercent) / 100);
  return { addonSurcharge, addonTotalPrice, gstOnAddon, gstPercent };
}
exports.computeAddonPricing = computeAddonPricing;

// How many days before the trip start add-ons can still be added. Snapja needs
// lead time to assign a creator (unassigned add-ons auto-cancel 1 day before).
const ADDON_ADD_CUTOFF_DAYS = 2;
exports.ADDON_ADD_CUTOFF_DAYS = ADDON_ADD_CUTOFF_DAYS;

async function creditOperatorWallet(
  operatorId,
  amount,
  bookingId,
  description,
  eventKey,
  purpose,
) {
  const result = await creditOperatorWalletIdempotent({
    operatorId,
    amount,
    bookingId,
    description,
    eventKey,
    purpose,
  });
  return result.wallet;
}

async function debitOperatorWallet(operatorId, amount, bookingId, description) {
  const wallet = await OperatorWallet.findOneAndUpdate(
    { operatorId },
    { $inc: { balance: -amount, totalEarned: -amount } },
    { new: true },
  );

  if (wallet) {
    await WalletTransaction.create({
      operatorId,
      bookingId,
      type: "DEBIT",
      amount,
      description,
      balanceAfter: Math.max(0, wallet.balance),
    });
  }
}

// Resolve the refund % for a user cancellation from the admin-configured slabs
async function resolveRefundPercent(startDate) {
  let refundPercent = 0;
  if (!startDate) return 0;
  // Compare at IST date-level (midnight-to-midnight) so date-only picker values
  // don't drift across timezones. Server TZ is pinned to Asia/Kolkata in server.js.
  const s = new Date(startDate);
  const startMid = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  const now = new Date();
  const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysBeforeTrip = Math.round(
    (startMid.getTime() - todayMid.getTime()) / (1000 * 60 * 60 * 24),
  );

  let slabs = [
    { daysBeforeTrip: 7, refundPercent: 90 },
    { daysBeforeTrip: 3, refundPercent: 50 },
    { daysBeforeTrip: 0, refundPercent: 0 },
  ];
  try {
    const slabsSetting = await getSetting("cancellation_refund_slabs");
    if (Array.isArray(slabsSetting) && slabsSetting.length > 0)
      slabs = slabsSetting;
  } catch {}

  slabs.sort((a, b) => b.daysBeforeTrip - a.daysBeforeTrip);
  for (const slab of slabs) {
    if (daysBeforeTrip >= slab.daysBeforeTrip) {
      refundPercent = slab.refundPercent;
      break;
    }
  }
  return refundPercent;
}

/**
 * Core cancellation + refund processor — used by user, operator, and admin cancels.
 *
 * @param {object} booking  the TripBooking document (already loaded)
 * @param {object} opts
 *   - cancelledBy: 'user' | 'operator' | 'admin' | 'system'
 *   - reason: string
 *   - fullRefund: boolean (operator/admin cancel → 100% refund regardless of slab)
 * @returns {Promise<object>} summary { refundAmount, refundPercent, breakdown, refundStatus }
 */
async function processCancellationRefund(
  booking,
  { cancelledBy, reason, fullRefund } = {},
) {
  const CANCELLATION_LEASE_MS = 5 * 60 * 1000;
  const token = randomUUID();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + CANCELLATION_LEASE_MS);

  const persistedSummary = (current, newlyCompleted = false) => ({
    refundAmount:
      (Number(current.refundAmount) || 0) +
      (Number(current.addonPurchaseRefundAmount) || 0),
    initialRefundAmount: Number(current.refundAmount) || 0,
    addonPurchaseRefundAmount: Number(current.addonPurchaseRefundAmount) || 0,
    refundPercent: Number(current.refundPercent) || 0,
    breakdown: current.refundBreakdown || {},
    refundStatus: current.refundStatus,
    financialSettlementState: current.financialSettlementState,
    localEffectsCompleted: current.cancellationState === "COMPLETED",
    refundMessage:
      (Number(current.refundAmount) || 0) +
        (Number(current.addonPurchaseRefundAmount) || 0) <=
      0
        ? "Cancellation completed; no refund is applicable."
        : current.financialSettlementState === "RECONCILIATION_REQUIRED"
          ? "Cancellation completed, but the refund requires manual attention."
          : current.refundStatus === "REFUNDED"
            ? "Refund processed by the payment provider."
            : current.refundStatus === "PROCESSING"
              ? "Refund was accepted and is still pending with the payment provider."
              : ["FAILED", "MANUAL"].includes(current.refundStatus)
                ? "Cancellation completed, but the refund requires manual attention."
                : "Refund status is pending review.",
    booking: current,
    newlyCompleted,
  });

  let current = await TripBooking.findById(booking._id);
  if (!current) {
    const error = new Error("Booking not found");
    error.statusCode = 404;
    throw error;
  }
  if (
    current.status === "CANCELLED" &&
    (!current.cancellationState || current.cancellationState === "NONE")
  ) {
    const legacyError =
      "Legacy cancellation has no durable effect markers; manual reconciliation is required before replay";
    current = await TripBooking.findByIdAndUpdate(
      current._id,
      {
        $set: {
          cancellationState: "RECONCILIATION_REQUIRED",
          cancellationError: legacyError,
          financialSettlementState: "RECONCILIATION_REQUIRED",
          cancellationLeaseToken: "",
          cancellationLeaseUntil: null,
        },
      },
      { new: true },
    );
    const error = new Error(legacyError);
    error.statusCode = 409;
    error.code = "CANCELLATION_RECONCILIATION_REQUIRED";
    throw error;
  }
  if (isBookingFinalizationPending(current)) {
    const error = new Error(
      "Booking finalization is still processing and cannot be cancelled yet",
    );
    error.statusCode = 409;
    error.code = "BOOKING_FINALIZATION_PENDING";
    throw error;
  }

  if (
    current.status === "CANCELLED" &&
    current.cancellationState === "COMPLETED"
  ) {
    return persistedSummary(current, false);
  }

  const resuming = current.status === "CANCELLED";
  const actor = resuming
    ? current.cancelledBy || cancelledBy || "system"
    : cancelledBy || current.cancelledBy || "system";
  const cancellationReason = resuming
    ? current.cancelReason || reason || `Cancelled by ${actor}`
    : reason || current.cancelReason || `Cancelled by ${actor}`;
  const isFullRefund = resuming
    ? actor !== "user"
    : fullRefund == null
      ? actor !== "user"
      : Boolean(fullRefund);

  const claimedBooking = await TripBooking.findOneAndUpdate(
    {
      _id: booking._id,
      $or: [
        { status: { $in: ["CONFIRMED", "PENDING"] } },
        {
          status: "CANCELLED",
          cancellationState: {
            $nin: ["COMPLETED", "RECONCILIATION_REQUIRED"],
          },
          $or: [
            { cancellationLeaseUntil: null },
            { cancellationLeaseUntil: { $exists: false } },
            { cancellationLeaseUntil: { $lte: now } },
          ],
        },
      ],
    },
    {
      $set: {
        status: "CANCELLED",
        cancelReason: cancellationReason,
        cancelledBy: actor,
        cancelledAt: current.cancelledAt || now,
        cancellationState: "PROCESSING",
        cancellationLeaseToken: token,
        cancellationLeaseUntil: leaseUntil,
        cancellationError: "",
      },
    },
    { new: true },
  );

  if (!claimedBooking) {
    current = await TripBooking.findById(booking._id);
    if (
      current?.status === "CANCELLED" &&
      current.cancellationState === "COMPLETED"
    ) {
      return persistedSummary(current, false);
    }
    const currentStatus = current?.status || "unknown";
    const error = new Error(
      current?.cancellationState === "RECONCILIATION_REQUIRED"
        ? current.cancellationError ||
            "Cancellation requires manual reconciliation"
        : `Cannot cancel a ${currentStatus.toLowerCase()} booking`,
    );
    error.statusCode = 400;
    error.code = "CANCELLATION_ALREADY_CLAIMED";
    throw error;
  }
  booking = claimedBooking;

  const persist = async (fields) => {
    const updated = await TripBooking.findOneAndUpdate(
      {
        _id: booking._id,
        cancellationState: "PROCESSING",
        cancellationLeaseToken: token,
      },
      { $set: fields },
      { new: true },
    );
    if (!updated) {
      const error = new Error("Cancellation lease was lost");
      error.code = "CANCELLATION_ALREADY_CLAIMED";
      error.statusCode = 400;
      throw error;
    }
    booking = updated;
    return updated;
  };

  let refundSubmissionStarted = false;
  let refundResultPersisted = false;
  try {
    const hasUnledgeredLegacyTopups =
      !booking.initialPricing &&
      (booking.addonTopupPaymentIds || []).length > 0;
    const p =
      booking.initialPricing ||
      (hasUnledgeredLegacyTopups ? {} : booking.pricing || {});
    const fareSubtotal = Number(p.fareSubtotal) || 0;
    const discountAmount = Number(p.discountAmount) || 0;
    const platformDiscountAmount = Number(p.platformDiscountAmount) || 0;
    const netFare = Math.max(0, fareSubtotal - discountAmount);
    const userNetFare = Math.max(0, netFare - platformDiscountAmount);
    const gst = Number(p.gstAmount) || 0;
    const addon = Number(p.addonAmount) || 0;
    const platformFeePercent = Number(p.platformFeePercent) || 0;
    const refundPercent = isFullRefund
      ? 100
      : await resolveRefundPercent(booking.snapshot?.startDate);
    const fareRefund = Math.round((userNetFare * refundPercent) / 100);
    const operatorFareRefund = Math.round((netFare * refundPercent) / 100);
    const gstOnFare =
      netFare > 0 ? Math.round((gst * netFare) / (netFare + addon)) : 0;
    const gstOnAddon = gst - gstOnFare;
    const gstFareRefund = Math.round((gstOnFare * refundPercent) / 100);
    const addonRefund = addon;
    const gstAddonRefund = addonRefund > 0 ? gstOnAddon : 0;
    const gstRefund = gstFareRefund + gstAddonRefund;
    const retainedFare = netFare - operatorFareRefund;
    const platformFeeOnRetained = isFullRefund
      ? 0
      : Math.round((retainedFare * platformFeePercent) / 100);
    const operatorRetained = isFullRefund
      ? 0
      : retainedFare - platformFeeOnRetained;
    const platformRetained = isFullRefund
      ? 0
      : platformFeeOnRetained + (gst - gstRefund);
    let userRefund = fareRefund + gstRefund + addonRefund;
    const AddonEntryRefund = require("../models/AddonEntryRefund");
    const ambiguousInitialEntryRefund = await AddonEntryRefund.findOne({
      bookingId: booking._id,
      paymentSource: "INITIAL",
      $or: [
        { status: "RECONCILIATION_REQUIRED" },
        { status: "PROCESSING", refundId: "" },
      ],
    }).select("_id");
    const priorInitialEntryRefunds = await AddonEntryRefund.aggregate([
      {
        $match: {
          bookingId: booking._id,
          paymentSource: "INITIAL",
          status: { $in: ["REFUNDED", "PROCESSING"] },
          refundId: { $ne: "" },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    userRefund = Math.max(
      0,
      userRefund - Number(priorInitialEntryRefunds[0]?.total || 0),
    );
    userRefund = Math.min(
      userRefund,
      Number(booking.initialPaymentAmount) || Number(p.totalAmount) || 0,
    );
    if (hasUnledgeredLegacyTopups) userRefund = 0;
    const breakdown = {
      fareRefund,
      gstRefund,
      addonRefund,
      operatorRetained,
      platformRetained,
    };

    await persist({
      refundPercent,
      refundAmount: userRefund,
      refundBreakdown: breakdown,
    });

    // Persist PROCESSING before submitting money movement. A later run never
    // resubmits an acknowledged or ambiguous refund.
    if (hasUnledgeredLegacyTopups || ambiguousInitialEntryRefund) {
      await persist({
        refundStatus: "MANUAL",
        refundError: hasUnledgeredLegacyTopups
          ? "Legacy booking mixes original and top-up pricing without durable per-payment amounts; financial reconciliation is required"
          : "An ambiguous per-entry refund exists on the original payment; whole-payment refund is blocked pending reconciliation",
        financialSettlementState: "RECONCILIATION_REQUIRED",
      });
    } else if (userRefund <= 0) {
      if (booking.refundStatus !== "REFUNDED") {
        await persist({
          refundStatus: "REFUNDED",
          refundedAt: new Date(),
          refundError: "",
        });
      }
    } else if (!booking.razorpayPaymentId) {
      if (!booking.refundId && booking.refundStatus === "NONE") {
        await persist({
          refundStatus: "MANUAL",
          refundError: "No Razorpay payment id — manual refund required",
        });
      }
    } else if (
      booking.refundId ||
      booking.refundStatus === "REFUNDED" ||
      (booking.refundStatus === "PROCESSING" && booking.refundId)
    ) {
      // Provider already acknowledged this refund; resume local effects only.
    } else if (booking.refundStatus === "PROCESSING") {
      const ambiguity =
        "A prior refund submission may have reached the provider; reconcile before retrying";
      // Financial ambiguity must not block durable local cleanup. Keep the
      // refund in attention state, then continue inventory/coupon/chat effects.
      await persist({
        refundError: ambiguity,
        financialSettlementState: "RECONCILIATION_REQUIRED",
      });
    } else if (!["FAILED", "MANUAL"].includes(booking.refundStatus)) {
      const refundClaim = await TripBooking.findOneAndUpdate(
        {
          _id: booking._id,
          cancellationState: "PROCESSING",
          cancellationLeaseToken: token,
          refundStatus: { $nin: ["PROCESSING", "REFUNDED"] },
          initialAddonRefundInFlight: { $ne: true },
        },
        {
          $set: {
            refundStatus: "PROCESSING",
            refundError: "Refund submission in progress",
          },
        },
        { new: true },
      );
      if (!refundClaim) {
        await persist({
          refundStatus: "MANUAL",
          refundError:
            "A per-entry refund claimed the original payment concurrently; whole-payment refund is blocked",
          financialSettlementState: "RECONCILIATION_REQUIRED",
        });
      } else {
        booking = refundClaim;
        refundSubmissionStarted = true;
        const { refundPayment } = require("../utils/razorpayRefund");
        const result = await refundPayment(
          booking.razorpayPaymentId,
          userRefund,
          { bookingId: booking.bookingId, reason: cancellationReason },
        );
        if (result.success) {
          await persist({
            refundId: result.refundId || "",
            refundStatus:
              result.status === "processed" ? "REFUNDED" : "PROCESSING",
            refundedAt: result.status === "processed" ? new Date() : null,
            refundError: "",
          });
        } else {
          await persist({
            refundStatus: "FAILED",
            refundError: result.error || "Refund failed",
          });
        }
        refundResultPersisted = true;
      }
    }

    const addonPurchaseRefund =
      await require("../utils/addonPurchaseCancellation").refundAppliedAddonPurchases(
        booking,
        cancellationReason,
      );
    await persist({
      addonPurchaseRefundAmount: addonPurchaseRefund.requestedAmount,
      addonPurchaseRefundStatus: addonPurchaseRefund.status,
      ...(addonPurchaseRefund.reconciliation
        ? { financialSettlementState: "RECONCILIATION_REQUIRED" }
        : {}),
    });

    if (!booking.inventoryReleasedAt) {
      const seatsToRelease = Math.max(0, Number(booking.seats) || 0);
      const releaseKey = String(booking._id);
      const releasePipeline = [
        {
          $set: {
            bookedSeats: {
              $max: [
                0,
                {
                  $subtract: [{ $ifNull: ["$bookedSeats", 0] }, seatsToRelease],
                },
              ],
            },
            inventoryReleaseClaimKeys: {
              $setUnion: [
                { $ifNull: ["$inventoryReleaseClaimKeys", []] },
                [releaseKey],
              ],
            },
          },
        },
      ];
      if (booking.bookingMode === "flexible" && booking.flexInventoryId) {
        await FlexibleDateInventory.updateOne(
          {
            _id: booking.flexInventoryId,
            inventoryReleaseClaimKeys: { $ne: releaseKey },
          },
          releasePipeline,
        );
        // Keep the legacy parent counter as aggregate analytics only. It never
        // gates new reservations, but remains useful to existing dashboards.
        if (booking.flexAvailabilityId) {
          const FlexibleAvailability = require("../models/FlexibleAvailability");
          await FlexibleAvailability.updateOne(
            {
              _id: booking.flexAvailabilityId,
              inventoryReleaseClaimKeys: { $ne: releaseKey },
            },
            releasePipeline,
          );
        }
      } else if (
        booking.bookingMode === "flexible" &&
        booking.flexAvailabilityId
      ) {
        // Legacy flexible bookings predate per-date inventory.
        const FlexibleAvailability = require("../models/FlexibleAvailability");
        await FlexibleAvailability.updateOne(
          {
            _id: booking.flexAvailabilityId,
            inventoryReleaseClaimKeys: { $ne: releaseKey },
          },
          releasePipeline,
        );
      } else if (booking.batchId) {
        await Batch.updateOne(
          {
            _id: booking.batchId,
            inventoryReleaseClaimKeys: { $ne: releaseKey },
          },
          releasePipeline,
        );
      }
      await Package.updateOne(
        {
          _id: booking.packageId,
          bookingCountReleaseKeys: { $ne: releaseKey },
        },
        [
          {
            $set: {
              bookingCount: {
                $max: [
                  0,
                  {
                    $subtract: [
                      { $ifNull: ["$bookingCount", 0] },
                      seatsToRelease,
                    ],
                  },
                ],
              },
              bookingCountReleaseKeys: {
                $setUnion: [
                  { $ifNull: ["$bookingCountReleaseKeys", []] },
                  [releaseKey],
                ],
              },
            },
          },
        ],
      );
      await persist({ inventoryReleasedAt: new Date() });
    }

    if (!booking.couponReleasedAt) {
      const usedCoupon = booking.pricing?.couponCode;
      if (usedCoupon) {
        const Coupon = require("../models/Coupon");
        const releaseKey = String(booking._id);
        const match = booking.operatorCouponId
          ? { _id: booking.operatorCouponId }
          : booking.batchId
            ? { batchId: booking.batchId, code: usedCoupon }
            : { packageId: booking.packageId, batchId: null, code: usedCoupon };
        await Coupon.updateOne(
          { ...match, releaseClaimKeys: { $ne: releaseKey } },
          [
            {
              $set: {
                usedCount: {
                  $max: [0, { $subtract: [{ $ifNull: ["$usedCount", 0] }, 1] }],
                },
                releaseClaimKeys: {
                  $setUnion: [
                    { $ifNull: ["$releaseClaimKeys", []] },
                    [releaseKey],
                  ],
                },
              },
            },
          ],
        );
      }
      await persist({ couponReleasedAt: new Date() });
    }

    if (!booking.platformCouponReleasedAt) {
      const usedPlatformCoupon = booking.pricing?.platformCouponCode;
      if (usedPlatformCoupon) {
        const PlatformCoupon = require("../models/PlatformCoupon");
        const releaseKey = String(booking._id);
        const release = buildPlatformCouponRelease({
          couponId: booking.platformCouponId,
          code: usedPlatformCoupon,
          effectKey: releaseKey,
          userId: booking.userId,
        });
        await PlatformCoupon.updateOne(release.filter, release.pipeline);
      }
      await persist({ platformCouponReleasedAt: new Date() });
    }

    if (!booking.retentionCreditedAt) {
      if (operatorRetained > 0) {
        await creditOperatorWallet(
          booking.operatorId,
          operatorRetained,
          booking._id,
          `Cancellation retention — Booking ${booking.bookingId}`,
          `cancellation-retention:${booking._id}`,
          "CANCELLATION_RETENTION",
        );
      }
      await persist({ retentionCreditedAt: new Date() });
    }

    if (!booking.conversationClosedAt) {
      const Conversation = require("../models/Conversation");
      await Conversation.updateMany(
        { bookingId: booking._id },
        { isActive: false },
      );
      await persist({ conversationClosedAt: new Date() });
    }

    const financialSettlementState =
      booking.financialSettlementState === "RECONCILIATION_REQUIRED" ||
      booking.addonPurchaseRefundStatus === "RECONCILIATION_REQUIRED"
        ? "RECONCILIATION_REQUIRED"
        : booking.refundStatus === "REFUNDED" &&
            ["NONE", "REFUNDED"].includes(
              booking.addonPurchaseRefundStatus || "NONE",
            )
          ? "SETTLED"
          : booking.refundStatus === "PROCESSING" ||
              booking.addonPurchaseRefundStatus === "PROCESSING"
            ? "PENDING"
            : ["FAILED", "MANUAL"].includes(booking.refundStatus)
              ? "RECONCILIATION_REQUIRED"
              : userRefund <= 0 &&
                  ["NONE", "REFUNDED"].includes(
                    booking.addonPurchaseRefundStatus || "NONE",
                  )
                ? "SETTLED"
                : "PENDING";

    const completed = await TripBooking.findOneAndUpdate(
      {
        _id: booking._id,
        cancellationState: "PROCESSING",
        cancellationLeaseToken: token,
      },
      {
        $set: {
          cancellationState: "COMPLETED",
          cancellationLeaseToken: "",
          cancellationLeaseUntil: null,
          cancellationError: "",
          financialSettlementState,
        },
      },
      { new: true },
    );
    if (!completed) throw new Error("Cancellation lease was lost");
    booking = completed;

    try {
      const audit = require("../utils/audit");
      audit.log({
        action:
          booking.refundStatus === "REFUNDED"
            ? "refund_issued"
            : booking.refundStatus === "PROCESSING"
              ? "refund_pending"
              : "refund_attention_required",
        actor: { type: "system" },
        target: { type: "booking", id: booking._id, ref: booking.bookingId },
        details: {
          cancelledBy: actor,
          reason: cancellationReason,
          refundAmount: userRefund,
          refundPercent,
          refundStatus: booking.refundStatus,
          refundId: booking.refundId || "",
          paymentId: booking.razorpayPaymentId || "",
          breakdown,
        },
      });
    } catch {}

    if (booking.addonDispatched && addonRefund > 0) {
      try {
        const { notifyAdmin } = require("./notificationController");
        notifyAdmin(
          "Manual Snapja Reconciliation Needed",
          `Booking ${booking.bookingId} cancelled after addon was dispatched to Snapja. ₹${addonRefund} is included in the cancellation refund calculation; provider status is ${booking.refundStatus}. Reconcile with Snapja manually.`,
          { type: "general", bookingId: booking._id.toString() },
        );
      } catch {}
    }

    return persistedSummary(booking, true);
  } catch (error) {
    if (error.code === "CANCELLATION_RECONCILIATION_REQUIRED") throw error;
    const message = String(error.message || error).slice(0, 500);
    const requiresReconciliation =
      refundSubmissionStarted && !refundResultPersisted;
    await TripBooking.updateOne(
      { _id: booking._id, cancellationLeaseToken: token },
      {
        $set: {
          cancellationState: "PROCESSING",
          cancellationLeaseToken: "",
          cancellationLeaseUntil: null,
          cancellationError: message,
          ...(requiresReconciliation
            ? { financialSettlementState: "RECONCILIATION_REQUIRED" }
            : {}),
        },
      },
    ).catch(() => {});
    if (requiresReconciliation) {
      error.code = "CANCELLATION_FINANCIAL_RECONCILIATION_REQUIRED";
      error.statusCode = 409;
    }
    throw error;
  }
}
exports.processCancellationRefund = processCancellationRefund;

async function ensureRequiredBookingEffects(bookingOrId) {
  let booking =
    bookingOrId && bookingOrId._id
      ? bookingOrId
      : await TripBooking.findById(bookingOrId);
  if (!booking) throw new Error("Booking not found while applying effects");

  const Conversation = require("../models/Conversation");
  if (booking.requiredEffectsState === "COMPLETED") {
    if (
      Number(booking.requiredEffectsVersion) === 1 &&
      booking.status === "PENDING"
    ) {
      booking = await TripBooking.findOneAndUpdate(
        {
          _id: booking._id,
          requiredEffectsVersion: 1,
          requiredEffectsState: "COMPLETED",
          status: "PENDING",
        },
        { $set: { status: "CONFIRMED" } },
        { new: true },
      );
      if (!booking)
        booking = await TripBooking.findById(bookingOrId._id || bookingOrId);
    }
    return {
      booking,
      conversation: await Conversation.findOne({ bookingId: booking._id }),
    };
  }

  // Rows created before effect-versioning have ambiguous package/chat history.
  // Replaying them could double-count, so keep those conservative.
  if (Number(booking.requiredEffectsVersion) !== 1) {
    const message =
      "Legacy booking has no trustworthy post-insert effect claims; manual reconciliation is required";
    await TripBooking.updateOne(
      { _id: booking._id },
      { $set: { requiredEffectsState: "RECONCILIATION_REQUIRED" } },
    );
    const error = new Error(message);
    error.code = "BOOKING_EFFECTS_RECONCILIATION_REQUIRED";
    throw error;
  }

  const effectKey = String(booking._id);
  // Claim the race-sensitive platform coupon before any other aggregate effect.
  // If eligibility was lost after quote time, finalization remains PENDING
  // without partially incrementing package/operator-coupon aggregates.
  if (booking.platformCouponId) {
    const PlatformCoupon = require("../models/PlatformCoupon");
    const now = new Date();
    const [pkg, priorPublishedBooking] = await Promise.all([
      Package.findById(booking.packageId).select(
        "category categories state city operatorId",
      ),
      TripBooking.exists({
        _id: { $ne: booking._id },
        userId: booking.userId,
        status: { $in: ["CONFIRMED", "COMPLETED"] },
      }),
    ]);
    if (!pkg) throw new Error("Booking package no longer exists");
    const claim = buildPlatformCouponClaim({
      couponId: booking.platformCouponId,
      effectKey,
      userId: booking.userId,
      packageId: booking.packageId,
      operatorId: booking.operatorId,
      pkg,
      seats: Math.max(0, Number(booking.seats) || 0),
      fareSubtotal: Math.max(0, Number(booking.pricing?.fareSubtotal) || 0),
      now,
      hasPriorPublishedBooking: Boolean(priorPublishedBooking),
    });
    const couponEffect = await PlatformCoupon.updateOne(
      claim.filter,
      claim.pipeline,
    );
    if (couponEffect.matchedCount === 0) {
      throw new Error(
        "Platform coupon is no longer eligible or has reached its usage limit",
      );
    }
  }

  const packageEffect = await Package.updateOne(
    { _id: booking.packageId, bookingCountClaimKeys: { $ne: effectKey } },
    {
      $inc: { bookingCount: Math.max(0, Number(booking.seats) || 0) },
      $addToSet: { bookingCountClaimKeys: effectKey },
    },
  );
  if (packageEffect.matchedCount === 0) {
    const packageExists = await Package.exists({ _id: booking.packageId });
    if (!packageExists) throw new Error("Booking package no longer exists");
  }
  await TripBooking.updateOne(
    { _id: booking._id },
    { $set: { packageCountAppliedAt: new Date() } },
  );

  if (booking.operatorCouponId) {
    const Coupon = require("../models/Coupon");
    const now = new Date();
    const dayStart = getISTDayRange(getISTDateKey(now)).start;
    const scopeMatch =
      booking.bookingMode === "flexible"
        ? { packageId: booking.packageId, batchId: null }
        : { batchId: booking.batchId };
    const couponEffect = await Coupon.updateOne(
      {
        _id: booking.operatorCouponId,
        ...scopeMatch,
        $or: [
          { usageClaimKeys: effectKey },
          {
            $and: [
              { isActive: true },
              { isArchived: { $ne: true } },
              { validFrom: { $lte: now } },
              { validUntil: { $gte: dayStart } },
              { minGuests: { $lte: Number(booking.seats) || 0 } },
              {
                minOrderAmount: {
                  $lte: Number(booking.pricing?.fareSubtotal) || 0,
                },
              },
              {
                $or: [
                  { usageLimit: 0 },
                  {
                    $expr: {
                      $lt: [{ $ifNull: ["$usedCount", 0] }, "$usageLimit"],
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      [
        {
          $set: {
            usedCount: {
              $cond: [
                { $in: [effectKey, { $ifNull: ["$usageClaimKeys", []] }] },
                { $ifNull: ["$usedCount", 0] },
                { $add: [{ $ifNull: ["$usedCount", 0] }, 1] },
              ],
            },
            everUsedCount: {
              $cond: [
                { $in: [effectKey, { $ifNull: ["$usageClaimKeys", []] }] },
                { $ifNull: ["$everUsedCount", 0] },
                { $add: [{ $ifNull: ["$everUsedCount", 0] }, 1] },
              ],
            },
            firstUsedAt: {
              $cond: [
                { $in: [effectKey, { $ifNull: ["$usageClaimKeys", []] }] },
                "$firstUsedAt",
                { $ifNull: ["$firstUsedAt", now] },
              ],
            },
            lastUsedAt: {
              $cond: [
                { $in: [effectKey, { $ifNull: ["$usageClaimKeys", []] }] },
                "$lastUsedAt",
                now,
              ],
            },
            usageClaimKeys: {
              $setUnion: [{ $ifNull: ["$usageClaimKeys", []] }, [effectKey]],
            },
          },
        },
      ],
    );
    if (couponEffect.matchedCount === 0) {
      throw new Error(
        "Operator coupon is no longer eligible or has reached capacity",
      );
    }
  }

  const tripStart = new Date(
    booking.snapshot?.startDate || booking.flexStartDate || booking.createdAt,
  );
  const tripEnd = new Date(
    booking.snapshot?.endDate || booking.flexEndDate || tripStart,
  );
  const expiresAt = new Date(tripEnd.getTime() + 2 * 24 * 60 * 60 * 1000);
  const conversation = await Conversation.findOneAndUpdate(
    { bookingId: booking._id },
    {
      $setOnInsert: {
        bookingId: booking._id,
        userId: booking.userId,
        operatorId: booking.operatorId,
        packageTitle: booking.snapshot?.packageTitle || "",
        packageImage: booking.snapshot?.packageImageUrl || "",
        startsAt: new Date(),
        expiresAt,
        lastMessage: "New booking received",
        lastMessageAt: new Date(),
        lastSenderType: "system",
      },
    },
    { upsert: true, new: true },
  );
  await TripBooking.updateOne(
    { _id: booking._id },
    { $set: { conversationPreparedAt: new Date() } },
  );

  const User = require("../models/User");
  const user = await User.findById(booking.userId).select("name phone");
  const formatDate = (date) =>
    new Date(date).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  const summaryText = `📋 New Booking!\n\n🎯 Package: ${booking.snapshot?.packageTitle || "Trip"}\n📅 Dates: ${formatDate(tripStart)} — ${formatDate(tripEnd)}\n👥 Travelers: ${booking.seats}\n🆔 Booking ID: ${booking.bookingId}\n👤 Name: ${user?.name || "User"}\n📱 Phone: ${user?.phone || "—"}\n\nChat is active until ${formatDate(expiresAt)}`;
  const Message = require("../models/Message");
  await Message.findOneAndUpdate(
    { effectKey: `booking-summary:${effectKey}` },
    {
      $setOnInsert: {
        conversationId: conversation._id,
        senderId: booking.userId,
        senderType: "user",
        senderName: "System",
        text: summaryText,
        effectKey: `booking-summary:${effectKey}`,
      },
    },
    { upsert: true, new: true },
  );

  booking = await TripBooking.findOneAndUpdate(
    { _id: booking._id, requiredEffectsVersion: 1 },
    {
      $set: {
        systemMessagePreparedAt: new Date(),
        requiredEffectsState: "COMPLETED",
        status: "CONFIRMED",
      },
    },
    { new: true },
  );
  if (!booking) throw new Error("Could not persist booking effect completion");
  return { booking, conversation };
}
exports.ensureRequiredBookingEffects = ensureRequiredBookingEffects;

function requireDeliverySuccess(result, channel) {
  if (!result) throw new Error(`${channel} confirmation delivery failed`);
  return result;
}
exports.requireDeliverySuccess = requireDeliverySuccess;

async function deliverBookingConfirmation(bookingOrId) {
  const bookingId = bookingOrId?._id || bookingOrId;
  const token = randomUUID();
  const now = new Date();
  const claimed = await TripBooking.findOneAndUpdate(
    {
      _id: bookingId,
      status: "CONFIRMED",
      requiredEffectsState: "COMPLETED",
      $or: [
        { confirmationDeliveryState: { $exists: false } },
        { confirmationDeliveryState: { $in: ["PENDING", "FAILED"] } },
        {
          confirmationDeliveryState: "PROCESSING",
          confirmationDeliveryLeaseUntil: { $lte: now },
        },
      ],
    },
    {
      $set: {
        confirmationDeliveryState: "PROCESSING",
        confirmationDeliveryToken: token,
        confirmationDeliveryLeaseUntil: new Date(now.getTime() + 5 * 60 * 1000),
        confirmationDeliveryError: "",
      },
      $inc: { confirmationDeliveryAttempts: 1 },
    },
    { new: true },
  );
  if (!claimed) {
    const current = await TripBooking.findById(bookingId).select(
      "confirmationDeliveryState confirmationSentAt",
    );
    return current?.confirmationDeliveryState === "COMPLETED";
  }

  const markChannel = async (field) => {
    const marked = await TripBooking.updateOne(
      {
        _id: claimed._id,
        confirmationDeliveryState: "PROCESSING",
        confirmationDeliveryToken: token,
      },
      { $set: { [field]: new Date() } },
    );
    if (marked.matchedCount !== 1)
      throw new Error("Confirmation delivery lease was lost");
    claimed[field] = new Date();
  };

  try {
    const User = require("../models/User");
    const Conversation = require("../models/Conversation");
    const [{ Operator }, user, pkg, conversation] = await Promise.all([
      Promise.resolve(require("../models/Operator")),
      User.findById(claimed.userId).select("name email phone"),
      Package.findById(claimed.packageId),
      Conversation.findOne({ bookingId: claimed._id }),
    ]);
    if (!pkg || !user || !conversation) {
      throw new Error("Confirmation delivery dependencies are incomplete");
    }
    const {
      notifyUserStrict,
      notifyOperatorStrict,
      notifyAdminStrict,
    } = require("./notificationController");

    if (!claimed.userConfirmationSentAt) {
      requireDeliverySuccess(
        await notifyUserStrict(
          claimed.userId,
          "Booking Confirmed! 🎉",
          `Your trip to ${pkg.title} is confirmed. ${claimed.seats} seat${claimed.seats > 1 ? "s" : ""} booked.`,
          {
            type: "booking_confirmed",
            bookingId: String(claimed._id),
            effectKey: `booking-confirmation:user:${claimed._id}:${claimed.userId}`,
          },
        ),
        "User notification",
      );
      await markChannel("userConfirmationSentAt");
    }
    if (!claimed.operatorConfirmationSentAt) {
      requireDeliverySuccess(
        await notifyOperatorStrict(
          claimed.operatorId,
          "New Booking! 🎊",
          `${user.name || "A user"} booked ${pkg.title} — ${claimed.seats} seat${claimed.seats > 1 ? "s" : ""}. ₹${Number(claimed.pricing?.operatorAmount || 0).toLocaleString("en-IN")} earning.`,
          {
            type: "new_booking",
            bookingId: String(claimed._id),
            effectKey: `booking-confirmation:operator:${claimed._id}:${claimed.operatorId}`,
          },
        ),
        "Operator notification",
      );
      await markChannel("operatorConfirmationSentAt");
    }
    if (!claimed.adminConfirmationSentAt) {
      requireDeliverySuccess(
        await notifyAdminStrict(
          "New Booking",
          `${user.name || "User"} booked ${pkg.title} — ₹${Number(claimed.pricing?.totalAmount || 0).toLocaleString("en-IN")}`,
          {
            type: "new_booking",
            bookingId: String(claimed._id),
            effectKey: `booking-confirmation:admin:${claimed._id}`,
          },
        ),
        "Admin notification",
      );
      await markChannel("adminConfirmationSentAt");
    }

    const fmtDate = (value) =>
      value
        ? new Date(value).toLocaleDateString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })
        : "-";
    if (!claimed.itineraryConfirmationSentAt) {
      const itineraryLines = (pkg.itinerary || [])
        .filter((day) => day.title)
        .map((day) => {
          const points = (day.points || [])
            .filter(Boolean)
            .map((point) => `  • ${point}`)
            .join("\n");
          return `Day ${day.day}: ${day.title}${points ? `\n${points}` : ""}`;
        })
        .join("\n\n");
      const itineraryText = [
        `📋 Your Itinerary — ${pkg.title}`,
        `📍 ${pkg.location || ""}`,
        `📅 ${fmtDate(claimed.snapshot?.startDate)} → ${fmtDate(claimed.snapshot?.endDate)}`,
        itineraryLines,
        pkg.inclusions?.length
          ? `✅ Inclusions: ${pkg.inclusions.filter(Boolean).join(", ")}`
          : "",
        pkg.exclusions?.length
          ? `❌ Exclusions: ${pkg.exclusions.filter(Boolean).join(", ")}`
          : "",
        "Your operator will share pickup details and transport info closer to the trip date.",
      ]
        .filter(Boolean)
        .join("\n\n");
      const Message = require("../models/Message");
      await Message.findOneAndUpdate(
        { effectKey: `booking-itinerary:${claimed._id}` },
        {
          $setOnInsert: {
            conversationId: conversation._id,
            senderId: claimed.operatorId,
            senderType: "operator",
            senderName: "Trip Reel",
            text: itineraryText,
            effectKey: `booking-itinerary:${claimed._id}`,
          },
        },
        { upsert: true, new: true },
      );
      await markChannel("itineraryConfirmationSentAt");
    }

    if (!claimed.emailConfirmationSentAt) {
      if (user.email) {
        const operator = await Operator.findById(claimed.operatorId).select(
          "businessName contactName phone",
        );
        const { sendBookingConfirmation } = require("../utils/sendMail");
        requireDeliverySuccess(
          await sendBookingConfirmation({
            to: user.email,
            userName: user.name || "Traveler",
            bookingDetails: {
              bookingId: claimed.bookingId,
              userName: user.name || "Traveler",
              packageName: pkg.title,
              packageLocation: pkg.location,
              batchDate: `${fmtDate(claimed.snapshot?.startDate)} - ${fmtDate(claimed.snapshot?.endDate)}`,
              seats: claimed.seats,
              totalAmount: claimed.pricing?.totalAmount,
              travelers: claimed.travelers || [],
              itinerary: pkg.itinerary || [],
              inclusions: pkg.inclusions || [],
              operatorName: operator?.businessName || operator?.contactName,
              operatorPhone: operator?.phone,
              paymentId: claimed.razorpayPaymentId || "",
              addonNames: claimed.addonNames || [],
              addonTotalPrice: claimed.addonTotalPrice || 0,
              addonDays: claimed.addonDays,
              itineraryDays: pkg.itinerary || [],
            },
          }),
          "Booking email",
        );
      }
      await markChannel("emailConfirmationSentAt");
    }

    const completedAt = new Date();
    const completed = await TripBooking.updateOne(
      {
        _id: claimed._id,
        confirmationDeliveryState: "PROCESSING",
        confirmationDeliveryToken: token,
      },
      {
        $set: {
          confirmationDeliveryState: "COMPLETED",
          confirmationDeliveryToken: "",
          confirmationDeliveryLeaseUntil: null,
          confirmationDeliveryError: "",
          confirmationSentAt: completedAt,
        },
      },
    );
    return completed.matchedCount === 1;
  } catch (error) {
    await TripBooking.updateOne(
      { _id: claimed._id, confirmationDeliveryToken: token },
      {
        $set: {
          confirmationDeliveryState: "FAILED",
          confirmationDeliveryToken: "",
          confirmationDeliveryLeaseUntil: null,
          confirmationDeliveryError: String(error.message || error).slice(
            0,
            500,
          ),
        },
      },
    ).catch(() => {});
    return false;
  }
}
exports.deliverBookingConfirmation = deliverBookingConfirmation;

// ── User ──────────────────────────────────────────────────────────────────────

// POST /api/trip-bookings  — user creates a booking
exports.createBooking = async (req, res) => {
  try {
    // ── SECURITY GATE ─────────────────────────────────────────────────────────
    // A booking may ONLY be minted by the payment-verification flow, which sets
    // req._paymentVerified after validating the Razorpay signature, amount, and
    // order ownership. A direct POST to /api/trip-bookings must never create a
    // free (unpaid) confirmed booking.
    if (!req._paymentVerified) {
      return res.status(402).json({
        success: false,
        message:
          "Payment required — bookings can only be created after payment verification.",
      });
    }

    const { packageId, batchId, seats = 1, bookingMode } = req.body;

    if (!["batch", "flexible"].includes(bookingMode)) {
      return res.status(400).json({
        success: false,
        message: "bookingMode must be exactly 'batch' or 'flexible'",
      });
    }

    const isFlexible = bookingMode === "flexible";
    const chargedQuote = req._chargedPricingSnapshot || null;
    if (!chargedQuote) {
      return res.status(409).json({
        success: false,
        message:
          "Authoritative charged pricing snapshot is required for booking finalization.",
      });
    }
    if (
      chargedQuote &&
      (String(chargedQuote.source?.packageId) !== String(packageId) ||
        chargedQuote.source?.bookingMode !== bookingMode ||
        Number(chargedQuote.source?.seats) !== Math.max(1, Number(seats) || 1))
    ) {
      return res.status(409).json({
        success: false,
        message: "Charged pricing snapshot does not match this booking",
      });
    }
    if (
      !packageId ||
      (!isFlexible && !batchId) ||
      (isFlexible && !req.body.flexAvailabilityId)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "packageId and the matching batch or flexible availability are required",
      });
    }

    // Validate package state and booking mode before any capacity mutation.
    const pkg = await Package.findById(packageId);
    if (!pkg || !pkg.isActive || pkg.status !== "APPROVED") {
      return res.status(404).json({
        success: false,
        message: "Package not found or not available",
      });
    }
    if (pkg.bookingMode !== bookingMode) {
      return res.status(400).json({
        success: false,
        message: `This package only supports ${pkg.bookingMode} bookings.`,
      });
    }

    const numSeats = Math.max(1, Number(seats) || 1);
    const hasSplit = req.body.adults != null;
    const numAdults = hasSplit
      ? Math.max(0, Number(req.body.adults) || 0)
      : numSeats;
    const numChildren = hasSplit
      ? Math.max(0, Number(req.body.children) || 0)
      : 0;

    let batch = null;
    let flexRecord = null;
    let flexInventory = null;
    let flexStartDateKey = null;
    const reservationOrderKey = String(
      req.body.razorpayOrderId ||
        req._paymentFinalization?.orderId ||
        req.body.paymentId ||
        "",
    );
    const flexReservationClaimKey = isFlexible ? reservationOrderKey : "";
    const batchReservationClaimKey = isFlexible ? "" : reservationOrderKey;
    let adultPrice, childPrice, operatorId;

    if (isFlexible) {
      // ── Flexible booking — validate flex availability ──────────────────────
      const FlexibleAvailability = require("../models/FlexibleAvailability");
      flexRecord = await FlexibleAvailability.findById(
        req.body.flexAvailabilityId,
      );
      if (!flexRecord || !flexRecord.isActive || flexRecord.isArchived) {
        return res.status(404).json({
          success: false,
          message: "Flexible availability not found or inactive",
        });
      }
      if (String(flexRecord.packageId) !== String(packageId)) {
        return res.status(400).json({
          success: false,
          message: "Flex record does not belong to this package",
        });
      }

      // ── Validate the chosen start date is in the future AND inside the
      // operator's available window. Without this a user could book a past date
      // or a date outside the range — breaking scheduling & refund slabs.
      flexStartDateKey = String(req.body.flexStartDate || "")
        .trim()
        .split("T")[0];
      const chosenStart = parseLocalDateStr(flexStartDateKey);
      if (!chosenStart || !parseDateKey(flexStartDateKey)) {
        return res.status(400).json({
          success: false,
          message: "Please select a valid start date.",
        });
      }
      if (!flexReservationClaimKey) {
        return res.status(409).json({
          success: false,
          message:
            "A stable payment order is required to reserve flexible inventory.",
        });
      }
      const winStartKey = storedDateKey(flexRecord.startDate);
      const winEndKey = storedDateKey(flexRecord.endDate);
      if (flexStartDateKey < getISTDateKey()) {
        return res.status(400).json({
          success: false,
          message: "The selected start date is in the past.",
        });
      }
      if (flexStartDateKey < winStartKey || flexStartDateKey > winEndKey) {
        return res.status(400).json({
          success: false,
          message: "The selected date is outside the available range.",
        });
      }

      adultPrice = flexRecord.adultPrice;
      childPrice = flexRecord.childPrice || 0;
      operatorId = flexRecord.operatorId;

      const capacityLease = await acquireFlexCapacityLease(flexRecord._id);
      try {
        flexRecord = capacityLease.item;
        flexInventory = await materializeDateInventory(
          flexRecord,
          flexStartDateKey,
          { syncCapacity: true },
        );

        const reserved = await FlexibleDateInventory.findOneAndUpdate(
          {
            _id: flexInventory._id,
            $or: [
              {
                reservationClaimKeys: flexReservationClaimKey,
                inventoryReleaseClaimKeys: { $ne: flexReservationClaimKey },
              },
              { capacity: 0 },
              {
                $expr: {
                  $lte: [
                    { $add: [{ $ifNull: ["$bookedSeats", 0] }, numSeats] },
                    "$capacity",
                  ],
                },
              },
            ],
          },
          [
            {
              $set: {
                bookedSeats: {
                  $cond: [
                    {
                      $and: [
                        {
                          $in: [
                            flexReservationClaimKey,
                            { $ifNull: ["$reservationClaimKeys", []] },
                          ],
                        },
                        {
                          $not: [
                            {
                              $in: [
                                flexReservationClaimKey,
                                { $ifNull: ["$inventoryReleaseClaimKeys", []] },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                    { $ifNull: ["$bookedSeats", 0] },
                    { $add: [{ $ifNull: ["$bookedSeats", 0] }, numSeats] },
                  ],
                },
                reservationClaimKeys: {
                  $setUnion: [
                    { $ifNull: ["$reservationClaimKeys", []] },
                    [flexReservationClaimKey],
                  ],
                },
                inventoryReleaseClaimKeys: {
                  $setDifference: [
                    { $ifNull: ["$inventoryReleaseClaimKeys", []] },
                    [flexReservationClaimKey],
                  ],
                },
              },
            },
          ],
          { new: true },
        );
        if (!reserved) {
          const current = await FlexibleDateInventory.findById(
            flexInventory._id,
          );
          const remaining =
            current?.capacity === 0
              ? null
              : Math.max(
                  0,
                  (current?.capacity || 0) - (current?.bookedSeats || 0),
                );
          return res.status(409).json({
            success: false,
            message:
              remaining > 0
                ? `Only ${remaining} seat${remaining === 1 ? "" : "s"} left for this start date.`
                : "This start date is fully booked.",
          });
        }
        flexInventory = reserved;

        await FlexibleAvailability.updateOne({ _id: flexRecord._id }, [
          {
            $set: {
              bookedSeats: {
                $cond: [
                  {
                    $and: [
                      {
                        $in: [
                          flexReservationClaimKey,
                          { $ifNull: ["$inventoryReservationClaimKeys", []] },
                        ],
                      },
                      {
                        $not: [
                          {
                            $in: [
                              flexReservationClaimKey,
                              { $ifNull: ["$inventoryReleaseClaimKeys", []] },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                  { $ifNull: ["$bookedSeats", 0] },
                  { $add: [{ $ifNull: ["$bookedSeats", 0] }, numSeats] },
                ],
              },
              inventoryReservationClaimKeys: {
                $setUnion: [
                  { $ifNull: ["$inventoryReservationClaimKeys", []] },
                  [flexReservationClaimKey],
                ],
              },
              inventoryReleaseClaimKeys: {
                $setDifference: [
                  { $ifNull: ["$inventoryReleaseClaimKeys", []] },
                  [flexReservationClaimKey],
                ],
              },
            },
          },
        ]);
      } finally {
        await releaseFlexCapacityLease(flexRecord._id, capacityLease.token);
      }
    } else {
      // ── Batch booking — existing flow ──────────────────────────────────────
      batch = await Batch.findById(batchId);
      if (!batch || !batch.isActive || batch.isArchived) {
        return res.status(404).json({
          success: false,
          message: "Batch not found or not available",
        });
      }
      const now = new Date();
      if (isDateKeyPastInclusiveEnd(batch.bookingDeadline, now)) {
        return res.status(400).json({
          success: false,
          message: "Booking deadline has passed for this batch",
        });
      }
      if (batch.startDate <= now) {
        return res
          .status(400)
          .json({ success: false, message: "This trip has already started" });
      }
      if (String(batch.packageId) !== String(packageId)) {
        return res.status(400).json({
          success: false,
          message: "Batch does not belong to this package",
        });
      }
      if (!batchReservationClaimKey) {
        return res.status(409).json({
          success: false,
          message:
            "A stable payment order is required to reserve batch inventory.",
        });
      }
      const seatReserved = await Batch.findOneAndUpdate(
        buildReservationClaimFilter({
          id: batchId,
          claimKey: batchReservationClaimKey,
          seats: numSeats,
        }),
        buildReservationClaimPipeline({
          claimKey: batchReservationClaimKey,
          seats: numSeats,
        }),
        { new: true },
      );
      if (!seatReserved) {
        return res.status(400).json({
          success: false,
          message:
            "Not enough seats available — someone else may have booked just now.",
        });
      }
      adultPrice = batch.adultPrice;
      childPrice = batch.childPrice || 0;
      operatorId = batch.operatorId;
    }

    // Paid finalization uses the immutable quote that produced the captured
    // provider amount. Live records above were consulted only for eligibility,
    // ownership, dates, and atomic capacity reservation.
    if (chargedQuote) {
      adultPrice = Number(chargedQuote.source?.adultPrice) || 0;
      childPrice = Number(chargedQuote.source?.childPrice) || 0;
      operatorId = chargedQuote.source?.operatorId || operatorId;
    }

    // Seats are now reserved (atomically). If ANY later step fails — before the
    // booking row exists — we MUST release them, otherwise payment was captured
    // but inventory stays locked (phantom sold-out).
    const releaseReservedSeats = async () => {
      try {
        if (isFlexible && flexInventory) {
          await FlexibleDateInventory.updateOne(
            {
              _id: flexInventory._id,
              reservationClaimKeys: flexReservationClaimKey,
              inventoryReleaseClaimKeys: { $ne: flexReservationClaimKey },
            },
            [
              {
                $set: {
                  bookedSeats: {
                    $max: [
                      0,
                      {
                        $subtract: [{ $ifNull: ["$bookedSeats", 0] }, numSeats],
                      },
                    ],
                  },
                  inventoryReleaseClaimKeys: {
                    $setUnion: [
                      { $ifNull: ["$inventoryReleaseClaimKeys", []] },
                      [flexReservationClaimKey],
                    ],
                  },
                },
              },
            ],
          );
          const FlexibleAvailability = require("../models/FlexibleAvailability");
          await FlexibleAvailability.updateOne(
            {
              _id: flexRecord._id,
              inventoryReservationClaimKeys: flexReservationClaimKey,
              inventoryReleaseClaimKeys: { $ne: flexReservationClaimKey },
            },
            [
              {
                $set: {
                  bookedSeats: {
                    $max: [
                      0,
                      {
                        $subtract: [{ $ifNull: ["$bookedSeats", 0] }, numSeats],
                      },
                    ],
                  },
                  inventoryReleaseClaimKeys: {
                    $setUnion: [
                      { $ifNull: ["$inventoryReleaseClaimKeys", []] },
                      [flexReservationClaimKey],
                    ],
                  },
                },
              },
            ],
          );
        } else if (batchId && batchReservationClaimKey) {
          await Batch.updateOne(
            buildReservationReleaseFilter({
              id: batchId,
              claimKey: batchReservationClaimKey,
            }),
            buildReservationReleasePipeline({
              claimKey: batchReservationClaimKey,
              seats: numSeats,
            }),
          );
        }
      } catch (e) {
        console.error("[createBooking] failed to release seats:", e.message);
      }
    };

    // Package state and booking mode were validated before reserving seats.

    // ── Get live platform settings ─────────────────────────────────────────
    const platformFeePercent = chargedQuote
      ? Number(chargedQuote.pricing?.platformFeePercent) || 0
      : ((await getSetting("platform_fee_percent")) ?? 10);
    const gstPercent = chargedQuote
      ? Number(chargedQuote.pricing?.gstPercent) || 0
      : ((await getSetting("gst_percent")) ?? 5);

    // ── Compute addon (Snapja) amounts — held by platform until dispatch ──────
    // One creator per booking. Each addon-day: base price (per service type) + per-day outside-city
    // surcharge (fallback to package default) + per-day extra charges.
    const photographerPrice = chargedQuote
      ? 0
      : ((await getSetting("photographer_base_price")) ?? 2000);
    const videographerPrice = chargedQuote
      ? 0
      : ((await getSetting("videographer_base_price")) ?? 2000);
    let addonSurcharge = chargedQuote
      ? Number(chargedQuote.addonSurcharge) || 0
      : 0; // operator's outside-city + extras portion
    let addonTotalPrice = chargedQuote
      ? Number(chargedQuote.addonTotalPrice) || 0
      : 0; // base + surcharge (full held amount)
    const addonServiceEntries = chargedQuote
      ? chargedQuote.addonServiceEntries || []
      : req.body.addonServiceEntries || [];
    const addonDaysData = chargedQuote
      ? chargedQuote.addonDays || null
      : req.body.addonDays || null;
    const resolvedAddonSchedule = chargedQuote
      ? chargedQuote.addonSchedule || null
      : req.body.addonSchedule || null;
    const resolvedAddonBookingTypes = chargedQuote
      ? chargedQuote.addonBookingTypes || {}
      : req.body.addonBookingTypes || {};
    const addonNames = chargedQuote
      ? Array.isArray(chargedQuote.addonNames)
        ? chargedQuote.addonNames
        : []
      : addonDaysData
        ? Object.keys(addonDaysData)
        : [];
    if (addonDaysData && !chargedQuote) {
      for (const addonName of addonNames) {
        const basePrice = pickAddonBasePrice(
          addonName,
          photographerPrice,
          videographerPrice,
        );
        const days = addonDaysData[addonName] || [];
        for (const dayIdx of days) {
          const dayInfo = pkg.itinerary[dayIdx];
          let surcharge = 0;
          if (dayInfo?.isOutsideCity) {
            surcharge =
              Number(dayInfo.outsideCityCharge) ||
              Number(pkg.outsideCityCharge) ||
              0;
            if (Array.isArray(dayInfo.extraCharges)) {
              for (const ec of dayInfo.extraCharges) {
                surcharge += Number(ec.amount) || 0;
              }
            }
          }
          addonSurcharge += surcharge;
          addonTotalPrice += basePrice + surcharge;
        }
      }
    }

    // ── Apply coupon (discount applies to fare only) ──────────────────────────
    const couponCode = (req.body.couponCode || "").trim().toUpperCase();
    let discountAmount = chargedQuote
      ? Number(chargedQuote.pricing?.discountAmount) || 0
      : 0;
    let appliedCouponId = chargedQuote?.operatorCouponId || null;
    const fareSubtotalRaw = Math.round(
      adultPrice * numAdults + (childPrice || 0) * numChildren,
    );

    if (couponCode && !chargedQuote) {
      const Coupon = require("../models/Coupon");
      const now = new Date();

      // Flexible coupons are keyed by packageId, batch coupons by batchId
      const couponMatch = isFlexible
        ? { packageId, batchId: null }
        : { batchId };
      // Atomic: only increment usedCount if coupon is still valid + within limit
      const coupon = await Coupon.findOneAndUpdate(
        {
          ...couponMatch,
          code: couponCode,
          isActive: true,
          validFrom: { $lte: now },
          validUntil: { $gte: now },
          $or: [
            { usageLimit: 0 }, // unlimited
            { $expr: { $lt: ["$usedCount", "$usageLimit"] } },
          ],
        },
        { $inc: { usedCount: 1 } },
        { new: true },
      );

      if (coupon) {
        const meetsGuests =
          coupon.minGuests === 0 || numSeats >= coupon.minGuests;
        const meetsOrder =
          coupon.minOrderAmount === 0 ||
          fareSubtotalRaw >= coupon.minOrderAmount;

        if (meetsGuests && meetsOrder) {
          if (coupon.type === "percentage") {
            discountAmount = Math.round((fareSubtotalRaw * coupon.value) / 100);
            if (coupon.maxDiscount > 0 && discountAmount > coupon.maxDiscount) {
              discountAmount = coupon.maxDiscount;
            }
          } else {
            discountAmount = Math.min(coupon.value, fareSubtotalRaw);
          }
          appliedCouponId = coupon._id;
        } else {
          // Conditions not met — roll back the increment
          await Coupon.updateOne(
            { _id: coupon._id },
            { $inc: { usedCount: -1 } },
          );
        }
      }
    }

    // ── Platform (admin) coupon — only if NO operator coupon was applied ──────
    const platformCouponCode = (req.body.platformCouponCode || "")
      .trim()
      .toUpperCase();
    let platformDiscountAmount = chargedQuote
      ? Number(chargedQuote.pricing?.platformDiscountAmount) || 0
      : 0;
    let appliedPlatformCouponId = chargedQuote?.platformCouponId || null;
    if (platformCouponCode && discountAmount === 0 && !chargedQuote) {
      const { resolvePlatformCoupon } = require("../utils/platformCoupon");
      const res = await resolvePlatformCoupon({
        code: platformCouponCode,
        userId: req.user._id,
        pkg,
        fareSubtotal: fareSubtotalRaw,
        numSeats,
      });
      if (res.ok && res.coupon) {
        // Atomically claim a usage slot (guards the global usageLimit under races)
        const PlatformCoupon = require("../models/PlatformCoupon");
        const claimed = await PlatformCoupon.findOneAndUpdate(
          {
            _id: res.coupon._id,
            $or: [
              { usageLimit: 0 },
              { $expr: { $lt: ["$usedCount", "$usageLimit"] } },
            ],
          },
          { $inc: { usedCount: 1 } },
          { new: true },
        );
        if (claimed) {
          platformDiscountAmount = res.discount;
          appliedPlatformCouponId = claimed._id;
        }
      }
    }

    // ── Calculate pricing (snapshotted forever) ────────────────────────────
    const pricing = chargedQuote
      ? { ...chargedQuote.pricing }
      : calcPricing({
          adultPrice,
          childPrice: childPrice || 0,
          adults: numAdults,
          children: numChildren,
          seats: numSeats,
          platformFeePercent,
          gstPercent,
          addonAmount: addonTotalPrice,
          addonSurcharge,
          discountAmount,
          platformDiscountAmount,
        });
    if (discountAmount > 0) pricing.couponCode = couponCode;
    if (platformDiscountAmount > 0)
      pricing.platformCouponCode = platformCouponCode;

    // ── Build snapshot ─────────────────────────────────────────────────────
    const snapshot = {
      packageTitle: pkg.title,
      packageLocation: pkg.location,
      packageImageUrl: pkg.image_url || "",
      batchLabel: batch ? batch.label || "" : "Flexible",
      startDate: isFlexible
        ? parseLocalDateStr(req.body.flexStartDate) || new Date()
        : batch.startDate,
      endDate: isFlexible
        ? dateKeyToISTStart(
            addDaysToDateKey(
              flexStartDateKey,
              Math.max(1, pkg.itinerary?.length || 5) - 1,
            ),
          )
        : batch.endDate,
      adultPrice,
    };

    // ── Create processing booking; required effects publish confirmation ─────
    // If create fails, payment was already captured — release the reserved seats
    // and return the consumed coupon slot so inventory isn't lost.
    let booking;
    try {
      // Fence booking publication with the same PendingOrder lease claimed by
      // verify/webhook/recovery. Extending immediately before the insert keeps a
      // stale worker from publishing after another worker starts compensation.
      if (req._paymentFinalization) {
        const PendingOrder = require("../models/PendingOrder");
        const fenced = await PendingOrder.findOneAndUpdate(
          {
            razorpayOrderId: req._paymentFinalization.orderId,
            finalizationState: "PROCESSING",
            finalizationLeaseToken: req._paymentFinalization.leaseToken,
            finalizationLeaseUntil: { $gt: new Date() },
          },
          {
            $set: {
              finalizationLeaseUntil: new Date(Date.now() + 10 * 60 * 1000),
            },
          },
          { new: true },
        );
        if (!fenced) throw new Error("Payment finalization lease was lost");
      }

      booking = await TripBooking.create({
        userId: req.user._id,
        packageId,
        batchId: isFlexible ? undefined : batchId,
        bookingMode: isFlexible ? "flexible" : "batch",
        flexStartDate: isFlexible
          ? parseLocalDateStr(req.body.flexStartDate)
          : undefined,
        flexEndDate: isFlexible ? snapshot.endDate : undefined,
        flexAvailabilityId: isFlexible
          ? req.body.flexAvailabilityId
          : undefined,
        flexInventoryId: isFlexible ? flexInventory?._id : undefined,
        flexStartDateKey: isFlexible ? flexStartDateKey : undefined,
        flexReservationClaimKey: isFlexible
          ? flexReservationClaimKey
          : undefined,
        batchReservationClaimKey: isFlexible
          ? undefined
          : batchReservationClaimKey,
        operatorId,
        seats: numSeats,
        // Versioned bookings remain processing-only until every required effect
        // is durable; ensureRequiredBookingEffects publishes CONFIRMED atomically.
        status: "PENDING",
        travelers: Array.isArray(req.body.travelers)
          ? req.body.travelers.slice(0, numSeats).map((t) => ({
              name: String(t.name || "").trim(),
              gender: String(t.gender || "").trim(),
              age: Number(t.age) || 0,
            }))
          : [],
        pricing,
        initialPricing: { ...pricing },
        initialPaymentAmount: Number(chargedQuote.totalAmount) || 0,
        snapshot,
        addonServiceEntries,
        addonEntryClaims: addonServiceEntries.map((entry) => entry.key),
        addonAppliedEntryKeys: addonServiceEntries.map((entry) => entry.key),
        addonDays: addonDaysData,
        addonSchedule: resolvedAddonSchedule,
        addonBookingTypes: resolvedAddonBookingTypes,
        addonSurcharge,
        addonNames,
        addonTotalPrice,
        addonHeld: addonTotalPrice > 0, // hold Snapja money until dispatch
        addonDispatched: false,
        razorpayPaymentId: req.body.paymentId || "",
        razorpayOrderId: req.body.razorpayOrderId || "",
        requiredEffectsVersion: 1,
        requiredEffectsState: "PENDING",
        operatorCouponId: appliedCouponId || undefined,
        platformCouponId: appliedPlatformCouponId || undefined,
      });
    } catch (createErr) {
      await releaseReservedSeats();
      if (appliedCouponId && !chargedQuote) {
        try {
          const Coupon = require("../models/Coupon");
          await Coupon.updateOne(
            { _id: appliedCouponId },
            { $inc: { usedCount: -1 } },
          );
        } catch {}
      }
      if (appliedPlatformCouponId && !chargedQuote) {
        try {
          const PlatformCoupon = require("../models/PlatformCoupon");
          await PlatformCoupon.updateOne(
            { _id: appliedPlatformCouponId, usedCount: { $gt: 0 } },
            { $inc: { usedCount: -1 } },
          );
        } catch {}
      }
      console.error(
        "[createBooking] booking create failed after payment:",
        createErr.message,
      );
      return res.status(500).json({
        success: false,
        message:
          "Payment was received but the booking could not be created. Our team has been notified — please contact support with your payment ID.",
      });
    }

    // PendingOrder may only become COMPLETED after these durable, replay-safe
    // effects finish. Aggregate-side claim keys make every retry idempotent.
    const requiredEffects = await ensureRequiredBookingEffects(booking);
    booking = requiredEffects.booking;
    const conversation = requiredEffects.conversation;

    const tripEnd = isFlexible
      ? new Date(snapshot.endDate)
      : new Date(batch.endDate);
    const tripStart = isFlexible
      ? new Date(snapshot.startDate)
      : new Date(batch.startDate);
    const expiresAt = new Date(tripEnd.getTime() + 2 * 24 * 60 * 60 * 1000);
    const startFmt = tripStart.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    const endFmt = tripEnd.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });

    // ── Double-email / notification guard ─────────────────────────────────────
    // The webhook/cron recovery can fire `createBooking` for the same payment if
    // the app's /verify also succeeded. `finalizeBookingFromOrder` prevents a
    // duplicate BOOKING (dedup on razorpayPaymentId), but if both paths succeed
    // on a tight race, the notifications below would fire twice. We stamp
    // `confirmationSentAt` atomically and skip if already set.
    await deliverBookingConfirmation(booking);
    // Delivery is owned by the replay-safe helper above. Keep the legacy block
    // disabled so recovery and initial creation cannot send a second copy.
    const stampedOk = null;
    // If stampedOk is null, another path already sent notifications — skip.
    if (!stampedOk) {
      console.log(
        `[createBooking] Notifications already sent for ${booking.bookingId} — skipping`,
      );
    } else {
      // Send push notification to user
      notifyUser(
        req.user._id,
        "Booking Confirmed! 🎉",
        `Your trip to ${pkg.title} is confirmed. ${booking.seats} seat${booking.seats > 1 ? "s" : ""} booked.`,
        { type: "booking_confirmed", bookingId: booking._id.toString() },
      );

      // Notify operator about new booking
      const { notifyOperator } = require("./notificationController");
      const { notifyAdmin } = require("./notificationController");
      notifyOperator(
        pkg.operatorId,
        "New Booking! 🎊",
        `${req.user.name || "A user"} booked ${pkg.title} — ${booking.seats} seat${booking.seats > 1 ? "s" : ""}. ₹${booking.pricing.operatorAmount.toLocaleString("en-IN")} earning.`,
        { type: "new_booking", bookingId: booking._id.toString() },
      );

      // ── Auto-send itinerary to traveller on confirmation ──────────────────
      // The base itinerary is always available from the package. The operator
      // can later send a richer document with transport/driver details from the
      // Booking Management page, but the traveller gets something useful NOW.
      try {
        if (pkg.itinerary?.length > 0) {
          const itineraryLines = pkg.itinerary
            .filter((d) => d.title)
            .map((d) => {
              let line = `Day ${d.day}: ${d.title}`;
              if (d.points?.length > 0) {
                line +=
                  "\n" +
                  d.points
                    .filter(Boolean)
                    .map((p) => `  • ${p}`)
                    .join("\n");
              }
              return line;
            })
            .join("\n\n");

          const itineraryMsg = [
            `📋 Your Itinerary — ${pkg.title}`,
            `📍 ${pkg.location || ""}`,
            `📅 ${startFmt} → ${endFmt}`,
            "",
            itineraryLines,
            "",
            pkg.inclusions?.length > 0
              ? "✅ Inclusions: " + pkg.inclusions.filter(Boolean).join(", ")
              : "",
            pkg.exclusions?.length > 0
              ? "❌ Exclusions: " + pkg.exclusions.filter(Boolean).join(", ")
              : "",
            "",
            "Your operator will share pickup details and transport info closer to the trip date.",
          ]
            .filter(Boolean)
            .join("\n");

          // Send via the existing chat conversation (already created above)
          const Message = require("../models/Message");
          await Message.create({
            conversationId: conversation._id,
            senderId: pkg.operatorId,
            senderType: "operator",
            senderName: "Trip Reel",
            text: itineraryMsg,
          });
        }
      } catch (itinErr) {
        // Non-blocking — booking is already confirmed regardless
        console.warn("Auto-itinerary send failed:", itinErr.message);
      }

      // Notify admin about new booking
      notifyAdmin(
        "New Booking",
        `${req.user.name || "User"} booked ${pkg.title} — ₹${booking.pricing.totalAmount.toLocaleString("en-IN")}`,
        { type: "new_booking", bookingId: booking._id.toString() },
      );

      // Send booking confirmation email
      try {
        const { sendBookingConfirmation } = require("../utils/sendMail");
        const { Operator } = require("../models/Operator");
        const operator = await Operator.findById(pkg.operatorId).select(
          "businessName contactName phone",
        );
        const fmtDate = (d) =>
          d
            ? new Date(d).toLocaleDateString("en-IN", {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })
            : "-";
        sendBookingConfirmation({
          to: req.user.email,
          userName: req.user.name || "Traveler",
          bookingDetails: {
            bookingId: booking.bookingId,
            userName: req.user.name || "Traveler",
            packageName: pkg.title,
            packageLocation: pkg.location,
            batchDate: batch
              ? `${fmtDate(batch.startDate)} - ${fmtDate(batch.endDate)}`
              : `${fmtDate(snapshot.startDate)} - ${fmtDate(snapshot.endDate)}`,
            seats: booking.seats,
            totalAmount: booking.pricing.totalAmount,
            travelers: req.body.travelers || booking.travelers || [],
            itinerary: pkg.itinerary || [],
            inclusions: pkg.inclusions || [],
            operatorName: operator?.businessName || operator?.contactName,
            operatorPhone: operator?.phone,
            paymentId: req.body.paymentId || "",
            addonNames: addonNames || [],
            addonTotalPrice: addonTotalPrice || 0,
            addonDays: addonDaysData,
            itineraryDays: pkg.itinerary || [],
          },
        });
      } catch (emailErr) {
        console.warn("Booking email failed:", emailErr.message);
      }

      // Mark any abandoned-booking reminder intent as converted (best-effort)
    } // end of notification guard (stampedOk)

    // Mark any abandoned-booking reminder intent as converted (best-effort)
    try {
      const { markIntentConverted } = require("./bookingIntentController");
      markIntentConverted(req.user._id, packageId);
    } catch {}
    // Mark any viewed-package re-engagement record as converted (best-effort)
    try {
      const { markViewConverted } = require("./packageViewController");
      markViewConverted(req.user._id, packageId);
    } catch {}

    // ── Audit log ─────────────────────────────────────────────────────────────
    try {
      const audit = require("../utils/audit");
      audit.log({
        action: "booking_created",
        actor: { id: req.user._id, type: "user", name: req.user.name },
        target: { type: "booking", id: booking._id, ref: booking.bookingId },
        details: {
          packageId,
          seats: numSeats,
          totalAmount: booking.pricing?.totalAmount,
          paymentId: req.body.paymentId,
        },
      });
    } catch {}

    res.status(201).json({ success: true, booking });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// GET /api/trip-bookings/my  — user's own bookings
exports.getMyBookings = async (req, res) => {
  try {
    const bookings = await TripBooking.find({ userId: req.user._id })
      .populate(
        "packageId",
        "title location image_url avgRating itinerary addons outsideCityCharge",
      )
      .populate(
        "batchId",
        "startDate endDate adultPrice totalSeats bookedSeats label",
      )
      .sort({ createdAt: -1 });

    res.json({ success: true, count: bookings.length, bookings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/trip-bookings/:id  — single booking (user sees own, admin sees all)
exports.getBookingById = async (req, res) => {
  try {
    const booking = await TripBooking.findById(req.params.id)
      .populate(
        "packageId",
        "title location image_url itinerary addons outsideCityCharge",
      )
      .populate("batchId")
      .populate("userId", "name email phone")
      .populate("operatorId", "businessName contactName email");

    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }

    if (
      req.user.role !== "admin" &&
      String(booking.userId?._id || booking.userId) !== String(req.user._id)
    ) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    res.json({ success: true, booking });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
// GET /api/trip-bookings  — admin: all bookings
exports.adminGetAllBookings = async (req, res) => {
  try {
    const {
      status,
      packageId,
      operatorId,
      batchId,
      search,
      fromDate,
      toDate,
      page = 1,
      limit = 20,
    } = req.query;

    const query = {};
    if (status && status !== "all") query.status = status;
    if (packageId) query.packageId = packageId;
    if (operatorId) query.operatorId = operatorId;
    if (batchId) query.batchId = batchId;
    if (search)
      query.bookingId = { $regex: escapeRegex(search), $options: "i" };
    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) query.createdAt.$gte = new Date(fromDate);
      if (toDate) {
        const end = new Date(toDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [bookings, total] = await Promise.all([
      TripBooking.find(query)
        .populate("userId", "name email phone")
        .populate("packageId", "title location")
        .populate("batchId", "startDate endDate label totalSeats bookedSeats")
        .populate("operatorId", "businessName contactName")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      TripBooking.countDocuments(query),
    ]);

    res.json({ success: true, total, page: Number(page), bookings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /api/trip-bookings/:id/status  — admin confirms or cancels
exports.updateBookingStatus = async (req, res) => {
  try {
    const { status, cancelReason } = req.body;
    const allowed = ["CONFIRMED", "CANCELLED", "COMPLETED"];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `status must be one of: ${allowed.join(", ")}`,
      });
    }

    const booking = await TripBooking.findById(req.params.id);
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }
    if (isBookingFinalizationPending(booking)) {
      return res.status(409).json({
        success: false,
        message:
          "Booking finalization is still processing; status changes are unavailable.",
      });
    }

    const prevStatus = booking.status;

    // Guard against invalid transitions
    if (prevStatus === "COMPLETED") {
      return res.status(400).json({
        success: false,
        message: "Completed bookings cannot be changed",
      });
    }
    if (
      prevStatus === "CANCELLED" &&
      booking.cancellationState === "COMPLETED"
    ) {
      return res.status(400).json({
        success: false,
        message: "Cancelled bookings cannot be changed",
      });
    }

    // ── Admin cancellation → 100% refund to user via shared helper ──────────
    if (status === "CANCELLED") {
      if (
        !["CONFIRMED", "PENDING", "CANCELLED"].includes(prevStatus) ||
        (prevStatus === "CANCELLED" &&
          booking.cancellationState === "COMPLETED")
      ) {
        return res.status(400).json({
          success: false,
          message: `Cannot cancel a ${prevStatus.toLowerCase()} booking`,
        });
      }
      if (prevStatus !== "CANCELLED") {
        const lifecycleConflict =
          await operatorCancellationLifecycleConflict(booking);
        if (lifecycleConflict) {
          return res.status(409).json({
            success: false,
            message: lifecycleConflict,
          });
        }
      }
      const summary = await processCancellationRefund(booking, {
        cancelledBy: "admin",
        reason: (cancelReason || "Cancelled by admin").trim(),
        fullRefund: true,
      });

      const snap = booking.snapshot || {};
      notifyUser(
        booking.userId,
        "Booking Cancelled by Trip Reel",
        `Your booking for ${snap.packageTitle || "trip"} was cancelled. ${summary.refundMessage}`,
        { type: "booking_cancelled", bookingId: booking._id.toString() },
      );
      const { notifyOperator } = require("./notificationController");
      notifyOperator(
        booking.operatorId,
        "Booking Cancelled by Admin",
        `Booking ${booking.bookingId} for ${snap.packageTitle || "your package"} was cancelled by admin.`,
        { type: "booking_cancelled", bookingId: booking._id.toString() },
      );

      const updated = await TripBooking.findById(booking._id)
        .populate("userId", "name email phone")
        .populate("packageId", "title location")
        .populate("batchId", "startDate endDate label");
      return res.json({ success: true, booking: updated, refund: summary });
    }

    booking.status = status;
    await booking.save();

    // ── Side effects ──────────────────────────────────────────────────────

    // CONFIRMED → increment bookedSeats + bookingCount (wallet released by cron after trip ends)
    if (status === "CONFIRMED" && prevStatus !== "CONFIRMED") {
      await Batch.findByIdAndUpdate(booking.batchId, {
        $inc: { bookedSeats: booking.seats },
      });
      await Package.findByIdAndUpdate(booking.packageId, {
        $inc: { bookingCount: booking.seats },
      });
      // No wallet credit here — funds released 2 days after trip endDate via cron
    }

    // Reload with populated fields
    const updated = await TripBooking.findById(booking._id)
      .populate("userId", "name email phone")
      .populate("packageId", "title location")
      .populate("batchId", "startDate endDate label");

    res.json({ success: true, booking: updated });
  } catch (err) {
    res
      .status(err.statusCode || 500)
      .json({ success: false, message: err.message });
  }
};

// ── Operator ──────────────────────────────────────────────────────────────────

function effectiveBookingStart(booking) {
  return (
    booking?.batchId?.startDate ||
    booking?.flexStartDate ||
    booking?.snapshot?.startDate ||
    null
  );
}

function effectiveBookingEnd(booking) {
  return (
    booking?.batchId?.endDate ||
    booking?.flexEndDate ||
    booking?.snapshot?.endDate ||
    null
  );
}

// Resolve cancellation dates without trusting stale client state. Booking
// snapshots remain the receipt date source; authoritative batch dates provide
// the fallback and lifecycle state for legacy snapshots with missing dates.
async function operatorCancellationLifecycleConflict(
  booking,
  now = new Date(),
) {
  const batchId = booking?.batchId?._id || booking?.batchId || null;
  const isFlexible =
    booking?.bookingMode === "flexible" ||
    Boolean(booking?.flexAvailabilityId || booking?.flexStartDate);
  let batch = null;

  if (batchId) {
    batch = await Batch.findById(batchId).select(
      "startDate endDate bookingDeadline isActive isCancelled isArchived totalSeats bookedSeats",
    );
    if (!batch) {
      return "Trip lifecycle could not be established because its batch is unavailable. Cancellation is blocked.";
    }
    const lifecycle = batchLifecycle(batch, now);
    if (isHistory("batch", lifecycle)) {
      return `This trip is in History (${lifecycle}) and is read-only. It cannot be cancelled.`;
    }
  } else if (!isFlexible) {
    return "Trip lifecycle could not be established because its batch reference is missing. Cancellation is blocked.";
  }

  const startDate = batchId
    ? batch?.startDate || booking?.snapshot?.startDate
    : booking?.flexStartDate || booking?.snapshot?.startDate;
  const endDate = batchId
    ? batch?.endDate || booking?.snapshot?.endDate
    : booking?.flexEndDate || booking?.snapshot?.endDate;

  if (!storedDateKey(startDate) || !storedDateKey(endDate)) {
    return "Trip lifecycle could not be established from authoritative dates. Cancellation is blocked.";
  }
  if (isDateKeyPastInclusiveEnd(endDate, now)) {
    return "This trip has ended and is in History. It cannot be cancelled.";
  }
  if (isDateKeyStarted(startDate, now)) {
    return "This trip has already started and is read-only. It cannot be cancelled.";
  }
  return null;
}

function bookingHistoryState(booking, now = new Date()) {
  if (["COMPLETED", "CANCELLED"].includes(booking.status)) return true;
  const end = effectiveBookingEnd(booking);
  // Missing authoritative end dates are unsafe for operational actions. Keep
  // malformed legacy bookings in read-only History until repaired.
  return !end || isDateKeyPastInclusiveEnd(end, now);
}

function serializeOperatorBooking(booking, now = new Date()) {
  const raw = booking?.toObject ? booking.toObject() : { ...booking };
  const history = bookingHistoryState(booking, now);
  return { ...raw, lifecycle: history ? "History" : "Current" };
}

function bookingDateTime(value, fallback) {
  const timestamp = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function compareBookingTieBreakers(a, b) {
  const createdDiff =
    bookingDateTime(b.createdAt, 0) - bookingDateTime(a.createdAt, 0);
  if (createdDiff !== 0) return createdDiff;
  return String(b._id || "").localeCompare(String(a._id || ""));
}

function sortOperatorBookings(bookings, view) {
  return [...bookings].sort((a, b) => {
    if (view === "current") {
      const aStart = bookingDateTime(
        effectiveBookingStart(a),
        Number.POSITIVE_INFINITY,
      );
      const bStart = bookingDateTime(
        effectiveBookingStart(b),
        Number.POSITIVE_INFINITY,
      );
      if (aStart !== bStart) return aStart < bStart ? -1 : 1;
    } else if (view === "history") {
      const aEnd = bookingDateTime(
        effectiveBookingEnd(a),
        Number.NEGATIVE_INFINITY,
      );
      const bEnd = bookingDateTime(
        effectiveBookingEnd(b),
        Number.NEGATIVE_INFINITY,
      );
      if (aEnd !== bEnd) return aEnd > bEnd ? -1 : 1;
    }
    return compareBookingTieBreakers(a, b);
  });
}

// GET /api/operator-bookings — lifecycle-aware operator booking list
exports.operatorGetMyBookings = async (req, res) => {
  try {
    const {
      status,
      packageId,
      batchId,
      bookingMode,
      search,
      fromDate,
      toDate,
    } = req.query;
    const { page, limit, skip } = getPagination(req.query, 20);
    const viewRaw = String(
      req.query.view || req.query.scope || "current",
    ).toLowerCase();
    const view = ["current", "history", "all"].includes(viewRaw)
      ? viewRaw
      : "current";
    const query = { operatorId: req.operator._id };
    if (status && status !== "all") query.status = status;
    if (packageId) query.packageId = packageId;
    if (batchId) query.batchId = batchId;
    if (bookingMode && bookingMode !== "all") query.bookingMode = bookingMode;
    const trimmedSearch = String(search || "").trim();
    if (trimmedSearch)
      query.bookingId = { $regex: escapeRegex(trimmedSearch), $options: "i" };
    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) {
        const range = getISTDayRange(fromDate);
        if (!range)
          return res
            .status(400)
            .json({ success: false, message: "fromDate must be YYYY-MM-DD" });
        query.createdAt.$gte = range.start;
      }
      if (toDate) {
        const range = getISTDayRange(toDate);
        if (!range)
          return res
            .status(400)
            .json({ success: false, message: "toDate must be YYYY-MM-DD" });
        query.createdAt.$lt = range.endExclusive;
      }
    }
    const docs = await TripBooking.find(query)
      .populate("userId", "name email phone")
      .populate("packageId", "title location image_url bookingMode")
      .populate("batchId", "startDate endDate label totalSeats bookedSeats")
      .populate(
        "flexAvailabilityId",
        "startDate endDate adultPrice childPrice maxBookings",
      )
      .populate("flexInventoryId", "startDateKey capacity bookedSeats");
    const now = new Date();
    const serialized = docs.map((booking) =>
      serializeOperatorBooking(booking, now),
    );
    const currentTotal = serialized.filter(
      (booking) => booking.lifecycle === "Current",
    ).length;
    const historyTotal = serialized.length - currentTotal;
    const filtered =
      view === "all"
        ? serialized
        : serialized.filter(
            (booking) => booking.lifecycle.toLowerCase() === view,
          );
    const selected = sortOperatorBookings(filtered, view);
    const bookings = selected.slice(skip, skip + limit);
    res.json({
      success: true,
      bookings,
      ...paginationMeta(selected.length, page, limit),
      currentTotal,
      historyTotal,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.operatorGetBookingById = async (req, res) => {
  try {
    const booking = await TripBooking.findOne({
      _id: req.params.id,
      operatorId: req.operator._id,
    })
      .populate("userId", "name email phone")
      .populate(
        "packageId",
        "title location image_url itinerary inclusions exclusions policies bookingMode",
      )
      .populate(
        "batchId",
        "startDate endDate bookingDeadline adultPrice childPrice totalSeats bookedSeats label",
      )
      .populate(
        "flexAvailabilityId",
        "startDate endDate adultPrice childPrice maxBookings isActive",
      )
      .populate(
        "flexInventoryId",
        "startDateKey startDate capacity bookedSeats",
      )
      .populate("operatorId", "businessName contactName email phone");
    if (!booking)
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    res.json({ success: true, booking: serializeOperatorBooking(booking) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Operator dashboard summary (server-side aggregation) ──────────────────────
// GET /api/operator-bookings/summary
// The dashboard used to reduce these numbers over a client-capped 200-booking
// list, so revenue/traveller/status counts were understated for busy operators.
// Aggregate across ALL bookings here instead.
exports.operatorBookingSummary = async (req, res) => {
  try {
    const operatorId = req.operator._id;
    const monthKey = `${getISTDateKey().slice(0, 7)}-01`;
    const monthStart = getISTDayRange(monthKey).start;

    const [
      byStatus,
      servedAgg,
      monthAgg,
      cancelledMonthAgg,
      packageBookingAgg,
      lifecycleDocs,
    ] = await Promise.all([
      TripBooking.aggregate([
        { $match: { operatorId } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      TripBooking.aggregate([
        {
          $match: { operatorId, status: { $in: ["CONFIRMED", "COMPLETED"] } },
        },
        {
          $group: {
            _id: null,
            seats: { $sum: { $ifNull: ["$pricing.seats", "$seats"] } },
          },
        },
      ]),
      TripBooking.aggregate([
        {
          $match: {
            operatorId,
            status: { $in: ["CONFIRMED", "COMPLETED"] },
            createdAt: { $gte: monthStart },
          },
        },
        {
          $group: {
            _id: null,
            revenue: { $sum: { $ifNull: ["$pricing.operatorAmount", 0] } },
          },
        },
      ]),
      TripBooking.aggregate([
        {
          $match: {
            operatorId,
            status: "CANCELLED",
            cancelledAt: { $gte: monthStart },
          },
        },
        {
          $group: {
            _id: null,
            revenue: {
              $sum: { $ifNull: ["$refundBreakdown.operatorRetained", 0] },
            },
          },
        },
      ]),
      TripBooking.aggregate([
        { $match: { operatorId, packageId: { $ne: null } } },
        {
          $group: {
            _id: "$packageId",
            tripBookingCount: { $sum: 1 },
          },
        },
        { $sort: { tripBookingCount: -1, _id: 1 } },
      ]),
      TripBooking.find({ operatorId })
        .select("status flexEndDate snapshot.endDate")
        .populate("batchId", "endDate"),
    ]);

    const statusCounts = byStatus.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {});
    const total = byStatus.reduce((sum, item) => sum + item.count, 0);
    const now = new Date();
    const currentTotal = lifecycleDocs.filter(
      (booking) => !bookingHistoryState(booking, now),
    ).length;
    const historyTotal = lifecycleDocs.length - currentTotal;
    const activeBookingRevenue = Number(monthAgg[0]?.revenue) || 0;
    const cancelledRetainedRevenue = Number(cancelledMonthAgg[0]?.revenue) || 0;
    const tripBookingsByPackage = packageBookingAgg.map((item) => ({
      packageId: String(item._id),
      tripBookingCount: Number(item.tripBookingCount) || 0,
    }));

    res.json({
      success: true,
      summary: {
        totalBookings: total,
        currentBookings: currentTotal,
        historyBookings: historyTotal,
        currentTotal,
        historyTotal,
        confirmedBookings: statusCounts.CONFIRMED || 0,
        completedBookings: statusCounts.COMPLETED || 0,
        cancelledBookings: statusCounts.CANCELLED || 0,
        pendingBookings: statusCounts.PENDING || 0,
        totalTravelers: Number(servedAgg[0]?.seats) || 0,
        activeBookingRevenue,
        monthRevenue: activeBookingRevenue + cancelledRetainedRevenue,
        cancelledRetainedRevenue,
        tripBookingsByPackage,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── User cancels their own booking ───────────────────────────────────────────
// POST /api/trip-bookings/:id/cancel
exports.cancelBooking = async (req, res) => {
  try {
    const { reason } = req.body;
    const booking = await TripBooking.findById(req.params.id);

    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }

    // Only the booking owner can cancel
    if (booking.userId.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized" });
    }

    // A cancelled but incomplete saga may be resumed by the owner.
    if (
      !["CONFIRMED", "PENDING", "CANCELLED"].includes(booking.status) ||
      (booking.status === "CANCELLED" &&
        booking.cancellationState === "COMPLETED")
    ) {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel a ${booking.status.toLowerCase()} booking`,
      });
    }

    // New cancellations must use authoritative batch/flexible dates. A claimed
    // CANCELLED saga remains resumable so recovery is not stranded mid-refund.
    if (booking.status !== "CANCELLED") {
      const lifecycleConflict =
        await operatorCancellationLifecycleConflict(booking);
      if (lifecycleConflict) {
        return res.status(409).json({
          success: false,
          message: lifecycleConflict,
        });
      }
    }

    // ── Process refund (slab-based) via shared helper ────────────────────────
    const summary = await processCancellationRefund(booking, {
      cancelledBy: "user",
      reason: reason || "Cancelled by user",
      fullRefund: false,
    });

    const snap = booking.snapshot || {};

    // Notify user
    notifyUser(
      booking.userId,
      "Booking Cancelled",
      summary.refundAmount > 0
        ? `Your booking for ${snap.packageTitle || "trip"} is cancelled. ${summary.refundMessage}`
        : `Your booking for ${snap.packageTitle || "trip"} has been cancelled. As per the cancellation policy, no refund is applicable.`,
      { type: "booking_cancelled", bookingId: booking._id.toString() },
    );

    // Notify operator
    const { notifyOperator } = require("./notificationController");
    notifyOperator(
      booking.operatorId,
      "Booking Cancelled",
      `A booking for ${snap.packageTitle || "your package"} (${booking.seats} seat${booking.seats > 1 ? "s" : ""}) was cancelled by the user.`,
      { type: "booking_cancelled", bookingId: booking._id.toString() },
    );

    // Notify admin (visibility — no approval needed)
    const { notifyAdmin } = require("./notificationController");
    notifyAdmin(
      "User Cancelled a Booking",
      `${snap.packageTitle || "Trip"} — Booking ${booking.bookingId} cancelled by user. Refund: ₹${summary.refundAmount.toLocaleString("en-IN")} (${summary.refundPercent}%).`,
      { type: "booking_cancelled", bookingId: booking._id.toString() },
    );

    // Cancellation email to user
    try {
      const { sendMail } = require("../utils/sendMail");
      const User = require("../models/User");
      const user = await User.findById(booking.userId).select("name email");
      if (user?.email) {
        sendMail({
          to: user.email,
          subject: `Booking Cancelled - ${snap.packageTitle || "Trip"}`,
          text: `Hi ${user.name}, your booking ${booking.bookingId} has been cancelled.${summary.refundAmount > 0 ? ` Refund amount: Rs.${summary.refundAmount} (${summary.refundPercent}%). ${summary.refundMessage}` : ""}`,
          html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;"><h2 style="color:#EF4444;">Booking Cancelled</h2><p>Hi <strong>${user.name}</strong>,</p><p>Your booking <strong>${booking.bookingId}</strong> for <strong>${snap.packageTitle || "trip"}</strong> has been cancelled.</p>${summary.refundAmount > 0 ? `<p style="background:#F0FDF4;padding:12px;border-radius:8px;color:#065F46;"><strong>Refund amount:</strong> Rs.${summary.refundAmount.toLocaleString("en-IN")} (${summary.refundPercent}%). ${summary.refundMessage}</p>` : ""}<p style="color:#6B7280;font-size:13px;">If you have questions, contact us via the app.</p><p>Team Trip Reel</p></div>`,
        });
      }
    } catch {}

    // ── Audit log ─────────────────────────────────────────────────────────────
    try {
      const audit = require("../utils/audit");
      audit.log({
        action: "booking_cancelled_user",
        actor: { id: req.user._id, type: "user", name: req.user.name },
        target: { type: "booking", id: booking._id, ref: booking.bookingId },
        details: {
          reason: reason || "Cancelled by user",
          refundAmount: summary.refundAmount,
          refundPercent: summary.refundPercent,
          refundStatus: summary.refundStatus,
        },
      });
    } catch {}

    res.json({
      success: true,
      message: `Booking cancelled. ${summary.refundMessage}`,
      refundMessage: summary.refundMessage,
      refundPercent: summary.refundPercent,
      refundAmount: summary.refundAmount,
      refundStatus: summary.refundStatus,
      breakdown: summary.breakdown,
      booking: summary.booking,
    });
  } catch (err) {
    res
      .status(err.statusCode || 500)
      .json({ success: false, message: err.message });
  }
};

// GET /api/trip-bookings/:id/refund-preview — preview refund before cancelling
exports.getRefundPreview = async (req, res) => {
  try {
    const booking = await TripBooking.findById(req.params.id);
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }

    if (booking.userId.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized" });
    }

    const startDate = booking.snapshot?.startDate;
    let daysBeforeTrip = 0;
    if (startDate) {
      // IST date-level comparison (midnight-to-midnight) to avoid TZ drift.
      const s = new Date(startDate);
      const startMid = new Date(s.getFullYear(), s.getMonth(), s.getDate());
      const now = new Date();
      const todayMid = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      );
      daysBeforeTrip = Math.round(
        (startMid.getTime() - todayMid.getTime()) / (1000 * 60 * 60 * 24),
      );
    }
    const refundPercent = await resolveRefundPercent(startDate);

    // Mirror the breakdown logic used in processCancellationRefund. New rows
    // keep the original charge separate from every top-up ledger.
    if (
      !booking.initialPricing &&
      (booking.addonTopupPaymentIds || []).length > 0
    ) {
      return res.status(409).json({
        success: false,
        code: "LEGACY_REFUND_RECONCILIATION_REQUIRED",
        message:
          "This legacy booking does not have safe per-payment top-up amounts. Support reconciliation is required.",
      });
    }
    const p = booking.initialPricing || booking.pricing || {};
    const fareSubtotal = Number(p.fareSubtotal) || 0;
    const discountAmount = Number(p.discountAmount) || 0;
    const platformDiscountAmount = Number(p.platformDiscountAmount) || 0;
    const netFare = Math.max(0, fareSubtotal - discountAmount);
    // The platform-funded discount was never paid by the user → not refundable.
    const userNetFare = Math.max(0, netFare - platformDiscountAmount);
    const gst = Number(p.gstAmount) || 0;
    const addon = Number(p.addonAmount) || 0;

    const fareRefund = Math.round((userNetFare * refundPercent) / 100);
    // Split GST: portion on fare vs portion on addons
    const gstOnFare =
      netFare > 0 ? Math.round((gst * netFare) / (netFare + addon)) : 0;
    const gstOnAddon = gst - gstOnFare;
    const gstFareRefund = Math.round((gstOnFare * refundPercent) / 100);
    // Addons always get full refund (+ their GST)
    const addonRefund = addon;
    const gstAddonRefund = addonRefund > 0 ? gstOnAddon : 0;
    const gstRefund = gstFareRefund + gstAddonRefund;
    let refundAmount = fareRefund + gstRefund + addonRefund;
    const AddonEntryRefund = require("../models/AddonEntryRefund");
    const priorInitial = await AddonEntryRefund.aggregate([
      {
        $match: {
          bookingId: booking._id,
          paymentSource: "INITIAL",
          status: { $in: ["REFUNDED", "PROCESSING"] },
          refundId: { $ne: "" },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    refundAmount = Math.max(
      0,
      refundAmount - Number(priorInitial[0]?.total || 0),
    );
    const AddonPurchase = require("../models/AddonPurchase");
    const purchases = await AddonPurchase.find({
      bookingId: booking._id,
      status: {
        $in: [
          "CAPTURED",
          "PROCESSING",
          "APPLIED",
          "REFUND_PROCESSING",
          "REFUNDED",
        ],
      },
    }).select("_id amountPaise");
    let topupRefundAmount = 0;
    for (const purchase of purchases) {
      const prior = await AddonEntryRefund.aggregate([
        {
          $match: {
            bookingId: booking._id,
            addonPurchaseId: purchase._id,
            status: { $in: ["REFUNDED", "PROCESSING"] },
            refundId: { $ne: "" },
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]);
      topupRefundAmount += Math.max(
        0,
        Number(purchase.amountPaise) / 100 - Number(prior[0]?.total || 0),
      );
    }
    refundAmount += topupRefundAmount;

    const totalPaid =
      (Number(booking.initialPaymentAmount) || Number(p.totalAmount) || 0) +
      purchases.reduce(
        (sum, purchase) => sum + Number(purchase.amountPaise) / 100,
        0,
      );
    const deducted = Math.max(0, totalPaid - refundAmount);

    res.json({
      success: true,
      daysBeforeTrip,
      refundPercent,
      refundAmount,
      totalPaid,
      deducted,
      hasAddon: addon > 0 || purchases.length > 0,
      topupRefundAmount,
      breakdown: {
        // what user paid, split
        netFare,
        gst,
        addon,
        // what comes back
        fareRefund,
        gstRefund,
        addonRefund,
        topupRefund: topupRefundAmount,
        // what is kept (non-refundable trip fare + its GST per the slab)
        fareKept: Math.max(0, userNetFare - fareRefund),
        gstKept: Math.max(0, gst - gstRefund),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Operator cancels a single booking ─────────────────────────────────────────
// POST /api/operator/bookings/:id/cancel  (operatorProtect)
exports.operatorCancelBooking = async (req, res) => {
  try {
    const reason = String(req.body?.reason || "").trim();
    if (!reason) {
      return res.status(400).json({
        success: false,
        message: "Cancellation reason is required.",
      });
    }
    const booking = await TripBooking.findById(req.params.id);
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }
    // Operator can only cancel bookings for their own packages
    if (String(booking.operatorId) !== String(req.operator._id)) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized" });
    }
    if (booking.status === "COMPLETED") {
      return res.status(409).json({
        success: false,
        message:
          "This booking is in History (Completed) and is read-only. It cannot be cancelled.",
      });
    }
    if (
      booking.status === "CANCELLED" &&
      booking.cancellationState === "COMPLETED"
    ) {
      return res.status(409).json({
        success: false,
        message:
          "This booking is in History (Cancelled) and is read-only. It cannot be cancelled again.",
      });
    }
    if (!["CONFIRMED", "PENDING", "CANCELLED"].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel a ${booking.status.toLowerCase()} booking`,
      });
    }
    // A claimed cancellation saga must remain resumable even after the trip
    // crosses its start date. New cancellations fail closed on lifecycle/date.
    if (booking.status !== "CANCELLED") {
      const lifecycleConflict =
        await operatorCancellationLifecycleConflict(booking);
      if (lifecycleConflict) {
        return res.status(409).json({
          success: false,
          message: lifecycleConflict,
        });
      }
    }

    const summary = await processCancellationRefund(booking, {
      cancelledBy: "operator",
      reason,
      fullRefund: true, // operator cancel → 100% refund to user
    });

    const snap = booking.snapshot || {};
    // Notify user (full refund)
    notifyUser(
      booking.userId,
      "Trip Cancelled by Operator",
      `Your booking for ${snap.packageTitle || "trip"} was cancelled by the operator. ${summary.refundMessage}`,
      { type: "booking_cancelled", bookingId: booking._id.toString() },
    );
    // Notify admin (visibility + who cancelled)
    const { notifyAdmin } = require("./notificationController");
    notifyAdmin(
      "Operator Cancelled a Booking",
      `Operator cancelled booking ${booking.bookingId} (${snap.packageTitle || "trip"}). Full refund ₹${summary.refundAmount.toLocaleString("en-IN")} to user. Reason: ${reason}`,
      { type: "booking_cancelled", bookingId: booking._id.toString() },
    );
    res.json({ success: true, refund: summary });
  } catch (err) {
    res
      .status(err.statusCode || 500)
      .json({ success: false, message: err.message });
  }
};

// ── Operator cancels an entire batch ──────────────────────────────────────────
// POST /api/operator/batches/:batchId/cancel  (operatorProtect)
exports.operatorCancelBatch = async (req, res) => {
  try {
    const requestedReason = String(req.body?.reason || "").trim();
    const { batchId } = req.params;

    const batch = await Batch.findById(batchId);
    if (!batch) {
      return res
        .status(404)
        .json({ success: false, message: "Batch not found" });
    }
    if (String(batch.operatorId) !== String(req.operator._id)) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized" });
    }

    const resumingCancelledBatch =
      batch.isCancelled === true && batch.isArchived !== true;
    const reason =
      requestedReason ||
      (resumingCancelledBatch
        ? String(batch.cancellationReason || "").trim()
        : "");
    if (!reason) {
      return res.status(400).json({
        success: false,
        message: "Cancellation reason is required.",
      });
    }

    const now = new Date();
    if (batch.isArchived) {
      return res.status(409).json({
        success: false,
        message:
          "This batch is in History (Archived) and is read-only. It cannot be cancelled.",
      });
    }
    // A batch already closed by this workflow may resume unfinished booking
    // cancellation effects. First-time cancellation always enforces dates.
    if (!resumingCancelledBatch) {
      if (!storedDateKey(batch.startDate) || !storedDateKey(batch.endDate)) {
        return res.status(409).json({
          success: false,
          message:
            "Batch lifecycle could not be established from authoritative dates. Cancellation is blocked.",
        });
      }
      const lifecycle = batchLifecycle(batch, now);
      if (isHistory("batch", lifecycle)) {
        return res.status(409).json({
          success: false,
          message: `This batch is in History (${lifecycle}) and is read-only. It cannot be cancelled.`,
        });
      }
      if (isDateKeyStarted(batch.startDate, now)) {
        return res.status(409).json({
          success: false,
          message:
            "This batch trip has already started and is read-only. It cannot be cancelled.",
        });
      }
    }

    const bookings = await TripBooking.find({
      batchId,
      $or: [
        { status: { $in: ["CONFIRMED", "PENDING"] } },
        {
          status: "CANCELLED",
          cancellationState: { $ne: "COMPLETED" },
        },
      ],
    });

    const { notifyAdmin } = require("./notificationController");

    // Deactivate the batch FIRST so no new booking can slip in while we refund.
    // (Previously this happened after the loop, leaving a window open.)
    batch.isActive = false;
    batch.isCancelled = true;
    batch.cancelledAt = batch.cancelledAt || new Date();
    batch.cancellationReason = String(
      reason || batch.cancellationReason || "Batch cancelled by operator",
    ).slice(0, 500);
    await batch.save();

    // Guard against a request that would time out mid-refund. Each cancellation
    // is a synchronous Razorpay call, so a very large batch can't be completed
    // inside one HTTP request — an admin has to handle those.
    if (bookings.length > MAX_BULK_CANCEL) {
      notifyAdmin(
        "Large Batch Cancellation Needs Admin Action",
        `Operator tried to cancel batch "${batch.label || batchId}" with ${bookings.length} live bookings — above the ${MAX_BULK_CANCEL} limit. The batch is now closed to new bookings; refunds must be processed by admin.`,
        { type: "booking_cancelled", batchId: String(batchId) },
      );
      return res.status(409).json({
        success: false,
        code: "BULK_CANCEL_TOO_LARGE",
        message: `This batch has ${bookings.length} active bookings, which is too many to refund in one go. We've closed it to new bookings and alerted our team, who will process the refunds and contact you.`,
      });
    }

    let cancelled = 0;
    let totalRefund = 0; // calculated refund liability, not settlement proof
    let settledCount = 0;
    let pendingCount = 0;
    let attentionCount = 0;
    const errors = [];

    for (const booking of bookings) {
      try {
        const summary = await processCancellationRefund(booking, {
          cancelledBy: "operator",
          reason: reason || "Batch cancelled by operator",
          fullRefund: true,
        });
        totalRefund += summary.refundAmount;
        cancelled++;
        if (summary.refundStatus === "REFUNDED") {
          settledCount++;
        } else if (
          summary.financialSettlementState === "RECONCILIATION_REQUIRED" ||
          ["FAILED", "MANUAL", "RECONCILIATION_REQUIRED"].includes(
            summary.refundStatus,
          )
        ) {
          attentionCount++;
          errors.push(
            `${booking.bookingId}: ${summary.refundStatus} — ${summary.refundMessage}`,
          );
        } else if (summary.refundStatus === "PROCESSING") {
          pendingCount++;
        } else if (summary.refundAmount > 0) {
          attentionCount++;
          errors.push(
            `${booking.bookingId}: ${summary.refundStatus} — ${summary.refundMessage}`,
          );
        }
        const snap = booking.snapshot || {};
        notifyUser(
          booking.userId,
          "Trip Cancelled by Operator",
          `Your booking for ${snap.packageTitle || "trip"} was cancelled by the operator. ${summary.refundMessage}`,
          { type: "booking_cancelled", bookingId: booking._id.toString() },
        );
      } catch (e) {
        errors.push(`${booking.bookingId}: ${e.message}`);
      }
    }

    notifyAdmin(
      errors.length > 0
        ? "Batch Cancellation Needs Refund Attention"
        : "Operator Cancelled an Entire Batch",
      `Operator cancelled batch "${batch.label || batchId}" — ${cancelled} local cancellation(s); ${settledCount} refund(s) processed, ${pendingCount} provider-pending, ${attentionCount} need attention. Calculated refund liability: ₹${totalRefund.toLocaleString("en-IN")}.${
        errors.length > 0 ? ` Details: ${errors.join("; ")}` : ""
      } Reason: ${reason || "—"}`,
      { type: "booking_cancelled", batchId: String(batchId) },
    );

    if (errors.length > 0) {
      return res.status(207).json({
        success: false,
        partial: true,
        cancelledCount: cancelled,
        settledCount,
        pendingCount,
        attentionCount,
        failedCount: errors.length,
        totalRefund,
        errors,
        message: `${cancelled} booking(s) were cancelled locally. ${settledCount} refund(s) are processed, ${pendingCount} remain provider-pending, and ${attentionCount} require manual attention.`,
      });
    }

    res.json({
      success: true,
      cancelledCount: cancelled,
      settledCount,
      pendingCount,
      attentionCount,
      totalRefund,
      errors,
      message: `${cancelled} booking(s) were cancelled locally. ${settledCount} refund(s) are processed and ${pendingCount} remain provider-pending.`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Admin: list cancellations / refunds (view-only log) ───────────────────────
// GET /api/trip-bookings/admin/refunds
exports.adminGetRefunds = async (req, res) => {
  try {
    const {
      refundStatus,
      search,
      cancelledBy,
      fromDate,
      toDate,
      page = 1,
      limit = 20,
    } = req.query;
    const query = { status: "CANCELLED" };
    if (refundStatus && refundStatus !== "all")
      query.refundStatus = refundStatus;
    if (cancelledBy && cancelledBy !== "all") query.cancelledBy = cancelledBy;
    if (search)
      query.bookingId = { $regex: escapeRegex(search), $options: "i" };
    if (fromDate || toDate) {
      query.cancelledAt = {};
      if (fromDate) query.cancelledAt.$gte = new Date(fromDate);
      if (toDate) {
        const end = new Date(toDate);
        end.setHours(23, 59, 59, 999);
        query.cancelledAt.$lte = end;
      }
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [bookings, total] = await Promise.all([
      TripBooking.find(query)
        .populate("userId", "name email phone")
        .populate("packageId", "title location")
        .populate("batchId", "startDate endDate label")
        .populate("operatorId", "businessName contactName")
        .sort({ cancelledAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      TripBooking.countDocuments(query),
    ]);

    res.json({ success: true, total, page: Number(page), bookings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Admin: retry a FAILED refund ──────────────────────────────────────────────
// POST /api/trip-bookings/admin/refunds/:id/retry
exports.adminRetryRefund = async (req, res) => {
  const retryToken = randomUUID();
  try {
    const existing = await TripBooking.findById(req.params.id);
    if (!existing) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }
    if (!["FAILED", "MANUAL"].includes(existing.refundStatus)) {
      return res.status(409).json({
        success: false,
        message: `Refund is '${existing.refundStatus}', nothing to retry`,
      });
    }
    if (!existing.razorpayPaymentId) {
      return res.status(400).json({
        success: false,
        message: "No Razorpay payment id — refund the user manually offline.",
      });
    }

    const maxRefundable =
      existing.pricing?.totalAmount || existing.refundAmount;
    const rawAmount = Number(req.body.amount) || existing.refundAmount;
    const amount = Math.min(rawAmount, maxRefundable);
    const booking = await TripBooking.findOneAndUpdate(
      {
        _id: existing._id,
        refundStatus: { $in: ["FAILED", "MANUAL"] },
      },
      {
        $set: {
          refundStatus: "PROCESSING",
          financialSettlementState: "PENDING",
          refundRetryToken: retryToken,
          refundRetryLeaseUntil: new Date(Date.now() + 5 * 60 * 1000),
          refundError: "Admin refund retry submitted",
        },
      },
      { new: true },
    );
    if (!booking) {
      return res.status(409).json({
        success: false,
        message: "Another refund action already claimed this booking.",
      });
    }

    const { refundPayment } = require("../utils/razorpayRefund");
    const result = await refundPayment(booking.razorpayPaymentId, amount, {
      bookingId: booking.bookingId,
      reason: "Admin retry",
    });

    const providerProcessed = result.success && result.status === "processed";
    const finalized = await TripBooking.updateOne(
      {
        _id: booking._id,
        refundStatus: "PROCESSING",
        refundRetryToken: retryToken,
      },
      {
        $set: result.success
          ? {
              refundId: result.refundId || "",
              refundAmount: amount,
              refundStatus: providerProcessed ? "REFUNDED" : "PROCESSING",
              financialSettlementState: providerProcessed
                ? "SETTLED"
                : "PENDING",
              refundError: providerProcessed
                ? ""
                : "Provider accepted the refund; settlement is still pending",
              refundedAt: providerProcessed ? new Date() : null,
              refundRetryToken: providerProcessed ? "" : retryToken,
              refundRetryLeaseUntil: providerProcessed
                ? null
                : new Date(Date.now() + 10 * 60 * 1000),
            }
          : {
              refundStatus: "FAILED",
              financialSettlementState: "RECONCILIATION_REQUIRED",
              refundError: result.error || "Refund failed",
              refundRetryToken: "",
              refundRetryLeaseUntil: null,
            },
      },
    );
    if (finalized.modifiedCount !== 1) {
      return res.status(409).json({
        success: false,
        message:
          "Refund provider response could not be fenced to this retry; reconciliation is required.",
      });
    }

    if (!result.success) {
      return res
        .status(400)
        .json({ success: false, message: result.error || "Refund failed" });
    }

    notifyUser(
      booking.userId,
      providerProcessed ? "Refund Completed" : "Refund Pending",
      providerProcessed
        ? `Your refund of ₹${amount.toLocaleString("en-IN")} for ${booking.snapshot?.packageTitle || "your trip"} was processed.`
        : `Your refund of ₹${amount.toLocaleString("en-IN")} for ${booking.snapshot?.packageTitle || "your trip"} was accepted and is still processing.`,
      { type: "booking_cancelled", bookingId: booking._id.toString() },
    );
    return res.json({
      success: true,
      refundStatus: providerProcessed ? "REFUNDED" : "PROCESSING",
      message: providerProcessed
        ? "Refund processed by the provider."
        : "Refund accepted by the provider and still pending.",
    });
  } catch (err) {
    await TripBooking.updateOne(
      { _id: req.params.id, refundRetryToken: retryToken },
      {
        $set: {
          refundStatus: "FAILED",
          financialSettlementState: "RECONCILIATION_REQUIRED",
          refundError: String(err.message || err).slice(0, 500),
          refundRetryToken: "",
          refundRetryLeaseUntil: null,
        },
      },
    ).catch(() => {});
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Admin: mark a MANUAL refund as done (offline) ─────────────────────────────
// POST /api/trip-bookings/admin/refunds/:id/mark-done
exports.adminMarkRefundDone = async (req, res) => {
  try {
    const booking = await TripBooking.findById(req.params.id);
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }

    // ── Guards ────────────────────────────────────────────────────────────────
    // This used to flip ANY booking to REFUNDED with no state check and no record
    // of which admin did it. "Paid offline" is a manual override, so it needs a
    // reason and must only apply where an automated refund actually failed.
    const note = (req.body.note || "").trim();
    if (!note) {
      return res.status(400).json({
        success: false,
        message:
          "Please add a note describing how this refund was paid (reference number, method, date).",
      });
    }

    if (booking.refundStatus === "REFUNDED") {
      return res.status(400).json({
        success: false,
        message: "This booking is already marked as refunded.",
      });
    }

    const markable = ["FAILED", "MANUAL", "RECONCILIATION_REQUIRED"];
    if (booking.refundStatus && !markable.includes(booking.refundStatus)) {
      return res.status(400).json({
        success: false,
        message: `Cannot mark a refund as done from state "${booking.refundStatus}".`,
      });
    }

    if (booking.status !== "CANCELLED") {
      return res.status(400).json({
        success: false,
        message:
          "Only a cancelled booking can have its refund marked as completed.",
      });
    }

    const marked = await TripBooking.findOneAndUpdate(
      {
        _id: booking._id,
        status: "CANCELLED",
        refundStatus: {
          $in: ["FAILED", "MANUAL", "RECONCILIATION_REQUIRED"],
        },
      },
      {
        $set: {
          refundStatus: "REFUNDED",
          financialSettlementState: "SETTLED",
          refundedAt: new Date(),
          refundError: "",
          refundMarkedManually: true,
          refundMarkedBy: req.user._id,
          refundNote: note,
          cancelReason:
            `${booking.cancelReason || ""} | Manual refund by admin: ${note}`.trim(),
        },
      },
      { new: true },
    );
    if (!marked) {
      return res.status(409).json({
        success: false,
        message:
          "Refund state changed or is still processing; verify provider status before marking an offline settlement.",
      });
    }

    console.log(
      `[adminMarkRefundDone] booking=${marked.bookingId} amount=${marked.refundAmount} admin=${req.user._id} note="${note}"`,
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Sync Snapja addon status for a single booking ─────────────────────────────
// GET /api/trip-bookings/:id/sync-snapja
exports.syncSnapjaStatus = async (req, res) => {
  try {
    const booking = await TripBooking.findById(req.params.id);
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }

    // Ownership check — this route only had `protect`, so any logged-in user
    // could sync and read add-on data for arbitrary bookings.
    const isOwner = String(booking.userId) === String(req.user._id);
    const isAdmin = req.user.role === "admin";
    if (!isOwner && !isAdmin) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized" });
    }

    const hasSnapjaEntries = Object.values(booking.snapjaBookings || {}).some(
      (entry) => entry?.bookingId,
    );
    if (!hasSnapjaEntries) {
      return res.json({
        success: true,
        updated: false,
        snapjaBookings: booking.snapjaBookings || {},
      });
    }

    const SNAPJA_API = "https://api.snapja.com/api/tripreel/bookings";
    const SNAPJA_API_KEY = process.env.SNAPJA_API_KEY;

    let updated = false;
    const snapjaBookings = { ...booking.snapjaBookings };

    for (const [key, snap] of Object.entries(snapjaBookings)) {
      if (!snap.bookingId) continue;
      try {
        const snapRes = await fetch(`${SNAPJA_API}/${snap.bookingId}`, {
          headers: { "X-API-Key": SNAPJA_API_KEY },
        });
        if (!snapRes.ok) continue;
        const data = await snapRes.json();
        const b = data.booking;
        if (!b) continue;

        // Update status
        if (b.status && b.status !== snap.status) {
          snapjaBookings[key].status = b.status;
          updated = true;

          // Definitive remote failure: execute an idempotent partial refund
          // against the frozen payment source before telling the customer.
          const failStatuses = ["no_creator_available", "cancelled", "expired"];
          if (failStatuses.includes(String(b.status).toLowerCase())) {
            const refund =
              await require("../utils/addonEntryRefund").processAddonEntryRefund(
                {
                  booking,
                  entryKey: key,
                  reason: String(b.status),
                  providerStatus: String(b.status),
                },
              );
            snapjaBookings[key].refundFlagged = true;
            snapjaBookings[key].refundReason = b.status;
            snapjaBookings[key].refundState = refund.refunded
              ? "REFUNDED"
              : refund.pending
                ? "PROCESSING"
                : "RECONCILIATION_REQUIRED";
            snapjaBookings[key].refundAmount = refund.amount || 0;
            snapjaBookings[key].refundId = refund.refundId || "";
            if (refund.refunded || refund.pending) {
              try {
                require("./notificationController").notifyUser(
                  booking.userId,
                  refund.refunded
                    ? "Add-on Refund Processed"
                    : "Add-on Refund Started",
                  refund.refunded
                    ? "The payment provider processed your add-on refund."
                    : "The payment provider accepted your add-on refund request.",
                  { type: "general", bookingId: booking._id.toString() },
                );
              } catch {}
            }
          }
        }
        // Update creator info if assigned (always sync latest)
        if (b.creator) {
          const newName = b.creator.name || b.creator.display_name || "";
          const newPhone = b.creator.phone || "";
          const newPhoto =
            b.creator.picture ||
            b.creator.profile_image ||
            b.creator.avatar ||
            "";
          if (
            newName !== (snap.creatorName || "") ||
            newPhone !== (snap.creatorPhone || "") ||
            newPhoto !== (snap.creatorPhoto || "")
          ) {
            snapjaBookings[key].creatorName = newName;
            snapjaBookings[key].creatorPhone = newPhone;
            snapjaBookings[key].creatorPhoto = newPhoto;
            updated = true;
          }
        }
        // Update OTP if refreshed
        if (b.otp && b.otp !== snap.otp) {
          snapjaBookings[key].otp = b.otp;
          if (b.otp_expires_at)
            snapjaBookings[key].otpExpiresAt = b.otp_expires_at;
          updated = true;
        }
        // Sync live status (confirmed → in_progress → completed). Once the
        // shoot is completed the app stops showing OTP + Call.
        if (b.status) {
          const liveStatus = String(b.status).toLowerCase();
          if (liveStatus !== String(snap.status || "").toLowerCase()) {
            snapjaBookings[key].status = liveStatus;
            updated = true;
          }
          const doneStatuses = ["completed", "delivered", "done", "finished"];
          if (doneStatuses.includes(liveStatus) && !snap.completedAt) {
            snapjaBookings[key].completedAt = new Date().toISOString();
            updated = true;
          }
        }
        // Pull deliverables (photos/videos)
        if (
          b.deliverables &&
          Array.isArray(b.deliverables) &&
          b.deliverables.length > 0
        ) {
          const existingCount = (snap.deliverables || []).length;
          if (b.deliverables.length > existingCount) {
            snapjaBookings[key].deliverables = b.deliverables;
            snapjaBookings[key].deliveredAt =
              snapjaBookings[key].deliveredAt || new Date().toISOString();
            updated = true;
          }
        }
      } catch {}
    }

    if (updated) {
      booking.snapjaBookings = snapjaBookings;
      booking.markModified("snapjaBookings");
      await booking.save();
    }

    res.json({ success: true, updated, snapjaBookings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Confirm one Snapja add-on delivery for the owning TripReel customer ──────
// POST /api/trip-bookings/:id/snapja/:entryKey/confirm-delivery
exports.confirmSnapjaDelivery = async (req, res) => {
  try {
    const booking = await TripBooking.findById(req.params.id);
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }
    if (String(booking.userId) !== String(req.user._id)) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized" });
    }

    const entryKey = req.params.entryKey;
    const snapjaBookings = { ...(booking.snapjaBookings || {}) };
    const snap = snapjaBookings[entryKey];
    if (!snap?.bookingId) {
      return res.status(404).json({
        success: false,
        message: "Snapja add-on booking was not found",
      });
    }
    if (snap.customerConfirmed) {
      return res.json({
        success: true,
        duplicate: true,
        entryKey,
        snapjaBooking: snap,
        message: "Delivery was already confirmed",
      });
    }

    const snapjaApi =
      process.env.SNAPJA_API_URL ||
      "https://api.snapja.com/api/tripreel/bookings";
    const liveResponse = await fetch(
      `${snapjaApi}/${encodeURIComponent(snap.bookingId)}`,
      { headers: { "X-API-Key": process.env.SNAPJA_API_KEY } },
    );
    const liveData = await liveResponse.json().catch(() => ({}));
    if (!liveResponse.ok || !liveData.booking) {
      return res.status(502).json({
        success: false,
        message: "Could not verify the latest Snapja delivery status",
      });
    }

    const liveBooking = liveData.booking;
    const liveStatus = String(liveBooking.status || "").toLowerCase();
    const liveDeliverables = Array.isArray(liveBooking.deliverables)
      ? liveBooking.deliverables
      : [];
    const confirmableStatuses = ["completed", "delivered", "done", "finished"];
    if (!confirmableStatuses.includes(liveStatus)) {
      return res.status(409).json({
        success: false,
        message: "The creator has not completed this add-on yet",
      });
    }
    if (liveDeliverables.length === 0) {
      return res.status(409).json({
        success: false,
        message: "No deliverables are available to confirm yet",
      });
    }
    const snapjaRes = await fetch(
      `${snapjaApi}/${encodeURIComponent(snap.bookingId)}/confirm-delivery`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": process.env.SNAPJA_API_KEY,
        },
        body: JSON.stringify({ source: "tripreel" }),
      },
    );
    const snapjaData = await snapjaRes.json().catch(() => ({}));
    if (!snapjaRes.ok || snapjaData.success === false) {
      const unavailable = snapjaRes.status === 404;
      return res.status(502).json({
        success: false,
        code: unavailable
          ? "SNAPJA_CONFIRMATION_ENDPOINT_UNAVAILABLE"
          : "SNAPJA_CONFIRMATION_FAILED",
        message: unavailable
          ? "Snapja delivery confirmation is not available on the connected API."
          : snapjaData.message || "Snapja could not confirm delivery",
      });
    }

    const now = new Date().toISOString();
    snapjaBookings[entryKey] = {
      ...snap,
      deliverables: liveDeliverables,
      status: snapjaData.booking?.status || "delivered",
      customerConfirmed: true,
      customerConfirmedAt: now,
    };
    booking.snapjaBookings = snapjaBookings;
    booking.markModified("snapjaBookings");
    await booking.save();

    return res.json({
      success: true,
      entryKey,
      snapjaBooking: snapjaBookings[entryKey],
      message: "Delivery confirmed successfully",
    });
  } catch (err) {
    console.error("[confirmSnapjaDelivery] Error:", err.message);
    return res.status(500).json({
      success: false,
      message: err.message || "Could not confirm delivery",
    });
  }
};
