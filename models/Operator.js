const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const VALID_STATES = [
  "DRAFT", // registered, onboarding form not submitted yet
  "PENDING_APPROVAL", // submitted, waiting on admin review
  "CHANGES_REQUESTED", // admin found wrong details — operator must correct & resubmit
  "APPROVED", // live: can create packages, batches, coupons, withdraw
  "REJECTED", // rejected, but may correct & re-apply
  "SUSPENDED", // approved then suspended by admin
  "ACTIVE_FULL", // approved + fully active (legacy/extended tier)
  "EXPIRED", // draft abandoned — auto-expired by cron; may re-apply
];

// States in which the operator is allowed to run their business
const ACTIVE_STATES = ["APPROVED", "ACTIVE_FULL"];

// States in which the operator may edit the onboarding form and (re)submit it
const EDITABLE_STATES = ["DRAFT", "CHANGES_REQUESTED", "REJECTED", "EXPIRED"];

// Legal admin/operator transitions — anything else is rejected
const ALLOWED_TRANSITIONS = {
  DRAFT: ["PENDING_APPROVAL", "EXPIRED"],
  PENDING_APPROVAL: ["APPROVED", "CHANGES_REQUESTED", "REJECTED"],
  CHANGES_REQUESTED: ["PENDING_APPROVAL", "APPROVED", "REJECTED"],
  REJECTED: ["PENDING_APPROVAL", "CHANGES_REQUESTED", "APPROVED"],
  APPROVED: ["SUSPENDED", "ACTIVE_FULL"],
  ACTIVE_FULL: ["SUSPENDED", "APPROVED"],
  SUSPENDED: ["APPROVED", "ACTIVE_FULL"],
  EXPIRED: ["PENDING_APPROVAL"],
};

// Onboarding fields an admin can flag as needing correction
const CORRECTABLE_FIELDS = [
  "contactName",
  "phone",
  "businessName",
  "businessType",
  "country",
  "state",
  "city",
  "mainOperatingDestinations",
  "accountHolderName",
  "bankName",
  "accountNumber",
  "ifscCode",
  "upiId",
  "gstNumber",
  "governmentId",
  "selfieVerification",
  "panCard",
  "tradeLicense",
];

const transitionHistorySchema = new mongoose.Schema(
  {
    fromState: { type: String, required: true },
    toState: { type: String, required: true },
    note: { type: String, default: "" },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false },
);

const operatorSchema = new mongoose.Schema(
  {
    // ── Step 1: Basic Information ─────────────────────────────────────────
    contactName: {
      type: String,
      required: true,
      trim: true,
      minlength: [2, "Full name must be at least 2 characters"],
      maxlength: [50, "Full name cannot exceed 50 characters"],
      match: [
        /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ.'\- ]*$/,
        "Full name can only contain letters, spaces, dots, hyphens and apostrophes",
      ],
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: [254, "Email address is too long"],
      match: [
        /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
        "Please enter a valid email address",
      ],
    },
    phone: {
      type: String,
      trim: true,
      match: [
        /^[6-9]\d{9}$/,
        "Enter a valid 10-digit Indian mobile number starting with 6-9",
      ],
    },
    password: { type: String, required: true, minlength: 8, select: false },

    // ── Step 2: Business Information ──────────────────────────────────────
    businessName: {
      type: String,
      trim: true,
      maxlength: [100, "Business name cannot exceed 100 characters"],
    },
    businessType: {
      type: String,
      enum: [
        "INDIVIDUAL_GUIDE",
        "TOUR_OPERATOR",
        "TRAVEL_AGENCY",
        "EXPERIENCE_HOST",
        "",
      ],
      default: "",
    },

    // ── Step 3: Location ──────────────────────────────────────────────────
    country: { type: String, trim: true, maxlength: 56 },
    state: { type: String, trim: true, maxlength: 50 },
    city: { type: String, trim: true, maxlength: 50 },
    mainOperatingDestinations: [{ type: String, trim: true }], // e.g. ["Dubai","Goa","Bali"]

    // ── Step 4: Identity Verification ────────────────────────────────────
    profilePhoto: { type: String }, // file path
    governmentId: { type: String }, // file path
    selfieVerification: { type: String }, // file path (optional)

    // ── Step 5: Bank Details ──────────────────────────────────────────────
    accountHolderName: {
      type: String,
      trim: true,
      maxlength: [50, "Account holder name cannot exceed 50 characters"],
    },
    bankName: {
      type: String,
      trim: true,
      maxlength: [60, "Bank name cannot exceed 60 characters"],
    },
    // Indian bank account numbers are 9–18 digits
    accountNumber: {
      type: String,
      trim: true,
      match: [/^\d{9,18}$/, "Account number must be 9 to 18 digits"],
    },
    ifscCode: {
      type: String,
      trim: true,
      uppercase: true,
      match: [/^[A-Z]{4}0[A-Z0-9]{6}$/, "Enter a valid 11-character IFSC code"],
    },
    upiId: {
      type: String,
      trim: true,
      maxlength: [128, "UPI ID is too long"],
    }, // optional

    // ── RazorpayX payout references (cached so we don't recreate each time) ──
    razorpayContactId: { type: String, default: "" },
    razorpayFundAccountId: { type: String, default: "" },
    // The bank/UPI snapshot the fund account was built from — if bank details
    // change, we recreate the fund account.
    razorpayFundFingerprint: { type: String, default: "" },

    // ── Step 6: Business Documents ────────────────────────────────────────
    // company docs
    gstNumber: {
      type: String,
      trim: true,
      uppercase: true,
      match: [
        /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/,
        "Enter a valid 15-character GST number",
      ],
    }, // optional
    tradeLicensePath: { type: String }, // file path, optional
    panCardPath: { type: String }, // file path, required for both
    // individual also just needs panCardPath

    // ── Step 7: Terms ─────────────────────────────────────────────────────
    agreedToPolicies: { type: Boolean, default: false },
    confirmedAccuracy: { type: Boolean, default: false },

    // FCM token for push notifications
    fcmToken: { type: String, default: "" },

    // ── Document status (per-doc review by admin) ─────────────────────────
    documentStatus: {
      governmentId: {
        status: {
          type: String,
          enum: ["PENDING", "APPROVED", "REJECTED", "REUPLOAD_REQUIRED"],
          default: "PENDING",
        },
        remark: { type: String, default: "" },
        updatedAt: { type: Date },
      },
      selfieVerification: {
        status: {
          type: String,
          enum: ["PENDING", "APPROVED", "REJECTED", "REUPLOAD_REQUIRED"],
          default: "PENDING",
        },
        remark: { type: String, default: "" },
        updatedAt: { type: Date },
      },
      tradeLicense: {
        status: {
          type: String,
          enum: ["PENDING", "APPROVED", "REJECTED", "REUPLOAD_REQUIRED"],
          default: "PENDING",
        },
        remark: { type: String, default: "" },
        updatedAt: { type: Date },
      },
      panCard: {
        status: {
          type: String,
          enum: ["PENDING", "APPROVED", "REJECTED", "REUPLOAD_REQUIRED"],
          default: "PENDING",
        },
        remark: { type: String, default: "" },
        updatedAt: { type: Date },
      },
    },

    // ── Approval state ────────────────────────────────────────────────────
    onboardingState: { type: String, enum: VALID_STATES, default: "DRAFT" },
    rejectionReason: { type: String, trim: true },
    transitionHistory: [transitionHistorySchema],

    // ── Correction loop (admin → operator → admin) ────────────────────────
    // Set when admin sends the application back for corrections. Cleared once
    // the operator resubmits, so the operator always sees only open requests.
    correctionRequest: {
      fields: [{ type: String }], // which onboarding fields are wrong
      note: { type: String, default: "", trim: true },
      requestedAt: { type: Date },
      requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },
    // Audit trail of every correction round
    correctionHistory: [
      {
        fields: [{ type: String }],
        note: { type: String, default: "" },
        requestedAt: { type: Date },
        resolvedAt: { type: Date },
        _id: false,
      },
    ],
    submissionCount: { type: Number, default: 0 },
    lastSubmittedAt: { type: Date },

    // Last time a payout destination (bank details or UPI) changed. Withdrawals
    // are held for a cooling-off window after any change so a hijacked session
    // can't redirect funds and cash out immediately.
    payoutDetailsChangedAt: { type: Date },
  },
  { timestamps: true },
);

// Hash password before saving
operatorSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password
operatorSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = {
  Operator: mongoose.model("Operator", operatorSchema),
  VALID_STATES,
  ACTIVE_STATES,
  EDITABLE_STATES,
  ALLOWED_TRANSITIONS,
  CORRECTABLE_FIELDS,
};
