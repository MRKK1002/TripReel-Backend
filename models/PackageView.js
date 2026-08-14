const mongoose = require("mongoose");

// Tracks that a user opened a package's detail screen (but may not have reached
// the booking screen). A cron sends a package-specific re-engagement push a few
// hours later if they never booked. One record per user+package (upserted).
const packageViewSchema = new mongoose.Schema(
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
    viewCount: { type: Number, default: 1 },
    lastViewedAt: { type: Date, default: Date.now, index: true },
    // Reminder state
    notified: { type: Boolean, default: false },
    converted: { type: Boolean, default: false }, // set true once they book
  },
  { timestamps: true },
);

packageViewSchema.index({ userId: 1, packageId: 1 }, { unique: true });

module.exports = mongoose.model("PackageView", packageViewSchema);
