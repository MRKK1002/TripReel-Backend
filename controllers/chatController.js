const Conversation = require("../models/Conversation");
const Message = require("../models/Message");

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
    const conv = await Conversation.findById(req.params.conversationId);

    if (!conv)
      return res
        .status(404)
        .json({ success: false, message: "Conversation not found" });
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
      text: text || "",
      imageUrl: imageUrl || "",
    });

    // Update conversation
    const preview = imageUrl ? "📷 Image" : text?.substring(0, 60) || "";
    const updateData = {
      lastMessage: preview,
      lastMessageAt: new Date(),
      lastSenderType: senderType,
    };
    if (senderType !== "user") updateData.$inc = { unreadUser: 1 };
    if (senderType !== "operator") {
      updateData.$inc = { ...(updateData.$inc || {}), unreadOperator: 1 };
    }

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
