const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    senderType: {
      type: String,
      enum: ["user", "operator", "admin"],
      required: true,
    },
    senderName: { type: String, default: "" },
    senderAvatar: { type: String, default: "" },
    // Sparse idempotency key for system-generated booking effects.
    effectKey: { type: String, default: undefined },

    // Content
    text: { type: String, default: "" },
    imageUrl: { type: String, default: "" }, // for image messages

    // Read status
    read: { type: Boolean, default: false },
  },
  { timestamps: true },
);

messageSchema.index(
  { effectKey: 1 },
  { unique: true, partialFilterExpression: { effectKey: { $type: "string" } } },
);

module.exports = mongoose.model("Message", messageSchema);
