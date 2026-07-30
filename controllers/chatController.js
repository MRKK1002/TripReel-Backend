const Conversation = require("../models/Conversation");
const Message = require("../models/Message");

// ─────────────────────────────────────────────────────────────────────────────
// Conversation access guard
//
// getMessages / sendMessage previously filtered on the conversationId alone, so
// any authenticated user or operator could read and post into ANY conversation
// by iterating ids. Every entry point must now resolve the conversation through
// this helper.
//
// Returns { conversation } on success, or { error: {status, message} }.
// ─────────────────────────────────────────────────────────────────────────────
async function loadAuthorizedConversation(req, conversationId) {
  const mongoose = require("mongoose");
  if (!mongoose.Types.ObjectId.isValid(conversationId)) {
    return { error: { status: 400, message: "Invalid conversation id" } };
  }

  const conversation = await Conversation.findById(conversationId);
  if (!conversation) {
    return { error: { status: 404, message: "Conversation not found" } };
  }

  // Admins may read any conversation
  if (req.user?.role === "admin") return { conversation, role: "admin" };

  if (req.operator) {
    if (String(conversation.operatorId) !== String(req.operator._id)) {
      return {
        error: { status: 403, message: "This conversation is not yours" },
      };
    }
    return { conversation, role: "operator" };
  }

  if (req.user) {
    if (String(conversation.userId) !== String(req.user._id)) {
      return {
        error: { status: 403, message: "This conversation is not yours" },
      };
    }
    return { conversation, role: "user" };
  }

  return { error: { status: 401, message: "Not authorized" } };
}

exports.loadAuthorizedConversation = loadAuthorizedConversation;

const MAX_MESSAGE_LENGTH = 2000;
exports.MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH;

// GET /api/chat/conversations — user's conversations
exports.getUserConversations = async (req, res) => {
  try {
    const now = new Date();
    const conversations = await Conversation.find({
      userId: req.user._id,
      isActive: true,
      expiresAt: { $gt: now },
    })
      .populate("operatorId", "contactName businessName profilePhoto")
      .sort({ lastMessageAt: -1, createdAt: -1 });

    res.json({ success: true, conversations });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/chat/operator/conversations — operator's conversations
exports.getOperatorConversations = async (req, res) => {
  try {
    const now = new Date();
    const conversations = await Conversation.find({
      operatorId: req.operator._id,
      isActive: true,
      expiresAt: { $gt: now },
    })
      .populate("userId", "name avatar phone")
      .sort({ lastMessageAt: -1, createdAt: -1 });

    res.json({ success: true, conversations });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/chat/admin/conversations — admin sees all
exports.getAdminConversations = async (req, res) => {
  try {
    const conversations = await Conversation.find({ isActive: true })
      .populate("userId", "name avatar")
      .populate("operatorId", "contactName businessName")
      .sort({ lastMessageAt: -1 });

    res.json({ success: true, conversations });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/chat/:conversationId/messages — get messages for a conversation
exports.getMessages = async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    // Ownership check — must run before any read or read-receipt write
    const { error } = await loadAuthorizedConversation(
      req,
      req.params.conversationId,
    );
    if (error) {
      return res
        .status(error.status)
        .json({ success: false, message: error.message });
    }

    const messages = await Message.find({
      conversationId: req.params.conversationId,
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    // Mark as read
    const userId = req.user?._id || req.operator?._id;
    const senderType = req.user ? "user" : "operator";

    // Mark unread messages from the other party as read
    await Message.updateMany(
      {
        conversationId: req.params.conversationId,
        senderType: { $ne: senderType },
        read: false,
      },
      { read: true },
    );

    // Reset unread count
    if (req.user) {
      await Conversation.findByIdAndUpdate(req.params.conversationId, {
        unreadUser: 0,
      });
    } else if (req.operator) {
      await Conversation.findByIdAndUpdate(req.params.conversationId, {
        unreadOperator: 0,
      });
    }

    res.json({ success: true, messages: messages.reverse() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/chat/:conversationId/messages — send a message (REST fallback)
exports.sendMessage = async (req, res) => {
  try {
    const { text, imageUrl } = req.body;

    // Ownership check — only the two parties (or an admin) may post here
    const { conversation: conv, error } = await loadAuthorizedConversation(
      req,
      req.params.conversationId,
    );
    if (error) {
      return res
        .status(error.status)
        .json({ success: false, message: error.message });
    }

    const bodyText = typeof text === "string" ? text.trim() : "";
    const bodyImage = typeof imageUrl === "string" ? imageUrl.trim() : "";
    if (!bodyText && !bodyImage) {
      return res
        .status(400)
        .json({ success: false, message: "Message cannot be empty" });
    }
    if (bodyText.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Message cannot exceed ${MAX_MESSAGE_LENGTH} characters`,
      });
    }

    if (new Date() > conv.expiresAt) {
      return res
        .status(400)
        .json({ success: false, message: "Chat window has expired" });
    }

    const senderType = req.user ? "user" : req.operator ? "operator" : "admin";
    const senderId = req.user?._id || req.operator?._id;
    const senderName = req.user?.name || req.operator?.contactName || "Admin";

    const message = await Message.create({
      conversationId: conv._id,
      senderId,
      senderType,
      senderName,
      text: bodyText,
      imageUrl: bodyImage,
    });

    // Update conversation
    const preview = bodyImage ? "📷 Image" : bodyText.substring(0, 60);

    await Conversation.findByIdAndUpdate(conv._id, {
      lastMessage: preview,
      lastMessageAt: new Date(),
      lastSenderType: senderType,
      ...(senderType !== "user" ? { $inc: { unreadUser: 1 } } : {}),
      ...(senderType === "user" ? { $inc: { unreadOperator: 1 } } : {}),
    });

    res.status(201).json({ success: true, message });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};
