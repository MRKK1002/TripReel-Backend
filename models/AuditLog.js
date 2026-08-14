const mongoose = require("mongoose");

// Centralized audit log for all sensitive actions — booking status changes,
// cancellations, refunds, withdrawals, operator/admin actions. Immutable:
// documents are only ever inserted, never updated or deleted.
const auditLogSchema = new mongoose.Schema(
  {
    // Who performed the action
    actorId: { type: mongoose.Schema.Types.ObjectId, index: true },
    actorType: {
      type: String,
      enum: ["user", "operator", "admin", "system"],
      required: true,
    },
    actorName: { type: String, default: "" },

    // What happened
    action: {
      type: String,
      required: true,
      index: true,
      enum: [
        // Booking
        "booking_created",
        "booking_confirmed",
        "booking_cancelled_user",
        "booking_cancelled_operator",
        "booking_cancelled_admin",
        "booking_completed",
        "booking_addon_added",
        // Payment & Refund
        "payment_captured",
        "refund_issued",
        "refund_failed",
        "addon_refund_issued",
        // Operator
        "operator_approved",
        "operator_suspended",
        "operator_reinstated",
        "batch_cancelled",
        // Withdrawal
        "withdrawal_requested",
        "withdrawal_approved",
        "withdrawal_rejected",
        // User
        "user_suspended",
        "user_reactivated",
        "user_deleted",
        // Admin
        "settings_changed",
        "coupon_created",
        "coupon_deleted",
        // Generic catch-all
        "other",
      ],
    },

    // Context — what was affected
    targetType: {
      type: String,
      enum: [
        "booking",
        "user",
        "operator",
        "batch",
        "package",
        "withdrawal",
        "settings",
        "coupon",
        "other",
      ],
      default: "other",
    },
    targetId: { type: mongoose.Schema.Types.ObjectId, index: true },
    targetRef: { type: String, default: "" }, // human-readable ref (bookingId, email, etc.)

    // Structured details (varies by action)
    details: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Optional IP for admin actions from the web panel
    ip: { type: String, default: "" },
  },
  { timestamps: true },
);

// TTL: keep logs for 3 years (legal/tax), then auto-purge
auditLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 3 * 365 * 24 * 60 * 60 },
);

module.exports = mongoose.model("AuditLog", auditLogSchema);
