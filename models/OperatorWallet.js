const mongoose = require("mongoose");

const operatorWalletSchema = new mongoose.Schema(
  {
    operatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Operator",
      required: true,
      unique: true,
      index: true,
    },
    // Current available balance
    balance: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Lifetime totals (for reporting)
    totalEarned: {
      type: Number,
      default: 0,
    },
    totalWithdrawn: {
      type: Number,
      default: 0,
    },
    // Durable idempotency keys for balance credits. A credit event may update
    // this wallet at most once even if multiple workers race or retry.
    appliedCreditKeys: {
      type: [String],
      default: [],
      select: false,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("OperatorWallet", operatorWalletSchema);
