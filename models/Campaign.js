const mongoose = require("mongoose");

const campaignSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    imageUrl: { type: String, default: "" },
    ctaText: { type: String, default: "View Offer", trim: true },
    ctaLink: { type: String, default: "", trim: true },
    // Optional: link to a specific package
    packageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Package",
      default: null,
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
    // How many times shown / clicked
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Campaign", campaignSchema);
