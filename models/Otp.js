const mongoose = require("mongoose");

// Purposes that hold a hashed code and are bound to a signed-in user.
const HASHED_PURPOSES = ["phone_link", "phone_change", "email_change"];
// Contact-change flows run in two stages: prove the CURRENT contact, then the new one.
const CONTACT_CHANGE_PURPOSES = ["phone_change", "email_change"];

const otpSchema = new mongoose.Schema(
  {
    // Not required for email_change, where the challenge targets an address.
    phone: {
      type: String,
      required: function () {
        return this.purpose !== "email_change";
      },
      trim: true,
      index: true,
    },
    // Address the current-stage code was sent to (email_change only).
    email: {
      type: String,
      trim: true,
      lowercase: true,
      required: function () {
        return this.purpose === "email_change";
      },
    },
    code: {
      type: String,
      required: function () {
        return !HASHED_PURPOSES.includes(this.purpose);
      },
    },
    codeHash: {
      type: String,
      required: function () {
        return HASHED_PURPOSES.includes(this.purpose);
      },
      select: false,
    },
    purpose: {
      type: String,
      enum: [
        "signup",
        "login",
        "delete_account",
        "phone_link",
        "phone_change",
        "email_change",
      ],
      required: true,
    },
    // ── Contact-change staging ───────────────────────────────────────────────
    // verify_current → awaiting_new → verify_new. The new contact can only be
    // set once the current one has been proven.
    stage: {
      type: String,
      enum: ["verify_current", "awaiting_new", "verify_new", null],
      default: null,
    },
    // The requested new value, only accepted after stage 1 passes.
    pendingPhone: { type: String, trim: true, default: "" },
    pendingEmail: { type: String, trim: true, lowercase: true, default: "" },
    currentVerifiedAt: { type: Date, default: null },
    // Single-use grant proving stage 1 succeeded. Stored hashed.
    changeTokenHash: { type: String, select: false, default: "" },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: function () {
        return HASHED_PURPOSES.includes(this.purpose);
      },
      index: true,
    },
    challengeId: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },
    // Stored only for signup so we can create the user on verify
    payload: {
      name: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      state: { type: String, trim: true },
      country: { type: String, trim: true, default: "India" },
    },
    attempts: {
      type: Number,
      default: 0,
    },
    active: {
      type: Boolean,
      default: false,
      index: true,
    },
    resendAvailableAt: Date,
    consumedAt: Date,
    invalidatedAt: Date,
    expiresAt: {
      type: Date,
      required: true,
      // TTL index — Mongo will auto-delete expired docs
      index: { expires: 0 },
    },
  },
  { timestamps: true },
);

// Compound indexes keep legacy lookups compatible and bound phone-link queries.
otpSchema.index({ phone: 1, purpose: 1 });
otpSchema.index({ userId: 1, purpose: 1, createdAt: -1 });
otpSchema.index({ purpose: 1, phone: 1, createdAt: -1 });
otpSchema.index(
  { userId: 1, purpose: 1 },
  {
    unique: true,
    partialFilterExpression: { purpose: "phone_link", active: true },
  },
);
// One live contact-change flow per user per purpose, so a second "start" cannot
// run alongside an in-progress change.
CONTACT_CHANGE_PURPOSES.forEach((purpose) => {
  otpSchema.index(
    { userId: 1, purpose: 1, active: 1 },
    {
      unique: true,
      partialFilterExpression: { purpose, active: true },
      name: `uniq_active_${purpose}`,
    },
  );
});

otpSchema.statics.CONTACT_CHANGE_PURPOSES = CONTACT_CHANGE_PURPOSES;

module.exports = mongoose.model("Otp", otpSchema);
