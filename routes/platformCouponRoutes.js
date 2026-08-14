const express = require("express");
const router = express.Router();
const {
  adminGetAll,
  adminCreate,
  adminUpdate,
  adminDelete,
  getAvailableForPackage,
  validateForUser,
} = require("../controllers/platformCouponController");
const { protect, restrictTo } = require("../middleware/authMiddleware");

// ── App (authenticated user) ──────────────────────────────────────────────────
router.get("/available", protect, getAvailableForPackage);
router.post("/validate", protect, validateForUser);

// ── Admin ─────────────────────────────────────────────────────────────────────
router.get("/admin", protect, restrictTo("admin"), adminGetAll);
router.post("/admin", protect, restrictTo("admin"), adminCreate);
router.patch("/admin/:id", protect, restrictTo("admin"), adminUpdate);
router.delete("/admin/:id", protect, restrictTo("admin"), adminDelete);

module.exports = router;
