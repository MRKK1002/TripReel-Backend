const Razorpay = require("razorpay");
const crypto = require("crypto");
const {
  sendBookingConfirmation,
  sendPaymentReceipt,
} = require("../utils/sendMail");
const { buildAddonBookingPlan } = require("../utils/addonBookingTiming");

const POST_INSERT_EFFECT_ATTEMPT_LIMIT = 5;
exports.POST_INSERT_EFFECT_ATTEMPT_LIMIT = POST_INSERT_EFFECT_ATTEMPT_LIMIT;

// Initialize lazily so dotenv has time to load
let razorpay;
function getRazorpay() {
  if (!razorpay) {
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return razorpay;
}

const RELEASE_OUTCOMES = new Set(["user_closed", "definitive_decline"]);
const PROTECTED_PAYMENT_STATUSES = new Set([
  "authorized",
  "captured",
  "refunded",
  "partially_refunded",
]);

function inspectReleaseProviderState({ order, paymentList, outcome }) {
  const orderStatus =
    typeof order?.status === "string" ? order.status.toLowerCase() : "";
  const attempts = Number(order?.attempts);
  const amountPaid = Number(order?.amount_paid);
  const payments = Array.isArray(paymentList?.items) ? paymentList.items : null;
  const listedCount = Number(paymentList?.count);

  if (
    !["created", "attempted", "paid"].includes(orderStatus) ||
    !Number.isInteger(attempts) ||
    attempts < 0 ||
    !Number.isFinite(amountPaid) ||
    amountPaid < 0 ||
    !payments ||
    !Number.isInteger(listedCount) ||
    listedCount !== payments.length ||
    payments.some(
      (payment) =>
        !payment ||
        typeof payment.status !== "string" ||
        (payment.order_id && payment.order_id !== order.id),
    )
  ) {
    return { releasable: false, reason: "ambiguous_provider_state" };
  }

  const paymentStatuses = payments.map((payment) =>
    payment.status.toLowerCase(),
  );
  if (
    orderStatus === "paid" ||
    amountPaid > 0 ||
    paymentStatuses.some((status) => PROTECTED_PAYMENT_STATUSES.has(status))
  ) {
    return { releasable: false, reason: "payment_recoverable" };
  }

  if (outcome === "user_closed") {
    return orderStatus === "created" && attempts === 0 && listedCount === 0
      ? { releasable: true }
      : { releasable: false, reason: "checkout_was_attempted" };
  }

  const allAttemptsFailed =
    orderStatus === "attempted" &&
    attempts > 0 &&
    attempts === listedCount &&
    listedCount > 0 &&
    paymentStatuses.every((status) => status === "failed");

  return allAttemptsFailed
    ? { releasable: true }
    : { releasable: false, reason: "decline_not_definitive" };
}

/**
 * POST /api/payments/release-order
 * Expires only an authenticated user's provider-confirmed abandoned booking
 * order. Client outcomes are hints; Razorpay remains authoritative.
 */
exports.releaseOrder = async (req, res) => {
  const body = req.body || {};
  const allowedFields = new Set(["razorpayOrderId", "outcome"]);
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    return res.status(400).json({
      success: false,
      released: false,
      message: "Only razorpayOrderId and outcome are accepted",
    });
  }

  const { razorpayOrderId, outcome } = body;
  if (
    typeof razorpayOrderId !== "string" ||
    !razorpayOrderId.trim() ||
    !RELEASE_OUTCOMES.has(outcome)
  ) {
    return res.status(400).json({
      success: false,
      released: false,
      message:
        "razorpayOrderId and outcome (user_closed or definitive_decline) are required",
    });
  }

  try {
    const PendingOrder = require("../models/PendingOrder");
    const pending = await PendingOrder.findOne({
      razorpayOrderId,
      userId: req.user._id,
    });

    if (!pending) {
      return res.status(404).json({
        success: false,
        released: false,
        message: "Payment order not found",
      });
    }

    if (pending.status === "expired") {
      return res.status(200).json({
        success: true,
        released: true,
        idempotent: true,
      });
    }

    if (pending.status !== "pending") {
      return res.status(200).json({
        success: true,
        released: false,
        reason: "order_not_pending",
      });
    }

    // PendingOrder ownership is necessary but not sufficient: only normal
    // booking orders created by createOrder may use this transition.
    if (!pending.payload?.packageId) {
      return res.status(200).json({
        success: true,
        released: false,
        reason: "not_a_booking_order",
      });
    }

    let order;
    let paymentList;
    try {
      order = await getRazorpay().orders.fetch(razorpayOrderId);
      paymentList = await getRazorpay().orders.fetchPayments(razorpayOrderId);
    } catch (providerError) {
      console.warn(
        `[releaseOrder] Provider check failed for ${razorpayOrderId}:`,
        providerError.message,
      );
      return res.status(200).json({
        success: true,
        released: false,
        reason: "provider_check_failed",
      });
    }

    const providerUserId = order?.notes?.userId;
    if (
      order?.id !== razorpayOrderId ||
      order?.notes?.purpose ||
      (providerUserId && String(providerUserId) !== String(req.user._id))
    ) {
      return res.status(200).json({
        success: true,
        released: false,
        reason: "provider_order_mismatch",
      });
    }

    const decision = inspectReleaseProviderState({
      order,
      paymentList,
      outcome,
    });
    if (!decision.releasable) {
      return res.status(200).json({
        success: true,
        released: false,
        reason: decision.reason,
      });
    }

    const expiredAt = new Date();
    const releasedOrder = await PendingOrder.findOneAndUpdate(
      {
        _id: pending._id,
        userId: req.user._id,
        status: "pending",
      },
      {
        $set: {
          status: "expired",
          expiredAt,
          expirationReason: outcome,
        },
      },
      { new: true },
    );

    if (releasedOrder) {
      return res.status(200).json({
        success: true,
        released: true,
        expiredAt: releasedOrder.expiredAt,
      });
    }

    // Verification/webhook may have completed it while provider state was
    // being checked. Only a concurrently expired record is a successful retry.
    const current = await PendingOrder.findById(pending._id).select(
      "status expiredAt",
    );
    return res.status(200).json({
      success: true,
      released: current?.status === "expired",
      idempotent: current?.status === "expired",
      expiredAt: current?.expiredAt,
      ...(current?.status === "expired"
        ? {}
        : { reason: "order_state_changed" }),
    });
  } catch (err) {
    console.error("[releaseOrder] Error:", err.message);
    return res.status(500).json({
      success: false,
      released: false,
      message: "Could not release payment order",
    });
  }
};

/**
 * POST /api/payments/create-order
 * Creates a Razorpay order and returns order details to frontend
 */
exports.createOrder = async (req, res) => {
  try {
    const {
      packageId,
      batchId,
      bookingMode,
      flexStartDate,
      flexAvailabilityId,
      seats,
      couponCode,
      platformCouponCode,
      addonDays,
      travelers,
    } = req.body;

    if (!["batch", "flexible"].includes(bookingMode)) {
      return res.status(400).json({
        success: false,
        message: "bookingMode must be exactly 'batch' or 'flexible'",
      });
    }

    const isFlexible = bookingMode === "flexible";

    if (!packageId || (!batchId && !isFlexible)) {
      return res.status(400).json({
        success: false,
        message: "packageId and batchId (or bookingMode=flexible) are required",
      });
    }

    const tripBookingController = require("./tripBookingController");

    // ── Derive the adult/child split from traveler AGES, server-side ─────────
    // The client's self-declared adults/children are NEVER trusted for pricing.
    // Travelers must be provided and their count must equal the reserved seats.
    const numSeats = Math.max(1, Number(seats) || 1);
    const split = tripBookingController.deriveSplitFromTravelers(travelers);
    if (split.total === 0) {
      return res.status(400).json({
        success: false,
        message: "Traveler details are required to book.",
      });
    }
    if (split.total !== numSeats) {
      return res.status(400).json({
        success: false,
        message: `Number of travelers (${split.total}) must equal seats (${numSeats}).`,
      });
    }
    const numAdults = split.adults;
    const numChildren = split.children;

    // ── Recompute the authoritative amount SERVER-SIDE (never trust client) ──
    let authoritativeAmount;
    let chargedPricingSnapshot;
    let couponIssue = null;
    try {
      const priced = await tripBookingController.computeAuthoritativePricing({
        packageId,
        batchId: isFlexible ? null : batchId,
        bookingMode: isFlexible ? "flexible" : "batch",
        flexAvailabilityId: isFlexible ? flexAvailabilityId : undefined,
        flexStartDate: isFlexible ? flexStartDate : undefined,
        seats: numSeats,
        adults: numAdults,
        children: numChildren,
        couponCode,
        platformCouponCode,
        userId: req.user._id,
        addonDays,
        addonSchedule: req.body.addonSchedule,
      });
      authoritativeAmount = priced.totalAmount;
      chargedPricingSnapshot = priced;
      couponIssue = priced.couponIssue;
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }

    if (!authoritativeAmount || authoritativeAmount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid booking amount" });
    }

    // Pricing has strictly validated this value; use one calendar-date identity
    // for duplicate detection, provider notes, and persisted recovery payloads.
    const canonicalFlexStartDate = isFlexible
      ? String(flexStartDate).trim().split("T")[0]
      : undefined;

    // ── Coupon no longer applicable ──────────────────────────────────────────
    // The user applied a coupon that has since expired, been deactivated, or run
    // out of uses. Charging silently at full price is what caused billing
    // disputes, so stop before creating the Razorpay order and report the real
    // amount so the app can show the updated price.
    if (couponIssue) {
      return res.status(409).json({
        success: false,
        code: "COUPON_NOT_APPLICABLE",
        message: couponIssue,
        amount: authoritativeAmount,
      });
    }

    const amountInPaise = Math.round(authoritativeAmount * 100);

    // Store the booking context in notes so verify uses the SAME data that was priced
    // Razorpay notes have a 512 char limit per value — compress addonDays
    let addonDaysStr = "";
    try {
      if (addonDays && Object.keys(addonDays).length > 0) {
        // Compact format: "addonName:0,1,2|otherAddon:1,3"
        addonDaysStr = Object.entries(addonDays)
          .map(([name, days]) => `${name}:${(days || []).join(",")}`)
          .join("|");
      }
    } catch {}

    // ── Double-charge guard ──────────────────────────────────────────────────
    // Reject if this user already has a recent pending order for the same
    // batch, or the same flexible availability + selected date.
    try {
      const PendingOrder = require("../models/PendingOrder");
      const GUARD_WINDOW_MS = 2 * 60 * 1000; // 2 min
      const duplicateKey = isFlexible
        ? {
            "payload.bookingMode": "flexible",
            "payload.flexAvailabilityId": flexAvailabilityId,
            "payload.flexStartDate": canonicalFlexStartDate,
          }
        : {
            "payload.bookingMode": "batch",
            "payload.batchId": batchId,
          };
      const existing = await PendingOrder.findOne({
        userId: req.user._id,
        status: "pending",
        "payload.packageId": packageId,
        ...duplicateKey,
        createdAt: { $gte: new Date(Date.now() - GUARD_WINDOW_MS) },
      });
      if (existing) {
        return res.status(409).json({
          success: false,
          message:
            "A payment is already in progress for this trip. Please complete or wait a moment before trying again.",
          existingOrderId: existing.razorpayOrderId,
        });
      }
    } catch (e) {
      // Non-blocking — if this check fails we still allow the order (safer than blocking)
      console.warn("[createOrder] double-charge guard error:", e.message);
    }

    const options = {
      amount: amountInPaise,
      currency: "INR",
      receipt: `tripreel_${Date.now()}`,
      notes: {
        packageId: String(packageId),
        batchId: batchId ? String(batchId) : "",
        bookingMode: isFlexible ? "flexible" : "batch",
        flexStartDate: canonicalFlexStartDate || "",
        flexAvailabilityId: flexAvailabilityId || "",
        seats: String(numSeats),
        adults: String(numAdults),
        children: String(numChildren),
        userId: req.user._id.toString(),
        couponCode: couponCode || "",
        platformCouponCode: platformCouponCode || "",
        addonDays: addonDaysStr, // compact format fits in Razorpay notes
      },
    };

    const order = await getRazorpay().orders.create(options);

    // ── Persist the full booking payload BEFORE payment ──────────────────────
    // If the app dies after the charge but before /verify, the webhook/cron use
    // this to recreate the booking (order notes lack traveller names + schedule).
    try {
      const PendingOrder = require("../models/PendingOrder");
      await PendingOrder.findOneAndUpdate(
        { razorpayOrderId: order.id },
        {
          $set: {
            razorpayOrderId: order.id,
            userId: req.user._id,
            amount: authoritativeAmount,
            chargedPricingSnapshot,
            packageId,
            batchId: isFlexible ? null : batchId,
            flexAvailabilityId: isFlexible ? flexAvailabilityId : null,
            flexInventoryId: isFlexible
              ? chargedPricingSnapshot.source?.flexInventoryId
              : null,
            flexStartDateKey: canonicalFlexStartDate || "",
            flexReservationClaimKey: isFlexible ? order.id : "",
            batchReservationClaimKey: isFlexible ? "" : order.id,
            status: "pending",
            payload: {
              packageId,
              batchId: isFlexible ? null : batchId,
              bookingMode: isFlexible ? "flexible" : "batch",
              flexStartDate: canonicalFlexStartDate,
              flexAvailabilityId: isFlexible ? flexAvailabilityId : undefined,
              seats: numSeats,
              adults: numAdults,
              children: numChildren,
              couponCode: couponCode || "",
              platformCouponCode: platformCouponCode || "",
              addonDays: chargedPricingSnapshot.addonDays || null,
              addonServiceEntries:
                chargedPricingSnapshot.addonServiceEntries || [],
              // Full traveller details + the frozen resolved schedule for recovery
              travelers: Array.isArray(travelers) ? travelers : [],
              addonSchedule: chargedPricingSnapshot.addonSchedule || null,
              addonBookingTypes: chargedPricingSnapshot.addonBookingTypes || {},
            },
          },
        },
        { upsert: true, setDefaultsOnInsert: true },
      );
    } catch (e) {
      // Recovery depends on this record. Never expose a checkout order that the
      // backend cannot later reconcile if the app dies after payment.
      console.error("[createOrder] PendingOrder persist failed:", e.message);
      return res.status(500).json({
        success: false,
        message: "Could not prepare payment order. Please try again.",
      });
    }

    res.status(200).json({
      success: true,
      orderId: order.id,
      razorpayOrderId: order.id,
      amount: authoritativeAmount, // authoritative — client should charge this
      amountInPaise: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID, // app must use THIS key so it matches the order's account
    });
  } catch (err) {
    console.error("Razorpay create order error:", err);
    res.status(500).json({
      success: false,
      message: "Could not create payment order",
      error: err.message,
    });
  }
};

// Parse addonDays from order notes ("name:0,1|name2:2,3" or legacy JSON).
function parseAddonDaysFromNotes(notes) {
  try {
    if (!notes.addonDays) return null;
    try {
      return JSON.parse(notes.addonDays);
    } catch {
      const out = {};
      notes.addonDays.split("|").forEach((part) => {
        const [name, daysStr] = part.split(":");
        if (name && daysStr) out[name] = daysStr.split(",").map(Number);
      });
      return out;
    }
  } catch {
    return null;
  }
}

/**
 * Create the booking from a paid Razorpay order — the single source of truth
 * shared by /verify (app), the payments webhook, and the recovery cron.
 *
 * Idempotent: if a booking already exists for this payment, it returns it.
 * Travellers + add-on schedule are taken from the caller if provided, else from
 * the PendingOrder we persisted at create-order time (so webhook/cron recovery
 * is full-fidelity even though order notes don't carry those fields).
 *
 * @returns {Promise<{ booking, bookingId, alreadyExisted }>}
 */
async function createBookingFromPaidOrder({
  order,
  paymentId,
  user, // optional — falls back to the order's userId
  travelers, // optional — falls back to PendingOrder payload
  addonSchedule, // optional — falls back to PendingOrder payload
  finalizationLeaseToken,
}) {
  const TripBooking = require("../models/TripBooking");
  const PendingOrder = require("../models/PendingOrder");
  const notes = order.notes || {};

  // ── Idempotency ────────────────────────────────────────────────────────────
  const existing = await TripBooking.findOne({ razorpayPaymentId: paymentId });
  if (existing) {
    return {
      booking: existing,
      bookingId: existing._id,
      alreadyExisted: true,
    };
  }

  // Recover missing details (travellers/schedule) from the persisted order
  const pending = await PendingOrder.findOne({ razorpayOrderId: order.id });
  const pPayload = pending?.payload || {};
  const chargedPricingSnapshot = pending?.chargedPricingSnapshot || null;
  if (!chargedPricingSnapshot) {
    const error = new Error(
      "Authoritative charged pricing snapshot is missing; manual reconciliation is required",
    );
    error.code = "CHARGED_PRICING_SNAPSHOT_MISSING";
    throw error;
  }
  if (
    chargedPricingSnapshot &&
    Math.round(Number(chargedPricingSnapshot.totalAmount) * 100) !==
      Number(order.amount)
  ) {
    throw new Error("Persisted charged quote does not match provider order");
  }

  // Resolve the acting user (webhook/cron have no req.user)
  let actingUser = user;
  if (!actingUser) {
    const uid = notes.userId || pending?.userId;
    if (uid) {
      const User = require("../models/User");
      actingUser = await User.findById(uid);
    }
  }
  if (!actingUser) throw new Error("Could not resolve user for order");

  // Canonical selections are recovered only from the persisted charged payload.
  // Provider notes are intentionally not trusted for add-on reconstruction.
  const addonDays =
    chargedPricingSnapshot.addonDays || pPayload.addonDays || null;
  const finalTravelers =
    (Array.isArray(travelers) && travelers.length > 0
      ? travelers
      : pPayload.travelers) || [];
  const finalSchedule =
    chargedPricingSnapshot.addonSchedule || pPayload.addonSchedule || null;

  const tripBookingController = require("./tripBookingController");
  const fakeReq = {
    user: actingUser,
    _paymentVerified: true, // SECURITY: marks this as a payment-verified booking
    _paymentFinalization: finalizationLeaseToken
      ? { orderId: order.id, leaseToken: finalizationLeaseToken }
      : null,
    _chargedPricingSnapshot: chargedPricingSnapshot,
    body: {
      packageId: notes.packageId || pPayload.packageId,
      batchId: notes.batchId || pPayload.batchId || null,
      bookingMode: notes.bookingMode || pPayload.bookingMode || "batch",
      flexStartDate: notes.flexStartDate || pPayload.flexStartDate || undefined,
      flexAvailabilityId:
        notes.flexAvailabilityId || pPayload.flexAvailabilityId || undefined,
      seats: Number(notes.seats || pPayload.seats) || 1,
      adults: notes.adults ? Number(notes.adults) : pPayload.adults,
      children: notes.children
        ? Number(notes.children)
        : pPayload.children || 0,
      couponCode: notes.couponCode || pPayload.couponCode || "",
      platformCouponCode:
        notes.platformCouponCode || pPayload.platformCouponCode || "",
      travelers: finalTravelers,
      paymentId,
      razorpayOrderId: order.id,
      addonDays,
      addonSchedule: finalSchedule,
      addonServiceEntries:
        chargedPricingSnapshot.addonServiceEntries ||
        pPayload.addonServiceEntries ||
        [],
      addonBookingTypes:
        chargedPricingSnapshot.addonBookingTypes ||
        pPayload.addonBookingTypes ||
        {},
    },
  };

  const result = await new Promise((resolve, reject) => {
    const fakeRes = {
      status: (code) => ({
        json: (data) => {
          if (code >= 400)
            reject(new Error(data.message || "Booking creation failed"));
          else resolve(data);
        },
      }),
      json: (data) => resolve(data),
    };
    tripBookingController.createBooking(fakeReq, fakeRes).catch(reject);
  });

  const booking = result?.booking || result;
  const bookingId = booking?._id;
  const bookingRef = booking?.bookingId;

  // ── Reconciliation: honor the charged amount, flag any mismatch for admin ──
  const bookingTotal = booking?.pricing?.totalAmount;
  const orderTotalRupees = Number(order.amount) / 100;
  if (
    bookingTotal &&
    bookingId &&
    Math.abs(bookingTotal - orderTotalRupees) > 1
  ) {
    const note = `Charged ₹${orderTotalRupees} but recomputed total is ₹${bookingTotal}. A price or setting likely changed between order and payment.`;
    console.warn(`[RECONCILIATION] Booking ${bookingRef}: ${note}`);
    try {
      await TripBooking.updateOne(
        { _id: bookingId },
        {
          $set: {
            pricingMismatch: {
              flagged: true,
              chargedAmount: orderTotalRupees,
              computedAmount: bookingTotal,
              note,
              flaggedAt: new Date(),
            },
          },
        },
      );
      const { notifyAdmin } = require("./notificationController");
      notifyAdmin(
        "Pricing Mismatch — Reconcile Booking",
        `Booking ${bookingRef}: ${note}`,
        {
          type: "general",
          bookingId: String(bookingId),
        },
      );
    } catch (flagErr) {
      console.error(
        "[RECONCILIATION] failed to persist mismatch flag:",
        flagErr.message,
      );
    }
  }

  return { booking, bookingId, alreadyExisted: false };
}
async function recordCapturedPayment({ order, payment }) {
  const PendingOrder = require("../models/PendingOrder");
  if (
    !order?.id ||
    !payment?.id ||
    payment.status !== "captured" ||
    String(payment.order_id) !== String(order.id) ||
    Number(payment.amount) !== Number(order.amount) ||
    payment.currency !== order.currency
  ) {
    const error = new Error(
      "Provider payment is not a matching captured payment",
    );
    error.code = "PAYMENT_NOT_CAPTURED";
    throw error;
  }

  const current = await PendingOrder.findOne({ razorpayOrderId: order.id });
  if (!current) throw new Error("Pending payment order not found");
  if (current.providerPaymentId && current.providerPaymentId !== payment.id) {
    throw new Error("A different provider payment is already recorded");
  }

  const paidAt = new Date();
  const updated = await PendingOrder.findOneAndUpdate(
    {
      _id: current._id,
      $or: [
        { providerPaymentId: "" },
        { providerPaymentId: { $exists: false } },
        { providerPaymentId: payment.id },
      ],
    },
    {
      $set: {
        providerPaymentId: payment.id,
        amount: Number(current.amount) || Number(order.amount) / 100,
        paidAt: current.paidAt || paidAt,
        ...(current.status === "expired" &&
        !["REFUNDED", "RECONCILIATION_REQUIRED"].includes(
          current.finalizationState,
        )
          ? { status: "pending", expiredAt: null, expirationReason: "" }
          : {}),
      },
    },
    { new: true },
  );
  if (!updated) throw new Error("Could not persist captured payment");
  return updated;
}

function finalizationPendingResult(pending, message) {
  const state = pending?.finalizationState || "RETRYABLE";
  const base = {
    finalizationState: state,
    bookingId: pending?.bookingId || null,
    alreadyExisted: false,
  };
  if (state === "REFUNDED") {
    return {
      ...base,
      pending: false,
      terminal: true,
      refunded: true,
      code: "PAYMENT_REFUNDED",
      message:
        "Your payment was refunded because the booking could not be finalized.",
    };
  }
  if (state === "RECONCILIATION_REQUIRED") {
    return {
      ...base,
      pending: false,
      terminal: true,
      reconciliationRequired: true,
      code: "PAYMENT_RECONCILIATION_REQUIRED",
      message:
        "Your payment is recorded and our team is reconciling its final status.",
    };
  }
  if (["REFUND_REQUIRED", "REFUND_PROCESSING"].includes(state)) {
    return {
      ...base,
      pending: true,
      code: "PAYMENT_REFUND_PENDING",
      message:
        "Your payment is recorded and an automatic refund is being resolved.",
    };
  }
  return {
    ...base,
    pending: true,
    code: "PAYMENT_FINALIZATION_PENDING",
    message:
      message ||
      "Payment is captured and booking finalization will continue automatically.",
  };
}

async function repairCompletedPendingOrder(
  orderId,
  paymentId,
  booking,
  leaseToken = null,
) {
  const PendingOrder = require("../models/PendingOrder");
  const tripBookingController = require("./tripBookingController");
  try {
    const effects =
      await tripBookingController.ensureRequiredBookingEffects(booking);
    booking = effects.booking;
  } catch (error) {
    const immediateReconciliation =
      error.code === "BOOKING_EFFECTS_RECONCILIATION_REQUIRED";
    const effectFilter = { razorpayOrderId: orderId };
    if (leaseToken) {
      effectFilter.finalizationState = "PROCESSING";
      effectFilter.finalizationLeaseToken = leaseToken;
    }
    const nextAttempts = {
      $add: [{ $ifNull: ["$finalizationAttempts", 0] }, 1],
    };
    const exhausted = {
      $gte: [nextAttempts, POST_INSERT_EFFECT_ATTEMPT_LIMIT],
    };
    const message = String(error.message || error).slice(0, 500);
    const updated = await PendingOrder.findOneAndUpdate(
      effectFilter,
      [
        {
          $set: {
            bookingId: booking._id,
            finalizationAttempts: nextAttempts,
            finalizationState: immediateReconciliation
              ? "RECONCILIATION_REQUIRED"
              : {
                  $cond: [exhausted, "RECONCILIATION_REQUIRED", "RETRYABLE"],
                },
            finalizationLeaseToken: "",
            finalizationLeaseUntil: null,
            finalizationLastError: message,
            finalizationNextAttemptAt: immediateReconciliation
              ? null
              : {
                  $cond: [exhausted, null, new Date(Date.now() + 60 * 1000)],
                },
          },
        },
      ],
      { new: true },
    );
    if (updated?.finalizationState === "RECONCILIATION_REQUIRED") {
      await require("../models/TripBooking").updateOne(
        {
          _id: booking._id,
          requiredEffectsVersion: 1,
          requiredEffectsState: { $ne: "COMPLETED" },
        },
        { $set: { requiredEffectsState: "RECONCILIATION_REQUIRED" } },
      );
      notifyFinalizationReconciliation(
        updated,
        `Booking effects could not be finalized after ${updated.finalizationAttempts} attempts: ${message}`,
      );
    }
    return false;
  }

  if (!booking?._id || booking.requiredEffectsState !== "COMPLETED") {
    return false;
  }

  const completedAt = new Date();
  const filter = { razorpayOrderId: orderId };
  if (leaseToken) {
    filter.finalizationState = "PROCESSING";
    filter.finalizationLeaseToken = leaseToken;
  }
  const repaired = await PendingOrder.updateOne(filter, {
    $set: {
      providerPaymentId: paymentId,
      status: "completed",
      bookingId: booking._id,
      completedAt,
      finalizationState: "COMPLETED",
      finalizationLeaseToken: "",
      finalizationLeaseUntil: null,
      finalizationLastError: "",
      finalizationNextAttemptAt: null,
    },
  });
  const repairedOk =
    repaired.modifiedCount === 1 || repaired.matchedCount === 1;
  if (repairedOk) {
    await tripBookingController.deliverBookingConfirmation(booking._id);
  }
  return repairedOk;
}

async function finalizeBookingFromOrder(args) {
  const { order, paymentId } = args;
  const PendingOrder = require("../models/PendingOrder");
  const TripBooking = require("../models/TripBooking");
  const now = new Date();
  const leaseToken = crypto.randomUUID();
  const leaseUntil = new Date(now.getTime() + 2 * 60 * 1000);

  let existing = await TripBooking.findOne({ razorpayPaymentId: paymentId });
  if (existing) {
    const pending = await PendingOrder.findOne({ razorpayOrderId: order.id });
    if (
      pending &&
      ["REFUND_PROCESSING", "REFUNDED", "RECONCILIATION_REQUIRED"].includes(
        pending.finalizationState,
      )
    ) {
      return {
        ...finalizationPendingResult(pending),
        bookingId: existing._id,
      };
    }
    const repaired = await repairCompletedPendingOrder(
      order.id,
      paymentId,
      existing,
    );
    if (!repaired) {
      const refreshed = await PendingOrder.findOne({
        razorpayOrderId: order.id,
      });
      return {
        ...finalizationPendingResult(
          refreshed,
          "The booking exists and its required effects are still being reconciled.",
        ),
        bookingId: existing._id,
      };
    }
    existing = await TripBooking.findById(existing._id);
    return {
      booking: existing,
      bookingId: existing._id,
      alreadyExisted: true,
      pending: false,
      finalizationState: "COMPLETED",
    };
  }

  const claimed = await PendingOrder.findOneAndUpdate(
    {
      razorpayOrderId: order.id,
      providerPaymentId: paymentId,
      status: { $ne: "completed" },
      $or: [
        { finalizationState: { $exists: false } },
        { finalizationState: "PENDING" },
        {
          finalizationState: "RETRYABLE",
          $or: [
            { finalizationNextAttemptAt: null },
            { finalizationNextAttemptAt: { $exists: false } },
            { finalizationNextAttemptAt: { $lte: now } },
          ],
        },
        {
          finalizationState: "PROCESSING",
          finalizationLeaseUntil: { $lte: now },
        },
      ],
    },
    {
      $set: {
        finalizationState: "PROCESSING",
        finalizationLeaseToken: leaseToken,
        finalizationLeaseUntil: leaseUntil,
        finalizationLastError: "",
        finalizationNextAttemptAt: null,
      },
      $inc: { finalizationAttempts: 1 },
    },
    { new: true },
  );

  if (!claimed) {
    existing = await TripBooking.findOne({ razorpayPaymentId: paymentId });
    const pending = await PendingOrder.findOne({ razorpayOrderId: order.id });
    if (existing) {
      if (
        pending &&
        ["REFUND_PROCESSING", "REFUNDED", "RECONCILIATION_REQUIRED"].includes(
          pending.finalizationState,
        )
      ) {
        return {
          ...finalizationPendingResult(pending),
          bookingId: existing._id,
        };
      }
      const repaired = await repairCompletedPendingOrder(
        order.id,
        paymentId,
        existing,
      );
      if (!repaired) {
        const refreshed = await PendingOrder.findOne({
          razorpayOrderId: order.id,
        });
        return {
          ...finalizationPendingResult(
            refreshed,
            "The booking exists and its required effects are still being reconciled.",
          ),
          bookingId: existing._id,
        };
      }
      existing = await TripBooking.findById(existing._id);
      return {
        booking: existing,
        bookingId: existing._id,
        alreadyExisted: true,
        pending: false,
        finalizationState: "COMPLETED",
      };
    }
    return finalizationPendingResult(
      pending,
      pending?.finalizationState === "PROCESSING"
        ? "Payment is captured and booking finalization is already in progress."
        : undefined,
    );
  }

  try {
    const result = await createBookingFromPaidOrder({
      ...args,
      finalizationLeaseToken: leaseToken,
    });
    const completedBooking =
      result.booking ||
      (await TripBooking.findOne({ razorpayPaymentId: paymentId }));
    if (!completedBooking)
      throw new Error("Booking finalization returned no booking");
    const repaired = await repairCompletedPendingOrder(
      order.id,
      paymentId,
      completedBooking,
      leaseToken,
    );
    if (!repaired) {
      const pending = await PendingOrder.findOne({ razorpayOrderId: order.id });
      return {
        ...finalizationPendingResult(
          pending,
          "A booking record exists and its payment state is being reconciled.",
        ),
        bookingId: completedBooking._id,
      };
    }
    const publishedBooking = await TripBooking.findById(completedBooking._id);
    return {
      ...result,
      booking: publishedBooking,
      bookingId: publishedBooking?._id || result.bookingId,
      pending: false,
      finalizationState: "COMPLETED",
    };
  } catch (error) {
    existing = await TripBooking.findOne({ razorpayPaymentId: paymentId });
    if (existing) {
      const repaired = await repairCompletedPendingOrder(
        order.id,
        paymentId,
        existing,
        leaseToken,
      );
      if (repaired) {
        existing = await TripBooking.findById(existing._id);
        return {
          booking: existing,
          bookingId: existing._id,
          alreadyExisted: true,
          pending: false,
          finalizationState: "COMPLETED",
        };
      }
      const pending = await PendingOrder.findOne({ razorpayOrderId: order.id });
      return {
        ...finalizationPendingResult(
          pending,
          "A booking record exists and its payment state is being reconciled.",
        ),
        bookingId: existing._id,
      };
    }

    const message = String(error.message || error).slice(0, 500);
    if (error.code === "CHARGED_PRICING_SNAPSHOT_MISSING") {
      const reconciled = await PendingOrder.findOneAndUpdate(
        {
          _id: claimed._id,
          finalizationState: "PROCESSING",
          finalizationLeaseToken: leaseToken,
        },
        {
          $set: {
            finalizationState: "RECONCILIATION_REQUIRED",
            finalizationLeaseToken: "",
            finalizationLeaseUntil: null,
            finalizationLastError: message,
            finalizationNextAttemptAt: null,
          },
        },
        { new: true },
      );
      return finalizationPendingResult(reconciled || claimed, message);
    }
    const attempts = Number(claimed.finalizationAttempts) || 1;
    const refundRequired = attempts >= 5;
    const retryMinutes = Math.min(15, 2 ** Math.max(0, attempts - 1));
    const updated = await PendingOrder.findOneAndUpdate(
      {
        _id: claimed._id,
        finalizationState: "PROCESSING",
        finalizationLeaseToken: leaseToken,
      },
      {
        $set: {
          finalizationState: refundRequired ? "REFUND_REQUIRED" : "RETRYABLE",
          finalizationLeaseToken: "",
          finalizationLeaseUntil: null,
          finalizationLastError: message,
          finalizationNextAttemptAt: refundRequired
            ? new Date(Date.now() + 15 * 60 * 1000)
            : new Date(Date.now() + retryMinutes * 60 * 1000),
        },
      },
      { new: true },
    );
    return finalizationPendingResult(updated || claimed, message);
  }
}
exports.recordCapturedPayment = recordCapturedPayment;
exports.finalizeBookingFromOrder = finalizeBookingFromOrder;

/**
 * Safety-net job: recover bookings for orders that were PAID but never verified
 * (e.g. the app was killed right after checkout). Runs on a short interval.
 * Idempotent via finalizeBookingFromOrder + the PendingOrder status flag.
 */
async function notifyFinalizationReconciliation(pending, message) {
  try {
    const { notifyAdmin } = require("./notificationController");
    notifyAdmin(
      "Paid Booking Requires Reconciliation",
      `Order ${pending.razorpayOrderId}: ${message}`,
      {
        type: "general",
        orderId: pending.razorpayOrderId,
        paymentId: pending.providerPaymentId || "",
      },
    );
  } catch {}
}

async function markRefundReconciliation(pending, message) {
  const PendingOrder = require("../models/PendingOrder");
  const bounded = String(message || "Refund requires reconciliation").slice(
    0,
    500,
  );
  const updated = await PendingOrder.findOneAndUpdate(
    { _id: pending._id, finalizationState: "REFUND_PROCESSING" },
    {
      $set: {
        finalizationState: "RECONCILIATION_REQUIRED",
        finalizationLeaseToken: "",
        finalizationLeaseUntil: null,
        refundError: bounded,
      },
    },
    { new: true },
  );
  if (updated) notifyFinalizationReconciliation(updated, bounded);
  return updated;
}

async function releasePendingReservation(pending) {
  const seats = Math.max(
    0,
    Number(
      pending.payload?.seats || pending.chargedPricingSnapshot?.source?.seats,
    ) || 0,
  );
  const bookingMode =
    pending.payload?.bookingMode ||
    pending.chargedPricingSnapshot?.source?.bookingMode ||
    (pending.batchId ? "batch" : "flexible");

  if (bookingMode === "batch") {
    const batchId =
      pending.batchId ||
      pending.payload?.batchId ||
      pending.chargedPricingSnapshot?.source?.batchId;
    const claimKey = String(
      pending.batchReservationClaimKey || pending.razorpayOrderId || "",
    );
    if (!batchId || !claimKey) return;
    const Batch = require("../models/Batch");
    const {
      buildReservationReleaseFilter,
      buildReservationReleasePipeline,
    } = require("../utils/inventoryClaims");
    await Batch.updateOne(
      buildReservationReleaseFilter({ id: batchId, claimKey }),
      buildReservationReleasePipeline({ claimKey, seats }),
    );
    return;
  }

  const inventoryId =
    pending.flexInventoryId ||
    pending.chargedPricingSnapshot?.source?.flexInventoryId;
  const claimKey = String(
    pending.flexReservationClaimKey || pending.razorpayOrderId || "",
  );
  if (!inventoryId || !claimKey) return;
  const FlexibleDateInventory = require("../models/FlexibleDateInventory");
  await FlexibleDateInventory.updateOne(
    {
      _id: inventoryId,
      reservationClaimKeys: claimKey,
      inventoryReleaseClaimKeys: { $ne: claimKey },
    },
    [
      {
        $set: {
          bookedSeats: {
            $max: [0, { $subtract: [{ $ifNull: ["$bookedSeats", 0] }, seats] }],
          },
          inventoryReleaseClaimKeys: {
            $setUnion: [
              { $ifNull: ["$inventoryReleaseClaimKeys", []] },
              [claimKey],
            ],
          },
        },
      },
    ],
  );
  const flexAvailabilityId =
    pending.flexAvailabilityId || pending.payload?.flexAvailabilityId;
  if (flexAvailabilityId) {
    const FlexibleAvailability = require("../models/FlexibleAvailability");
    await FlexibleAvailability.updateOne(
      {
        _id: flexAvailabilityId,
        inventoryReservationClaimKeys: claimKey,
        inventoryReleaseClaimKeys: { $ne: claimKey },
      },
      [
        {
          $set: {
            bookedSeats: {
              $max: [
                0,
                { $subtract: [{ $ifNull: ["$bookedSeats", 0] }, seats] },
              ],
            },
            inventoryReleaseClaimKeys: {
              $setUnion: [
                { $ifNull: ["$inventoryReleaseClaimKeys", []] },
                [claimKey],
              ],
            },
          },
        },
      ],
    );
  }
}
exports.releasePendingReservation = releasePendingReservation;

async function attemptCompensatingRefund(pending) {
  const PendingOrder = require("../models/PendingOrder");
  const TripBooking = require("../models/TripBooking");
  let existing = await TripBooking.findOne({
    razorpayPaymentId: pending.providerPaymentId,
  });
  if (existing) {
    const repaired = await repairCompletedPendingOrder(
      pending.razorpayOrderId,
      pending.providerPaymentId,
      existing,
    );
    return {
      claimed: false,
      bookingRecovered: repaired,
      reconciliationRequired: !repaired,
    };
  }

  const token = crypto.randomUUID();
  const claimed = await PendingOrder.findOneAndUpdate(
    {
      _id: pending._id,
      finalizationState: "REFUND_REQUIRED",
      $or: [
        { finalizationNextAttemptAt: null },
        { finalizationNextAttemptAt: { $exists: false } },
        { finalizationNextAttemptAt: { $lte: new Date() } },
      ],
    },
    {
      $set: {
        finalizationState: "REFUND_PROCESSING",
        finalizationLeaseToken: token,
        finalizationLeaseUntil: new Date(Date.now() + 5 * 60 * 1000),
        refundStatus: "PROCESSING",
        refundError: "",
        refundAttemptedAt: new Date(),
      },
    },
    { new: true },
  );
  if (!claimed) return { claimed: false };

  existing = await TripBooking.findOne({
    razorpayPaymentId: claimed.providerPaymentId,
  });
  if (existing) {
    const repaired = await repairCompletedPendingOrder(
      claimed.razorpayOrderId,
      claimed.providerPaymentId,
      existing,
    );
    return {
      claimed: true,
      bookingRecovered: repaired,
      reconciliationRequired: !repaired,
    };
  }

  const { refundPayment } = require("../utils/razorpayRefund");
  const result = await refundPayment(
    claimed.providerPaymentId,
    Number(claimed.amount) || 0,
    {
      orderId: claimed.razorpayOrderId,
      reason: "Booking finalization failed",
    },
  );

  if (result.success && result.status === "processed") {
    try {
      await releasePendingReservation(claimed);
    } catch (error) {
      const reconciled = await PendingOrder.findOneAndUpdate(
        {
          _id: claimed._id,
          finalizationState: "REFUND_PROCESSING",
          finalizationLeaseToken: token,
        },
        {
          $set: {
            finalizationState: "RECONCILIATION_REQUIRED",
            finalizationLeaseToken: "",
            finalizationLeaseUntil: null,
            refundId: result.refundId || "",
            refundStatus: "REFUNDED",
            refundError:
              `Refund completed but reserved inventory release failed: ${error.message}`.slice(
                0,
                500,
              ),
          },
        },
        { new: true },
      );
      if (reconciled)
        notifyFinalizationReconciliation(reconciled, reconciled.refundError);
      return { claimed: true, refunded: true, reconciliationRequired: true };
    }
    await PendingOrder.updateOne(
      {
        _id: claimed._id,
        finalizationState: "REFUND_PROCESSING",
        finalizationLeaseToken: token,
      },
      {
        $set: {
          status: "expired",
          expiredAt: new Date(),
          expirationReason: "compensating_refund",
          finalizationState: "REFUNDED",
          finalizationLeaseToken: "",
          finalizationLeaseUntil: null,
          refundId: result.refundId || "",
          refundStatus: "REFUNDED",
          refundError: "",
        },
      },
    );
    return { claimed: true, refunded: true };
  }

  if (result.success) {
    await PendingOrder.updateOne(
      {
        _id: claimed._id,
        finalizationState: "REFUND_PROCESSING",
        finalizationLeaseToken: token,
      },
      {
        $set: {
          refundId: result.refundId || "",
          refundStatus: result.status || "PROCESSING",
          refundError:
            "Provider accepted the refund but completion is not confirmed",
        },
      },
    );
    return { claimed: true, ambiguous: true };
  }

  const message = result.error || "Compensating refund failed";
  const reconciled = await PendingOrder.findOneAndUpdate(
    {
      _id: claimed._id,
      finalizationState: "REFUND_PROCESSING",
      finalizationLeaseToken: token,
    },
    {
      $set: {
        finalizationState: "RECONCILIATION_REQUIRED",
        finalizationLeaseToken: "",
        finalizationLeaseUntil: null,
        refundStatus: "FAILED",
        refundError: String(message).slice(0, 500),
      },
    },
    { new: true },
  );
  if (reconciled) notifyFinalizationReconciliation(reconciled, message);
  return { claimed: true, reconciliationRequired: true };
}

async function reconcileCompensatingRefund(pending) {
  const PendingOrder = require("../models/PendingOrder");
  const token = crypto.randomUUID();
  const claimed = await PendingOrder.findOneAndUpdate(
    {
      _id: pending._id,
      finalizationState: "REFUND_PROCESSING",
      $or: [
        { finalizationLeaseUntil: null },
        { finalizationLeaseUntil: { $exists: false } },
        { finalizationLeaseUntil: { $lte: new Date() } },
      ],
    },
    {
      $set: {
        finalizationLeaseToken: token,
        finalizationLeaseUntil: new Date(Date.now() + 5 * 60 * 1000),
      },
    },
    { new: true },
  );
  if (!claimed) return { claimed: false };

  const refundFetcher = getRazorpay().refunds?.fetch;
  if (!claimed.refundId || typeof refundFetcher !== "function") {
    const reconciled = await markRefundReconciliation(
      claimed,
      !claimed.refundId
        ? "Compensating refund has no provider refund id; manual reconciliation is required"
        : "Configured payment SDK cannot fetch refund status; manual reconciliation is required",
    );
    return { claimed: true, reconciliationRequired: Boolean(reconciled) };
  }

  let providerRefund;
  try {
    providerRefund = await refundFetcher.call(
      getRazorpay().refunds,
      claimed.refundId,
    );
  } catch (error) {
    const reconciled = await markRefundReconciliation(
      claimed,
      `Could not fetch compensating refund status: ${error.message}`,
    );
    return { claimed: true, reconciliationRequired: Boolean(reconciled) };
  }

  if (providerRefund?.status === "processed") {
    try {
      await releasePendingReservation(claimed);
    } catch (error) {
      const reconciled = await PendingOrder.findOneAndUpdate(
        {
          _id: claimed._id,
          finalizationState: "REFUND_PROCESSING",
          finalizationLeaseToken: token,
        },
        {
          $set: {
            finalizationState: "RECONCILIATION_REQUIRED",
            finalizationLeaseToken: "",
            finalizationLeaseUntil: null,
            refundStatus: "REFUNDED",
            refundError:
              `Refund completed but reserved inventory release failed: ${error.message}`.slice(
                0,
                500,
              ),
          },
        },
        { new: true },
      );
      if (reconciled)
        notifyFinalizationReconciliation(reconciled, reconciled.refundError);
      return { claimed: true, refunded: true, reconciliationRequired: true };
    }
    const settled = await PendingOrder.updateOne(
      {
        _id: claimed._id,
        finalizationState: "REFUND_PROCESSING",
        finalizationLeaseToken: token,
      },
      {
        $set: {
          status: "expired",
          expiredAt: new Date(),
          expirationReason: "compensating_refund",
          finalizationState: "REFUNDED",
          finalizationLeaseToken: "",
          finalizationLeaseUntil: null,
          refundStatus: "REFUNDED",
          refundError: "",
        },
      },
    );
    return { claimed: true, refunded: settled.modifiedCount === 1 };
  }

  if (["pending", "processing"].includes(providerRefund?.status)) {
    const pendingUpdate = await PendingOrder.updateOne(
      {
        _id: claimed._id,
        finalizationState: "REFUND_PROCESSING",
        finalizationLeaseToken: token,
      },
      {
        $set: {
          finalizationLeaseToken: "",
          finalizationLeaseUntil: new Date(Date.now() + 10 * 60 * 1000),
          refundStatus: "PROCESSING",
          refundError: "Provider refund is still pending",
        },
      },
    );
    return { claimed: true, pending: pendingUpdate.modifiedCount === 1 };
  }

  const reconciled = await markRefundReconciliation(
    claimed,
    `Provider refund status is '${providerRefund?.status || "unknown"}'`,
  );
  return { claimed: true, reconciliationRequired: Boolean(reconciled) };
}

async function synchronizeAppliedAddonLegacyFields(booking) {
  const TripBooking = require("../models/TripBooking");
  const legacy = require("../utils/canonicalAddonServices").entriesToLegacy(
    booking.addonServiceEntries || [],
  );
  await TripBooking.updateOne(
    { _id: booking._id },
    {
      $set: {
        addonDays: legacy.addonDays,
        addonSchedule: legacy.schedule,
        addonBookingTypes: legacy.bookingTypes,
        addonNames: [
          ...new Set(
            (booking.addonServiceEntries || []).map(
              (entry) => entry.displayName,
            ),
          ),
        ],
      },
    },
  );
}

async function applyCapturedAddonPurchase(ledgerId) {
  const AddonPurchase = require("../models/AddonPurchase");
  const TripBooking = require("../models/TripBooking");
  let ledger = await AddonPurchase.findById(ledgerId);
  if (!ledger) return { state: "NOT_FOUND" };
  if (ledger.status === "APPLIED") {
    return { state: "APPLIED", bookingId: ledger.bookingId };
  }
  if (
    [
      "REFUND_PROCESSING",
      "REFUNDED",
      "RECONCILIATION_REQUIRED",
      "EXPIRED",
    ].includes(ledger.status)
  ) {
    return {
      state: ledger.status,
      bookingId: ledger.bookingId,
      refundId: ledger.refundId || "",
    };
  }
  if (!ledger.razorpayPaymentId) {
    await AddonPurchase.updateOne(
      { _id: ledger._id },
      {
        $set: {
          status: "RECONCILIATION_REQUIRED",
          applicationError:
            "Captured add-on purchase is missing its provider payment id",
        },
      },
    );
    return { state: "RECONCILIATION_REQUIRED" };
  }

  let booking = await TripBooking.findById(ledger.bookingId);
  const alreadyApplied =
    booking?.status === "CONFIRMED" &&
    ledger.entryKeys.every((key) =>
      (booking.addonServiceEntries || []).some(
        (entry) =>
          entry.key === key &&
          entry.paymentSource?.orderId === ledger.razorpayOrderId,
      ),
    );
  if (alreadyApplied) {
    await synchronizeAppliedAddonLegacyFields(booking);
    const repaired = await AddonPurchase.findOneAndUpdate(
      {
        _id: ledger._id,
        status: { $in: ["CAPTURED", "PROCESSING"] },
        refundStatus: "NONE",
      },
      {
        $set: {
          status: "APPLIED",
          appliedAt: ledger.appliedAt || new Date(),
          leaseToken: "",
          leaseUntil: null,
          applicationError: "",
        },
      },
      { new: true },
    );
    if (repaired || ledger.status === "APPLIED") {
      return { state: "APPLIED", bookingId: booking._id, repaired: true };
    }
    ledger = await AddonPurchase.findById(ledger._id);
    return { state: ledger?.status || "RECONCILIATION_REQUIRED" };
  }

  let eligibilityError = null;
  if (!booking || booking.status !== "CONFIRMED") {
    eligibilityError = new Error("The booking is no longer confirmed.");
  } else {
    try {
      require("../utils/canonicalAddonServices").revalidateFrozenEntryTiming(
        ledger.entries,
      );
      if (
        ledger.entryKeys.some((key) =>
          (booking.addonAppliedEntryKeys || []).includes(key),
        )
      ) {
        eligibilityError = new Error(
          "A creator service for this day was already applied.",
        );
      }
    } catch (error) {
      eligibilityError = error;
    }
  }
  if (eligibilityError) {
    const refund = await refundAddonPurchaseLedger(
      ledger,
      ledger.razorpayPaymentId,
      eligibilityError.message,
    );
    return {
      state: refund.reconciliation
        ? "RECONCILIATION_REQUIRED"
        : refund.refunded
          ? "REFUNDED"
          : "REFUND_PROCESSING",
      bookingId: ledger.bookingId,
      ...refund,
    };
  }

  const leaseToken = crypto.randomUUID();
  const now = new Date();
  ledger = await AddonPurchase.findOneAndUpdate(
    {
      _id: ledger._id,
      razorpayPaymentId: { $gt: "" },
      refundStatus: "NONE",
      $or: [
        { status: "CAPTURED" },
        {
          status: "PROCESSING",
          $or: [
            { leaseUntil: null },
            { leaseUntil: { $exists: false } },
            { leaseUntil: { $lte: now } },
          ],
        },
      ],
    },
    {
      $set: {
        status: "PROCESSING",
        leaseToken,
        leaseUntil: new Date(now.getTime() + 5 * 60 * 1000),
        applicationError: "",
      },
      $inc: { applicationAttempts: 1 },
    },
    { new: true },
  );
  if (!ledger) {
    const current = await AddonPurchase.findById(ledgerId);
    return {
      state: current?.status || "PROCESSING",
      bookingId: current?.bookingId,
    };
  }

  const pricing = ledger.pricing || {};
  const applied = await TripBooking.findOneAndUpdate(
    {
      _id: ledger.bookingId,
      userId: ledger.userId,
      status: "CONFIRMED",
      addonEntryClaims: { $all: ledger.entryKeys },
      addonAppliedEntryKeys: { $nin: ledger.entryKeys },
    },
    [
      {
        $set: {
          addonServiceEntries: {
            $concatArrays: [
              { $ifNull: ["$addonServiceEntries", []] },
              ledger.entries,
            ],
          },
          addonAppliedEntryKeys: {
            $setUnion: [
              { $ifNull: ["$addonAppliedEntryKeys", []] },
              ledger.entryKeys,
            ],
          },
          addonTopupPaymentIds: {
            $setUnion: [
              { $ifNull: ["$addonTopupPaymentIds", []] },
              [ledger.razorpayPaymentId],
            ],
          },
          addonSurcharge: {
            $add: [
              { $ifNull: ["$addonSurcharge", 0] },
              Number(pricing.addonSurcharge) || 0,
            ],
          },
          addonTotalPrice: {
            $add: [
              { $ifNull: ["$addonTotalPrice", 0] },
              Number(pricing.addonTotalPrice) || 0,
            ],
          },
          addonHeld: true,
          addonDispatched: false,
          pricing: {
            $mergeObjects: [
              "$pricing",
              {
                addonAmount: {
                  $add: [
                    { $ifNull: ["$pricing.addonAmount", 0] },
                    Number(pricing.addonTotalPrice) || 0,
                  ],
                },
                gstAmount: {
                  $add: [
                    { $ifNull: ["$pricing.gstAmount", 0] },
                    Number(pricing.gstOnAddon) || 0,
                  ],
                },
                totalAmount: {
                  $add: [
                    { $ifNull: ["$pricing.totalAmount", 0] },
                    Number(pricing.totalAmount) || 0,
                  ],
                },
                operatorAmount: {
                  $add: [
                    { $ifNull: ["$pricing.operatorAmount", 0] },
                    Number(pricing.addonSurcharge) || 0,
                  ],
                },
              },
            ],
          },
        },
      },
    ],
    { new: true },
  );
  if (!applied) {
    const refund = await refundAddonPurchaseLedger(
      ledger,
      ledger.razorpayPaymentId,
      "Booking eligibility or canonical add-on claim changed before application",
    );
    return {
      state: refund.reconciliation
        ? "RECONCILIATION_REQUIRED"
        : refund.refunded
          ? "REFUNDED"
          : "REFUND_PROCESSING",
      bookingId: ledger.bookingId,
      ...refund,
    };
  }

  await synchronizeAppliedAddonLegacyFields(applied);
  const finalized = await AddonPurchase.updateOne(
    { _id: ledger._id, status: "PROCESSING", leaseToken },
    {
      $set: {
        status: "APPLIED",
        appliedAt: new Date(),
        leaseToken: "",
        leaseUntil: null,
        applicationError: "",
      },
    },
  );
  if (finalized.matchedCount !== 1) {
    const current = await AddonPurchase.findById(ledger._id);
    return {
      state: current?.status || "RECONCILIATION_REQUIRED",
      bookingId: ledger.bookingId,
    };
  }
  return { state: "APPLIED", bookingId: applied._id };
}

async function recoverAddonPurchaseState(results) {
  const AddonPurchase = require("../models/AddonPurchase");
  const AddonEntryRefund = require("../models/AddonEntryRefund");
  const TripBooking = require("../models/TripBooking");
  const { fetchRefundStatus } = require("../utils/razorpayRefund");
  const expiryAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const pendingPurchases = await AddonPurchase.find({
    status: "PENDING",
    createdAt: { $lte: expiryAgo },
  })
    .sort({ createdAt: 1 })
    .limit(100);
  for (const purchase of pendingPurchases) {
    try {
      const [order, paymentList] = await Promise.all([
        getRazorpay().orders.fetch(purchase.razorpayOrderId),
        getRazorpay().orders.fetchPayments(purchase.razorpayOrderId),
      ]);
      const captured = (paymentList?.items || []).find(
        (payment) =>
          payment.status === "captured" &&
          payment.order_id === purchase.razorpayOrderId &&
          Number(payment.amount) === Number(purchase.amountPaise) &&
          String(payment.currency).toUpperCase() ===
            String(purchase.currency).toUpperCase(),
      );
      if (
        captured &&
        Number(order.amount) === Number(purchase.amountPaise) &&
        String(order.currency).toUpperCase() ===
          String(purchase.currency).toUpperCase()
      ) {
        await AddonPurchase.updateOne(
          { _id: purchase._id, status: "PENDING" },
          {
            $set: {
              status: "CAPTURED",
              razorpayPaymentId: captured.id,
              paidAt: new Date(),
            },
          },
        );
        const capturedLedger = await AddonPurchase.findById(purchase._id);
        const capturedBooking = await TripBooking.findById(
          purchase.bookingId,
        ).select("status");
        if (capturedLedger && capturedBooking?.status !== "CONFIRMED") {
          await refundAddonPurchaseLedger(
            capturedLedger,
            captured.id,
            "Booking was no longer confirmed when captured top-up was recovered",
          );
        }
        results.addonCaptured = (results.addonCaptured || 0) + 1;
        continue;
      }
      const releasable =
        inspectReleaseProviderState({
          order,
          paymentList,
          outcome: "user_closed",
        }).releasable ||
        inspectReleaseProviderState({
          order,
          paymentList,
          outcome: "definitive_decline",
        }).releasable;
      if (!releasable) continue;
      const expired = await AddonPurchase.findOneAndUpdate(
        { _id: purchase._id, status: "PENDING" },
        { $set: { status: "EXPIRED", expiredAt: new Date() } },
        { new: true },
      );
      if (expired) {
        await TripBooking.updateOne(
          { _id: expired.bookingId },
          { $pull: { addonEntryClaims: { $in: expired.entryKeys } } },
        );
        results.addonExpired = (results.addonExpired || 0) + 1;
      }
    } catch (error) {
      results.errors.push(
        `Add-on order ${purchase.razorpayOrderId}: ${error.message}`,
      );
    }
  }

  const applicationNow = new Date();
  const applicationCandidates = await AddonPurchase.find({
    razorpayPaymentId: { $gt: "" },
    refundStatus: "NONE",
    $or: [
      { status: "CAPTURED" },
      {
        status: "PROCESSING",
        $or: [
          { leaseUntil: null },
          { leaseUntil: { $exists: false } },
          { leaseUntil: { $lte: applicationNow } },
        ],
      },
    ],
  })
    .sort({ paidAt: 1, createdAt: 1, _id: 1 })
    .limit(100);
  for (const purchase of applicationCandidates) {
    try {
      const application = await applyCapturedAddonPurchase(purchase._id);
      if (application.state === "APPLIED") {
        results.addonApplied = (results.addonApplied || 0) + 1;
      } else if (application.state === "REFUNDED") {
        results.addonRefunded = (results.addonRefunded || 0) + 1;
      } else if (application.state === "RECONCILIATION_REQUIRED") {
        results.reconciliationRequired =
          (results.reconciliationRequired || 0) + 1;
      }
    } catch (error) {
      results.errors.push(
        `Add-on application ${purchase.razorpayOrderId}: ${error.message}`,
      );
    }
  }

  const ambiguousBefore = new Date(Date.now() - 10 * 60 * 1000);
  await AddonPurchase.updateMany(
    {
      refundStatus: "PROCESSING",
      refundId: "",
      updatedAt: { $lte: ambiguousBefore },
    },
    {
      $set: {
        status: "RECONCILIATION_REQUIRED",
        refundStatus: "RECONCILIATION_REQUIRED",
        refundError:
          "Refund submission has no persisted provider id; manual reconciliation is required",
      },
    },
  );
  await AddonEntryRefund.updateMany(
    {
      status: "PROCESSING",
      refundId: "",
      updatedAt: { $lte: ambiguousBefore },
    },
    {
      $set: {
        status: "RECONCILIATION_REQUIRED",
        error:
          "Refund submission has no persisted provider id; manual reconciliation is required",
      },
    },
  );

  const pendingPurchaseRefunds = await AddonPurchase.find({
    refundStatus: "PROCESSING",
    refundId: { $gt: "" },
  }).limit(100);
  for (const purchase of pendingPurchaseRefunds) {
    const provider = await fetchRefundStatus(purchase.refundId);
    if (!provider.supported || !provider.success) {
      await AddonPurchase.updateOne(
        { _id: purchase._id, refundStatus: "PROCESSING" },
        {
          $set: {
            status: "RECONCILIATION_REQUIRED",
            refundStatus: "RECONCILIATION_REQUIRED",
            refundError:
              provider.error || "Provider refund status polling is unavailable",
          },
        },
      );
      continue;
    }
    if (provider.status === "processed") {
      await AddonPurchase.updateOne(
        { _id: purchase._id, refundStatus: "PROCESSING" },
        {
          $set: {
            status: "REFUNDED",
            refundStatus: "REFUNDED",
            refundedAt: new Date(),
            refundError: "",
            partialRefundInFlight: false,
          },
        },
      );
      await TripBooking.updateOne(
        { _id: purchase.bookingId },
        { $pull: { addonEntryClaims: { $in: purchase.entryKeys } } },
      );
      results.addonRefundsSettled = (results.addonRefundsSettled || 0) + 1;
    } else if (!["pending", "processed"].includes(String(provider.status))) {
      await AddonPurchase.updateOne(
        { _id: purchase._id, refundStatus: "PROCESSING" },
        {
          $set: {
            status: "RECONCILIATION_REQUIRED",
            refundStatus: "RECONCILIATION_REQUIRED",
            refundError: `Provider refund status is '${provider.status}'`,
          },
        },
      );
    }
  }

  const pendingEntryRefunds = await AddonEntryRefund.find({
    status: "PROCESSING",
    refundId: { $gt: "" },
  }).limit(100);
  for (const entryRefund of pendingEntryRefunds) {
    const provider = await fetchRefundStatus(entryRefund.refundId);
    if (!provider.supported || !provider.success) {
      await AddonEntryRefund.updateOne(
        { _id: entryRefund._id, status: "PROCESSING" },
        {
          $set: {
            status: "RECONCILIATION_REQUIRED",
            error:
              provider.error || "Provider refund status polling is unavailable",
          },
        },
      );
      continue;
    }
    if (provider.status === "processed") {
      await AddonEntryRefund.updateOne(
        { _id: entryRefund._id, status: "PROCESSING" },
        { $set: { status: "REFUNDED", refundedAt: new Date(), error: "" } },
      );
      const booking = await TripBooking.findById(entryRefund.bookingId);
      if (booking?.snapjaBookings?.[entryRefund.entryKey]) {
        booking.snapjaBookings[entryRefund.entryKey].refundState = "REFUNDED";
        booking.snapjaBookings[entryRefund.entryKey].refundId =
          entryRefund.refundId;
        booking.markModified("snapjaBookings");
        await booking.save();
      }
      results.addonEntryRefundsSettled =
        (results.addonEntryRefundsSettled || 0) + 1;
    } else if (!["pending", "processed"].includes(String(provider.status))) {
      await AddonEntryRefund.updateOne(
        { _id: entryRefund._id, status: "PROCESSING" },
        {
          $set: {
            status: "RECONCILIATION_REQUIRED",
            error: `Provider refund status is '${provider.status}'`,
          },
        },
      );
    }
  }
}

exports.runOrphanPaymentRecovery = async function () {
  const results = {
    recovered: 0,
    expired: 0,
    refunded: 0,
    reconciliationRequired: 0,
    confirmationDelivered: 0,
    checked: 0,
    errors: [],
  };
  try {
    const PendingOrder = require("../models/PendingOrder");
    const now = new Date();
    const graceAgo = new Date(now.getTime() - 10 * 60 * 1000);
    const expiryAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const pendingOrders = await PendingOrder.find({
      $or: [
        {
          status: "pending",
          createdAt: { $lte: graceAgo },
          $or: [
            { providerPaymentId: "" },
            { providerPaymentId: { $exists: false } },
          ],
        },
        {
          providerPaymentId: { $gt: "" },
          $or: [
            { finalizationState: { $exists: false } },
            { finalizationState: "PENDING" },
            {
              finalizationState: "RETRYABLE",
              $or: [
                { finalizationNextAttemptAt: null },
                { finalizationNextAttemptAt: { $exists: false } },
                { finalizationNextAttemptAt: { $lte: now } },
              ],
            },
            {
              finalizationState: "PROCESSING",
              finalizationLeaseUntil: { $lte: now },
            },
            {
              finalizationState: "REFUND_REQUIRED",
              $or: [
                { finalizationNextAttemptAt: null },
                { finalizationNextAttemptAt: { $exists: false } },
                { finalizationNextAttemptAt: { $lte: now } },
              ],
            },
            {
              finalizationState: "REFUND_PROCESSING",
              finalizationLeaseUntil: { $lte: now },
            },
          ],
        },
      ],
    })
      .sort({ finalizationNextAttemptAt: 1, createdAt: 1 })
      .limit(100);

    for (let po of pendingOrders) {
      results.checked++;
      try {
        if (po.finalizationState === "REFUND_PROCESSING") {
          const refund = await reconcileCompensatingRefund(po);
          if (refund.refunded) results.refunded++;
          if (refund.reconciliationRequired) results.reconciliationRequired++;
          continue;
        }
        if (po.finalizationState === "REFUND_REQUIRED") {
          const refund = await attemptCompensatingRefund(po);
          if (refund.refunded) results.refunded++;
          if (refund.reconciliationRequired) results.reconciliationRequired++;
          continue;
        }

        const order = await getRazorpay().orders.fetch(po.razorpayOrderId);
        let payment = null;
        if (po.providerPaymentId) {
          payment = await getRazorpay().payments.fetch(po.providerPaymentId);
        } else if (order?.status === "paid") {
          const list = await getRazorpay().orders.fetchPayments(
            po.razorpayOrderId,
          );
          const captured = (list?.items || []).find(
            (item) => item.status === "captured",
          );
          if (captured?.id) {
            payment = await getRazorpay().payments.fetch(captured.id);
          }
        }

        if (payment?.status === "captured") {
          po = await recordCapturedPayment({ order, payment });
          const finalized = await finalizeBookingFromOrder({
            order,
            paymentId: payment.id,
          });
          if (
            finalized.finalizationState === "COMPLETED" &&
            finalized.bookingId
          ) {
            results.recovered++;
          }
          continue;
        }

        if (!po.providerPaymentId && po.createdAt <= expiryAgo) {
          const expired = await PendingOrder.updateOne(
            {
              _id: po._id,
              status: "pending",
              $or: [
                { providerPaymentId: "" },
                { providerPaymentId: { $exists: false } },
              ],
            },
            {
              $set: {
                status: "expired",
                expiredAt: new Date(),
                expirationReason: "unpaid_timeout",
              },
            },
          );
          if (expired.modifiedCount === 1) results.expired++;
        }
      } catch (error) {
        results.errors.push(`Recover ${po.razorpayOrderId}: ${error.message}`);
      }
    }

    const TripBooking = require("../models/TripBooking");
    const confirmationController = require("./tripBookingController");
    const undelivered = await TripBooking.find({
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
    })
      .select("_id")
      .limit(100);
    for (const booking of undelivered) {
      try {
        if (
          await confirmationController.deliverBookingConfirmation(booking._id)
        ) {
          results.confirmationDelivered++;
        }
      } catch (error) {
        results.errors.push(`Confirmation ${booking._id}: ${error.message}`);
      }
    }
  } catch (error) {
    results.errors.push(`Orphan payment recovery: ${error.message}`);
  }
  try {
    await recoverAddonPurchaseState(results);
  } catch (error) {
    results.errors.push(`Add-on payment recovery: ${error.message}`);
  }
  return results;
};

/**
 * POST /api/payments/verify
 * Verifies Razorpay payment signature and creates the booking
 */
exports.verifyPayment = async (req, res) => {
  let captureObserved = false;
  let captureConfirmed = false;
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      orderId,
    } = req.body;

    console.log("[Payment Verify] Received:", {
      razorpay_order_id,
      razorpay_payment_id,
      hasSignature: !!razorpay_signature,
      orderId,
    });

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Missing payment verification fields",
      });
    }

    // Verify signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      console.error("[verifyPayment] signature mismatch", {
        razorpay_order_id,
        razorpay_payment_id,
        keyIdInUse: process.env.RAZORPAY_KEY_ID,
        secretLoaded: !!process.env.RAZORPAY_KEY_SECRET,
      });
      return res.status(400).json({
        success: false,
        message: "Payment verification failed — invalid signature",
      });
    }

    // Fetch the order to get the trusted, server-priced context from notes
    const order = await getRazorpay().orders.fetch(razorpay_order_id);
    const notes = order.notes || {};

    // ── Ensure the order belongs to the authenticated user ───────────────────
    if (notes.userId && String(notes.userId) !== String(req.user._id)) {
      return res.status(403).json({
        success: false,
        message: "This payment order does not belong to you",
      });
    }

    // Fail closed unless the provider confirms this exact payment was captured.
    let payment;
    try {
      payment = await getRazorpay().payments.fetch(razorpay_payment_id);
    } catch (e) {
      console.error("[verifyPayment] payment fetch failed:", e.message);
      return res.status(502).json({
        success: false,
        message: "Could not confirm payment capture. Please try again.",
      });
    }

    if (
      String(payment.order_id) !== String(razorpay_order_id) ||
      Number(payment.amount) !== Number(order.amount) ||
      payment.currency !== order.currency
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment details do not match the order",
      });
    }
    if (payment.status !== "captured") {
      return res.status(409).json({
        success: false,
        message: "Payment has not been captured yet",
      });
    }

    captureObserved = true;
    await recordCapturedPayment({ order, payment });
    captureConfirmed = true;

    const finalized = await finalizeBookingFromOrder({
      order,
      paymentId: razorpay_payment_id,
      user: req.user,
      travelers: req.body.travelers || [],
      addonSchedule: req.body.addonSchedule || null,
    });

    if (finalized.terminal) {
      return res.status(finalized.refunded ? 200 : 202).json({
        success: true,
        bookingConfirmed: false,
        pending: false,
        refunded: finalized.refunded === true,
        reconciliationRequired: finalized.reconciliationRequired === true,
        code: finalized.code,
        message: finalized.message,
        bookingId: finalized.bookingId || null,
        paymentId: razorpay_payment_id,
      });
    }

    if (finalized.pending) {
      return res.status(202).json({
        success: true,
        bookingConfirmed: false,
        pending: true,
        refunded: false,
        reconciliationRequired: false,
        code: finalized.code || "PAYMENT_FINALIZATION_PENDING",
        message:
          finalized.message ||
          "Payment captured. Your booking is being finalized and will appear automatically.",
        bookingId: finalized.bookingId || null,
        paymentId: razorpay_payment_id,
      });
    }

    if (finalized.finalizationState !== "COMPLETED" || !finalized.bookingId) {
      return res.status(202).json({
        success: true,
        bookingConfirmed: false,
        pending: true,
        code: "PAYMENT_FINALIZATION_PENDING",
        message:
          "Payment captured. Your booking is being finalized and will appear automatically.",
        bookingId: null,
        paymentId: razorpay_payment_id,
      });
    }

    res.status(200).json({
      success: true,
      bookingConfirmed: true,
      pending: false,
      message: "Payment verified and booking confirmed",
      bookingId: finalized.bookingId || null,
      paymentId: razorpay_payment_id,
    });

    // Email is already sent by createBooking — no need to send again here
  } catch (err) {
    console.error("[Payment Verify] Error:", err.message);
    if (captureObserved && !captureConfirmed) {
      return res.status(202).json({
        success: true,
        bookingConfirmed: false,
        pending: false,
        refunded: false,
        reconciliationRequired: true,
        code: "PAYMENT_RECONCILIATION_REQUIRED",
        message:
          "Payment capture was confirmed, but its durable record needs reconciliation. Please contact support with your payment ID.",
        paymentId: req.body?.razorpay_payment_id || null,
      });
    }
    if (captureConfirmed) {
      return res.status(202).json({
        success: true,
        bookingConfirmed: false,
        pending: true,
        refunded: false,
        reconciliationRequired: false,
        code: "PAYMENT_FINALIZATION_PENDING",
        message:
          "Payment captured. Your booking is being finalized and will appear automatically.",
        paymentId: req.body?.razorpay_payment_id || null,
      });
    }
    res.status(500).json({
      success: false,
      message: err.message || "Payment verification failed",
    });
  }
};

/**
 * POST /api/payments/webhook  (PUBLIC — verified by Razorpay signature)
 * Recovers a booking if the app was killed after payment but before /verify.
 * Handles `order.paid` / `payment.captured` events idempotently.
 */
exports.razorpayWebhook = async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      console.error("[razorpayWebhook] RAZORPAY_WEBHOOK_SECRET not set");
      return res
        .status(503)
        .json({ success: false, message: "Webhook not configured" });
    }

    // Verify signature against the RAW body (captured by express.json verify)
    const signature = req.headers["x-razorpay-signature"];
    const expected = crypto
      .createHmac("sha256", secret)
      .update(req.rawBody || Buffer.from(JSON.stringify(req.body)))
      .digest("hex");
    if (!signature || signature !== expected) {
      console.error("[razorpayWebhook] invalid signature");
      return res
        .status(400)
        .json({ success: false, message: "Invalid signature" });
    }

    // ACK immediately — Razorpay retries on non-2xx, so we never want to hang.
    res.status(200).json({ success: true });

    const event = req.body?.event;
    if (event !== "order.paid" && event !== "payment.captured") return;

    const paymentEntity = req.body?.payload?.payment?.entity || {};
    const orderId =
      paymentEntity.order_id || req.body?.payload?.order?.entity?.id;
    let paymentId = paymentEntity.id;
    if (!orderId) return;

    const order = await getRazorpay().orders.fetch(orderId);
    if (order?.notes?.purpose === "addon_topup") {
      if (!paymentId) {
        const list = await getRazorpay().orders.fetchPayments(orderId);
        paymentId = (list?.items || []).find(
          (item) => item.status === "captured",
        )?.id;
      }
      if (!paymentId) return;
      const payment = await getRazorpay().payments.fetch(paymentId);
      const AddonPurchase = require("../models/AddonPurchase");
      const ledger = await AddonPurchase.findOne({ razorpayOrderId: orderId });
      const valid =
        ledger &&
        payment.order_id === orderId &&
        payment.status === "captured" &&
        Number(payment.amount) === Number(ledger.amountPaise) &&
        Number(order.amount) === Number(ledger.amountPaise) &&
        String(payment.currency).toUpperCase() ===
          String(ledger.currency).toUpperCase();
      if (!valid) {
        if (ledger) {
          await AddonPurchase.updateOne(
            { _id: ledger._id },
            {
              $set: {
                status: "RECONCILIATION_REQUIRED",
                applicationError:
                  "Webhook captured payment did not match the frozen add-on ledger",
              },
            },
          );
        }
        return;
      }
      await AddonPurchase.updateOne(
        {
          _id: ledger._id,
          $or: [{ razorpayPaymentId: "" }, { razorpayPaymentId: paymentId }],
          status: "PENDING",
        },
        {
          $set: {
            razorpayPaymentId: paymentId,
            paidAt: new Date(),
            status: "CAPTURED",
          },
        },
      );
      const capturedLedger = await AddonPurchase.findById(ledger._id);
      const capturedBooking = await require("../models/TripBooking")
        .findById(ledger.bookingId)
        .select("status");
      if (capturedLedger && capturedBooking?.status !== "CONFIRMED") {
        await refundAddonPurchaseLedger(
          capturedLedger,
          paymentId,
          "Booking was no longer confirmed when top-up capture arrived",
        );
        return;
      }
      if (capturedLedger) {
        const application = await applyCapturedAddonPurchase(
          capturedLedger._id,
        );
        if (
          ["REFUND_PROCESSING", "RECONCILIATION_REQUIRED"].includes(
            application.state,
          )
        ) {
          try {
            require("./notificationController").notifyAdmin(
              "Captured Add-on Payment Needs Attention",
              `Add-on purchase ${ledger._id} was captured but ended in ${application.state}.`,
              { type: "general", bookingId: String(ledger.bookingId) },
            );
          } catch {}
        }
      }
      return;
    }

    if (!paymentId) {
      const list = await getRazorpay().orders.fetchPayments(orderId);
      paymentId = (list?.items || []).find(
        (item) => item.status === "captured",
      )?.id;
    }
    if (!paymentId) return;

    const payment = await getRazorpay().payments.fetch(paymentId);
    await recordCapturedPayment({ order, payment });
    const finalized = await finalizeBookingFromOrder({ order, paymentId });
    if (finalized.terminal) {
      console.warn(
        `[razorpayWebhook] terminal payment state ${finalized.code} for order ${orderId}`,
      );
    } else if (finalized.pending) {
      console.warn(
        `[razorpayWebhook] payment captured; finalization pending for order ${orderId}`,
      );
    } else {
      console.log(`[razorpayWebhook] recovered booking for order ${orderId}`);
    }
  } catch (err) {
    // Response already sent; just log
    console.error("[razorpayWebhook] error:", err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Add-on top-up — let a user add photographer/reel-maker add-ons to an EXISTING
// confirmed booking. This is a SEPARATE payment for just the add-on amount + GST;
// it never touches the original package fare.
// ─────────────────────────────────────────────────────────────────────────────

// Compact "name:0,1|name2:2,3" ⇄ { name:[0,1], name2:[2,3] }
function encodeAddonDays(addonDays) {
  try {
    return Object.entries(addonDays || {})
      .map(([name, days]) => `${name}:${(days || []).join(",")}`)
      .join("|");
  } catch {
    return "";
  }
}
function decodeAddonDays(str) {
  const out = {};
  if (!str) return out;
  str.split("|").forEach((part) => {
    const idx = part.lastIndexOf(":");
    if (idx <= 0) return;
    const name = part.slice(0, idx);
    const daysStr = part.slice(idx + 1);
    out[name] = daysStr
      .split(",")
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 0);
  });
  return out;
}

// Only keep addon-days that are NOT already booked for that service, and that
// point to a valid itinerary day. Returns the cleaned addonDays (may be empty).
function sanitizeNewAddonDays(requested, existing, itineraryLen) {
  const clean = {};
  for (const name of Object.keys(requested || {})) {
    const already = new Set((existing?.[name] || []).map(Number));
    const days = [...new Set((requested[name] || []).map(Number))].filter(
      (d) =>
        Number.isInteger(d) && d >= 0 && d < itineraryLen && !already.has(d),
    );
    if (days.length > 0) clean[name] = days;
  }
  return clean;
}

async function refundIneligibleAddonPayment({
  booking,
  order,
  paymentId,
  reason,
}) {
  const existing = (booking.addonTopupRefunds || []).find(
    (entry) => entry.paymentId === paymentId,
  );
  if (existing?.status === "REFUNDED") {
    return { refunded: true, refundId: existing.refundId, duplicate: true };
  }

  let record = existing;
  if (!record) {
    booking.addonTopupRefunds.push({
      paymentId,
      orderId: order.id,
      amount: Number(order.amount) / 100,
      reason,
      status: "PROCESSING",
      createdAt: new Date(),
    });
    record = booking.addonTopupRefunds[booking.addonTopupRefunds.length - 1];
  } else {
    record.status = "PROCESSING";
    record.reason = reason;
    record.error = "";
  }
  await booking.save();

  try {
    const refund = await getRazorpay().payments.refund(paymentId, {
      amount: Number(order.amount),
      notes: {
        purpose: "addon_topup_eligibility_refund",
        bookingId: String(booking._id),
      },
    });
    record.status = "REFUNDED";
    record.refundId = refund.id || "";
    record.error = "";
    booking.markModified("addonTopupRefunds");
    await booking.save();
    return { refunded: true, refundId: record.refundId };
  } catch (refundError) {
    record.status = "FAILED";
    record.error = refundError.message || "Refund failed";
    booking.markModified("addonTopupRefunds");
    await booking.save();
    try {
      const { notifyAdmin } = require("./notificationController");
      notifyAdmin(
        "Urgent: Add-on Payment Refund Failed",
        `Booking ${booking.bookingId}: payment ${paymentId} was captured but the add-on became ineligible. Refund manually. Reason: ${reason}. Error: ${record.error}`,
        { type: "general", bookingId: booking._id.toString() },
      );
    } catch {}
    return { refunded: false, error: record.error };
  }
}

/**
 * POST /api/payments/create-addon-order
 * Body: { bookingId, addonDays, addonSchedule }
 * Creates a Razorpay order for the add-on delta on an existing booking.
 */
async function legacyCreateAddonOrder(req, res) {
  try {
    const { bookingId, addonDays } = req.body;
    if (!bookingId || !addonDays || Object.keys(addonDays).length === 0) {
      return res.status(400).json({
        success: false,
        message: "bookingId and addonDays are required",
      });
    }

    const TripBooking = require("../models/TripBooking");
    const Package = require("../models/Package");
    const tripBookingController = require("./tripBookingController");

    const booking = await TripBooking.findById(bookingId);
    if (!booking)
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    if (String(booking.userId) !== String(req.user._id))
      return res
        .status(403)
        .json({ success: false, message: "Not authorized" });
    if (booking.status !== "CONFIRMED")
      return res.status(400).json({
        success: false,
        message: "Add-ons can only be added to a confirmed booking.",
      });

    const pkg = await Package.findById(booking.packageId).select(
      "itinerary outsideCityCharge title",
    );
    if (!pkg)
      return res
        .status(404)
        .json({ success: false, message: "Package not found" });

    // Only allow NEW, valid days (no duplicates of already-booked addon-days)
    const cleanDays = sanitizeNewAddonDays(
      addonDays,
      booking.addonDays || {},
      (pkg.itinerary || []).length,
    );
    if (Object.keys(cleanDays).length === 0) {
      return res.status(400).json({
        success: false,
        message: "These add-on days are already booked or invalid.",
      });
    }

    // Per-day timing replaces the old trip-level two-day cutoff. Future days
    // remain scheduled; an eligible itinerary day that is today becomes an
    // instant booking with the operator's fixed pickup details.
    const addonPlan = buildAddonBookingPlan({
      booking,
      pkg,
      addonDays: cleanDays,
    });

    const { addonTotalPrice, gstOnAddon } =
      await tripBookingController.computeAddonPricing({
        pkg,
        addonDays: cleanDays,
      });
    const amount = addonTotalPrice + gstOnAddon;
    if (!amount || amount <= 0)
      return res
        .status(400)
        .json({ success: false, message: "Invalid add-on amount" });

    const amountInPaise = Math.round(amount * 100);
    const order = await getRazorpay().orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `addon_${Date.now()}`,
      notes: {
        purpose: "addon_topup",
        bookingId: String(booking._id),
        userId: String(req.user._id),
        addonDays: encodeAddonDays(cleanDays),
      },
    });

    res.status(200).json({
      success: true,
      orderId: order.id,
      razorpayOrderId: order.id,
      amount, // authoritative add-on total (base + surcharge + GST)
      addonTotal: addonTotalPrice,
      gst: gstOnAddon,
      amountInPaise: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      instantEntries: addonPlan.instantEntries,
    });
  } catch (err) {
    console.error("Add-on order error:", err);
    res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Could not create add-on order",
    });
  }
}

/**
 * POST /api/payments/verify-addon
 * Verifies the add-on payment and merges the add-ons into the existing booking.
 */
async function legacyVerifyAddonPayment(req, res) {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Missing payment verification fields",
      });
    }

    // Verify signature
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");
    if (expected !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Payment verification failed — invalid signature",
      });
    }

    const TripBooking = require("../models/TripBooking");
    const Package = require("../models/Package");
    const tripBookingController = require("./tripBookingController");

    // Trusted context from the order (priced server-side at create time)
    const order = await getRazorpay().orders.fetch(razorpay_order_id);
    const notes = order.notes || {};
    if (notes.purpose !== "addon_topup") {
      return res
        .status(400)
        .json({ success: false, message: "Not an add-on payment order" });
    }
    if (String(notes.userId) !== String(req.user._id)) {
      return res
        .status(403)
        .json({ success: false, message: "This order does not belong to you" });
    }

    const booking = await TripBooking.findById(notes.bookingId);
    if (!booking)
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });

    // Idempotency — if we already applied this payment, just return success.
    if ((booking.addonTopupPaymentIds || []).includes(razorpay_payment_id)) {
      return res.json({
        success: true,
        message: "Add-ons already added",
        bookingId: booking._id,
      });
    }
    const priorRefund = (booking.addonTopupRefunds || []).find(
      (entry) => entry.paymentId === razorpay_payment_id,
    );
    if (priorRefund) {
      return res.status(priorRefund.status === "REFUNDED" ? 409 : 500).json({
        success: false,
        paymentRefunded: priorRefund.status === "REFUNDED",
        refundId: priorRefund.refundId || "",
        code:
          priorRefund.status === "REFUNDED"
            ? "ADDON_PAYMENT_REFUNDED"
            : "ADDON_REFUND_REQUIRES_RECONCILIATION",
        message:
          priorRefund.status === "REFUNDED"
            ? "This add-on payment was refunded because the booking window closed."
            : "This add-on payment is awaiting refund reconciliation.",
      });
    }

    // Confirm the captured amount matches the order
    try {
      const payment = await getRazorpay().payments.fetch(razorpay_payment_id);
      if (
        payment.order_id !== razorpay_order_id ||
        Number(payment.amount) !== Number(order.amount)
      ) {
        return res.status(400).json({
          success: false,
          message: "Payment amount mismatch — possible tampering",
        });
      }
    } catch (e) {
      console.warn("Add-on payment fetch check skipped:", e.message);
    }

    const newDays = decodeAddonDays(notes.addonDays);
    const pkg = await Package.findById(booking.packageId).select(
      "itinerary outsideCityCharge title",
    );

    // Re-clean against current booking state (guards double-adds / races)
    const cleanDays = sanitizeNewAddonDays(
      newDays,
      booking.addonDays || {},
      (pkg?.itinerary || []).length,
    );
    if (Object.keys(cleanDays).length === 0) {
      // Nothing to add (already applied concurrently) — record payment + return
      booking.addonTopupPaymentIds.push(razorpay_payment_id);
      await booking.save();
      return res.json({
        success: true,
        message: "Add-ons already applied",
        bookingId: booking._id,
      });
    }

    // Revalidate at verification time. If eligibility changed while Razorpay
    // checkout was open, refund the captured amount instead of leaving a paid
    // customer without either the add-on or their money.
    let addonPlan;
    try {
      addonPlan = buildAddonBookingPlan({
        booking,
        pkg,
        addonDays: cleanDays,
      });
    } catch (eligibilityError) {
      const refundResult = await refundIneligibleAddonPayment({
        booking,
        order,
        paymentId: razorpay_payment_id,
        reason: eligibilityError.message,
      });
      return res.status(refundResult.refunded ? 409 : 500).json({
        success: false,
        paymentRefunded: refundResult.refunded,
        refundId: refundResult.refundId || "",
        code: refundResult.refunded
          ? "ADDON_PAYMENT_REFUNDED"
          : "ADDON_REFUND_REQUIRES_RECONCILIATION",
        message: refundResult.refunded
          ? `${eligibilityError.message} Your payment has been refunded.`
          : `${eligibilityError.message} Your payment was received, but the automatic refund needs support review.`,
      });
    }

    const { addonSurcharge, addonTotalPrice, gstOnAddon } =
      await tripBookingController.computeAddonPricing({
        pkg,
        addonDays: cleanDays,
      });

    // ── Merge add-on days into the booking ────────────────────────────────────
    const mergedDays = { ...(booking.addonDays || {}) };
    for (const name of Object.keys(cleanDays)) {
      mergedDays[name] = [
        ...new Set([...(mergedDays[name] || []), ...cleanDays[name]]),
      ];
    }
    booking.addonDays = mergedDays;
    booking.markModified("addonDays");

    // Merge only schedules for the paid addon-days. Same-day entries always
    // use the server-built operator schedule and cannot be overridden by the
    // client; future scheduled entries retain the existing custom schedule.
    const sched = { ...(booking.addonSchedule || {}) };
    const requestedSchedule =
      req.body.addonSchedule && typeof req.body.addonSchedule === "object"
        ? req.body.addonSchedule
        : {};
    for (const [name, days] of Object.entries(cleanDays)) {
      sched[name] = { ...(sched[name] || {}) };
      for (const dayIdx of days) {
        const key = `${name}_${dayIdx}`;
        const fixedSchedule = addonPlan.schedule?.[name]?.[dayIdx];
        if (addonPlan.bookingTypes[key] === "instant") {
          sched[name][dayIdx] = fixedSchedule;
        } else if (requestedSchedule?.[name]?.[dayIdx]) {
          sched[name][dayIdx] = requestedSchedule[name][dayIdx];
        }
      }
    }
    booking.addonSchedule = sched;
    booking.markModified("addonSchedule");

    booking.addonBookingTypes = {
      ...(booking.addonBookingTypes || {}),
      ...addonPlan.bookingTypes,
    };
    booking.markModified("addonBookingTypes");

    booking.addonNames = Object.keys(mergedDays);
    booking.addonSurcharge = (booking.addonSurcharge || 0) + addonSurcharge;
    booking.addonTotalPrice = (booking.addonTotalPrice || 0) + addonTotalPrice;

    // ── Update the pricing snapshot (add-on + its GST are extra cost) ─────────
    const p = booking.pricing || {};
    p.addonAmount = (p.addonAmount || 0) + addonTotalPrice;
    p.gstAmount = (p.gstAmount || 0) + gstOnAddon;
    p.totalAmount = (p.totalAmount || 0) + addonTotalPrice + gstOnAddon;
    // Operator earns the outside-city surcharge portion of the add-on
    p.operatorAmount = (p.operatorAmount || 0) + addonSurcharge;
    booking.pricing = p;
    booking.markModified("pricing");

    // Hold the money and re-open dispatch so the cron sends the NEW addon-days.
    // (Dispatch is idempotent per addon-day, so already-sent days aren't resent.)
    booking.addonHeld = true;
    booking.addonDispatched = false;
    booking.addonTopupPaymentIds.push(razorpay_payment_id);
    await booking.save();

    // Same-day instant add-ons are sent immediately after payment. The existing
    // five-minute cron calls the same idempotent dispatcher as a retry safety net.
    let dispatchResult = null;
    try {
      const { runSnapjaDispatch } = require("./cronController");
      dispatchResult = await runSnapjaDispatch(booking._id);
    } catch (dispatchError) {
      console.error(
        `[verifyAddonPayment] Immediate Snapja dispatch failed for ${booking.bookingId}:`,
        dispatchError.message,
      );
    }

    // Notify operator + admin
    try {
      const { notifyOperator } = require("./notificationController");
      const { notifyAdmin } = require("./notificationController");
      const snap = booking.snapshot || {};
      notifyOperator(
        booking.operatorId,
        "Add-on Added to a Booking",
        `A traveller added ${Object.keys(cleanDays).join(", ")} to ${snap.packageTitle || "their trip"} (Booking ${booking.bookingId}).`,
        { type: "new_booking", bookingId: booking._id.toString() },
      );
      notifyAdmin(
        "Add-on Top-up",
        `Booking ${booking.bookingId}: add-on ₹${(addonTotalPrice + gstOnAddon).toLocaleString("en-IN")} added.`,
        { type: "general", bookingId: booking._id.toString() },
      );
    } catch {}

    res.json({
      success: true,
      message: "Add-ons added to your booking",
      bookingId: booking._id,
      dispatched: Boolean(dispatchResult?.dispatched),
      dispatchErrors: dispatchResult?.errors || [],
    });
  } catch (err) {
    console.error("[verifyAddonPayment] Error:", err.message);
    res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Add-on verification failed",
    });
  }
}

// Durable canonical add-on purchase flow. These exports intentionally replace
// the legacy implementations above while retaining the old code for safe review
// against the substantial pre-existing working-tree changes.
async function refundAddonPurchaseLedger(ledger, paymentId, reason) {
  const AddonPurchase = require("../models/AddonPurchase");
  const TripBooking = require("../models/TripBooking");
  const now = new Date();
  let claimed = await AddonPurchase.findOneAndUpdate(
    {
      _id: ledger._id,
      refundStatus: { $in: ["NONE", "FAILED"] },
    },
    {
      $set: {
        status: "REFUND_PROCESSING",
        refundStatus: "PROCESSING",
        refundAmount: Number(ledger.amountPaise) / 100,
        refundReason: reason,
        refundError: "Refund submission in progress",
      },
    },
    { new: true },
  );
  if (!claimed) {
    claimed = await AddonPurchase.findById(ledger._id);
    return {
      refunded: claimed?.refundStatus === "REFUNDED",
      pending: claimed?.refundStatus === "PROCESSING",
      refundId: claimed?.refundId || "",
      reconciliation: claimed?.refundStatus === "RECONCILIATION_REQUIRED",
    };
  }

  try {
    const refund = await getRazorpay().payments.refund(paymentId, {
      amount: Number(claimed.amountPaise),
      notes: {
        purpose: "addon_purchase_refund",
        bookingId: String(claimed.bookingId),
        addonPurchaseId: String(claimed._id),
      },
    });
    const processed = String(refund.status || "").toLowerCase() === "processed";
    claimed = await AddonPurchase.findByIdAndUpdate(
      claimed._id,
      {
        $set: {
          status: processed ? "REFUNDED" : "REFUND_PROCESSING",
          refundStatus: processed ? "REFUNDED" : "PROCESSING",
          refundId: refund.id || "",
          refundedAt: processed ? now : null,
          refundError: "",
        },
      },
      { new: true },
    );
    if (processed) {
      await TripBooking.updateOne(
        { _id: claimed.bookingId },
        { $pull: { addonEntryClaims: { $in: claimed.entryKeys } } },
      );
    }
    return {
      refunded: processed,
      pending: !processed,
      refundId: claimed.refundId,
    };
  } catch (error) {
    claimed = await AddonPurchase.findByIdAndUpdate(
      claimed._id,
      {
        $set: {
          status: "RECONCILIATION_REQUIRED",
          refundStatus: "RECONCILIATION_REQUIRED",
          refundError: String(error.message || error).slice(0, 500),
        },
      },
      { new: true },
    );
    try {
      const { notifyAdmin } = require("./notificationController");
      notifyAdmin(
        "Urgent: Add-on Refund Needs Reconciliation",
        `Booking ${claimed.bookingId}: captured payment ${paymentId} could not be safely refunded. ${claimed.refundError}`,
        { type: "general", bookingId: String(claimed.bookingId) },
      );
    } catch {}
    return {
      refunded: false,
      reconciliation: true,
      error: claimed.refundError,
    };
  }
}

async function refundUnexpectedAddonPayment({ ledger, paymentId, reason }) {
  try {
    const refund = await getRazorpay().payments.refund(paymentId, {
      amount: Number(ledger.amountPaise),
      notes: {
        purpose: "unexpected_addon_payment_refund",
        addonPurchaseId: String(ledger._id),
      },
    });
    await require("../models/AddonPurchase").updateOne(
      { _id: ledger._id },
      {
        $push: {
          unexpectedPayments: {
            paymentId,
            amount: Number(ledger.amountPaise) / 100,
            reason,
            refundId: refund.id || "",
            status: refund.status || "pending",
            createdAt: new Date(),
          },
        },
      },
    );
    return {
      refunded: refund.status === "processed",
      refundId: refund.id || "",
    };
  } catch (error) {
    await require("../models/AddonPurchase").updateOne(
      { _id: ledger._id },
      {
        $set: {
          status: "RECONCILIATION_REQUIRED",
          applicationError: `Unexpected payment ${paymentId} requires reconciliation: ${error.message}`,
        },
        $push: {
          unexpectedPayments: {
            paymentId,
            amount: Number(ledger.amountPaise) / 100,
            reason,
            status: "RECONCILIATION_REQUIRED",
            error: error.message,
            createdAt: new Date(),
          },
        },
      },
    );
    return { refunded: false, reconciliation: true };
  }
}

exports.createAddonOrder = async (req, res) => {
  const TripBooking = require("../models/TripBooking");
  const AddonPurchase = require("../models/AddonPurchase");
  let claimedKeys = [];
  let booking;
  try {
    const { bookingId, addonDays, addonSchedule } = req.body || {};
    if (!bookingId || !addonDays || typeof addonDays !== "object") {
      return res.status(400).json({
        success: false,
        message: "bookingId and addonDays are required",
      });
    }

    const Package = require("../models/Package");
    const { getSetting } = require("./platformSettingsController");
    const {
      buildCanonicalAddonEntries,
      summarizeAddonEntries,
    } = require("../utils/canonicalAddonServices");

    booking = await TripBooking.findOne({
      _id: bookingId,
      userId: req.user._id,
    });
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }
    if (booking.status !== "CONFIRMED") {
      return res.status(409).json({
        success: false,
        message: "Add-ons can only be added to a confirmed booking.",
      });
    }
    const pkg = await Package.findById(booking.packageId).select(
      "itinerary outsideCityCharge title",
    );
    if (!pkg) {
      return res
        .status(404)
        .json({ success: false, message: "Package not found" });
    }

    const photographerPrice =
      (await getSetting("photographer_base_price")) ?? 2000;
    const reelmakerPrice =
      (await getSetting("videographer_base_price")) ?? 2000;
    const gstPercent = (await getSetting("gst_percent")) ?? 5;
    const existingKeys = [
      ...(booking.addonEntryClaims || []),
      ...(booking.addonServiceEntries || []).map((entry) => entry.key),
    ];
    const plan = buildCanonicalAddonEntries({
      booking,
      pkg,
      addonDays,
      addonSchedule,
      photographerPrice,
      reelmakerPrice,
      gstPercent,
      paymentSource: { kind: "topup" },
      existingEntryKeys: existingKeys,
    });
    if (plan.entries.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Select at least one add-on day." });
    }
    claimedKeys = plan.entries.map((entry) => entry.key);
    const claim = await TripBooking.findOneAndUpdate(
      {
        _id: booking._id,
        userId: req.user._id,
        status: "CONFIRMED",
        addonEntryClaims: { $nin: claimedKeys },
      },
      { $addToSet: { addonEntryClaims: { $each: claimedKeys } } },
      { new: true },
    );
    if (!claim) {
      return res.status(409).json({
        success: false,
        code: "ADDON_ENTRY_ALREADY_CLAIMED",
        message:
          "One of these creator services is already booked or awaiting payment.",
      });
    }

    const pricing = summarizeAddonEntries(plan.entries);
    const amount = pricing.addonTotalPrice + pricing.gstOnAddon;
    const amountPaise = Math.round(amount * 100);
    const order = await getRazorpay().orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: `addon_${Date.now()}`,
      notes: {
        purpose: "addon_topup",
        bookingId: String(booking._id),
        userId: String(req.user._id),
      },
    });
    const frozenEntries = plan.entries.map((entry) => ({
      ...entry,
      paymentSource: { kind: "topup", orderId: order.id },
    }));
    await AddonPurchase.create({
      razorpayOrderId: order.id,
      bookingId: booking._id,
      userId: req.user._id,
      entryKeys: claimedKeys,
      entries: frozenEntries,
      pricing: { ...pricing, gstPercent, totalAmount: amount },
      requestedAddonDays: plan.addonDays,
      requestedSchedule: plan.schedule,
      amountPaise,
      currency: order.currency,
    });

    return res.status(200).json({
      success: true,
      orderId: order.id,
      razorpayOrderId: order.id,
      amount,
      addonTotal: pricing.addonTotalPrice,
      gst: pricing.gstOnAddon,
      amountInPaise: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      instantEntries: frozenEntries
        .filter((entry) => entry.bookingType === "instant")
        .map((entry) => ({
          serviceType: entry.serviceType,
          dayIdx: entry.dayIndex,
          date: entry.date,
          cutoffAt: entry.cutoffAt,
          schedule: {
            time: entry.time,
            placeName: entry.location.placeName,
            lat: entry.location.lat,
            lng: entry.location.lng,
            fixedByOperator: entry.fixedByOperator,
          },
        })),
    });
  } catch (error) {
    if (booking?._id && claimedKeys.length > 0) {
      await TripBooking.updateOne(
        { _id: booking._id },
        { $pull: { addonEntryClaims: { $in: claimedKeys } } },
      ).catch(() => {});
    }
    console.error("[createAddonOrder] Error:", error.message);
    return res.status(error.statusCode || 500).json({
      success: false,
      code: error.code,
      message: error.message || "Could not create add-on order",
    });
  }
};

exports.verifyAddonPayment = async (req, res) => {
  const AddonPurchase = require("../models/AddonPurchase");
  const TripBooking = require("../models/TripBooking");
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Missing payment verification fields",
      });
    }
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest();
    let supplied;
    try {
      supplied = Buffer.from(razorpay_signature, "hex");
    } catch {
      supplied = Buffer.alloc(0);
    }
    if (
      supplied.length !== expected.length ||
      !crypto.timingSafeEqual(expected, supplied)
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment verification failed — invalid signature",
      });
    }

    let ledger = await AddonPurchase.findOne({
      razorpayOrderId: razorpay_order_id,
      userId: req.user._id,
    });
    if (!ledger) {
      return res
        .status(404)
        .json({ success: false, message: "Add-on purchase ledger not found" });
    }
    if (
      ledger.status === "APPLIED" &&
      ledger.razorpayPaymentId === razorpay_payment_id
    ) {
      return res.json({
        success: true,
        message: "Add-ons already added",
        bookingId: ledger.bookingId,
      });
    }
    if (["REFUNDED", "RECONCILIATION_REQUIRED"].includes(ledger.status)) {
      return res.status(409).json({
        success: false,
        paymentRefunded: ledger.status === "REFUNDED",
        code:
          ledger.status === "REFUNDED"
            ? "ADDON_PAYMENT_REFUNDED"
            : "ADDON_REFUND_REQUIRES_RECONCILIATION",
        message:
          ledger.status === "REFUNDED"
            ? "This add-on payment was refunded."
            : "This add-on payment requires support reconciliation.",
      });
    }

    let order;
    let payment;
    try {
      [order, payment] = await Promise.all([
        getRazorpay().orders.fetch(razorpay_order_id),
        getRazorpay().payments.fetch(razorpay_payment_id),
      ]);
    } catch (providerError) {
      return res.status(502).json({
        success: false,
        code: "PAYMENT_PROVIDER_VERIFICATION_UNAVAILABLE",
        message: "Could not verify the captured add-on payment. Please retry.",
      });
    }
    const exactProviderMatch =
      order?.id === ledger.razorpayOrderId &&
      order?.notes?.purpose === "addon_topup" &&
      String(order?.notes?.bookingId) === String(ledger.bookingId) &&
      String(order?.notes?.userId) === String(ledger.userId) &&
      payment?.order_id === ledger.razorpayOrderId &&
      payment?.status === "captured" &&
      Number(payment?.amount) === Number(ledger.amountPaise) &&
      Number(order?.amount) === Number(ledger.amountPaise) &&
      String(payment?.currency).toUpperCase() ===
        String(ledger.currency).toUpperCase() &&
      String(order?.currency).toUpperCase() ===
        String(ledger.currency).toUpperCase();
    if (!exactProviderMatch) {
      return res.status(400).json({
        success: false,
        message: "Captured payment does not match the frozen add-on order",
      });
    }

    if (
      ledger.razorpayPaymentId &&
      ledger.razorpayPaymentId !== razorpay_payment_id
    ) {
      const unexpected = await refundUnexpectedAddonPayment({
        ledger,
        paymentId: razorpay_payment_id,
        reason:
          "A different captured payment was already bound to this add-on order",
      });
      return res.status(unexpected.reconciliation ? 500 : 409).json({
        success: false,
        paymentRefunded: unexpected.refunded,
        code: unexpected.reconciliation
          ? "ADDON_REFUND_REQUIRES_RECONCILIATION"
          : "DUPLICATE_ADDON_PAYMENT_REFUNDED",
        message: unexpected.reconciliation
          ? "The duplicate payment needs support reconciliation."
          : "The duplicate payment was sent for refund.",
      });
    }

    ledger = await AddonPurchase.findOneAndUpdate(
      {
        _id: ledger._id,
        $or: [
          { razorpayPaymentId: "" },
          { razorpayPaymentId: razorpay_payment_id },
        ],
      },
      {
        $set: {
          razorpayPaymentId: razorpay_payment_id,
          paidAt: ledger.paidAt || new Date(),
          status: ledger.status === "PENDING" ? "CAPTURED" : ledger.status,
        },
      },
      { new: true },
    );
    if (!ledger) {
      return res.status(409).json({
        success: false,
        message: "This payment is already being reconciled.",
      });
    }

    const booking = await TripBooking.findOne({
      _id: ledger.bookingId,
      userId: req.user._id,
    });
    const alreadyApplied =
      booking &&
      booking.status === "CONFIRMED" &&
      ledger.entryKeys.every((key) =>
        (booking.addonServiceEntries || []).some(
          (entry) =>
            entry.key === key &&
            entry.paymentSource?.orderId === ledger.razorpayOrderId,
        ),
      );
    if (alreadyApplied) {
      await AddonPurchase.updateOne(
        { _id: ledger._id },
        {
          $set: {
            status: "APPLIED",
            appliedAt: ledger.appliedAt || new Date(),
            leaseToken: "",
            leaseUntil: null,
          },
        },
      );
      return res.json({
        success: true,
        message: "Add-ons already added",
        bookingId: booking._id,
      });
    }

    let eligibilityError = null;
    if (!booking || booking.status !== "CONFIRMED") {
      eligibilityError = new Error("The booking is no longer confirmed.");
    } else {
      try {
        require("../utils/canonicalAddonServices").revalidateFrozenEntryTiming(
          ledger.entries,
        );
        const overlap = ledger.entryKeys.some((key) =>
          (booking.addonAppliedEntryKeys || []).includes(key),
        );
        if (overlap)
          eligibilityError = new Error(
            "A creator service for this day was already applied.",
          );
      } catch (error) {
        eligibilityError = error;
      }
    }
    if (eligibilityError) {
      const refund = await refundAddonPurchaseLedger(
        ledger,
        razorpay_payment_id,
        eligibilityError.message,
      );
      return res.status(refund.reconciliation ? 500 : 409).json({
        success: false,
        paymentRefunded: refund.refunded,
        refundPending: refund.pending,
        refundId: refund.refundId || "",
        code: refund.reconciliation
          ? "ADDON_REFUND_REQUIRES_RECONCILIATION"
          : "ADDON_PAYMENT_REFUND_STARTED",
        message: refund.reconciliation
          ? `${eligibilityError.message} The refund needs support reconciliation.`
          : `${eligibilityError.message} The captured payment has been sent for refund.`,
      });
    }

    const leaseToken = crypto.randomUUID();
    const now = new Date();
    ledger = await AddonPurchase.findOneAndUpdate(
      {
        _id: ledger._id,
        $or: [
          { status: "CAPTURED" },
          { status: "PROCESSING", leaseUntil: { $lte: now } },
        ],
      },
      {
        $set: {
          status: "PROCESSING",
          leaseToken,
          leaseUntil: new Date(now.getTime() + 5 * 60 * 1000),
          applicationError: "",
        },
        $inc: { applicationAttempts: 1 },
      },
      { new: true },
    );
    if (!ledger) {
      const current = await AddonPurchase.findOne({
        razorpayOrderId: razorpay_order_id,
      });
      if (current?.status === "APPLIED") {
        return res.json({
          success: true,
          message: "Add-ons already added",
          bookingId: current.bookingId,
        });
      }
      return res.status(202).json({
        success: true,
        pending: true,
        message: "Add-on application is already processing.",
      });
    }

    const pricing = ledger.pricing || {};
    const applied = await TripBooking.findOneAndUpdate(
      {
        _id: ledger.bookingId,
        userId: req.user._id,
        status: "CONFIRMED",
        addonEntryClaims: { $all: ledger.entryKeys },
        addonAppliedEntryKeys: { $nin: ledger.entryKeys },
      },
      [
        {
          $set: {
            addonServiceEntries: {
              $concatArrays: [
                { $ifNull: ["$addonServiceEntries", []] },
                ledger.entries,
              ],
            },
            addonAppliedEntryKeys: {
              $setUnion: [
                { $ifNull: ["$addonAppliedEntryKeys", []] },
                ledger.entryKeys,
              ],
            },
            addonTopupPaymentIds: {
              $setUnion: [
                { $ifNull: ["$addonTopupPaymentIds", []] },
                [razorpay_payment_id],
              ],
            },
            addonSurcharge: {
              $add: [
                { $ifNull: ["$addonSurcharge", 0] },
                Number(pricing.addonSurcharge) || 0,
              ],
            },
            addonTotalPrice: {
              $add: [
                { $ifNull: ["$addonTotalPrice", 0] },
                Number(pricing.addonTotalPrice) || 0,
              ],
            },
            addonHeld: true,
            addonDispatched: false,
            pricing: {
              $mergeObjects: [
                "$pricing",
                {
                  addonAmount: {
                    $add: [
                      { $ifNull: ["$pricing.addonAmount", 0] },
                      Number(pricing.addonTotalPrice) || 0,
                    ],
                  },
                  gstAmount: {
                    $add: [
                      { $ifNull: ["$pricing.gstAmount", 0] },
                      Number(pricing.gstOnAddon) || 0,
                    ],
                  },
                  totalAmount: {
                    $add: [
                      { $ifNull: ["$pricing.totalAmount", 0] },
                      Number(pricing.totalAmount) || 0,
                    ],
                  },
                  operatorAmount: {
                    $add: [
                      { $ifNull: ["$pricing.operatorAmount", 0] },
                      Number(pricing.addonSurcharge) || 0,
                    ],
                  },
                },
              ],
            },
          },
        },
      ],
      { new: true },
    );
    if (!applied) {
      const refund = await refundAddonPurchaseLedger(
        ledger,
        razorpay_payment_id,
        "Booking eligibility or canonical add-on claim changed before application",
      );
      return res.status(refund.reconciliation ? 500 : 409).json({
        success: false,
        paymentRefunded: refund.refunded,
        refundPending: refund.pending,
        code: refund.reconciliation
          ? "ADDON_REFUND_REQUIRES_RECONCILIATION"
          : "ADDON_PAYMENT_REFUND_STARTED",
        message: refund.reconciliation
          ? "The payment requires support reconciliation."
          : "The add-on could not be applied, so the payment was sent for refund.",
      });
    }

    const legacy = require("../utils/canonicalAddonServices").entriesToLegacy(
      applied.addonServiceEntries,
    );
    await TripBooking.updateOne(
      { _id: applied._id },
      {
        $set: {
          addonDays: legacy.addonDays,
          addonSchedule: legacy.schedule,
          addonBookingTypes: legacy.bookingTypes,
          addonNames: [
            ...new Set(
              applied.addonServiceEntries.map((entry) => entry.displayName),
            ),
          ],
        },
      },
    );
    const finalizedLedger = await AddonPurchase.updateOne(
      { _id: ledger._id, status: "PROCESSING", leaseToken },
      {
        $set: {
          status: "APPLIED",
          appliedAt: new Date(),
          leaseToken: "",
          leaseUntil: null,
          applicationError: "",
        },
      },
    );
    if (finalizedLedger.matchedCount !== 1) {
      const currentLedger = await AddonPurchase.findById(ledger._id);
      return res.status(409).json({
        success: false,
        paymentRefunded: currentLedger?.refundStatus === "REFUNDED",
        refundPending: currentLedger?.refundStatus === "PROCESSING",
        code: "ADDON_APPLICATION_INTERRUPTED_BY_CANCELLATION",
        message:
          "The trip was cancelled while the add-on was being applied; its payment is being refunded or reconciled.",
      });
    }

    let dispatchResult = null;
    try {
      dispatchResult = await require("./cronController").runSnapjaDispatch(
        applied._id,
      );
    } catch (error) {
      console.error(`[verifyAddonPayment] dispatch deferred: ${error.message}`);
    }
    return res.json({
      success: true,
      message: "Add-ons added to your booking",
      bookingId: applied._id,
      dispatched: Boolean(dispatchResult?.dispatched),
      dispatchErrors: dispatchResult?.errors || [],
    });
  } catch (error) {
    console.error("[verifyAddonPayment] Error:", error.message);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Add-on verification failed",
    });
  }
};
