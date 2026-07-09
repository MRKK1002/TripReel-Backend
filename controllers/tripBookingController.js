const TripBooking = require("../models/TripBooking");
const Batch = require("../models/Batch");
const Package = require("../models/Package");
const OperatorWallet = require("../models/OperatorWallet");
const WalletTransaction = require("../models/WalletTransaction");
const { notifyUser } = require("./notificationController");
const { getSetting } = require("./platformSettingsController");
const escapeRegex = require("../utils/escapeRegex");

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
  discountAmount = 0,
}) {
  // Backward compatible: if an explicit adults count isn't given, treat every
  // seat as an adult (legacy behaviour). Otherwise price adults + children.
  const numAdults = adults != null ? Number(adults) : Number(seats) || 0;
  const numChildren = adults != null ? Number(children) || 0 : 0;
  const totalSeats = numAdults + numChildren;

  const fareSubtotal = Math.round(
    adultPrice * numAdults + (childPrice || 0) * numChildren,
  );
  const netFare = Math.max(0, fareSubtotal - discountAmount); // discount applies to fare only
  const subtotal = fareSubtotal + addonAmount;
  // GST charged on (discounted fare + addon)
  const gstAmount = Math.round(((netFare + addonAmount) * gstPercent) / 100);
  // Platform fee is taken on the operator's fare only (not GST, not Snapja base)
  const platformFeeAmount = Math.round((netFare * platformFeePercent) / 100);
  const totalAmount = netFare + addonAmount + gstAmount;
  // Operator earns: net fare minus platform fee, plus their outside-city surcharge.
  // (The ₹2000/day Snapja base and the GST are NOT operator earnings.)
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
  seats,
  adults,
  children,
  couponCode,
  addonDays,
}) {
  const numSeats = Math.max(1, Number(seats) || 1);
  const pkg = await Package.findById(packageId);
  if (!pkg) throw new Error("Package not found");

  let adultPrice, childPrice;

  if (bookingMode === "flexible") {
    // Flexible booking — get pricing from FlexibleAvailability record
    const FlexibleAvailability = require("../models/FlexibleAvailability");
    const flex = await FlexibleAvailability.findById(flexAvailabilityId);
    if (!flex || !flex.isActive)
      throw new Error("Flexible availability not found or inactive");
    if (String(flex.packageId) !== String(packageId))
      throw new Error("Flexible availability does not belong to this package");
    adultPrice = flex.adultPrice;
    childPrice = flex.childPrice || 0;
  } else {
    // Batch booking — existing flow
    const batch = await Batch.findById(batchId);
    if (!batch || !batch.isActive)
      throw new Error("Batch not found or inactive");
    if (String(batch.packageId) !== String(packageId))
      throw new Error("Batch does not belong to this package");
    adultPrice = batch.adultPrice;
    childPrice = batch.childPrice || 0;
  }

  // Resolve adult / child split (backward compatible — default all to adults)
  const numAdults = adults != null ? Math.max(0, Number(adults)) : numSeats;
  const numChildren = adults != null ? Math.max(0, Number(children) || 0) : 0;

  const platformFeePercent = (await getSetting("platform_fee_percent")) ?? 10;
  const gstPercent = (await getSetting("gst_percent")) ?? 5;

  // Addons
  const ADDON_BASE_PRICE = 2000;
  let addonSurcharge = 0;
  let addonTotalPrice = 0;
  if (addonDays) {
    for (const name of Object.keys(addonDays)) {
      for (const dayIdx of addonDays[name] || []) {
        const dayInfo = pkg.itinerary[dayIdx];
        const sc = dayInfo?.isOutsideCity ? pkg.outsideCityCharge || 0 : 0;
        addonSurcharge += sc;
        addonTotalPrice += ADDON_BASE_PRICE + sc;
      }
    }
  }

  // Coupon (read-only — no usage increment here)
  const code = (couponCode || "").trim().toUpperCase();
  let discountAmount = 0;
  const fareSubtotalRaw = Math.round(
    adultPrice * numAdults + (childPrice || 0) * numChildren,
  );
  if (code) {
    const Coupon = require("../models/Coupon");
    const now = new Date();
    const coupon = await Coupon.findOne({
      batchId,
      code,
      isActive: true,
      validFrom: { $lte: now },
      validUntil: { $gte: now },
    });
    if (coupon) {
      const withinUsage =
        coupon.usageLimit === 0 || coupon.usedCount < coupon.usageLimit;
      const meetsGuests =
        coupon.minGuests === 0 || numSeats >= coupon.minGuests;
      const meetsOrder =
        coupon.minOrderAmount === 0 || fareSubtotalRaw >= coupon.minOrderAmount;
      if (withinUsage && meetsGuests && meetsOrder) {
        if (coupon.type === "percentage") {
          discountAmount = Math.round((fareSubtotalRaw * coupon.value) / 100);
          if (coupon.maxDiscount > 0 && discountAmount > coupon.maxDiscount)
            discountAmount = coupon.maxDiscount;
        } else {
          discountAmount = Math.min(coupon.value, fareSubtotalRaw);
        }
      }
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
  });
  return pricing.totalAmount;
}
exports.computeAuthoritativePricing = computeAuthoritativePricing;

async function creditOperatorWallet(
  operatorId,
  amount,
  bookingId,
  description,
) {
  // Upsert wallet
  const wallet = await OperatorWallet.findOneAndUpdate(
    { operatorId },
    {
      $inc: { balance: amount, totalEarned: amount },
    },
    { upsert: true, new: true },
  );

  await WalletTransaction.create({
    operatorId,
    bookingId,
    type: "CREDIT",
    amount,
    description,
    balanceAfter: wallet.balance,
  });

  return wallet;
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
  { cancelledBy, reason, fullRefund },
) {
  const p = booking.pricing || {};
  const fareSubtotal = Number(p.fareSubtotal) || 0;
  const discountAmount = Number(p.discountAmount) || 0;
  const netFare = Math.max(0, fareSubtotal - discountAmount);
  const gst = Number(p.gstAmount) || 0;
  const addon = Number(p.addonAmount) || 0;
  const platformFeePercent = Number(p.platformFeePercent) || 0;

  // ── Determine refund percentage ──────────────────────────────────────────
  const refundPercent = fullRefund
    ? 100
    : await resolveRefundPercent(booking.snapshot?.startDate);

  // ── Compute the split ──────────────────────────────────────────────────────
  const fareRefund = Math.round((netFare * refundPercent) / 100);
  // Split GST: portion on fare vs portion on addons
  const gstOnFare =
    netFare > 0 ? Math.round((gst * netFare) / (netFare + addon)) : 0;
  const gstOnAddon = gst - gstOnFare;
  const gstFareRefund = Math.round((gstOnFare * refundPercent) / 100);
  // Addon: always fully refundable (with its GST)
  const addonRefundable = true; // addons always get full refund on cancellation
  const addonRefund = fullRefund
    ? addon // operator/admin cancel → always refund addon
    : addon; // user cancel → also full refund on addons
  const gstAddonRefund = addonRefund > 0 ? gstOnAddon : 0;
  const gstRefund = gstFareRefund + gstAddonRefund;

  const retainedFare = netFare - fareRefund;
  const platformFeeOnRetained = fullRefund
    ? 0
    : Math.round((retainedFare * platformFeePercent) / 100);
  const operatorRetained = fullRefund
    ? 0
    : retainedFare - platformFeeOnRetained;
  const platformRetained = fullRefund
    ? 0
    : platformFeeOnRetained + (gst - gstRefund);

  const userRefund = fareRefund + gstRefund + addonRefund;

  const breakdown = {
    fareRefund,
    gstRefund,
    addonRefund,
    operatorRetained,
    platformRetained,
  };

  // ── Update booking record ───────────────────────────────────────────────
  booking.status = "CANCELLED";
  booking.cancelReason = reason || `Cancelled by ${cancelledBy}`;
  booking.cancelledBy = cancelledBy;
  booking.cancelledAt = new Date();
  booking.refundPercent = refundPercent;
  booking.refundAmount = userRefund;
  booking.refundBreakdown = breakdown;

  // ── Issue Razorpay refund (or flag manual if no payment id) ───────────────
  if (userRefund > 0) {
    if (booking.razorpayPaymentId) {
      const { refundPayment } = require("../utils/razorpayRefund");
      const result = await refundPayment(
        booking.razorpayPaymentId,
        userRefund,
        { bookingId: booking.bookingId, reason: reason || cancelledBy },
      );
      if (result.success) {
        booking.refundId = result.refundId || "";
        booking.refundStatus =
          result.status === "processed" ? "REFUNDED" : "PROCESSING";
        if (booking.refundStatus === "REFUNDED")
          booking.refundedAt = new Date();
      } else {
        booking.refundStatus = "FAILED";
        booking.refundError = result.error || "Refund failed";
      }
    } else {
      // Legacy booking without payment id — admin must refund manually
      booking.refundStatus = "MANUAL";
      booking.refundError = "No Razorpay payment id — manual refund required";
    }
  } else {
    booking.refundStatus = "REFUNDED"; // nothing to refund (0% slab)
    booking.refundedAt = new Date();
  }

  await booking.save();

  // ── Release seats + bookingCount ──────────────────────────────────────────
  await Batch.findByIdAndUpdate(booking.batchId, {
    $inc: { bookedSeats: -booking.seats },
  });
  await Package.findByIdAndUpdate(booking.packageId, {
    $inc: { bookingCount: -booking.seats },
  });

  // ── Credit operator the cancellation retention (immediately) ─────────────
  if (operatorRetained > 0) {
    await creditOperatorWallet(
      booking.operatorId,
      operatorRetained,
      booking._id,
      `Cancellation retention — Booking ${booking.bookingId}`,
    );
  }

  // ── Flag admin if addon was already dispatched to Snapja ──────────────────
  if (booking.addonDispatched && addonRefund > 0) {
    try {
      const { notifyAdmin } = require("./notificationController");
      notifyAdmin(
        "Manual Snapja Reconciliation Needed",
        `Booking ${booking.bookingId} cancelled after addon was dispatched to Snapja. ₹${addonRefund} refunded to user — reconcile with Snapja manually.`,
        { type: "general", bookingId: booking._id.toString() },
      );
    } catch {}
  }

  return {
    refundAmount: userRefund,
    refundPercent,
    breakdown,
    refundStatus: booking.refundStatus,
  };
}

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

    const { packageId, batchId, seats = 1 } = req.body;

    if (!packageId || (!batchId && req.body.bookingMode !== "flexible")) {
      return res.status(400).json({
        success: false,
        message: "packageId and batchId (or bookingMode=flexible) are required",
      });
    }

    const isFlexible = req.body.bookingMode === "flexible";

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
    let adultPrice, childPrice, operatorId;

    if (isFlexible) {
      // ── Flexible booking — validate flex availability ──────────────────────
      const FlexibleAvailability = require("../models/FlexibleAvailability");
      flexRecord = await FlexibleAvailability.findById(
        req.body.flexAvailabilityId,
      );
      if (!flexRecord || !flexRecord.isActive) {
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
      adultPrice = flexRecord.adultPrice;
      childPrice = flexRecord.childPrice || 0;
      operatorId = flexRecord.operatorId;
    } else {
      // ── Batch booking — existing flow ──────────────────────────────────────
      batch = await Batch.findById(batchId);
      if (!batch || !batch.isActive) {
        return res.status(404).json({
          success: false,
          message: "Batch not found or not available",
        });
      }
      const now = new Date();
      if (batch.bookingDeadline < now) {
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
      const available = batch.totalSeats - batch.bookedSeats;
      if (numSeats > available) {
        return res.status(400).json({
          success: false,
          message: `Only ${available} seat${available !== 1 ? "s" : ""} available`,
        });
      }
      const seatReserved = await Batch.findOneAndUpdate(
        {
          _id: batchId,
          $expr: {
            $lte: [{ $add: ["$bookedSeats", numSeats] }, "$totalSeats"],
          },
        },
        { $inc: { bookedSeats: numSeats } },
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

    // ── Fetch package ──────────────────────────────────────────────────────
    const pkg = await Package.findById(packageId);
    if (!pkg || !pkg.isActive || pkg.status !== "APPROVED") {
      return res.status(404).json({
        success: false,
        message: "Package not found or not available",
      });
    }

    // ── Get live platform settings ─────────────────────────────────────────
    const platformFeePercent = (await getSetting("platform_fee_percent")) ?? 10;
    const gstPercent = (await getSetting("gst_percent")) ?? 5;

    // ── Compute addon (Snapja) amounts — held by platform until dispatch ──────
    const ADDON_BASE_PRICE = 2000;
    let addonSurcharge = 0; // operator's outside-city portion
    let addonTotalPrice = 0; // base + surcharge (full held amount)
    const addonDaysData = req.body.addonDays || null;
    const addonNames = addonDaysData ? Object.keys(addonDaysData) : [];
    if (addonDaysData) {
      for (const addonName of addonNames) {
        const days = addonDaysData[addonName] || [];
        for (const dayIdx of days) {
          const dayInfo = pkg.itinerary[dayIdx];
          const surcharge = dayInfo?.isOutsideCity
            ? pkg.outsideCityCharge || 0
            : 0;
          addonSurcharge += surcharge;
          addonTotalPrice += ADDON_BASE_PRICE + surcharge;
        }
      }
    }

    // ── Apply coupon (discount applies to fare only) ──────────────────────────
    const couponCode = (req.body.couponCode || "").trim().toUpperCase();
    let discountAmount = 0;
    let appliedCouponId = null;
    const fareSubtotalRaw = Math.round(
      adultPrice * numAdults + (childPrice || 0) * numChildren,
    );

    if (couponCode) {
      const Coupon = require("../models/Coupon");
      const now = new Date();

      // Atomic: only increment usedCount if coupon is still valid + within limit
      const coupon = await Coupon.findOneAndUpdate(
        {
          batchId,
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

    // ── Calculate pricing (snapshotted forever) ────────────────────────────
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
    });
    if (discountAmount > 0) pricing.couponCode = couponCode;

    // ── Build snapshot ─────────────────────────────────────────────────────
    const snapshot = {
      packageTitle: pkg.title,
      packageLocation: pkg.location,
      packageImageUrl: pkg.image_url || "",
      batchLabel: batch ? batch.label || "" : "Flexible",
      startDate: isFlexible
        ? req.body.flexStartDate || new Date()
        : batch.startDate,
      endDate: isFlexible
        ? (() => {
            const d = new Date(req.body.flexStartDate || Date.now());
            d.setDate(d.getDate() + (pkg.itinerary?.length || 5) - 1);
            return d;
          })()
        : batch.endDate,
      adultPrice,
    };

    // ── Create booking — auto-confirmed (payment simulated) ──────────────────
    const booking = await TripBooking.create({
      userId: req.user._id,
      packageId,
      batchId: isFlexible ? undefined : batchId,
      bookingMode: isFlexible ? "flexible" : "batch",
      flexStartDate: isFlexible ? req.body.flexStartDate : undefined,
      flexEndDate: isFlexible ? snapshot.endDate : undefined,
      flexAvailabilityId: isFlexible ? req.body.flexAvailabilityId : undefined,
      operatorId,
      seats: numSeats,
      status: "CONFIRMED", // auto-confirmed — no admin approval needed
      travelers: Array.isArray(req.body.travelers)
        ? req.body.travelers.slice(0, numSeats).map((t) => ({
            name: String(t.name || "").trim(),
            gender: String(t.gender || "").trim(),
            age: Number(t.age) || 0,
          }))
        : [],
      pricing,
      snapshot,
      addonDays: addonDaysData,
      addonSchedule: req.body.addonSchedule || null,
      addonSurcharge,
      addonNames,
      addonTotalPrice,
      addonHeld: addonTotalPrice > 0, // hold Snapja money until dispatch
      addonDispatched: false,
      razorpayPaymentId: req.body.paymentId || "",
      razorpayOrderId: req.body.razorpayOrderId || "",
    });

    // ── Side effects — increment seats + bookingCount immediately ──────────
    // ── Side effects — bookingCount (seats already reserved atomically above) ─
    await Package.findByIdAndUpdate(packageId, {
      $inc: { bookingCount: numSeats },
    });
    // NOTE: Wallet credit happens via cron 2 days after trip endDate (not now)
    // outsideCityCharge is also credited at the same time as package earnings (via cron)

    // Auto-create chat conversation for this booking
    const Conversation = require("../models/Conversation");
    const Message = require("../models/Message");
    const tripEnd = isFlexible
      ? new Date(snapshot.endDate)
      : new Date(batch.endDate);
    const tripStart = isFlexible
      ? new Date(snapshot.startDate)
      : new Date(batch.startDate);
    const expiresAt = new Date(tripEnd.getTime() + 2 * 24 * 60 * 60 * 1000); // endDate + 2 days
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

    const conversation = await Conversation.create({
      bookingId: booking._id,
      userId: req.user._id,
      operatorId: pkg.operatorId,
      packageTitle: pkg.title,
      packageImage: pkg.image_url || "",
      startsAt: new Date(),
      expiresAt,
      lastMessage: "New booking received",
      lastMessageAt: new Date(),
      lastSenderType: "system",
    });

    // Auto-send booking summary as first message (visible to operator)
    const summaryText = `📋 New Booking!\n\n🎯 Package: ${pkg.title}\n📅 Dates: ${startFmt} — ${endFmt}\n👥 Travelers: ${booking.seats}\n🆔 Booking ID: ${booking.bookingId}\n👤 Name: ${req.user.name || "User"}\n📱 Phone: ${req.user.phone || "—"}\n\nChat is active until ${new Date(expiresAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`;

    await Message.create({
      conversationId: conversation._id,
      senderId: req.user._id,
      senderType: "user",
      senderName: "System",
      text: summaryText,
    });

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

    res.status(201).json({ success: true, booking });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// GET /api/trip-bookings/my  — user's own bookings
exports.getMyBookings = async (req, res) => {
  try {
    const bookings = await TripBooking.find({ userId: req.user._id })
      .populate("packageId", "title location image_url avgRating")
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
      .populate("packageId", "title location image_url")
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

    const prevStatus = booking.status;

    // Guard against invalid transitions
    if (prevStatus === "COMPLETED") {
      return res.status(400).json({
        success: false,
        message: "Completed bookings cannot be changed",
      });
    }
    if (prevStatus === "CANCELLED") {
      return res.status(400).json({
        success: false,
        message: "Cancelled bookings cannot be changed",
      });
    }

    // ── Admin cancellation → 100% refund to user via shared helper ──────────
    if (status === "CANCELLED") {
      if (prevStatus !== "CONFIRMED" && prevStatus !== "PENDING") {
        return res.status(400).json({
          success: false,
          message: `Cannot cancel a ${prevStatus.toLowerCase()} booking`,
        });
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
        `Your booking for ${snap.packageTitle || "trip"} was cancelled. A full refund of ₹${summary.refundAmount.toLocaleString("en-IN")} is being processed.`,
        { type: "booking_cancelled", bookingId: booking._id.toString() },
      );
      const { notifyOperator } = require("./notificationController");
      notifyOperator(
        booking.operatorId,
        "Booking Cancelled by Admin",
        `Booking ${booking.bookingId} for ${snap.packageTitle || "your package"} was cancelled by admin.`,
        { type: "booking_cancelled", bookingId: booking._id.toString() },
      );
      try {
        const Conversation = require("../models/Conversation");
        await Conversation.updateMany(
          { bookingId: booking._id },
          { isActive: false },
        );
      } catch {}

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
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Operator ──────────────────────────────────────────────────────────────────

// GET /api/trip-bookings/operator/mine  — operator sees bookings for their packages
exports.operatorGetMyBookings = async (req, res) => {
  try {
    const {
      status,
      packageId,
      batchId,
      search,
      fromDate,
      toDate,
      page = 1,
      limit = 20,
    } = req.query;
    const query = { operatorId: req.operator._id };
    if (status && status !== "all") query.status = status;
    if (packageId) query.packageId = packageId;
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
        .populate("packageId", "title")
        .populate("batchId", "startDate endDate label")
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

    // Can only cancel CONFIRMED or PENDING bookings
    if (!["CONFIRMED", "PENDING"].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel a ${booking.status.toLowerCase()} booking`,
      });
    }

    // Guard: can't cancel after the trip has started
    if (
      booking.snapshot?.startDate &&
      new Date(booking.snapshot.startDate) <= new Date()
    ) {
      return res.status(400).json({
        success: false,
        message: "This trip has already started and cannot be cancelled.",
      });
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
        ? `Your booking for ${snap.packageTitle || "trip"} is cancelled. ₹${summary.refundAmount.toLocaleString("en-IN")} refund is being processed to your original payment method.`
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
          text: `Hi ${user.name}, your booking ${booking.bookingId} has been cancelled.${summary.refundAmount > 0 ? ` Refund of Rs.${summary.refundAmount} (${summary.refundPercent}%) is being processed.` : ""}`,
          html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;"><h2 style="color:#EF4444;">Booking Cancelled</h2><p>Hi <strong>${user.name}</strong>,</p><p>Your booking <strong>${booking.bookingId}</strong> for <strong>${snap.packageTitle || "trip"}</strong> has been cancelled.</p>${summary.refundAmount > 0 ? `<p style="background:#F0FDF4;padding:12px;border-radius:8px;color:#065F46;"><strong>Refund:</strong> Rs.${summary.refundAmount.toLocaleString("en-IN")} (${summary.refundPercent}%) is being processed to your original payment method within 5-7 business days.</p>` : ""}<p style="color:#6B7280;font-size:13px;">If you have questions, contact us via the app.</p><p>Team Trip Reel</p></div>`,
        });
      }
    } catch {}

    // Close chat window
    try {
      const Conversation = require("../models/Conversation");
      await Conversation.updateMany(
        { bookingId: booking._id },
        { isActive: false },
      );
    } catch {}

    res.json({
      success: true,
      message: "Booking cancelled successfully",
      refundPercent: summary.refundPercent,
      refundAmount: summary.refundAmount,
      refundStatus: summary.refundStatus,
      breakdown: summary.breakdown,
      booking,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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

    // Mirror the breakdown logic used in processCancellationRefund
    const p = booking.pricing || {};
    const fareSubtotal = Number(p.fareSubtotal) || 0;
    const discountAmount = Number(p.discountAmount) || 0;
    const netFare = Math.max(0, fareSubtotal - discountAmount);
    const gst = Number(p.gstAmount) || 0;
    const addon = Number(p.addonAmount) || 0;

    const fareRefund = Math.round((netFare * refundPercent) / 100);
    // Split GST: portion on fare vs portion on addons
    const gstOnFare =
      netFare > 0 ? Math.round((gst * netFare) / (netFare + addon)) : 0;
    const gstOnAddon = gst - gstOnFare;
    const gstFareRefund = Math.round((gstOnFare * refundPercent) / 100);
    // Addons always get full refund (+ their GST)
    const addonRefund = addon;
    const gstAddonRefund = addonRefund > 0 ? gstOnAddon : 0;
    const gstRefund = gstFareRefund + gstAddonRefund;
    const refundAmount = fareRefund + gstRefund + addonRefund;

    res.json({
      success: true,
      daysBeforeTrip,
      refundPercent,
      refundAmount,
      totalPaid: booking.pricing.totalAmount,
      breakdown: { fareRefund, gstRefund, addonRefund },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Operator cancels a single booking ─────────────────────────────────────────
// POST /api/operator/bookings/:id/cancel  (operatorProtect)
exports.operatorCancelBooking = async (req, res) => {
  try {
    const { reason } = req.body;
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
    if (!["CONFIRMED", "PENDING"].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel a ${booking.status.toLowerCase()} booking`,
      });
    }

    const summary = await processCancellationRefund(booking, {
      cancelledBy: "operator",
      reason: reason || "Cancelled by operator",
      fullRefund: true, // operator cancel → 100% refund to user
    });

    const snap = booking.snapshot || {};
    // Notify user (full refund)
    notifyUser(
      booking.userId,
      "Trip Cancelled by Operator",
      `Your booking for ${snap.packageTitle || "trip"} was cancelled by the operator. A full refund of ₹${summary.refundAmount.toLocaleString("en-IN")} is being processed.`,
      { type: "booking_cancelled", bookingId: booking._id.toString() },
    );
    // Notify admin (visibility + who cancelled)
    const { notifyAdmin } = require("./notificationController");
    notifyAdmin(
      "Operator Cancelled a Booking",
      `Operator cancelled booking ${booking.bookingId} (${snap.packageTitle || "trip"}). Full refund ₹${summary.refundAmount.toLocaleString("en-IN")} to user. Reason: ${reason || "—"}`,
      { type: "booking_cancelled", bookingId: booking._id.toString() },
    );
    try {
      const Conversation = require("../models/Conversation");
      await Conversation.updateMany(
        { bookingId: booking._id },
        { isActive: false },
      );
    } catch {}

    res.json({ success: true, refund: summary });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Operator cancels an entire batch ──────────────────────────────────────────
// POST /api/operator/batches/:batchId/cancel  (operatorProtect)
exports.operatorCancelBatch = async (req, res) => {
  try {
    const { reason } = req.body;
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

    const bookings = await TripBooking.find({
      batchId,
      status: { $in: ["CONFIRMED", "PENDING"] },
    });

    const { notifyAdmin } = require("./notificationController");
    let cancelled = 0;
    let totalRefund = 0;
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
        const snap = booking.snapshot || {};
        notifyUser(
          booking.userId,
          "Trip Cancelled by Operator",
          `Your booking for ${snap.packageTitle || "trip"} was cancelled by the operator. A full refund of ₹${summary.refundAmount.toLocaleString("en-IN")} is being processed.`,
          { type: "booking_cancelled", bookingId: booking._id.toString() },
        );
        try {
          const Conversation = require("../models/Conversation");
          await Conversation.updateMany(
            { bookingId: booking._id },
            { isActive: false },
          );
        } catch {}
      } catch (e) {
        errors.push(`${booking.bookingId}: ${e.message}`);
      }
    }

    // Deactivate the batch so no new bookings
    batch.isActive = false;
    await batch.save();

    notifyAdmin(
      "Operator Cancelled an Entire Batch",
      `Operator cancelled batch "${batch.label || batchId}" — ${cancelled} booking(s) refunded (₹${totalRefund.toLocaleString("en-IN")} total). Reason: ${reason || "—"}`,
      { type: "booking_cancelled", batchId: String(batchId) },
    );

    res.json({
      success: true,
      cancelledCount: cancelled,
      totalRefund,
      errors,
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
  try {
    const booking = await TripBooking.findById(req.params.id);
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }
    if (!["FAILED", "MANUAL"].includes(booking.refundStatus)) {
      return res.status(400).json({
        success: false,
        message: `Refund is '${booking.refundStatus}', nothing to retry`,
      });
    }
    if (!booking.razorpayPaymentId) {
      return res.status(400).json({
        success: false,
        message: "No Razorpay payment id — refund the user manually offline.",
      });
    }

    // Allow admin to optionally override the amount (capped to what user paid)
    const maxRefundable = booking.pricing?.totalAmount || booking.refundAmount;
    const rawAmount = Number(req.body.amount) || booking.refundAmount;
    const amount = Math.min(rawAmount, maxRefundable);
    const { refundPayment } = require("../utils/razorpayRefund");
    const result = await refundPayment(booking.razorpayPaymentId, amount, {
      bookingId: booking.bookingId,
      reason: "Admin retry",
    });

    if (result.success) {
      booking.refundId = result.refundId || "";
      booking.refundAmount = amount;
      booking.refundStatus =
        result.status === "processed" ? "REFUNDED" : "PROCESSING";
      booking.refundError = "";
      if (booking.refundStatus === "REFUNDED") booking.refundedAt = new Date();
      await booking.save();
      notifyUser(
        booking.userId,
        "Refund Processing",
        `Your refund of ₹${amount.toLocaleString("en-IN")} for ${booking.snapshot?.packageTitle || "your trip"} is being processed.`,
        { type: "booking_cancelled", bookingId: booking._id.toString() },
      );
      return res.json({ success: true, refundStatus: booking.refundStatus });
    }
    booking.refundStatus = "FAILED";
    booking.refundError = result.error || "Refund failed";
    await booking.save();
    res
      .status(400)
      .json({ success: false, message: result.error || "Refund failed" });
  } catch (err) {
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
    booking.refundStatus = "REFUNDED";
    booking.refundedAt = new Date();
    booking.refundError = "";
    if (req.body.note)
      booking.cancelReason = `${booking.cancelReason} | ${req.body.note}`;
    await booking.save();
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
    if (!booking.addonDispatched || !booking.snapjaBookings) {
      return res.json({
        success: true,
        updated: false,
        snapjaBookings: booking.snapjaBookings || {},
      });
    }

    const SNAPJA_API = "https://api.snapja.com/api/tripreel/bookings";
    const SNAPJA_API_KEY = process.env.SNAPJA_API_KEY || "tripreel_snapja_2025";

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

          // No creator / cancelled / expired on Snapja side → flag for refund.
          const failStatuses = ["no_creator_available", "cancelled", "expired"];
          if (
            failStatuses.includes(String(b.status).toLowerCase()) &&
            !snapjaBookings[key].refundFlagged
          ) {
            snapjaBookings[key].refundFlagged = true;
            snapjaBookings[key].refundReason = b.status;
            try {
              const { notifyUser } = require("./notificationController");
              notifyUser(
                booking.userId,
                "Add-on Could Not Be Assigned",
                `We couldn't assign a creator for one of your add-on days. A refund for that add-on will be processed.`,
                { type: "general", bookingId: booking._id.toString() },
              );
            } catch {}
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
