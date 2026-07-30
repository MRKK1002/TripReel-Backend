const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");

let io;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Auth middleware — verify the JWT and DERIVE the identity from the database.
  //
  // The sender type used to come from `handshake.auth.userType`, i.e. from the
  // client, so any valid user token could connect as "operator" or "admin" and
  // post messages under that identity. It is now resolved from the token id.
  // ───────────────────────────────────────────────────────────────────────────
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error("No token"));

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return next(new Error("Invalid token"));
    }

    try {
      const { Operator } = require("../models/Operator");
      const User = require("../models/User");

      // Operator and user tokens are both signed with { id }, so resolve which
      // collection the id actually belongs to.
      const operator = await Operator.findById(decoded.id).select(
        "onboardingState",
      );
      if (operator) {
        if (operator.onboardingState === "SUSPENDED") {
          return next(new Error("Account suspended"));
        }
        socket.userId = String(operator._id);
        socket.userType = "operator";
        return next();
      }

      const user = await User.findById(decoded.id).select("role status");
      if (!user) return next(new Error("Account no longer exists"));
      if (user.status === "Suspended") {
        return next(new Error("Account suspended"));
      }
      socket.userId = String(user._id);
      socket.userType = user.role === "admin" ? "admin" : "user";
      return next();
    } catch (err) {
      return next(new Error("Authentication failed"));
    }
  });

  // Verify the connected socket is a party to the conversation
  async function canAccessConversation(socket, conversationId) {
    const mongoose = require("mongoose");
    if (!mongoose.Types.ObjectId.isValid(conversationId)) return null;
    const conv = await Conversation.findById(conversationId);
    if (!conv) return null;
    if (socket.userType === "admin") return conv;
    if (socket.userType === "operator")
      return String(conv.operatorId) === socket.userId ? conv : null;
    return String(conv.userId) === socket.userId ? conv : null;
  }

  io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.userId} (${socket.userType})`);

    // Join user's personal room
    socket.join(socket.userId);

    // Join a conversation room — only if you're a party to it
    socket.on("join_conversation", async (conversationId) => {
      const conv = await canAccessConversation(socket, conversationId);
      if (!conv) {
        socket.emit("error_message", {
          message: "You don't have access to this conversation",
        });
        return;
      }
      socket.join(`conv_${conversationId}`);
    });

    // Leave conversation room
    socket.on("leave_conversation", (conversationId) => {
      socket.leave(`conv_${conversationId}`);
    });

    // Send message
    socket.on("send_message", async (data) => {
      try {
        const { conversationId, text, imageUrl } = data;

        const conv = await canAccessConversation(socket, conversationId);
        if (!conv) {
          socket.emit("error_message", {
            message: "You don't have access to this conversation",
          });
          return;
        }
        if (new Date() > conv.expiresAt) {
          socket.emit("error_message", { message: "Chat expired" });
          return;
        }

        const bodyText = typeof text === "string" ? text.trim() : "";
        const bodyImage = typeof imageUrl === "string" ? imageUrl.trim() : "";
        if (!bodyText && !bodyImage) return;
        if (bodyText.length > 2000) {
          socket.emit("error_message", { message: "Message too long" });
          return;
        }

        const senderType = socket.userType;
        const senderId = socket.userId;

        const message = await Message.create({
          conversationId,
          senderId,
          senderType,
          senderName: data.senderName || "",
          text: bodyText,
          imageUrl: bodyImage,
        });

        // Update conversation preview
        const preview = bodyImage ? "📷 Image" : bodyText.substring(0, 60);
        const update = {
          lastMessage: preview,
          lastMessageAt: new Date(),
          lastSenderType: senderType,
        };

        if (senderType === "user") {
          await Conversation.findByIdAndUpdate(conversationId, {
            ...update,
            $inc: { unreadOperator: 1 },
          });
        } else {
          await Conversation.findByIdAndUpdate(conversationId, {
            ...update,
            $inc: { unreadUser: 1 },
          });
        }

        // Emit to conversation room (both parties see it)
        io.to(`conv_${conversationId}`).emit("new_message", message);

        // Also emit to the other party's personal room (for notification badge)
        if (senderType === "user") {
          io.to(conv.operatorId.toString()).emit("message_notification", {
            conversationId,
            preview,
          });
        } else {
          io.to(conv.userId.toString()).emit("message_notification", {
            conversationId,
            preview,
          });
        }
      } catch (err) {
        socket.emit("error_message", { message: err.message });
      }
    });

    // Typing indicator — only broadcast into rooms you've legitimately joined
    socket.on("typing", ({ conversationId, isTyping }) => {
      if (!socket.rooms.has(`conv_${conversationId}`)) return;
      socket.to(`conv_${conversationId}`).emit("user_typing", {
        userId: socket.userId,
        userType: socket.userType,
        isTyping,
      });
    });

    // Mark messages as read
    socket.on("mark_read", async ({ conversationId }) => {
      try {
        const conv = await canAccessConversation(socket, conversationId);
        if (!conv) return;
        const senderType = socket.userType;
        await Message.updateMany(
          { conversationId, senderType: { $ne: senderType }, read: false },
          { read: true },
        );
        if (senderType === "user") {
          await Conversation.findByIdAndUpdate(conversationId, {
            unreadUser: 0,
          });
        } else {
          await Conversation.findByIdAndUpdate(conversationId, {
            unreadOperator: 0,
          });
        }
        // Notify the other party
        socket
          .to(`conv_${conversationId}`)
          .emit("messages_read", { conversationId, by: socket.userId });
      } catch {}
    });

    socket.on("disconnect", () => {
      console.log(`Socket disconnected: ${socket.userId}`);
    });
  });

  return io;
}

function getIO() {
  return io;
}

module.exports = { initSocket, getIO };
