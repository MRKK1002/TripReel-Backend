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
    // Operator can disable without deleting
    isActive: { type: Boolean, default: true },
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
