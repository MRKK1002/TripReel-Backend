const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    // Who receives this notification
    recipientId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    recipientType: {
      type: String,
      enum: ["user", "operator", "admin"],
      required: true,
    },

    // Content
    title: { type: String, required: true },
    body: { type: String, default: "" },
    type: {
      type: String,
      enum: [
        "booking_confirmed",
        "booking_cancelled",
        "trip_reminder",
        "trip_completed",
        "new_booking",
        "package_approved",
        "package_rejected",
        "package_revision",
        "wallet_credited",
        "new_review",
        "report_resolved",
        "account_suspended",
        "account_reinstated",
        "account_approved",
        "offer",
        "general",
      ],
      default: "general",
    },

    // Optional reference
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "TripBooking" },
    packageId: { type: mongoose.Schema.Types.ObjectId, ref: "Package" },

    // Read status
    read: { type: Boolean, default: false },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Notification", notificationSchema);
