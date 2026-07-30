const TripGroup = require("../models/TripGroup");
const TripBooking = require("../models/TripBooking");

// GET /api/trip-groups — operator's trip groups
exports.getMyGroups = async (req, res) => {
  try {
    const { packageId } = req.query;
    const query = { operatorId: req.operator._id };
    if (packageId) query.packageId = packageId;

    const groups = await TripGroup.find(query)
      .populate({
        path: "bookingIds",
        select:
          "bookingId userId seats status pricing snapshot flexStartDate travelers bookingMode",
        populate: { path: "userId", select: "name phone email" },
      })
      .populate("packageId", "title location durationDays itinerary")
      .sort({ tripStartDate: -1 });

    res.json({ success: true, groups });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/trip-groups — create a group from selected flex bookings
exports.createGroup = async (req, res) => {
  try {
    const { bookingIds, label, notes } = req.body;

    if (!Array.isArray(bookingIds) || bookingIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Select at least one booking to create a group.",
      });
    }
    if (bookingIds.length > 50) {
      return res.status(400).json({
        success: false,
        message: "A group can have at most 50 bookings.",
      });
    }

    // Verify all bookings belong to this operator and are flexible
    const bookings = await TripBooking.find({
      _id: { $in: bookingIds },
      operatorId: req.operator._id,
    }).select("packageId bookingMode status flexStartDate snapshot batchId");

    if (bookings.length !== bookingIds.length) {
      return res.status(400).json({
        success: false,
        message: "One or more bookings were not found or don't belong to you.",
      });
    }

    // All must be from the same package
    const packageIds = [...new Set(bookings.map((b) => String(b.packageId)))];
    if (packageIds.length > 1) {
      return res.status(400).json({
        success: false,
        message: "All bookings in a group must be from the same package.",
      });
    }

    // Check none are already in another group
    const existing = await TripGroup.findOne({
      bookingIds: { $in: bookingIds },
      operatorId: req.operator._id,
    });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: `One or more bookings are already in group "${existing.label || "Untitled"}". Remove them first.`,
      });
    }

    // Derive trip date range from the bookings
    const starts = bookings
      .map(
        (b) =>
          b.flexStartDate ||
          (b.snapshot?.startDate ? new Date(b.snapshot.startDate) : null),
      )
      .filter(Boolean);
    const ends = bookings
      .map((b) => (b.snapshot?.endDate ? new Date(b.snapshot.endDate) : null))
      .filter(Boolean);

    const tripStartDate =
      starts.length > 0
        ? new Date(Math.min(...starts.map((d) => d.getTime())))
        : undefined;
    const tripEndDate =
      ends.length > 0
        ? new Date(Math.max(...ends.map((d) => d.getTime())))
        : undefined;

    const group = await TripGroup.create({
      operatorId: req.operator._id,
      packageId: packageIds[0],
      label: (label || "").trim().slice(0, 80) || undefined,
      bookingIds,
      tripStartDate,
      tripEndDate,
      notes: (notes || "").trim().slice(0, 500),
    });

    // Populate for the response
    const populated = await TripGroup.findById(group._id)
      .populate({
        path: "bookingIds",
        select:
          "bookingId userId seats status pricing snapshot flexStartDate travelers bookingMode",
        populate: { path: "userId", select: "name phone email" },
      })
      .populate("packageId", "title location durationDays itinerary");

    res.status(201).json({ success: true, group: populated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
