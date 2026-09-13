const mongoose = require("mongoose");

const addonEntryRefundSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TripBooking",
      required: true,
      index: true,
    },
    entryKey: { type: String, required: true },
    addonPurchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AddonPurchase",
      default: null,
    },
    paymentSource: { type: String, enum: ["INITIAL", "TOPUP"], required: true },
    paymentId: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    reason: { type: String, default: "" },
    providerStatus: { type: String, default: "" },
    status: {
      type: String,
      enum: ["PENDING", "PROCESSING", "REFUNDED", "RECONCILIATION_REQUIRED"],
      default: "PENDING",
      index: true,
    },
    refundId: { type: String, default: "" },
    refundedAt: { type: Date, default: null },
    error: { type: String, default: "" },
  },
  { timestamps: true },
);

addonEntryRefundSchema.index({ bookingId: 1, entryKey: 1 }, { unique: true });

module.exports = mongoose.model("AddonEntryRefund", addonEntryRefundSchema);
