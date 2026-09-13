const mongoose = require("mongoose");

const flexibleAvailabilitySchema = new mongoose.Schema(
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
    // Date range in which this package is available for flexible booking
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    // Pricing for flexible dates (can differ from batch pricing)
    adultPrice: { type: Number, required: true, min: 0 },
    childPrice: { type: Number, default: 0, min: 0 },
    // Maximum bookings (total seats) allowed in this range. 0 = unlimited.
    // Without this, flex bookings had no capacity check — a package could be
    // booked infinitely. The operator sets this when creating the range.
    maxBookings: {
      type: Number,
      default: 0,
      min: 0,
      max: 1000,
      validate: {
        validator: Number.isInteger,
        message: "Maximum bookings must be a whole number",
      },
    },
    // Current booked seat count (atomically incremented on each booking)
    bookedSeats: { type: Number, default: 0, min: 0 },
    inventoryReservationClaimKeys: {
      type: [String],
      default: [],
      select: false,
    },
    inventoryReleaseClaimKeys: { type: [String], default: [], select: false },
    // Short document lease serializes reservations with capacity reductions.
    capacityLeaseToken: { type: String, default: "", select: false },
    capacityLeaseUntil: { type: Date, default: null, select: false },
    // Operator can disable without deleting
    isActive: { type: Boolean, default: true },
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

// Index for efficient date-range queries from the app
flexibleAvailabilitySchema.index({
  packageId: 1,
  isActive: 1,
  startDate: 1,
  endDate: 1,
});

module.exports = mongoose.model(
  "FlexibleAvailability",
  flexibleAvailabilitySchema,
);
