const mongoose = require("mongoose");

// Stores the full booking payload for a Razorpay order the moment it is created,
// BEFORE the customer pays. If the app is killed after payment is captured but
// before /payments/verify runs, a webhook or reconciliation cron can still create
// the booking from this record (the order notes alone don't carry traveller
// names/gender or the add-on schedule). One record per Razorpay order.
const pendingOrderSchema = new mongoose.Schema(
  {
    razorpayOrderId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    amount: { type: Number, default: 0 }, // rupees (authoritative order amount)
    // Full booking payload — used to recreate the booking on recovery
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: ["pending", "completed", "expired"],
      default: "pending",
      index: true,
    },
    // Set once a booking has been created from this order (idempotency)
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "TripBooking" },
    completedAt: { type: Date },
  },
  { timestamps: true },
);

module.exports = mongoose.model("PendingOrder", pendingOrderSchema);
