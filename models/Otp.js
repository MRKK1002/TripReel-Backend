const mongoose = require("mongoose");

const otpSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    code: {
      type: String,
      required: true,
    },
    purpose: {
      type: String,
      enum: ["signup", "login"],
      required: true,
    },
    // Stored only for signup so we can create the user on verify
    payload: {
      name: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      state: { type: String, trim: true },
    },
    attempts: {
      type: Number,
      default: 0,
    },
    expiresAt: {
      type: Date,
      required: true,
      // TTL index — Mongo will auto-delete expired docs
      index: { expires: 0 },
    },
  },
  { timestamps: true },
);

// Compound index to look up "active" OTP for a phone+purpose quickly
otpSchema.index({ phone: 1, purpose: 1 });

module.exports = mongoose.model("Otp", otpSchema);
