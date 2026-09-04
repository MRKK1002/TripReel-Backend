const express = require("express");
const router = express.Router();
const {
  getCouponsForBatch,
  validateCoupon,
  createCoupon,
  operatorGetMyCoupons,
  updateCoupon,
  deleteCoupon,
} = require("../controllers/couponController");
const { protect } = require("../middleware/authMiddleware");
const {
  operatorProtect,
  requireApprovedOperator,
} = require("../middleware/operatorAuthMiddleware");

// Signed-in users — available coupons for a batch/package (shown in app).
// This was public, which let anyone enumerate every operator's live codes,
// discount values and caps for an arbitrary packageId.
router.get("/", protect, getCouponsForBatch);

// User — validate a coupon code
router.post("/validate", protect, validateCoupon);

// Operator — CRUD (writes require an approved account)
router.get("/operator/mine", operatorProtect, operatorGetMyCoupons);
router.post("/", operatorProtect, requireApprovedOperator, createCoupon);
router.put("/:id", operatorProtect, requireApprovedOperator, updateCoupon);
router.delete("/:id", operatorProtect, requireApprovedOperator, deleteCoupon);

module.exports = router;
