const express = require("express");
const router = express.Router();
const {
  createOrder,
  verifyPayment,
  createAddonOrder,
  verifyAddonPayment,
  razorpayWebhook,
} = require("../controllers/paymentController");
const { protect } = require("../middleware/authMiddleware");

// ── Public webhook (no auth — verified by Razorpay signature) ────────────────
// Recovers bookings if the app died after payment but before /verify.
router.post("/webhook", razorpayWebhook);

// All payment routes below require authentication
router.use(protect);

router.post("/create-order", createOrder);
router.post("/verify", verifyPayment);

// Post-booking add-on top-up (separate payment for just the add-on amount)
router.post("/create-addon-order", createAddonOrder);
router.post("/verify-addon", verifyAddonPayment);

module.exports = router;
