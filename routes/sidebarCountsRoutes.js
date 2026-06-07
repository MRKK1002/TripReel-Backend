const express = require("express");
const router = express.Router();
const { protect, restrictTo } = require("../middleware/authMiddleware");
const { operatorProtect } = require("../middleware/operatorAuthMiddleware");
const LastSeen = require("../models/LastSeen");

// Helper: get lastSeenAt for a user+section
async function getLastSeen(userId, userType, section) {
  const record = await LastSeen.findOne({ userId, userType, section });
  return record?.lastSeenAt || new Date(0); // If never seen, use epoch (everything is new)
}

// ── Admin sidebar counts ──────────────────────────────────────────────────────
router.get("/admin", protect, restrictTo("admin"), async (req, res) => {
  try {
    const Package = require("../models/Package");
    const { Operator } = require("../models/Operator");
    const TripBooking = require("../models/TripBooking");
    const Notification = require("../models/Notification");

    const adminId = req.user._id;

    const [lastSeenPackages, lastSeenOperators, lastSeenBookings] =
      await Promise.all([
        getLastSeen(adminId, "admin", "packages"),
        getLastSeen(adminId, "admin", "operators"),
        getLastSeen(adminId, "admin", "trip-bookings"),
      ]);

    const [
      pendingPackages,
      pendingOperators,
      newBookings,
      unreadNotifications,
    ] = await Promise.all([
      Package.countDocuments({
        status: "PENDING",
        createdAt: { $gt: lastSeenPackages },
      }),
      Operator.countDocuments({
        onboardingState: "PENDING_APPROVAL",
        createdAt: { $gt: lastSeenOperators },
      }),
      TripBooking.countDocuments({
        createdAt: { $gt: lastSeenBookings },
      }),
      Notification.countDocuments({
        recipientType: "admin",
        read: false,
      }),
    ]);

    res.json({
      success: true,
      counts: {
        pendingPackages,
        pendingOperators,
        newBookings,
        unreadNotifications,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Admin: mark a section as seen ─────────────────────────────────────────────
router.post("/admin/seen", protect, restrictTo("admin"), async (req, res) => {
  try {
    const { section } = req.body;
    if (!section) {
      return res
        .status(400)
        .json({ success: false, message: "section required" });
    }

    await LastSeen.findOneAndUpdate(
      { userId: req.user._id, userType: "admin", section },
      { lastSeenAt: new Date() },
      { upsert: true, new: true },
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Operator sidebar counts ───────────────────────────────────────────────────
router.get("/operator", operatorProtect, async (req, res) => {
  try {
    const TripBooking = require("../models/TripBooking");
    const Notification = require("../models/Notification");

    const operatorId = req.operator._id;

    const lastSeenBookings = await getLastSeen(
      operatorId,
      "operator",
      "bookings",
    );

    const [newBookings, unreadNotifications] = await Promise.all([
      TripBooking.countDocuments({
        operatorId,
        createdAt: { $gt: lastSeenBookings },
      }),
      Notification.countDocuments({
        recipientId: operatorId,
        recipientType: "operator",
        read: false,
      }),
    ]);

    res.json({
      success: true,
      counts: {
        newBookings,
        unreadNotifications,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Operator: mark a section as seen ──────────────────────────────────────────
router.post("/operator/seen", operatorProtect, async (req, res) => {
  try {
    const { section } = req.body;
    if (!section) {
      return res
        .status(400)
        .json({ success: false, message: "section required" });
    }

    await LastSeen.findOneAndUpdate(
      { userId: req.operator._id, userType: "operator", section },
      { lastSeenAt: new Date() },
      { upsert: true, new: true },
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
