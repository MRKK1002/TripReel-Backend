// ─────────────────────────────────────────────────────────────────────────────
// Platform (admin) coupon resolution — shared by pricing preview and booking.
//
// Returns { ok, discount, coupon, reason }.
//   ok:false + reason  → not applicable (invalid / expired / scope mismatch)
//   ok:true            → discount (₹, on fare only) and the coupon document
//
// The discount is ALWAYS computed on the fare subtotal (never addons/GST) and is
// absorbed by the platform — the operator's earnings are never reduced.
// ─────────────────────────────────────────────────────────────────────────────
const PlatformCoupon = require("../models/PlatformCoupon");

/**
 * @param {object} opts
 *   code           - the coupon code the user entered
 *   userId         - the booking user's id (for first-booking + per-user limit)
 *   pkg            - the Package document (category/categories, state, city, operatorId)
 *   fareSubtotal   - fare-only subtotal (pre-addon, pre-GST) the discount applies to
 *   numSeats       - total travellers
 */
async function resolvePlatformCoupon({
  code,
  userId,
  pkg,
  fareSubtotal,
  numSeats,
}) {
  const normalized = (code || "").trim().toUpperCase();
  if (!normalized) return { ok: false, reason: "No code" };

  const now = new Date();
  const coupon = await PlatformCoupon.findOne({
    code: normalized,
    isActive: true,
    isArchived: { $ne: true },
    validFrom: { $lte: now },
    validUntil: { $gte: now },
  });
  if (!coupon) return { ok: false, reason: "Invalid or expired coupon code." };

  // ── Global usage limit ─────────────────────────────────────────────────────
  if (coupon.usageLimit > 0 && coupon.usedCount >= coupon.usageLimit) {
    return { ok: false, reason: "This coupon has reached its usage limit." };
  }

  // ── Minimums ────────────────────────────────────────────────────────────────
  if (coupon.minGuests > 0 && numSeats < coupon.minGuests) {
    return {
      ok: false,
      reason: `Requires at least ${coupon.minGuests} travellers.`,
    };
  }
  if (coupon.minOrderAmount > 0 && fareSubtotal < coupon.minOrderAmount) {
    return {
      ok: false,
      reason: `Minimum order of ₹${coupon.minOrderAmount.toLocaleString("en-IN")} required.`,
    };
  }

  // ── Scope / targeting ────────────────────────────────────────────────────────
  if (coupon.appliesTo === "category") {
    const pkgCats = [
      pkg?.category,
      ...(Array.isArray(pkg?.categories) ? pkg.categories : []),
    ]
      .filter(Boolean)
      .map((c) => String(c).toLowerCase());
    const wanted = (coupon.categories || []).map((c) =>
      String(c).toLowerCase(),
    );
    if (!wanted.some((c) => pkgCats.includes(c))) {
      return { ok: false, reason: "Not valid for this trip category." };
    }
  } else if (coupon.appliesTo === "destination") {
    const pkgState = String(pkg?.state || "").toLowerCase();
    const pkgCity = String(pkg?.city || "").toLowerCase();
    const wantStates = (coupon.states || []).map((s) => s.toLowerCase());
    const wantCities = (coupon.cities || []).map((c) => c.toLowerCase());
    const stateOk = wantStates.length > 0 && wantStates.includes(pkgState);
    const cityOk = wantCities.length > 0 && wantCities.includes(pkgCity);
    if (!stateOk && !cityOk) {
      return { ok: false, reason: "Not valid for this destination." };
    }
  } else if (coupon.appliesTo === "package") {
    const ids = (coupon.packageIds || []).map((id) => String(id));
    if (!ids.includes(String(pkg?._id))) {
      return { ok: false, reason: "Not valid for this package." };
    }
  } else if (coupon.appliesTo === "operator") {
    const ids = (coupon.operatorIds || []).map((id) => String(id));
    if (!ids.includes(String(pkg?.operatorId))) {
      return { ok: false, reason: "Not valid for this operator." };
    }
  }
  // appliesTo === "all" → no scope restriction

  // ── First-booking-only ───────────────────────────────────────────────────────
  if (coupon.firstBookingOnly && userId) {
    const TripBooking = require("../models/TripBooking");
    const prior = await TripBooking.countDocuments({
      userId,
      status: { $in: ["CONFIRMED", "COMPLETED"] },
    });
    if (prior > 0) {
      return {
        ok: false,
        reason: "This offer is only for your first booking.",
      };
    }
  }

  // ── Per-user limit ────────────────────────────────────────────────────────────
  if (coupon.perUserLimit > 0 && userId) {
    const TripBooking = require("../models/TripBooking");
    const usedByUser = await TripBooking.countDocuments({
      userId,
      "pricing.platformCouponCode": normalized,
      status: { $in: ["CONFIRMED", "COMPLETED", "PENDING"] },
    });
    if (usedByUser >= coupon.perUserLimit) {
      return {
        ok: false,
        reason: "You've already used this coupon.",
      };
    }
  }

  // ── Compute discount on fare only ─────────────────────────────────────────────
  let discount = 0;
  if (coupon.type === "percentage") {
    discount = Math.round((fareSubtotal * coupon.value) / 100);
    if (coupon.maxDiscount > 0 && discount > coupon.maxDiscount) {
      discount = coupon.maxDiscount;
    }
  } else {
    discount = Math.min(coupon.value, fareSubtotal);
  }
  discount = Math.max(0, Math.min(discount, fareSubtotal));

  return { ok: true, discount, coupon };
}

module.exports = { resolvePlatformCoupon };
