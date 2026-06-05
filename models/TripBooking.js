const mongoose = require("mongoose");

// Pricing snapshot — fixed at time of booking, never changes
const pricingSchema = new mongoose.Schema(
  {
    adultPrice: { type: Number, default: 0 },
    seats: { type: Number, default: 1 },
    subtotal: { type: Number, default: 0 },
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
      required: true,
      index: true,
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

    // Traveler names — seat 1 auto-filled from user profile, rest optional
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
      enum: ["user", "admin", "system", ""],
      default: "",
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

module.exports = mongoose.model("TripBooking", tripBookingSchema);
