const Razorpay = require("razorpay");
const crypto = require("crypto");
const {
  sendBookingConfirmation,
  sendPaymentReceipt,
} = require("../utils/sendMail");
const { buildAddonBookingPlan } = require("../utils/addonBookingTiming");

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
      });
      authoritativeAmount = priced.totalAmount;
      couponIssue = priced.couponIssue;
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }

    if (!authoritativeAmount || authoritativeAmount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid booking amount" });
    }

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
    // package+batch (prevents double-tap / back+retry opening two checkouts).
    try {
      const PendingOrder = require("../models/PendingOrder");
      const GUARD_WINDOW_MS = 2 * 60 * 1000; // 2 min
      const existing = await PendingOrder.findOne({
        userId: req.user._id,
        status: "pending",
        "payload.packageId": packageId,
        "payload.batchId": isFlexible ? null : batchId,
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
        flexStartDate: flexStartDate || "",
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
            status: "pending",
            payload: {
              packageId,
              batchId: isFlexible ? null : batchId,
              bookingMode: isFlexible ? "flexible" : "batch",
              flexStartDate: isFlexible ? flexStartDate : undefined,
              flexAvailabilityId: isFlexible ? flexAvailabilityId : undefined,
              seats: numSeats,
              adults: numAdults,
              children: numChildren,
              couponCode: couponCode || "",
              platformCouponCode: platformCouponCode || "",
              addonDays: addonDays || null,
              // Full traveller details + schedule for complete recovery
              travelers: Array.isArray(travelers) ? travelers : [],
              addonSchedule: req.body.addonSchedule || null,
            },
          },
        },
        { upsert: true, setDefaultsOnInsert: true },
      );
    } catch (e) {
      // Non-fatal — the app's own /verify still works; this only affects recovery
      console.warn("[createOrder] PendingOrder persist failed:", e.message);
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
async function finalizeBookingFromOrder({
  order,
  paymentId,
  user, // optional — falls back to the order's userId
  travelers, // optional — falls back to PendingOrder payload
  addonSchedule, // optional — falls back to PendingOrder payload
}) {
  const TripBooking = require("../models/TripBooking");
  const PendingOrder = require("../models/PendingOrder");
  const notes = order.notes || {};

  // ── Idempotency ────────────────────────────────────────────────────────────
  const existing = await TripBooking.findOne({ razorpayPaymentId: paymentId });
  if (existing) {
    await PendingOrder.updateOne(
      { razorpayOrderId: order.id },
      { $set: { status: "completed", bookingId: existing._id } },
    );
    return {
      booking: existing,
      bookingId: existing._id,
      alreadyExisted: true,
    };
  }

  // Recover missing details (travellers/schedule) from the persisted order
  const pending = await PendingOrder.findOne({ razorpayOrderId: order.id });
  const pPayload = pending?.payload || {};

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

  const addonDays =
    parseAddonDaysFromNotes(notes) || pPayload.addonDays || null;
  const finalTravelers =
    (Array.isArray(travelers) && travelers.length > 0
      ? travelers
      : pPayload.travelers) || [];
  const finalSchedule =
    addonSchedule != null ? addonSchedule : pPayload.addonSchedule || null;

  const tripBookingController = require("./tripBookingController");
  const fakeReq = {
    user: actingUser,
    _paymentVerified: true, // SECURITY: marks this as a payment-verified booking
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

  // Mark the pending order done so the cron won't reprocess it
  await PendingOrder.updateOne(
    { razorpayOrderId: order.id },
    { $set: { status: "completed", bookingId, completedAt: new Date() } },
  );

  return { booking, bookingId, alreadyExisted: false };
}
exports.finalizeBookingFromOrder = finalizeBookingFromOrder;

/**
 * Safety-net job: recover bookings for orders that were PAID but never verified
 * (e.g. the app was killed right after checkout). Runs on a short interval.
 * Idempotent via finalizeBookingFromOrder + the PendingOrder status flag.
 */
exports.runOrphanPaymentRecovery = async function () {
  const results = { recovered: 0, expired: 0, checked: 0, errors: [] };
  try {
    const PendingOrder = require("../models/PendingOrder");
    const now = Date.now();
    // Give the app time to verify normally before we step in
    const graceAgo = new Date(now - 10 * 60 * 1000); // 10 min
    const expiryAgo = new Date(now - 24 * 60 * 60 * 1000); // 24 h

    const pending = await PendingOrder.find({
      status: "pending",
      createdAt: { $lte: graceAgo },
    })
      .sort({ createdAt: 1 })
      .limit(100);

    for (const po of pending) {
      results.checked++;
      try {
        const order = await getRazorpay().orders.fetch(po.razorpayOrderId);

        if (order?.status === "paid") {
          // Find the captured payment for this order
          let paymentId = null;
          try {
            const list = await getRazorpay().orders.fetchPayments(
              po.razorpayOrderId,
            );
            const captured = (list?.items || []).find(
              (p) => p.status === "captured" || p.status === "authorized",
            );
            paymentId = captured?.id || null;
          } catch (e) {
            results.errors.push(
              `fetchPayments ${po.razorpayOrderId}: ${e.message}`,
            );
          }

          if (paymentId) {
            const { alreadyExisted } = await finalizeBookingFromOrder({
              order,
              paymentId,
            });
            if (!alreadyExisted) {
              results.recovered++;
              // Let the user know their booking is safe
              try {
                const { notifyUser } = require("./notificationController");
                notifyUser(
                  po.userId,
                  "Booking Confirmed ✅",
                  "Your payment went through and your booking is confirmed. Open the app to see the details.",
                  { type: "new_booking" },
                );
              } catch {}
            }
          }
        } else if (po.createdAt <= expiryAgo) {
          // Never paid within 24h — stop tracking it.
          // BUT double-check with Razorpay in case a late capture happened
          // (prevents expiring an order that was actually paid).
          if (order?.status === "paid") {
            // Edge case: order shows paid now but didn't earlier — recover it
            try {
              const list = await getRazorpay().orders.fetchPayments(
                po.razorpayOrderId,
              );
              const captured = (list?.items || []).find(
                (p) => p.status === "captured" || p.status === "authorized",
              );
              if (captured?.id) {
                const { alreadyExisted } = await finalizeBookingFromOrder({
                  order,
                  paymentId: captured.id,
                });
                if (!alreadyExisted) results.recovered++;
                continue;
              }
            } catch {}
          }
          po.status = "expired";
          await po.save();
          results.expired++;
        }
      } catch (e) {
        results.errors.push(`Recover ${po.razorpayOrderId}: ${e.message}`);
      }
    }
  } catch (err) {
    results.errors.push(`Orphan payment recovery: ${err.message}`);
  }
  return results;
};

/**
 * POST /api/payments/verify
 * Verifies Razorpay payment signature and creates the booking
 */
exports.verifyPayment = async (req, res) => {
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

    // Optional: confirm payment was actually captured for this order amount
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
      // If fetch fails, signature already validated — proceed cautiously
      console.warn("Payment fetch check skipped:", e.message);
    }

    const { bookingId } = await finalizeBookingFromOrder({
      order,
      paymentId: razorpay_payment_id,
      user: req.user,
      travelers: req.body.travelers || [],
      addonSchedule: req.body.addonSchedule || null,
    });

    res.status(200).json({
      success: true,
      message: "Payment verified and booking confirmed",
      bookingId: bookingId || null,
      paymentId: razorpay_payment_id,
    });

    // Email is already sent by createBooking — no need to send again here
  } catch (err) {
    console.error("[Payment Verify] Error:", err.message);
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
    const paymentId = paymentEntity.id;
    if (!orderId || !paymentId) return;

    // Only recover our booking orders (add-on top-ups have their own flow)
    const order = await getRazorpay().orders.fetch(orderId);
    if (order?.notes?.purpose === "addon_topup") return;

    await finalizeBookingFromOrder({ order, paymentId });
    console.log(`[razorpayWebhook] recovered booking for order ${orderId}`);
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
exports.createAddonOrder = async (req, res) => {
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
};

/**
 * POST /api/payments/verify-addon
 * Verifies the add-on payment and merges the add-ons into the existing booking.
 */
exports.verifyAddonPayment = async (req, res) => {
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
};
