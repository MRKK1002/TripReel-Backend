const express = require("express");
const router = express.Router();
const {
  createOrder,
  verifyPayment,
  createAddonOrder,
  verifyAddonPayment,
  releaseOrder,
  razorpayWebhook,
} = require("../controllers/paymentController");
const {
  protect,
  requireVerifiedPhone,
} = require("../middleware/authMiddleware");

// ── Public webhook (no auth — verified by Razorpay signature) ────────────────
// Recovers bookings if the app died after payment but before /verify.
router.post("/webhook", razorpayWebhook);

// All payment routes below require authentication
router.use(protect);

router.post("/create-order", requireVerifiedPhone, createOrder);
router.post("/release-order", releaseOrder);
router.post("/verify", verifyPayment);

// Post-booking add-on top-up (separate payment for just the add-on amount)
router.post("/create-addon-order", requireVerifiedPhone, createAddonOrder);
router.post("/verify-addon", verifyAddonPayment);

module.exports = router;
