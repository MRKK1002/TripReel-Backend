const mongoose = require("mongoose");

const couponSchema = new mongoose.Schema(
  {
    // Which batch this coupon belongs to
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      required: true,
      index: true,
    },
    operatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Operator",
      required: true,
      index: true,
    },
    // Also store packageId for easy lookup
    packageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Package",
      required: true,
      index: true,
    },

    // Coupon code — what user types
    code: {
      type: String,
      required: [true, "Coupon code is required"],
      trim: true,
      uppercase: true,
    },

    // Discount type
    type: {
      type: String,
      enum: ["percentage", "flat"],
      required: true,
    },
    // Value — 20 means 20% or ₹20 depending on type
    value: {
      type: Number,
      required: true,
      min: 0,
    },
    // Max discount amount (only for percentage — caps the discount)
    maxDiscount: {
      type: Number,
      default: 0, // 0 means no cap
      min: 0,
    },

    // Conditions
    minGuests: {
      type: Number,
      default: 0, // 0 means no minimum
      min: 0,
    },
    minOrderAmount: {
      type: Number,
      default: 0, // 0 means no minimum
      min: 0,
    },

    // Usage limits
    usageLimit: {
      type: Number,
      default: 0, // 0 means unlimited
      min: 0,
    },
    usedCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Validity period
    validFrom: {
      type: Date,
      default: Date.now,
    },
    validUntil: {
      type: Date,
      required: [true, "Expiry date is required"],
    },

    // Status
    isActive: {
      type: Boolean,
      default: true,
    },

    // Human-readable description shown to users
    description: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true },
);

// Compound index for quick lookups
couponSchema.index({ batchId: 1, code: 1 }, { unique: true });
couponSchema.index({ packageId: 1, isActive: 1 });

module.exports = mongoose.model("Coupon", couponSchema);
