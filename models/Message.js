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

    // Content
    text: { type: String, default: "" },
    imageUrl: { type: String, default: "" }, // for image messages

    // Read status
    read: { type: Boolean, default: false },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Message", messageSchema);
