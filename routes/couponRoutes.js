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
const { operatorProtect } = require("../middleware/operatorAuthMiddleware");

// Public — get available coupons for a batch (shown in app)
router.get("/", getCouponsForBatch);

// User — validate a coupon code
router.post("/validate", protect, validateCoupon);

// Operator — CRUD
router.get("/operator/mine", operatorProtect, operatorGetMyCoupons);
router.post("/", operatorProtect, createCoupon);
router.put("/:id", operatorProtect, updateCoupon);
router.delete("/:id", operatorProtect, deleteCoupon);

module.exports = router;
