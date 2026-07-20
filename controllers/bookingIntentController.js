const BookingIntent = require("../models/BookingIntent");

// POST /api/booking-intents — record that the user reached the booking screen
// (upsert per user+package; resets reminder state so a fresh visit can re-remind)
exports.recordIntent = async (req, res) => {
  try {
    const {
      packageId,
      packageTitle,
      bookingMode,
      batchId,
      flexAvailabilityId,
      flexStartDate,
    } = req.body;

    if (!packageId) {
      return res
        .status(400)
        .json({ success: false, message: "packageId is required" });
    }

    await BookingIntent.findOneAndUpdate(
      { userId: req.user._id, packageId },
      {
        $set: {
          packageTitle: packageTitle || "",
          bookingMode: bookingMode === "flexible" ? "flexible" : "batch",
          batchId: batchId || undefined,
          flexAvailabilityId: flexAvailabilityId || undefined,
          flexStartDate: flexStartDate || undefined,
          notified: false,
          converted: false,
          lastSeenAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.json({ success: true });
  } catch (err) {
    // Non-critical — never block the booking screen on this
    res.status(200).json({ success: false, message: err.message });
  }
};

// Mark a user's intent for a package as converted (called after a booking).
exports.markIntentConverted = async (userId, packageId) => {
  try {
    await BookingIntent.updateOne(
      { userId, packageId },
      { $set: { converted: true } },
    );
  } catch {
    // best-effort
  }
};
