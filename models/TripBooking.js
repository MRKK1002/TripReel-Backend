const mongoose = require("mongoose");

// Pricing snapshot — fixed at time of booking, never changes
const pricingSchema = new mongoose.Schema(
  {
    adultPrice: { type: Number, default: 0 },
    childPrice: { type: Number, default: 0 },
    seats: { type: Number, default: 1 },
    adults: { type: Number, default: 0 },
    children: { type: Number, default: 0 },
    subtotal: { type: Number, default: 0 },
    // Explicit breakdown for accurate refund math
    fareSubtotal: { type: Number, default: 0 }, // package fare only (adult+child), pre-addon, pre-gst
    addonAmount: { type: Number, default: 0 }, // total addon (base + surcharge), held by platform
    platformFeePercent: { type: Number, default: 0 },
    platformFeeAmount: { type: Number, default: 0 },
    gstPercent: { type: Number, default: 5 },
    gstAmount: { type: Number, default: 0 },
    // What the user pays
    totalAmount: { type: Number, default: 0 },
    // Discount applied via coupon
    discountAmount: { type: Number, default: 0 },
    couponCode: { type: String, default: "" },
    // What the operator receives (totalAmount - platformFeeAmount)
    operatorAmount: { type: Number, default: 0 },
  },
  { _id: false },
);

// Breakdown of how a refund was split (for transparency + admin log)
const refundBreakdownSchema = new mongoose.Schema(
  {
    fareRefund: { type: Number, default: 0 }, // fare portion returned to user
    gstRefund: { type: Number, default: 0 }, // gst portion returned to user
    addonRefund: { type: Number, default: 0 }, // addon returned to user (if not dispatched)
    operatorRetained: { type: Number, default: 0 }, // cancellation money credited to operator (after platform fee)
    platformRetained: { type: Number, default: 0 }, // platform's share of the retained amount + retained gst
  },
  { _id: false },
);

// Snapshot of package + batch at booking time (for receipts)
const snapshotSchema = new mongoose.Schema(
  {
    packageTitle: { type: String, default: "" },
    packageLocation: { type: String, default: "" },
    packageImageUrl: { type: String, default: "" },
    batchLabel: { type: String, default: "" },
    startDate: { type: Date },
    endDate: { type: Date },
    adultPrice: { type: Number, default: 0 },
  },
  { _id: false },
);

const tripBookingSchema = new mongoose.Schema(
  {
    // Auto-generated human-readable ID
    bookingId: {
      type: String,
      unique: true,
      index: true,
    },

    // References
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    packageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Package",
      required: true,
      index: true,
    },
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      required: false, // not required for flexible bookings
      index: true,
    },
    // "batch" (default) or "flexible" — determines booking source
    bookingMode: {
      type: String,
      enum: ["batch", "flexible"],
      default: "batch",
    },
    // For flexible bookings — the chosen start date and matched availability record
    flexStartDate: { type: Date },
    flexEndDate: { type: Date },
    flexAvailabilityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FlexibleAvailability",
    },
    operatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Operator",
      required: true,
      index: true,
    },

    // Seats booked
    seats: {
      type: Number,
      default: 1,
      min: 1,
    },

    // Traveler details — name, gender, age for each person
    travelers: [
      {
        name: { type: String, trim: true, default: "" },
        gender: {
          type: String,
          enum: ["Male", "Female", "Other", ""],
          default: "",
        },
        age: { type: Number, default: 0, min: 0 },
        _id: false,
      },
    ],

    // Legacy field — kept for backward compat
    travelerNames: [{ type: String, trim: true }],

    // Booking status
    status: {
      type: String,
      enum: ["PENDING", "CONFIRMED", "COMPLETED", "CANCELLED"],
      default: "PENDING",
    },

    // Pricing locked at booking time
    pricing: pricingSchema,

    // Snapshot for receipts (never changes even if package/batch is edited)
    snapshot: snapshotSchema,

    // Review tracking — flipped to true when user submits a review
    hasReviewed: {
      type: Boolean,
      default: false,
    },

    // Cancellation info
    cancelReason: {
      type: String,
      trim: true,
      default: "",
    },
    cancelledBy: {
      type: String,
      enum: ["user", "admin", "operator", "system", ""],
      default: "",
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    refundPercent: {
      type: Number,
      default: 0,
    },
    refundAmount: {
      type: Number,
      default: 0,
    },
    // Refund processing status
    refundStatus: {
      type: String,
      enum: ["NONE", "PROCESSING", "REFUNDED", "FAILED", "MANUAL"],
      default: "NONE",
    },
    refundId: { type: String, default: "" }, // Razorpay refund id
    refundedAt: { type: Date, default: null },
    refundError: { type: String, default: "" },
    refundBreakdown: refundBreakdownSchema,

    // Razorpay references (needed to issue refunds)
    razorpayPaymentId: { type: String, default: "" },
    razorpayOrderId: { type: String, default: "" },

    // Addon day selections — { addonName: [dayIndex, ...] }
    addonDays: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    // Per addon-day meeting schedule chosen by the user:
    // { addonName: { dayIndex: { time, placeName, lat, lng } } }
    // Used to dispatch Snapja with the exact location + time the user wants.
    addonSchedule: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    // Pre-computed outside-city surcharge to credit operator (via cron with package earnings)
    addonSurcharge: {
      type: Number,
      default: 0,
    },
    // Addon names selected (for display purposes)
    addonNames: {
      type: [String],
      default: [],
    },
    // Total addon price paid (base + surcharges)
    addonTotalPrice: {
      type: Number,
      default: 0,
    },
    // Tracks whether operator wallet has been credited (escrow released 2 days after trip end)
    walletReleased: {
      type: Boolean,
      default: false,
    },

    // Addon (Snapja) money is HELD by platform until the booking is locked-in,
    // then dispatched to Snapja. If cancelled before dispatch → fully refundable.
    addonHeld: {
      type: Boolean,
      default: false,
    },
    addonDispatched: {
      type: Boolean,
      default: false,
    },
    addonDispatchedAt: {
      type: Date,
      default: null,
    },
    // Snapja booking references — saved after dispatch so we can track/cancel each addon-day
    // Structure: { "addonName_dayIdx": { bookingId, snapjaId, otp, status } }
    snapjaBookings: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true },
);

// Auto-generate bookingId before first save
tripBookingSchema.pre("save", async function (next) {
  if (!this.bookingId) {
    const count = await mongoose.model("TripBooking").countDocuments();
    this.bookingId = `TR-BKG-${String(count + 1).padStart(6, "0")}`;
  }
  next();
});

// SECURITY: prevent two bookings being minted from the same Razorpay payment
// (guards against a race in the verify endpoint's idempotency check). Partial
// index so the many legacy bookings with empty payment id don't collide.
tripBookingSchema.index(
  { razorpayPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: { razorpayPaymentId: { $gt: "" } },
  },
);

module.exports = mongoose.model("TripBooking", tripBookingSchema);
