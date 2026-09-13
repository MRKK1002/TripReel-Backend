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
    // Exact server-side quote used to create the provider order. Finalization
    // consumes this snapshot and revalidates only mutable eligibility/capacity.
    chargedPricingSnapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    // Indexed source references make integrity guards reliable for new rows;
    // controllers also retain payload fallbacks for legacy orders.
    packageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Package",
      index: true,
    },
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      index: true,
    },
    flexAvailabilityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FlexibleAvailability",
      index: true,
    },
    flexInventoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FlexibleDateInventory",
      index: true,
    },
    flexStartDateKey: { type: String, default: "" },
    flexReservationClaimKey: { type: String, default: "" },
    batchReservationClaimKey: { type: String, default: "" },
    providerPaymentId: { type: String, default: "", index: true },
    paidAt: { type: Date, default: null },
    // Full booking payload — used to recreate the booking on recovery
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: ["pending", "completed", "expired"],
      default: "pending",
      index: true,
    },
    finalizationState: {
      type: String,
      enum: [
        "PENDING",
        "PROCESSING",
        "RETRYABLE",
        "COMPLETED",
        "REFUND_REQUIRED",
        "REFUND_PROCESSING",
        "REFUNDED",
        "RECONCILIATION_REQUIRED",
      ],
      default: "PENDING",
      index: true,
    },
    finalizationAttempts: { type: Number, default: 0 },
    finalizationLeaseToken: { type: String, default: "" },
    finalizationLeaseUntil: { type: Date, default: null },
    finalizationLastError: { type: String, default: "" },
    finalizationNextAttemptAt: { type: Date, default: null, index: true },
    refundId: { type: String, default: "" },
    refundStatus: { type: String, default: "" },
    refundError: { type: String, default: "" },
    refundAttemptedAt: { type: Date, default: null },
    // Set once a booking has been created from this order (idempotency)
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "TripBooking" },
    completedAt: { type: Date },
    // Audit fields for provider-confirmed abandoned checkout attempts.
    expiredAt: { type: Date },
    expirationReason: { type: String },
  },
  { timestamps: true },
);

module.exports = mongoose.model("PendingOrder", pendingOrderSchema);
