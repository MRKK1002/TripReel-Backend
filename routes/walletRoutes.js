const express = require("express");
const router = express.Router();
const {
  getMyWallet,
  getMyTransactions,
  adminGetAllWallets,
  adminGetWallet,
  requestWithdrawal,
  getMyWithdrawals,
  razorpayxWebhook,
  adminGetWithdrawals,
} = require("../controllers/walletController");
const { protect, restrictTo } = require("../middleware/authMiddleware");
const {
  operatorProtect,
  requireApprovedOperator,
} = require("../middleware/operatorAuthMiddleware");

// ── RazorpayX webhook (no auth — verified by signature) ───────────────────────
router.post("/razorpayx/webhook", razorpayxWebhook);

// ── Operator ──────────────────────────────────────────────────────────────────
router.get("/", operatorProtect, getMyWallet);
router.get("/transactions", operatorProtect, getMyTransactions);
router.post(
  "/withdraw",
  operatorProtect,
  requireApprovedOperator,
  requestWithdrawal,
);
router.get("/withdrawals", operatorProtect, getMyWithdrawals);

// ── Admin ─────────────────────────────────────────────────────────────────────
router.get("/admin/all", protect, restrictTo("admin"), adminGetAllWallets);
router.get(
  "/admin/withdrawals",
  protect,
  restrictTo("admin"),
  adminGetWithdrawals,
);
router.get("/admin/:operatorId", protect, restrictTo("admin"), adminGetWallet);

module.exports = router;
