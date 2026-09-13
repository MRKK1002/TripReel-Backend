const mongoose = require("mongoose");

const batchSchema = new mongoose.Schema(
  {
    packageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Package",
      required: true,
      index: true,
    },
    operatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Operator",
      required: true,
      index: true,
    },

    // ── Dates ──────────────────────────────────────────────────────────────
    startDate: {
      type: Date,
      required: [true, "Start date is required"],
    },
    endDate: {
      type: Date,
      required: [true, "End date is required"],
    },
    // Users must book before this date — must be ≤ startDate
    bookingDeadline: {
      type: Date,
      required: [true, "Booking deadline is required"],
    },

    // ── Pricing (can differ per batch) ─────────────────────────────────────
    adultPrice: {
      type: Number,
      required: [true, "Adult price is required"],
      min: 0,
    },
    childPrice: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ── Seats ──────────────────────────────────────────────────────────────
    totalSeats: {
      type: Number,
      required: [true, "Total seats is required"],
      min: 1,
    },
    // Incremented only when a booking is CONFIRMED by admin
    bookedSeats: {
      type: Number,
      default: 0,
      min: 0,
    },
    inventoryReservationClaimKeys: {
      type: [String],
      default: [],
      select: false,
    },
    inventoryReleaseClaimKeys: { type: [String], default: [], select: false },

    // ── Display ────────────────────────────────────────────────────────────
    label: {
      type: String,
      trim: true,
      default: "",
    },

    // Admin can suspend a batch without deleting it
    isActive: {
      type: Boolean,
      default: true,
    },
    isCancelled: { type: Boolean, default: false, index: true },
    cancelledAt: { type: Date, default: null },
    cancellationReason: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
    isArchived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date, default: null },
    archivedReason: { type: String, default: "", trim: true, maxlength: 500 },
    archivedBy: { type: String, default: "" },
    archivedByType: {
      type: String,
      enum: ["operator", "admin", "system", ""],
      default: "",
    },
  },
  { timestamps: true },
);

// ── Virtual computed fields ────────────────────────────────────────────────────
batchSchema.virtual("availableSeats").get(function () {
  return Math.max(0, this.totalSeats - this.bookedSeats);
});

batchSchema.virtual("isFull").get(function () {
  return this.bookedSeats >= this.totalSeats;
});

batchSchema.virtual("isBookable").get(function () {
  const now = new Date();
  return (
    this.isActive &&
    this.bookingDeadline >= now &&
    this.startDate > now &&
    this.bookedSeats < this.totalSeats
  );
});

batchSchema.virtual("isUpcoming").get(function () {
  return new Date() < this.startDate;
});

batchSchema.virtual("isOngoing").get(function () {
  const now = new Date();
  return this.startDate <= now && this.endDate >= now;
});

batchSchema.virtual("isCompleted").get(function () {
  return new Date() > this.endDate;
});

batchSchema.set("toJSON", { virtuals: true });
batchSchema.set("toObject", { virtuals: true });

// ── Validation ────────────────────────────────────────────────────────────────
batchSchema.pre("validate", function (next) {
  if (this.endDate && this.startDate && this.endDate < this.startDate) {
    return next(new Error("End date must be on or after start date"));
  }
  if (
    this.bookingDeadline &&
    this.startDate &&
    this.bookingDeadline > this.startDate
  ) {
    // Auto-clamp instead of error
    this.bookingDeadline = this.startDate;
  }
  next();
});

module.exports = mongoose.model("Batch", batchSchema);
