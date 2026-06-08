const User = require("../models/User");
const { Operator } = require("../models/Operator");
const Notification = require("../models/Notification");
const {
  sendNotification,
  sendMulticast,
  sendToTopic,
} = require("../config/firebase");

// POST /api/notifications/register-token — app sends FCM token after login
exports.registerToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) {
      return res
        .status(400)
        .json({ success: false, message: "fcmToken required" });
    }
    await User.findByIdAndUpdate(req.user._id, { fcmToken });
    res.json({ success: true, message: "Token registered" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/notifications/send — admin sends notification to specific user or all
exports.adminSendNotification = async (req, res) => {
  try {
    const { userId, title, body, topic, imageUrl } = req.body;

    if (!title || !body) {
      return res
        .status(400)
        .json({ success: false, message: "title and body required" });
    }

    // Send to specific user
    if (userId) {
      await Notification.create({
        recipientId: userId,
        recipientType: "user",
        title,
        body,
        type: "general",
      });
      const user = await User.findById(userId);
      if (user?.fcmToken) {
        await sendNotification(user.fcmToken, title, body, {
          imageUrl: imageUrl || "",
        }).catch(() => {});
      }
      return res.json({ success: true, sent: 1 });
    }

    // Send to topic
    if (topic) {
      await sendToTopic(topic, title, body).catch(() => {});
      return res.json({ success: true });
    }

    // Send to ALL users (exclude admins)
    const users = await User.find({ role: { $ne: "admin" } }).select(
      "_id fcmToken",
    );
    const tokens = [];

    for (const user of users) {
      await Notification.create({
        recipientId: user._id,
        recipientType: "user",
        title,
        body,
        type: "offer",
      });
      if (user.fcmToken) tokens.push(user.fcmToken);
    }

    if (tokens.length > 0) {
      await sendMulticast(tokens, title, body, {
        imageUrl: imageUrl || "",
      }).catch(() => {});
    }

    res.json({ success: true, sent: users.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Helper: send booking notification to a user + save to DB ─────────────────
exports.notifyUser = async (userId, title, body, data = {}) => {
  try {
    // Save to DB
    await Notification.create({
      recipientId: userId,
      recipientType: "user",
      title,
      body,
      type: data.type || "general",
      bookingId: data.bookingId || undefined,
      packageId: data.packageId || undefined,
    });
    // Push notification
    const user = await User.findById(userId).select("fcmToken");
    if (user?.fcmToken) {
      await sendNotification(user.fcmToken, title, body, data);
    }
  } catch (err) {
    console.warn("notifyUser error:", err.message);
  }
};

// ── Notify an operator by ID + save to DB ────────────────────────────────────
exports.notifyOperator = async (operatorId, title, body, data = {}) => {
  try {
    // Save to DB
    await Notification.create({
      recipientId: operatorId,
      recipientType: "operator",
      title,
      body,
      type: data.type || "general",
      bookingId: data.bookingId || undefined,
      packageId: data.packageId || undefined,
    });
    // Push notification
    const op = await Operator.findById(operatorId).select("fcmToken");
    if (op?.fcmToken) {
      await sendNotification(op.fcmToken, title, body, data);
    }
  } catch (err) {
    console.warn("notifyOperator error:", err.message);
  }
};

// GET /api/notifications/my — user gets their notifications
exports.getMyNotifications = async (req, res) => {
  try {
    const notifications = await Notification.find({ recipientId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50);
    const unreadCount = await Notification.countDocuments({
      recipientId: req.user._id,
      read: false,
    });
    res.json({ success: true, notifications, unreadCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/notifications/operator/my — operator gets their notifications
exports.getOperatorNotifications = async (req, res) => {
  try {
    const notifications = await Notification.find({
      recipientId: req.operator._id,
    })
      .sort({ createdAt: -1 })
      .limit(50);
    const unreadCount = await Notification.countDocuments({
      recipientId: req.operator._id,
      read: false,
    });
    res.json({ success: true, notifications, unreadCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /api/notifications/mark-read — mark all as read
exports.markAllRead = async (req, res) => {
  try {
    const userId = req.user?._id || req.operator?._id;
    const isAdmin = req.user?.role === "admin";

    // For admin, mark ALL admin notifications as read (not just by recipientId)
    if (isAdmin) {
      await Notification.updateMany(
        { recipientType: "admin", read: false },
        { read: true },
      );
    } else {
      await Notification.updateMany(
        { recipientId: userId, read: false },
        { read: true },
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Notify admin (find admin user and save notification) ─────────────────────
exports.notifyAdmin = async (title, body, data = {}) => {
  try {
    const User = require("../models/User");
    const admins = await User.find({ role: "admin" }).select("_id fcmToken");
    for (const admin of admins) {
      await Notification.create({
        recipientId: admin._id,
        recipientType: "admin",
        title,
        body,
        type: data.type || "general",
        bookingId: data.bookingId || undefined,
        packageId: data.packageId || undefined,
      });
      if (admin.fcmToken) {
        await sendNotification(admin.fcmToken, title, body, data).catch(
          () => {},
        );
      }
    }
  } catch (err) {
    console.warn("notifyAdmin error:", err.message);
  }
};

// GET /api/notifications/admin/all — admin gets their notifications
exports.getAdminNotifications = async (req, res) => {
  try {
    const notifications = await Notification.find({ recipientId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(100);
    const unreadCount = await Notification.countDocuments({
      recipientId: req.user._id,
      read: false,
    });
    res.json({ success: true, notifications, unreadCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
