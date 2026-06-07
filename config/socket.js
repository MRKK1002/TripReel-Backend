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

  // Auth middleware — verify JWT token on connection
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error("No token"));

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.id;
      socket.userType = socket.handshake.auth?.userType || "user"; // 'user' | 'operator' | 'admin'
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.userId} (${socket.userType})`);

    // Join user's personal room
    socket.join(socket.userId);

    // Join a conversation room
    socket.on("join_conversation", (conversationId) => {
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

        const conv = await Conversation.findById(conversationId);
        if (!conv || new Date() > conv.expiresAt) {
          socket.emit("error_message", { message: "Chat expired" });
          return;
        }

        const senderType = socket.userType;
        const senderId = socket.userId;

        const message = await Message.create({
          conversationId,
          senderId,
          senderType,
          senderName: data.senderName || "",
          text: text || "",
          imageUrl: imageUrl || "",
        });

        // Update conversation preview
        const preview = imageUrl ? "📷 Image" : (text || "").substring(0, 60);
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

    // Typing indicator
    socket.on("typing", ({ conversationId, isTyping }) => {
      socket.to(`conv_${conversationId}`).emit("user_typing", {
        userId: socket.userId,
        userType: socket.userType,
        isTyping,
      });
    });

    // Mark messages as read
    socket.on("mark_read", async ({ conversationId }) => {
      try {
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
