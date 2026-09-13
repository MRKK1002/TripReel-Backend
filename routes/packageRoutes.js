const express = require("express");
const router = express.Router();
const {
  getAllPackages,
  getPopularPackages,
  getPackageById,
  adminGetAllPackages,
  adminGetPackageById,
  reviewPackage,
  deletePackage,
  operatorGetMyPackages,
  operatorCreatePackage,
  operatorUpdatePackage,
  operatorDeletePackage,
  operatorToggleActive,
  adminTogglePackageSuspend,
  operatorGetReviews,
} = require("../controllers/packageController");
const { protect, restrictTo } = require("../middleware/authMiddleware");
const {
  operatorProtect,
  requireApprovedOperator,
} = require("../middleware/operatorAuthMiddleware");
const upload = require("../middleware/uploadMiddleware");
const Package = require("../models/Package");
const { packageLifecycle, isHistory } = require("../utils/lifecycle");

// multer fields for package images
const packageUpload = upload.fields([
  { name: "image_url", maxCount: 1 },
  { name: "images", maxCount: 4 },
]);

// Reject historical package edits before multer writes uploaded files. The
// controller repeats this authoritative check after upload before changing DB state.
async function requireMutableOperatorPackage(req, res, next) {
  try {
    const pkg = await Package.findOne({
      _id: req.params.id,
      operatorId: req.operator._id,
    });
    if (!pkg)
      return res
        .status(404)
        .json({ success: false, message: "Package not found or not yours" });
    const lifecycle = packageLifecycle(pkg);
    if (isHistory("package", lifecycle))
      return res.status(409).json({
        success: false,
        message: `This package is in History (${lifecycle}) and is read-only. It cannot be changed.`,
      });
    next();
  } catch (err) {
    next(err);
  }
}

// ── Operator routes (must come before /:id to avoid conflicts) ────────────────
// Writes are gated on admin approval — an unapproved operator can read their
// (empty) list but cannot create or change anything.
router.get("/operator/mine", operatorProtect, operatorGetMyPackages);
router.get("/operator/reviews", operatorProtect, operatorGetReviews);
router.post(
  "/operator",
  operatorProtect,
  requireApprovedOperator,
  packageUpload,
  operatorCreatePackage,
);
router.put(
  "/operator/:id",
  operatorProtect,
  requireApprovedOperator,
  requireMutableOperatorPackage,
  packageUpload,
  operatorUpdatePackage,
);
router.delete(
  "/operator/:id",
  operatorProtect,
  requireApprovedOperator,
  operatorDeletePackage,
);
router.patch(
  "/operator/:id/toggle-active",
  operatorProtect,
  requireApprovedOperator,
  operatorToggleActive,
);

// ── Admin routes ──────────────────────────────────────────────────────────────
router.get("/admin/all", protect, restrictTo("admin"), adminGetAllPackages);
router.get("/admin/:id", protect, restrictTo("admin"), adminGetPackageById);
router.patch("/:id/review", protect, restrictTo("admin"), reviewPackage);
router.patch(
  "/:id/sample-media",
  protect,
  restrictTo("admin"),
  async (req, res) => {
    try {
      const Package = require("../models/Package");
      const pkg = await Package.findByIdAndUpdate(
        req.params.id,
        { sampleMedia: req.body.sampleMedia || [] },
        { new: true },
      );
      if (!pkg)
        return res
          .status(404)
          .json({ success: false, message: "Package not found" });
      res.json({ success: true, sampleMedia: pkg.sampleMedia });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);
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
