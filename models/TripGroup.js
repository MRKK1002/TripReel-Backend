const mongoose = require("mongoose");

// A TripGroup lets operators manually group flexible-date bookings into a
// manageable unit — equivalent to a batch but assembled after booking.
// This gives the operator the same workflow (traveller list, document builder,
// bulk messaging) for flex bookings as they already have for fixed batches.

const tripGroupSchema = new mongoose.Schema(
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
    label: {
      type: String,
      trim: true,
      default: "",
      maxlength: 80,
    },
    // The booking ids that belong to this group
    bookingIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "TripBooking",
      },
    ],
    // Derived from the earliest/latest booking dates in the group
    tripStartDate: { type: Date },
    tripEndDate: { type: Date },
    notes: { type: String, default: "", trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

// One booking should only belong to one group at a time
tripGroupSchema.index({ bookingIds: 1 });

module.exports = mongoose.model("TripGroup", tripGroupSchema);
