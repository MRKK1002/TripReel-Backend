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
} = require("../controllers/tripBookingController");
const { protect, restrictTo } = require("../middleware/authMiddleware");
const { operatorProtect } = require("../middleware/operatorAuthMiddleware");

// ── User (requires login) ─────────────────────────────────────────────────────
router.use(protect);

router.post("/", createBooking);
router.get("/my", getMyBookings);
router.get("/:id", getBookingById);
router.get("/:id/refund-preview", getRefundPreview);
router.post("/:id/cancel", cancelBooking);

// ── Admin ─────────────────────────────────────────────────────────────────────
router.get("/", restrictTo("admin"), adminGetAllBookings);
router.patch("/:id/status", restrictTo("admin"), updateBookingStatus);

module.exports = router;
