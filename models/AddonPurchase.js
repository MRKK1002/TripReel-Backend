const mongoose = require("mongoose");

const addonPurchaseSchema = new mongoose.Schema(
  {
    razorpayOrderId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    razorpayPaymentId: { type: String, default: "" },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TripBooking",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    entryKeys: { type: [String], required: true },
    entries: { type: mongoose.Schema.Types.Mixed, required: true },
    pricing: { type: mongoose.Schema.Types.Mixed, required: true },
    requestedAddonDays: { type: mongoose.Schema.Types.Mixed, required: true },
    requestedSchedule: { type: mongoose.Schema.Types.Mixed, default: {} },
    amountPaise: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, default: "INR" },
    status: {
      type: String,
      enum: [
        "PENDING",
        "CAPTURED",
        "PROCESSING",
        "APPLIED",
        "REFUND_PROCESSING",
        "REFUNDED",
        "RECONCILIATION_REQUIRED",
        "EXPIRED",
      ],
      default: "PENDING",
      index: true,
    },
    paidAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },
    partialRefundInFlight: { type: Boolean, default: false },
    leaseToken: { type: String, default: "" },
    leaseUntil: { type: Date, default: null },
    applicationAttempts: { type: Number, default: 0 },
    appliedAt: { type: Date, default: null },
    applicationError: { type: String, default: "" },
    refundStatus: {
      type: String,
      enum: [
        "NONE",
        "PROCESSING",
        "REFUNDED",
        "FAILED",
        "RECONCILIATION_REQUIRED",
      ],
      default: "NONE",
    },
    refundAmount: { type: Number, default: 0 },
    refundId: { type: String, default: "" },
    refundedAt: { type: Date, default: null },
    refundError: { type: String, default: "" },
    refundReason: { type: String, default: "" },
    unexpectedPayments: { type: mongoose.Schema.Types.Mixed, default: [] },
  },
  { timestamps: true },
);

addonPurchaseSchema.index(
  { razorpayPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: { razorpayPaymentId: { $gt: "" } },
  },
);
addonPurchaseSchema.index({ bookingId: 1, status: 1 });

module.exports = mongoose.model("AddonPurchase", addonPurchaseSchema);
