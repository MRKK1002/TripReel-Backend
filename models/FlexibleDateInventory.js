const mongoose = require("mongoose");

const flexibleDateInventorySchema = new mongoose.Schema(
  {
    flexAvailabilityId: { type: mongoose.Schema.Types.ObjectId, ref: "FlexibleAvailability", required: true, index: true },
    packageId: { type: mongoose.Schema.Types.ObjectId, ref: "Package", required: true, index: true },
    operatorId: { type: mongoose.Schema.Types.ObjectId, ref: "Operator", required: true, index: true },
    startDateKey: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    startDate: { type: Date, required: true },
    capacity: { type: Number, default: 0, min: 0, max: 1000 },
    bookedSeats: { type: Number, default: 0, min: 0 },
    reservationClaimKeys: { type: [String], default: [], select: false },
    inventoryReleaseClaimKeys: { type: [String], default: [], select: false },
  },
  { timestamps: true },
);

flexibleDateInventorySchema.index({ flexAvailabilityId: 1, startDateKey: 1 }, { unique: true });
flexibleDateInventorySchema.index({ packageId: 1, startDateKey: 1 });

module.exports = mongoose.model("FlexibleDateInventory", flexibleDateInventorySchema);
