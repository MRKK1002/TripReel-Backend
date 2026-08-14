const mongoose = require("mongoose");

// Tracks when a user reached the booking screen for a package but hasn't
// completed the booking yet. A cron sends a gentle reminder push a couple of
// hours later, deep-linking back to the package so they can finish booking.
const bookingIntentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    packageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Package",
      required: true,
    },
    packageTitle: { type: String, default: "" },
    bookingMode: {
      type: String,
      enum: ["batch", "flexible"],
      default: "batch",
    },
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: "Batch" },
    flexAvailabilityId: { type: mongoose.Schema.Types.ObjectId },
    flexStartDate: { type: Date },
    // ── Draft snapshot — so we can pre-fill the booking screen when the user
    // taps the reminder ("pick up where you left off"). Stored loosely.
    draft: {
      adults: { type: Number, default: 1 },
      children: { type: Number, default: 0 },
      travelers: { type: mongoose.Schema.Types.Mixed, default: [] },
      addonDays: { type: mongoose.Schema.Types.Mixed, default: {} },
      addonSchedule: { type: mongoose.Schema.Types.Mixed, default: {} },
      couponCode: { type: String, default: "" },
    },
    // Reminder state
    notified: { type: Boolean, default: false },
    converted: { type: Boolean, default: false }, // set true once they book
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// One live intent per user+package (upsert on each visit to the booking screen)
bookingIntentSchema.index({ userId: 1, packageId: 1 }, { unique: true });

module.exports = mongoose.model("BookingIntent", bookingIntentSchema);
