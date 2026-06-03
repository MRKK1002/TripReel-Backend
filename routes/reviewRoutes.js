const express = require("express");
const router = express.Router();
const { protect, restrictTo } = require("../middleware/authMiddleware");
const {
  getPackageReviews,
  createReview,
  getMyReview,
  deleteReview,
  adminGetAllReviews,
  toggleVisibility,
} = require("../controllers/reviewController");

// Public
router.get("/:packageId", getPackageReviews);

// User (auth required)
router.post("/", protect, createReview);
router.get("/my/:packageId", protect, getMyReview);
router.delete("/:id", protect, deleteReview);

// Admin
router.get("/admin/all", protect, restrictTo("admin"), adminGetAllReviews);
router.patch("/:id/visibility", protect, restrictTo("admin"), toggleVisibility);

module.exports = router;
