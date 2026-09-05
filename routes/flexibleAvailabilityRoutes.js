const express = require("express");
const router = express.Router();
const {
  operatorProtect,
  requireApprovedOperator,
} = require("../middleware/operatorAuthMiddleware");
const FlexibleAvailability = require("../models/FlexibleAvailability");
const Package = require("../models/Package");

// ── GET /api/flexible-availability?packageId=xxx — get all for a package (operator)
router.get("/", operatorProtect, async (req, res) => {
  try {
    const { packageId } = req.query;
    if (!packageId) {
      return res
        .status(400)
        .json({ success: false, message: "packageId is required" });
    }
    // Verify operator owns this package
    const pkg = await Package.findById(packageId);
    if (!pkg || String(pkg.operatorId) !== String(req.operator._id)) {
      return res
        .status(403)
        .json({ success: false, message: "Not your package" });
    }
    const items = await FlexibleAvailability.find({ packageId }).sort({
      startDate: 1,
    });
    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/flexible-availability/package/:packageId — public (app uses this)
router.get("/package/:packageId", async (req, res) => {
  try {
    const pkg = await Package.findOne({
      _id: req.params.packageId,
      status: "APPROVED",
      isActive: true,
    }).select("_id");
    if (!pkg) {
      return res
        .status(404)
        .json({ success: false, message: "Package not found" });
    }

    const items = await FlexibleAvailability.find({
      packageId: pkg._id,
      isActive: true,
      endDate: { $gte: new Date() },
    }).sort({ startDate: 1 });
    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/flexible-availability — create (approved operator)
router.post("/", operatorProtect, requireApprovedOperator, async (req, res) => {
  try {
    const {
      packageId,
      startDate,
      endDate,
      adultPrice,
      childPrice,
      maxBookings = 0,
    } = req.body;

    if (!packageId || !startDate || !endDate || adultPrice == null) {
      return res.status(400).json({
        success: false,
        message: "packageId, startDate, endDate, and adultPrice are required",
      });
    }

    const parsedAdultPrice = Number(adultPrice);
    const parsedChildPrice = childPrice == null ? 0 : Number(childPrice);
    const parsedMaxBookings = Number(maxBookings);
    if (!Number.isFinite(parsedAdultPrice) || parsedAdultPrice <= 0) {
      return res.status(400).json({
        success: false,
        message: "Adult price must be greater than ₹0",
      });
    }
    if (!Number.isFinite(parsedChildPrice) || parsedChildPrice < 0) {
      return res.status(400).json({
        success: false,
        message: "Child price cannot be negative",
      });
    }
    // Consistency with the PUT path: child price can't exceed adult price
    if (parsedChildPrice > parsedAdultPrice) {
      return res.status(400).json({
        success: false,
        message: "Child price cannot be higher than the adult price",
      });
    }
    if (
      !Number.isInteger(parsedMaxBookings) ||
      parsedMaxBookings < 0 ||
      parsedMaxBookings > 1000
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Maximum bookings must be a whole number between 0 and 1000 (0 means unlimited)",
      });
    }

    // Verify ownership
    const pkg = await Package.findById(packageId);
    if (!pkg || String(pkg.operatorId) !== String(req.operator._id)) {
      return res
        .status(403)
        .json({ success: false, message: "Not your package" });
    }
    // Date-availability ranges only apply to flexible-mode packages
    if (pkg.bookingMode !== "flexible") {
      return res.status(400).json({
        success: false,
        message:
          "This package uses fixed batches, not flexible dates. Switch its booking mode to 'flexible' first.",
      });
    }

    if (new Date(endDate) <= new Date(startDate)) {
      return res
        .status(400)
        .json({ success: false, message: "endDate must be after startDate" });
    }

    // Reject past dates
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (new Date(startDate) < today) {
      return res
        .status(400)
        .json({ success: false, message: "Start date cannot be in the past" });
    }

    // Check for overlapping ACTIVE date ranges on the same package
    // (disabled ranges don't block re-listing new dates over the same window)
    const overlap = await FlexibleAvailability.findOne({
      packageId,
      isActive: { $ne: false },
      startDate: { $lt: new Date(endDate) },
      endDate: { $gt: new Date(startDate) },
    });
    if (overlap) {
      return res.status(400).json({
        success: false,
        message: `This range overlaps with an existing range (${overlap.startDate.toLocaleDateString("en-IN")} – ${overlap.endDate.toLocaleDateString("en-IN")}). Please choose different dates.`,
      });
    }

    const item = await FlexibleAvailability.create({
      packageId,
      operatorId: req.operator._id,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      adultPrice: parsedAdultPrice,
      childPrice: parsedChildPrice,
      maxBookings: parsedMaxBookings,
    });

    res.status(201).json({ success: true, item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/flexible-availability/:id — update (approved operator)
router.put(
  "/:id",
  operatorProtect,
  requireApprovedOperator,
  async (req, res) => {
    try {
      const item = await FlexibleAvailability.findById(req.params.id);
      if (!item) {
        return res.status(404).json({ success: false, message: "Not found" });
      }
      if (String(item.operatorId) !== String(req.operator._id)) {
        return res
          .status(403)
          .json({ success: false, message: "Not your record" });
      }

      const {
        startDate,
        endDate,
        adultPrice,
        childPrice,
        maxBookings,
        isActive,
      } = req.body;

      // Block edits while travellers hold bookings in this range
      const TripBookingModel = require("../models/TripBooking");
      const liveBookings = await TripBookingModel.countDocuments({
        flexAvailabilityId: item._id,
        status: { $in: ["CONFIRMED", "PENDING"] },
      });
      const changingTerms =
        startDate != null ||
        endDate != null ||
        adultPrice != null ||
        childPrice != null;
      if (liveBookings > 0 && changingTerms) {
        return res.status(400).json({
          success: false,
          message: `Cannot change dates or pricing — ${liveBookings} active booking(s) use this range. You can still disable it.`,
        });
      }

      const datesChanged = startDate != null || endDate != null;
      if (startDate) item.startDate = new Date(startDate);
      if (endDate) item.endDate = new Date(endDate);
      if (adultPrice != null) item.adultPrice = Number(adultPrice);
      if (childPrice != null) item.childPrice = Number(childPrice);
      let parsedMaxBookings = null;
      if (maxBookings != null) {
        parsedMaxBookings = Number(maxBookings);
        if (
          !Number.isInteger(parsedMaxBookings) ||
          parsedMaxBookings < 0 ||
          parsedMaxBookings > 1000
        ) {
          return res.status(400).json({
            success: false,
            message:
              "Maximum bookings must be a whole number between 0 and 1000 (0 means unlimited)",
          });
        }
      }
      if (isActive != null) item.isActive = Boolean(isActive);

      if (
        Number.isNaN(item.startDate?.getTime?.()) ||
        Number.isNaN(item.endDate?.getTime?.())
      ) {
        return res
          .status(400)
          .json({ success: false, message: "Please provide valid dates" });
      }

      if (item.endDate <= item.startDate) {
        return res
          .status(400)
          .json({ success: false, message: "endDate must be after startDate" });
      }

      // POST rejects past dates and non-positive prices; PUT did neither.
      if (datesChanged) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (item.startDate < today) {
          return res.status(400).json({
            success: false,
            message: "Start date cannot be in the past",
          });
        }
      }

      if (!Number.isFinite(item.adultPrice) || item.adultPrice <= 0) {
        return res.status(400).json({
          success: false,
          message: "Adult price must be greater than ₹0",
        });
      }
      if (!Number.isFinite(item.childPrice) || item.childPrice < 0) {
        return res
          .status(400)
          .json({ success: false, message: "Child price cannot be negative" });
      }
      if (item.childPrice > item.adultPrice) {
        return res.status(400).json({
          success: false,
          message: "Child price cannot be higher than the adult price",
        });
      }

      // Check for overlapping ACTIVE date ranges (exclude self; ignore disabled)
      const overlap = await FlexibleAvailability.findOne({
        packageId: item.packageId,
        _id: { $ne: item._id },
        isActive: { $ne: false },
        startDate: { $lt: item.endDate },
        endDate: { $gt: item.startDate },
      });
      if (overlap) {
        return res.status(400).json({
          success: false,
          message: `This range overlaps with an existing range (${overlap.startDate.toLocaleDateString("en-IN")} – ${overlap.endDate.toLocaleDateString("en-IN")}). Please choose different dates.`,
        });
      }

      // Apply the edit as one conditional write. The capacity predicate is on
      // the same document used by checkout's atomic reservation, so either a
      // booking observes the new limit or the limit reduction loses with 409;
      // the two operations cannot leave bookedSeats above maxBookings.
      const updateFields = {};
      if (startDate) updateFields.startDate = item.startDate;
      if (endDate) updateFields.endDate = item.endDate;
      if (adultPrice != null) updateFields.adultPrice = item.adultPrice;
      if (childPrice != null) updateFields.childPrice = item.childPrice;
      if (parsedMaxBookings != null)
        updateFields.maxBookings = parsedMaxBookings;
      if (isActive != null) updateFields.isActive = item.isActive;

      const updateQuery = {
        _id: item._id,
        operatorId: req.operator._id,
      };
      if (parsedMaxBookings > 0) {
        updateQuery.$expr = {
          $lte: [{ $ifNull: ["$bookedSeats", 0] }, parsedMaxBookings],
        };
      }

      const updated = await FlexibleAvailability.findOneAndUpdate(
        updateQuery,
        { $set: updateFields },
        { new: true, runValidators: true },
      );
      if (!updated) {
        const current = await FlexibleAvailability.findById(item._id).select(
          "bookedSeats",
        );
        return res.status(409).json({
          success: false,
          message: `Maximum bookings cannot be lower than the ${current?.bookedSeats || 0} seats already booked`,
        });
      }

      res.json({ success: true, item: updated });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ── DELETE /api/flexible-availability/:id — delete (approved operator)
router.delete(
  "/:id",
  operatorProtect,
  requireApprovedOperator,
  async (req, res) => {
    try {
      const item = await FlexibleAvailability.findById(req.params.id);
      if (!item) {
        return res.status(404).json({ success: false, message: "Not found" });
      }
      if (String(item.operatorId) !== String(req.operator._id)) {
        return res
          .status(403)
          .json({ success: false, message: "Not your record" });
      }

      // Block delete if there are active (CONFIRMED/PENDING) bookings using this flex range
      const TripBooking = require("../models/TripBooking");
      const activeBookings = await TripBooking.countDocuments({
        flexAvailabilityId: item._id,
        status: { $in: ["CONFIRMED", "PENDING"] },
      });
      if (activeBookings > 0) {
        return res.status(400).json({
          success: false,
          message: `Cannot delete — ${activeBookings} active booking(s) use this date range. Disable it instead.`,
        });
      }

      await item.deleteOne();
      res.json({ success: true, message: "Deleted" });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

module.exports = router;
