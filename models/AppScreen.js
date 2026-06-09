const mongoose = require("mongoose");

const slideSchema = new mongoose.Schema(
  {
    imageUrl: { type: String, required: true },
    title: { type: String, default: "" },
    description: { type: String, default: "" },
    order: { type: Number, default: 0 },
  },
  { _id: true },
);

const appScreenSchema = new mongoose.Schema(
  {
    splashImageUrl: { type: String, default: "" },
    slides: [slideSchema],
  },
  { timestamps: true },
);

module.exports = mongoose.model("AppScreen", appScreenSchema);
