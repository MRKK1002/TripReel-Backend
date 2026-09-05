const mongoose = require("mongoose");

const walletTransactionSchema = new mongoose.Schema(
  {
    operatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Operator",
      required: true,
      index: true,
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TripBooking",
      default: null,
    },
    // Stable business-event identity used by idempotent wallet credits.
    eventKey: {
      type: String,
      trim: true,
    },
    purpose: {
      type: String,
      enum: [
        "ESCROW_RELEASE",
        "CANCELLATION_RETENTION",
        "MANUAL_CREDIT",
        "WITHDRAWAL_REVERSAL",
        "",
      ],
      default: "",
    },
    type: {
      type: String,
      enum: ["CREDIT", "DEBIT", "WITHDRAWAL"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    // Balance after this transaction (for audit trail)
    balanceAfter: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

walletTransactionSchema.index(
  { eventKey: 1 },
  {
    unique: true,
    partialFilterExpression: { eventKey: { $type: "string" } },
  },
);

module.exports = mongoose.model("WalletTransaction", walletTransactionSchema);
