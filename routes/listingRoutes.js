const express = require("express");
const router = express.Router();
const {
  getAllListings,
  getListingById,
  adminGetAllListings,
  reviewListing,
  operatorGetMyListings,
  operatorCreateListing,
  operatorUpdateListing,
  operatorDeleteListing,
} = require("../controllers/packageListingController");
const { protect, restrictTo } = require("../middleware/authMiddleware");
const {
  operatorProtect,
  requireApprovedOperator,
} = require("../middleware/operatorAuthMiddleware");

router.get("/", getAllListings);
router.get("/admin/all", protect, restrictTo("admin"), adminGetAllListings);
router.patch("/:id/review", protect, restrictTo("admin"), reviewListing);

router.get("/operator/mine", operatorProtect, operatorGetMyListings);
router.post(
  "/operator",
  operatorProtect,
  requireApprovedOperator,
  operatorCreateListing,
);
router.put(
  "/operator/:id",
  operatorProtect,
  requireApprovedOperator,
  operatorUpdateListing,
);
router.delete(
  "/operator/:id",
  operatorProtect,
  requireApprovedOperator,
  operatorDeleteListing,
);

router.get("/:id", getListingById);

module.exports = router;
