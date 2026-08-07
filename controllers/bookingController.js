const Booking = require("../models/Booking");
const PackageListing = require("../models/PackageListing");
const PackageTemplate = require("../models/PackageTemplate");
const Package = require("../models/Package");

function calcPricing({ baseAmount, gstRate, tcsRate, currency }) {
  const gstAmount = Math.round((baseAmount * (gstRate || 0)) / 100);
  const tcsAmount = Math.round((baseAmount * (tcsRate || 0)) / 100);
  const totalAmount = baseAmount + gstAmount + tcsAmount;
  return {
    currency: currency || "INR",
    baseAmount,
    gstAmount,
    tcsAmount,
    totalAmount,
    gstRate: gstRate || 0,
    tcsRate: tcsRate || 0,
  };
}

// GET /api/bookings (admin)
exports.adminGetAllBookings = async (req, res) => {
  try {
    const { status, page = 1, limit = 20, search } = req.query;
    const query = {};
    if (status && status !== "all") query.status = status;
    if (search) {
      const escapeRegex = require("../utils/escapeRegex");
      query.bookingId = { $regex: escapeRegex(String(search)), $options: "i" };
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [bookings, total] = await Promise.all([
      Booking.find(query)
        .populate("userId", "name email")
        .populate("templateId", "destinationName theme durationLabel seoPath")
        .populate("listingId", "basePrice gstRate tcsRate")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Booking.countDocuments(query),
    ]);

    res.json({ success: true, bookings, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/bookings/my (user)
exports.getMyBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ userId: req.user._id })
      .populate("templateId", "destinationName theme durationLabel seoPath")
      .populate("listingId", "basePrice gstRate tcsRate")
      .sort({ createdAt: -1 });
    res.json({ success: true, bookings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/bookings/:id (user/admin)
exports.getBookingById = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id)
      .populate("userId", "name email")
      .populate("templateId")
      .populate("listingId");
    if (!booking)
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });

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

// POST /api/bookings (user)
exports.createBooking = async (req, res) => {
  try {
    const {
      listingId,
      travelers = [],
      travelStartDate,
      travelEndDate,
      guests,
    } = req.body;
    if (!listingId)
      return res
        .status(400)
        .json({ success: false, message: "listingId is required" });

    const listing = await PackageListing.findById(listingId).lean();
    if (!listing)
      return res
        .status(404)
        .json({ success: false, message: "Listing not found" });
    if (!listing.isActive || listing.status !== "APPROVED") {
      return res.status(400).json({
        success: false,
        message: "Listing is not available for booking",
      });
    }

    const template = listing.templateId
      ? await PackageTemplate.findById(listing.templateId).lean()
      : null;

    const qty =
      Number(
        guests ||
          (Array.isArray(travelers) && travelers.length ? travelers.length : 1),
      ) || 1;
    const baseAmount = Math.round(Number(listing.basePrice || 0) * qty);
    const pricing = calcPricing({
      baseAmount,
      gstRate: Number(listing.gstRate || 0),
      tcsRate: Number(listing.tcsRate || 0),
      currency: listing.currency || "INR",
    });

    const booking = await Booking.create({
      userId: req.user._id,
      listingId,
      templateId: listing.templateId || null,
      travelStartDate: travelStartDate ? new Date(travelStartDate) : undefined,
      travelEndDate: travelEndDate ? new Date(travelEndDate) : undefined,
      travelers: Array.isArray(travelers) ? travelers : [],
      pricing,
      snapshot: {
        template,
        listing,
      },
    });

    res.status(201).json({ success: true, booking });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// PATCH /api/bookings/:id/status (admin)
exports.updateBookingStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ["PENDING", "CONFIRMED", "CANCELLED", "COMPLETED"];
    if (!allowed.includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid status" });
    }

    const booking = await Booking.findById(req.params.id);
    if (!booking)
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });

    const prevStatus = booking.status;
    booking.status = status;
    await booking.save();

    // When confirmed for the first time → increment package bookingCount (popularity signal)
    if (status === "CONFIRMED" && prevStatus !== "CONFIRMED") {
      try {
        const pkgId =
          booking.snapshot?.listing?.packageId ||
          booking.snapshot?.template?.packageId ||
          null;
        if (pkgId) {
          await Package.findByIdAndUpdate(pkgId, { $inc: { bookingCount: 1 } });
        }
      } catch (_) {
        /* non-critical, don't fail the booking update */
      }
    }

    // When a confirmed booking is cancelled → decrement to keep count accurate
    if (status === "CANCELLED" && prevStatus === "CONFIRMED") {
      try {
        const pkgId =
          booking.snapshot?.listing?.packageId ||
          booking.snapshot?.template?.packageId ||
          null;
        if (pkgId) {
          await Package.findByIdAndUpdate(pkgId, {
            $inc: { bookingCount: -1 },
          });
        }
      } catch (_) {
        /* non-critical */
      }
    }

    res.json({ success: true, booking });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
