const express = require("express");
const router = express.Router();
const {
  getUserConversations,
  getOperatorConversations,
  getAdminConversations,
  getMessages,
  sendMessage,
} = require("../controllers/chatController");
const { protect, restrictTo } = require("../middleware/authMiddleware");
const { operatorProtect } = require("../middleware/operatorAuthMiddleware");

// User routes
router.get("/conversations", protect, getUserConversations);
router.get("/:conversationId/messages", protect, getMessages);
router.post("/:conversationId/messages", protect, sendMessage);

// Operator routes
router.get(
  "/operator/conversations",
  operatorProtect,
  getOperatorConversations,
);
router.get(
  "/operator/:conversationId/messages",
  operatorProtect,
  (req, res, next) => {
    req.user = null;
    next();
  },
  getMessages,
);
router.post(
  "/operator/:conversationId/messages",
  operatorProtect,
  (req, res, next) => {
    req.user = null;
    next();
  },
  sendMessage,
);

// Admin routes
router.get(
  "/admin/conversations",
  protect,
  restrictTo("admin"),
  getAdminConversations,
);
router.get(
  "/admin/:conversationId/messages",
  protect,
  restrictTo("admin"),
  getMessages,
);
router.post(
  "/admin/:conversationId/messages",
  protect,
  restrictTo("admin"),
  sendMessage,
);

// Operator: send message to a user (creates conversation if needed)
router.post(
  "/operator/send-to-user/:userId",
  operatorProtect,
  async (req, res) => {
    try {
      const Conversation = require("../models/Conversation");
      const Message = require("../models/Message");
      const mongoose = require("mongoose");
      const { text, imageUrl } = req.body;
      const operatorId = req.operator._id;
      const userId = req.params.userId;

      // Find existing active conversation
      let conv = await Conversation.findOne({
        userId,
        operatorId,
        isActive: true,
      }).sort({ createdAt: -1 });

      if (!conv || new Date() > conv.expiresAt) {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        const TripBooking = require("../models/TripBooking");
        const recentBooking = await TripBooking.findOne({
          userId,
          operatorId,
        }).sort({ createdAt: -1 });

        conv = await Conversation.create({
          bookingId: recentBooking
            ? recentBooking._id
            : new mongoose.Types.ObjectId(),
          userId,
          operatorId,
          packageTitle:
            recentBooking?.snapshot?.packageTitle || "Trip Document",
          startsAt: now,
          expiresAt,
        });
      }

      const message = await Message.create({
        conversationId: conv._id,
        senderId: operatorId,
        senderType: "operator",
        senderName: req.operator.contactName || "Operator",
        text: text || "",
        imageUrl: imageUrl || "",
      });

      const preview = (text || "").substring(0, 60) || "Document shared";
      await Conversation.findByIdAndUpdate(conv._id, {
        lastMessage: preview,
        lastMessageAt: new Date(),
        lastSenderType: "operator",
        $inc: { unreadUser: 1 },
      });

      // Send push notification to user
      const { notifyUser } = require("../controllers/notificationController");
      const operatorName =
        req.operator.businessName ||
        req.operator.contactName ||
        "Your operator";
      notifyUser(
        userId,
        "New message from " + operatorName,
        "Trip document shared. Check your messages.",
        { type: "general", screen: "Messages" },
      );

      res.json({ success: true, message });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

module.exports = router;
