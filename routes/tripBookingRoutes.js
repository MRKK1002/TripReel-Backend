const express = require("express");
const router = express.Router();
const {
  createBooking,
  getMyBookings,
  getBookingById,
  adminGetAllBookings,
  updateBookingStatus,
  operatorGetMyBookings,
  cancelBooking,
  getRefundPreview,
  adminGetRefunds,
  adminRetryRefund,
  adminMarkRefundDone,
  syncSnapjaStatus,
  confirmSnapjaDelivery,
} = require("../controllers/tripBookingController");
const {
  protect,
  requireVerifiedPhone,
  restrictTo,
} = require("../middleware/authMiddleware");
const { operatorProtect } = require("../middleware/operatorAuthMiddleware");

// ── User (requires login) ─────────────────────────────────────────────────────
router.use(protect);

router.post("/", requireVerifiedPhone, createBooking);
router.get("/my", getMyBookings);

// ── Admin refunds (must be before /:id to avoid route clash) ──────────────────
router.get("/admin/refunds", restrictTo("admin"), adminGetRefunds);
router.post("/admin/refunds/:id/retry", restrictTo("admin"), adminRetryRefund);
router.post(
  "/admin/refunds/:id/mark-done",
  restrictTo("admin"),
  adminMarkRefundDone,
);

router.get("/:id", getBookingById);
router.get("/:id/refund-preview", getRefundPreview);
router.get("/:id/sync-snapja", syncSnapjaStatus);
router.post("/:id/snapja/:entryKey/confirm-delivery", confirmSnapjaDelivery);
router.post("/:id/cancel", cancelBooking);

// ── Admin ─────────────────────────────────────────────────────────────────────
router.get("/", restrictTo("admin"), adminGetAllBookings);
router.patch("/:id/status", restrictTo("admin"), updateBookingStatus);

module.exports = router;
