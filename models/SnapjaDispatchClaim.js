const mongoose = require("mongoose");

const snapjaDispatchClaimSchema = new mongoose.Schema(
  {
    tripBookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TripBooking",
      required: true,
      index: true,
    },
    entryKey: { type: String, required: true },
    operationId: { type: String, required: true },
    state: {
      type: String,
      enum: ["RETRYABLE", "DISPATCHING", "DISPATCHED", "UNCERTAIN"],
      default: "RETRYABLE",
      index: true,
    },
    leaseUntil: Date,
    nextAttemptAt: { type: Date, default: null, index: true },
    attempts: { type: Number, default: 0 },
    snapjaBooking: { type: mongoose.Schema.Types.Mixed, default: null },
    lastError: { type: String, default: "" },
  },
  { timestamps: true },
);

snapjaDispatchClaimSchema.index(
  { tripBookingId: 1, entryKey: 1 },
  { unique: true },
);

module.exports = mongoose.model(
  "SnapjaDispatchClaim",
  snapjaDispatchClaimSchema,
);
