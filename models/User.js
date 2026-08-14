const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },
    password: {
      type: String,
      minlength: 6,
      select: false,
    },
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },
    status: {
      type: String,
      enum: ["Active", "Inactive", "Suspended", "Deleted"],
      default: "Active",
    },
    // Set when the user erases their account (DPDP). The record is anonymized,
    // not dropped, so legally-required financial history stays consistent.
    deletedAt: { type: Date },
    avatar: {
      type: String,
      default: "",
    },
    state: {
      type: String,
      trim: true,
      default: "",
    },
    country: {
      type: String,
      trim: true,
      default: "India",
    },
    tripsCount: {
      type: Number,
      default: 0,
    },
    // Firebase Cloud Messaging token for push notifications
    fcmToken: {
      type: String,
      default: "",
    },
    // Google Sign-In
    googleId: { type: String, default: "", sparse: true },
    profileImage: { type: String, default: "" },
    // Re-engagement tracking
    lastActiveAt: { type: Date, default: Date.now, index: true },
    lastReengagedAt: { type: Date }, // last time we sent a re-engagement nudge
  },
  { timestamps: true },
);

// Hash password before saving
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  if (!this.password) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password
userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model("User", userSchema);
