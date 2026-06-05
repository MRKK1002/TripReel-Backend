const express = require("express");
const router = express.Router();
const {
  getAllPackages,
  getPopularPackages,
  getPackageById,
  adminGetAllPackages,
  reviewPackage,
  deletePackage,
  operatorGetMyPackages,
  operatorCreatePackage,
  operatorUpdatePackage,
  operatorDeletePackage,
  adminTogglePackageSuspend,
  operatorGetReviews,
} = require("../controllers/packageController");
const { protect, restrictTo } = require("../middleware/authMiddleware");
const { operatorProtect } = require("../middleware/operatorAuthMiddleware");
const upload = require("../middleware/uploadMiddleware");

// multer fields for package images
const packageUpload = upload.fields([
  { name: "image_url", maxCount: 1 },
  { name: "images", maxCount: 4 },
]);

// ── Operator routes (must come before /:id to avoid conflicts) ────────────────
router.get("/operator/mine", operatorProtect, operatorGetMyPackages);
router.get("/operator/reviews", operatorProtect, operatorGetReviews);
router.post("/operator", operatorProtect, packageUpload, operatorCreatePackage);
router.put(
  "/operator/:id",
  operatorProtect,
  packageUpload,
  operatorUpdatePackage,
);
router.delete("/operator/:id", operatorProtect, operatorDeletePackage);

// ── Admin routes ──────────────────────────────────────────────────────────────
router.get("/admin/all", protect, restrictTo("admin"), adminGetAllPackages);
router.patch("/:id/review", protect, restrictTo("admin"), reviewPackage);
router.patch(
  "/:id/suspend",
  protect,
  restrictTo("admin"),
  adminTogglePackageSuspend,
);
router.delete("/:id", protect, restrictTo("admin"), deletePackage);

// ── Public routes ─────────────────────────────────────────────────────────────
router.get("/popular", getPopularPackages); // must be before /:id
router.get("/", getAllPackages);
router.get("/:id", getPackageById);

module.exports = router;
