const express = require("express");
const router = express.Router();
const {
  registerToken,
  adminSendNotification,
  getMyNotifications,
  getOperatorNotifications,
  getAdminNotifications,
  markAllRead,
} = require("../controllers/notificationController");
const { protect, restrictTo } = require("../middleware/authMiddleware");
const { operatorProtect } = require("../middleware/operatorAuthMiddleware");

// Operator notifications (before protect middleware)
router.get("/operator/my", operatorProtect, getOperatorNotifications);
router.patch(
  "/operator/mark-read",
  operatorProtect,
  (req, res, next) => {
    next();
  },
  markAllRead,
);

// User & Admin routes
router.use(protect);
router.post("/register-token", registerToken);
router.get("/my", getMyNotifications);
router.get("/admin/all", restrictTo("admin"), getAdminNotifications);
router.patch("/mark-read", markAllRead);
router.post("/send", restrictTo("admin"), adminSendNotification);

module.exports = router;
