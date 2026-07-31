const mongoose = require("mongoose");

// A reusable trip document template per package. The operator saves the
// itinerary + hotel + transport + policies once, then for each batch they only
// fill the per-batch variables (vehicle no, driver, pickup time) and send.

const tripDocTemplateSchema = new mongoose.Schema(
  {
    operatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Operator",
      required: true,
      index: true,
    },
    packageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Package",
      required: true,
      index: true,
    },
    label: { type: String, trim: true, default: "Default", maxlength: 80 },

    // Fixed content (reused across all batches for this package)
    itinerary: [
      {
        day: { type: Number },
        title: { type: String, trim: true },
        points: [{ type: String }],
        _id: false,
      },
    ],
    inclusions: [{ type: String }],
    exclusions: [{ type: String }],
    hotel: {
      name: { type: String, default: "", trim: true },
      category: { type: String, default: "", trim: true },
      roomType: { type: String, default: "", trim: true },
      mealPlan: { type: String, default: "", trim: true },
    },
    transport: {
      vehicleType: { type: String, default: "", trim: true },
      pickupDrop: { type: String, default: "", trim: true },
      flightIncluded: { type: Boolean, default: false },
      cabIncluded: { type: Boolean, default: false },
    },
    policies: {
      cancellation: { type: String, default: "", trim: true },
      refund: { type: String, default: "", trim: true },
      terms: { type: String, default: "", trim: true },
    },
    specialNotes: { type: String, default: "", trim: true, maxlength: 1000 },
  },
  { timestamps: true },
);

// One default template per package per operator
tripDocTemplateSchema.index(
  { operatorId: 1, packageId: 1, label: 1 },
  { unique: true },
);

module.exports = mongoose.model("TripDocTemplate", tripDocTemplateSchema);
