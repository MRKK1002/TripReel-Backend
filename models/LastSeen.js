const mongoose = require("mongoose");

const lastSeenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    userType: {
      type: String,
      enum: ["admin", "operator"],
      required: true,
    },
    section: {
      type: String,
      required: true,
      index: true,
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

// Compound index for quick lookup
lastSeenSchema.index({ userId: 1, userType: 1, section: 1 }, { unique: true });

module.exports = mongoose.model("LastSeen", lastSeenSchema);
