const Razorpay = require("razorpay");
const crypto = require("crypto");
const {
  sendBookingConfirmation,
  sendPaymentReceipt,
} = require("../utils/sendMail");

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
      adults,
      children,
      couponCode,
      addonDays,
    } = req.body;

    const isFlexible = bookingMode === "flexible";

    if (!packageId || (!batchId && !isFlexible)) {
      return res.status(400).json({
        success: false,
        message: "packageId and batchId (or bookingMode=flexible) are required",
      });
    }

    // ── Recompute the authoritative amount SERVER-SIDE (never trust client) ──
    const tripBookingController = require("./tripBookingController");
    let authoritativeAmount;
    try {
      authoritativeAmount =
        await tripBookingController.computeAuthoritativePricing({
          packageId,
          batchId: isFlexible ? null : batchId,
          bookingMode: isFlexible ? "flexible" : "batch",
          flexAvailabilityId: isFlexible ? flexAvailabilityId : undefined,
          seats,
          adults,
          children,
          couponCode,
          addonDays,
        });
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }

    if (!authoritativeAmount || authoritativeAmount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid booking amount" });
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
        seats: String(seats || 1),
        adults: adults != null ? String(adults) : "",
        children: children != null ? String(children) : "0",
        userId: req.user._id.toString(),
        couponCode: couponCode || "",
        addonDays: addonDaysStr, // compact format fits in Razorpay notes
      },
    };

    const order = await getRazorpay().orders.create(options);

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

    console.log("[VERIFY DEBUG] Received:", {
      razorpay_order_id,
      razorpay_payment_id,
      hasSignature: !!razorpay_signature,
      orderId,
      bodyKeys: Object.keys(req.body),
      hasAddonDays: !!req.body.addonDays,
      addonDays: req.body.addonDays,
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

    const TripBooking = require("../models/TripBooking");

    // ── Idempotency: if this payment already created a booking, return it ─────
    const existing = await TripBooking.findOne({
      razorpayPaymentId: razorpay_payment_id,
    });
    if (existing) {
      return res.status(200).json({
        success: true,
        message: "Payment already processed",
        bookingId: existing._id,
        paymentId: razorpay_payment_id,
      });
    }

    // Fetch the order to get the trusted, server-priced context from notes
    const order = await getRazorpay().orders.fetch(razorpay_order_id);
    const notes = order.notes || {};
    const { packageId, batchId, seats, couponCode, userId } = notes;

    // ── Ensure the order belongs to the authenticated user ───────────────────
    if (userId && String(userId) !== String(req.user._id)) {
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

    // Use addonDays from the order notes (priced server-side), not the client body
    let addonDays = null;
    try {
      if (notes.addonDays) {
        // Try JSON first (legacy), then compact format "name:0,1|name2:2,3"
        try {
          addonDays = JSON.parse(notes.addonDays);
        } catch {
          // Parse compact format
          addonDays = {};
          notes.addonDays.split("|").forEach((part) => {
            const [name, daysStr] = part.split(":");
            if (name && daysStr) {
              addonDays[name] = daysStr.split(",").map(Number);
            }
          });
        }
      }
    } catch {
      addonDays = null;
    }

    // Now create the actual booking using the existing tripBookingController logic
    const tripBookingController = require("./tripBookingController");
    console.log("[VERIFY DEBUG] Creating booking with:", {
      packageId: notes.packageId,
      batchId: notes.batchId,
      bookingMode: notes.bookingMode,
      seats: notes.seats,
      adults: notes.adults,
      children: notes.children,
      addonDays,
      flexAvailabilityId: notes.flexAvailabilityId,
    });
    const fakeReq = {
      user: req.user,
      _paymentVerified: true, // SECURITY: marks this as a payment-verified booking
      body: {
        packageId,
        batchId: batchId || null,
        bookingMode: notes.bookingMode || "batch",
        flexStartDate: notes.flexStartDate || undefined,
        flexAvailabilityId: notes.flexAvailabilityId || undefined,
        seats: Number(seats) || 1,
        adults: notes.adults ? Number(notes.adults) : undefined,
        children: notes.children ? Number(notes.children) : 0,
        couponCode: couponCode || "",
        travelers: req.body.travelers || [],
        paymentId: razorpay_payment_id,
        razorpayOrderId: razorpay_order_id,
        addonDays,
        addonSchedule: req.body.addonSchedule || null,
      },
    };

    // Use a promise-based wrapper for the existing controller
    const booking = await new Promise((resolve, reject) => {
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

    res.status(200).json({
      success: true,
      message: "Payment verified and booking confirmed",
      bookingId: booking?.booking?._id || booking?._id || null,
      paymentId: razorpay_payment_id,
    });

    // Email is already sent by createBooking — no need to send again here
  } catch (err) {
    console.error("[VERIFY DEBUG] FULL ERROR:", err.message, err.stack);
    res.status(500).json({
      success: false,
      message: err.message || "Payment verification failed",
    });
  }
};
