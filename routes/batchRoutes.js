const express = require("express");
const router = express.Router();
const {
  getBatchesForPackage,
  getBatchById,
  createBatch,
  cloneBatch,
  updateBatch,
  deleteBatch,
  operatorGetMyBatches,
  adminGetAllBatches,
  adminToggleActive,
} = require("../controllers/batchController");
const { protect, restrictTo } = require("../middleware/authMiddleware");
const {
  operatorProtect,
  requireApprovedOperator,
} = require("../middleware/operatorAuthMiddleware");

// ── Public ────────────────────────────────────────────────────────────────────
router.get("/", getBatchesForPackage); // ?packageId=X
router.get("/:id", getBatchById);

// ── Operator (write actions require an approved account) ──────────────────────
router.get("/operator/mine", operatorProtect, operatorGetMyBatches);
router.post("/", operatorProtect, requireApprovedOperator, createBatch);
router.post("/:id/clone", operatorProtect, requireApprovedOperator, cloneBatch);
router.put("/:id", operatorProtect, requireApprovedOperator, updateBatch);
router.delete("/:id", operatorProtect, requireApprovedOperator, deleteBatch);

// ── Admin ─────────────────────────────────────────────────────────────────────
router.get("/admin/all", protect, restrictTo("admin"), adminGetAllBatches);
router.patch("/:id/active", protect, restrictTo("admin"), adminToggleActive);

module.exports = router;
