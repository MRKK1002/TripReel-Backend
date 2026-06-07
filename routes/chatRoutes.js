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
    // Attach operator as req.operator for getMessages
    req.user = null; // clear user so getMessages knows it's operator
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

module.exports = router;
