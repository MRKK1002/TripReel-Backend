const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
  {
    packageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Package",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    // The trip or booking this review is for (to verify user actually took the trip)
    tripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trip",
      default: null,
    },
    rating: {
      type: Number,
      required: [true, "Rating is required"],
      min: 1,
      max: 5,
    },
    comment: {
      type: String,
      trim: true,
      default: "",
      maxlength: 1000,
    },
    // Helpful for moderation
    isVisible: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

// One review per user per package
reviewSchema.index({ packageId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model("Review", reviewSchema);
