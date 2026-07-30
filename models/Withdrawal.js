const mongoose = require("mongoose");

const withdrawalSchema = new mongoose.Schema(
  {
    operatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Operator",
      required: true,
      index: true,
    },
    amount: { type: Number, required: true, min: 1 },

    // Destination snapshot (for the audit trail / display)
    method: {
      type: String,
      enum: ["bank_account", "vpa"],
      default: "bank_account",
    },
    destination: { type: String, default: "" }, // masked acct or vpa

    // RazorpayX references
    payoutId: { type: String, default: "", index: true },
    fundAccountId: { type: String, default: "" },
    referenceId: { type: String, default: "", unique: true, sparse: true },
    // UTR — the bank's money-movement reference, returned by RazorpayX once the
    // payout is processed. This is the number an operator/bank uses to trace the
    // transfer, so it's the most important id for reconciliation.
    utr: { type: String, default: "" },

    // queued/pending/processing/processed/reversed/failed/cancelled
    status: {
      type: String,
      enum: [
        "PENDING",
        "PROCESSING",
        "PROCESSED",
        "REVERSED",
        "FAILED",
        "CANCELLED",
      ],
      default: "PENDING",
    },
    failureReason: { type: String, default: "" },

    // True once the debited amount has been returned to the wallet (on fail/reversal)
    refunded: { type: Boolean, default: false },

    // True once this payout has been added to OperatorWallet.totalWithdrawn.
    // Guards against double-counting when several webhook events arrive for the
    // same payout.
    countedInTotal: { type: Boolean, default: false },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Withdrawal", withdrawalSchema);
