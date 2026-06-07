const mongoose = require("mongoose");

const conversationSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TripBooking",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    operatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Operator",
      required: true,
      index: true,
    },
    // Package info for display
    packageTitle: { type: String, default: "" },
    packageImage: { type: String, default: "" },

    // Chat window: from booking creation to endDate + 2 days
    startsAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },

    // Last message preview
    lastMessage: { type: String, default: "" },
    lastMessageAt: { type: Date, default: null },
    lastSenderType: {
      type: String,
      enum: ["user", "operator", "admin", "system", ""],
      default: "",
    },

    // Unread counts
    unreadUser: { type: Number, default: 0 },
    unreadOperator: { type: Number, default: 0 },

    // Status
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// Auto-deactivate expired conversations
conversationSchema.methods.isExpired = function () {
  return new Date() > this.expiresAt;
};

module.exports = mongoose.model("Conversation", conversationSchema);
