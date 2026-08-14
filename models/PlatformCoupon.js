const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// Platform (admin) coupons — created by admin, discount is ABSORBED BY PLATFORM.
// The operator always receives their full earnings (fare − platform fee); the
// coupon discount comes out of the platform's margin, never the operator's.
//
// A user may apply only ONE coupon per booking (either an operator coupon OR a
// platform coupon — whichever they choose). This is enforced at pricing time.
// ─────────────────────────────────────────────────────────────────────────────
const platformCouponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, "Coupon code is required"],
      trim: true,
      uppercase: true,
      unique: true,
      index: true,
    },

    // Discount
    type: {
      type: String,
      enum: ["percentage", "flat"],
      required: true,
    },
    value: {
      type: Number,
      required: true,
      min: 0,
    },
    // Cap for percentage coupons (0 = no cap)
    maxDiscount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Conditions
    minOrderAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    minGuests: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Welcome coupon — only for users with no prior confirmed bookings
    firstBookingOnly: {
      type: Boolean,
      default: false,
    },

    // ── Targeting scope ──────────────────────────────────────────────────────
    // appliesTo decides which of the arrays below are honoured.
    appliesTo: {
      type: String,
      enum: ["all", "category", "destination", "package", "operator"],
      default: "all",
    },
    categories: { type: [String], default: [] }, // for appliesTo=category
    states: { type: [String], default: [] }, // for appliesTo=destination
    cities: { type: [String], default: [] }, // for appliesTo=destination
    packageIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Package" }],
      default: [],
    },
    operatorIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Operator" }],
      default: [],
    },

    // Usage limits
    usageLimit: {
      type: Number,
      default: 0, // 0 = unlimited total redemptions
      min: 0,
    },
    usedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    perUserLimit: {
      type: Number,
      default: 1, // how many times a single user can use it
      min: 1,
    },

    // Validity
    validFrom: {
      type: Date,
      default: Date.now,
    },
    validUntil: {
      type: Date,
      required: [true, "Expiry date is required"],
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    // Marketing
    description: {
      type: String,
      trim: true,
      default: "",
    },
    // Show as a promotional banner/offer in the app
    featured: {
      type: Boolean,
      default: false,
    },

    // Always platform-funded for admin coupons; kept explicit for clarity/audit.
    fundedBy: {
      type: String,
      enum: ["platform"],
      default: "platform",
    },
  },
  { timestamps: true },
);

platformCouponSchema.index({ isActive: 1, validUntil: 1 });

module.exports = mongoose.model("PlatformCoupon", platformCouponSchema);
