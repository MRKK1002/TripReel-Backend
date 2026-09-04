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
      draft,
    } = req.body;

    if (!packageId) {
      return res
        .status(400)
        .json({ success: false, message: "packageId is required" });
    }

    const set = {
      packageTitle: packageTitle || "",
      bookingMode: bookingMode === "flexible" ? "flexible" : "batch",
      batchId: batchId || undefined,
      flexAvailabilityId: flexAvailabilityId || undefined,
      flexStartDate: flexStartDate || undefined,
      notified: false,
      converted: false,
      lastSeenAt: new Date(),
    };

    // Draft snapshot (optional) — used to pre-fill the booking screen on resume
    if (draft && typeof draft === "object") {
      set.draft = {
        adults: Number(draft.adults) || 1,
        children: Number(draft.children) || 0,
        travelers: Array.isArray(draft.travelers) ? draft.travelers : [],
        addonDays:
          draft.addonDays && typeof draft.addonDays === "object"
            ? draft.addonDays
            : {},
        addonSchedule:
          draft.addonSchedule && typeof draft.addonSchedule === "object"
            ? draft.addonSchedule
            : {},
        couponCode: draft.couponCode || "",
      };
    }

    const intent = await BookingIntent.findOneAndUpdate(
      { userId: req.user._id, packageId },
      { $set: set },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.json({ success: true, intentId: intent._id.toString() });
  } catch (err) {
    // Non-critical — never block the booking screen on this
    res.status(200).json({ success: false, message: err.message });
  }
};

// GET /api/booking-intents/:id — fetch a single intent (for resume/pre-fill).
// Only returns the intent if it belongs to the requesting user and is fresh.
exports.getIntentById = async (req, res) => {
  try {
    const intent = await BookingIntent.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!intent) {
      return res
        .status(404)
        .json({ success: false, message: "Intent not found" });
    }

    // Freshness window — after this we don't trust the draft (prices/seats
    // may have changed), so the app should just open the package instead.
    const TTL_HOURS = 72;
    const ageMs = Date.now() - new Date(intent.lastSeenAt).getTime();
    const fresh = ageMs <= TTL_HOURS * 60 * 60 * 1000;

    res.json({ success: true, fresh, intent });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
