const TripBooking = require("../models/TripBooking");
const Batch = require("../models/Batch");
const Package = require("../models/Package");
const OperatorWallet = require("../models/OperatorWallet");
const WalletTransaction = require("../models/WalletTransaction");
const { getSetting } = require("./platformSettingsController");

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcPricing({ adultPrice, seats, platformFeePercent, gstPercent }) {
  const subtotal = Math.round(adultPrice * seats);
  const platformFeeAmount = Math.round((subtotal * platformFeePercent) / 100);
  const gstAmount = Math.round((subtotal * gstPercent) / 100);
  const totalAmount = subtotal + gstAmount;
  const operatorAmount = totalAmount - platformFeeAmount;
  return {
    adultPrice,
    seats,
    subtotal,
    platformFeePercent,
    platformFeeAmount,
    gstPercent,
    gstAmount,
    totalAmount,
    operatorAmount,
  };
}

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

// ── User ──────────────────────────────────────────────────────────────────────

// POST /api/trip-bookings  — user creates a booking
exports.createBooking = async (req, res) => {
  try {
    const { packageId, batchId, seats = 1 } = req.body;

    if (!packageId || !batchId) {
      return res.status(400).json({
        success: false,
        message: "packageId and batchId are required",
      });
    }

    const numSeats = Math.max(1, Number(seats) || 1);

    // ── Fetch and validate batch ───────────────────────────────────────────
    const batch = await Batch.findById(batchId);
    if (!batch || !batch.isActive) {
      return res
        .status(404)
        .json({ success: false, message: "Batch not found or not available" });
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

    // User CAN book same batch multiple times (e.g. adding more friends later)

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

    // ── Calculate pricing (snapshotted forever) ────────────────────────────
    const pricing = calcPricing({
      adultPrice: batch.adultPrice,
      seats: numSeats,
      platformFeePercent,
      gstPercent,
    });

    // ── Apply coupon if provided ───────────────────────────────────────────
    const couponCode = (req.body.couponCode || "").trim().toUpperCase();
    let discountAmount = 0;
    let appliedCouponId = null;

    if (couponCode) {
      const Coupon = require("../models/Coupon");
      const now = new Date();
      const coupon = await Coupon.findOne({
        batchId,
        code: couponCode,
        isActive: true,
        validFrom: { $lte: now },
        validUntil: { $gte: now },
      });

      if (coupon) {
        // Check usage limit
        const withinUsage =
          coupon.usageLimit === 0 || coupon.usedCount < coupon.usageLimit;
        // Check min guests
        const meetsGuests =
          coupon.minGuests === 0 || numSeats >= coupon.minGuests;
        // Check min order
        const meetsOrder =
          coupon.minOrderAmount === 0 ||
          pricing.subtotal >= coupon.minOrderAmount;

        if (withinUsage && meetsGuests && meetsOrder) {
          if (coupon.type === "percentage") {
            discountAmount = Math.round(
              (pricing.subtotal * coupon.value) / 100,
            );
            if (coupon.maxDiscount > 0 && discountAmount > coupon.maxDiscount) {
              discountAmount = coupon.maxDiscount;
            }
          } else {
            discountAmount = Math.min(coupon.value, pricing.subtotal);
          }
          appliedCouponId = coupon._id;
          // Increment usage
          coupon.usedCount += 1;
          await coupon.save();
        }
      }
    }

    // Update pricing with discount
    if (discountAmount > 0) {
      pricing.discountAmount = discountAmount;
      pricing.couponCode = couponCode;
      pricing.totalAmount = pricing.totalAmount - discountAmount;
      pricing.operatorAmount = pricing.totalAmount - pricing.platformFeeAmount;
    }

    // ── Build snapshot ─────────────────────────────────────────────────────
    const snapshot = {
      packageTitle: pkg.title,
      packageLocation: pkg.location,
      packageImageUrl: pkg.image_url || "",
      batchLabel: batch.label || "",
      startDate: batch.startDate,
      endDate: batch.endDate,
      adultPrice: batch.adultPrice,
    };

    // ── Create booking — auto-confirmed (payment simulated) ──────────────────
    const booking = await TripBooking.create({
      userId: req.user._id,
      packageId,
      batchId,
      operatorId: batch.operatorId,
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
    });

    // ── Side effects — increment seats + bookingCount immediately ──────────
    await Batch.findByIdAndUpdate(batchId, { $inc: { bookedSeats: numSeats } });
    await Package.findByIdAndUpdate(packageId, {
      $inc: { bookingCount: numSeats },
    });
    // NOTE: Wallet credit happens via cron 2 days after trip endDate (not now)

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

// ── Admin ─────────────────────────────────────────────────────────────────────

// GET /api/trip-bookings  — admin: all bookings
exports.adminGetAllBookings = async (req, res) => {
  try {
    const {
      status,
      packageId,
      operatorId,
      batchId,
      search,
      page = 1,
      limit = 20,
    } = req.query;

    const query = {};
    if (status && status !== "all") query.status = status;
    if (packageId) query.packageId = packageId;
    if (operatorId) query.operatorId = operatorId;
    if (batchId) query.batchId = batchId;
    if (search) query.bookingId = { $regex: search, $options: "i" };

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

    booking.status = status;
    if (status === "CANCELLED") {
      booking.cancelReason = (cancelReason || "Cancelled by admin").trim();
      booking.cancelledBy = "admin";
    }

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

    // CANCELLED (was CONFIRMED) → reverse seats + bookingCount + debit wallet
    if (status === "CANCELLED" && prevStatus === "CONFIRMED") {
      await Batch.findByIdAndUpdate(booking.batchId, {
        $inc: { bookedSeats: -booking.seats },
      });
      await Package.findByIdAndUpdate(booking.packageId, {
        $inc: { bookingCount: -booking.seats },
      });
      await debitOperatorWallet(
        booking.operatorId,
        booking.pricing.operatorAmount,
        booking._id,
        `Booking ${booking.bookingId} cancelled — reversal`,
      );
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
    const { status, packageId, batchId, page = 1, limit = 20 } = req.query;
    const query = { operatorId: req.operator._id };
    if (status && status !== "all") query.status = status;
    if (packageId) query.packageId = packageId;
    if (batchId) query.batchId = batchId;

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

    // Calculate refund based on days before trip start
    const startDate = booking.snapshot?.startDate;
    let refundPercent = 0;
    let refundAmount = 0;

    if (startDate) {
      const now = new Date();
      const tripStart = new Date(startDate);
      const daysBeforeTrip = Math.ceil(
        (tripStart - now) / (1000 * 60 * 60 * 24),
      );

      // Get refund slabs from platform settings
      let slabs = [
        { daysBeforeTrip: 7, refundPercent: 90 },
        { daysBeforeTrip: 3, refundPercent: 50 },
        { daysBeforeTrip: 0, refundPercent: 0 },
      ];

      try {
        const slabsSetting = await getSetting("cancellation_refund_slabs");
        if (Array.isArray(slabsSetting) && slabsSetting.length > 0) {
          slabs = slabsSetting;
        }
      } catch {}

      // Sort slabs descending by daysBeforeTrip
      slabs.sort((a, b) => b.daysBeforeTrip - a.daysBeforeTrip);

      // Find which slab applies
      for (const slab of slabs) {
        if (daysBeforeTrip >= slab.daysBeforeTrip) {
          refundPercent = slab.refundPercent;
          break;
        }
      }

      refundAmount = Math.round(
        (booking.pricing.totalAmount * refundPercent) / 100,
      );
    }

    // Update booking
    booking.status = "CANCELLED";
    booking.cancelReason = reason || "Cancelled by user";
    booking.cancelledBy = "user";
    booking.cancelledAt = new Date();
    booking.refundPercent = refundPercent;
    booking.refundAmount = refundAmount;
    await booking.save();

    // Release seats on the batch
    await Batch.findByIdAndUpdate(booking.batchId, {
      $inc: { bookedSeats: -booking.seats },
    });

    // Decrement bookingCount on the package
    await Package.findByIdAndUpdate(booking.packageId, {
      $inc: { bookingCount: -1 },
    });

    res.json({
      success: true,
      message: "Booking cancelled successfully",
      refundPercent,
      refundAmount,
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
    let refundPercent = 0;
    let daysBeforeTrip = 0;

    if (startDate) {
      const now = new Date();
      const tripStart = new Date(startDate);
      daysBeforeTrip = Math.ceil((tripStart - now) / (1000 * 60 * 60 * 24));

      let slabs = [
        { daysBeforeTrip: 7, refundPercent: 90 },
        { daysBeforeTrip: 3, refundPercent: 50 },
        { daysBeforeTrip: 0, refundPercent: 0 },
      ];

      try {
        const slabsSetting = await getSetting("cancellation_refund_slabs");
        if (Array.isArray(slabsSetting) && slabsSetting.length > 0) {
          slabs = slabsSetting;
        }
      } catch {}

      slabs.sort((a, b) => b.daysBeforeTrip - a.daysBeforeTrip);
      for (const slab of slabs) {
        if (daysBeforeTrip >= slab.daysBeforeTrip) {
          refundPercent = slab.refundPercent;
          break;
        }
      }
    }

    const refundAmount = Math.round(
      (booking.pricing.totalAmount * refundPercent) / 100,
    );

    res.json({
      success: true,
      daysBeforeTrip,
      refundPercent,
      refundAmount,
      totalPaid: booking.pricing.totalAmount,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
