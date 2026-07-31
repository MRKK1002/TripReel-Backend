const express = require("express");
const router = express.Router();
const {
  getAllSettings,
  getPublicSettings,
  updateSetting,
  incrementSampleMediaView,
} = require("../controllers/platformSettingsController");
const { protect, restrictTo } = require("../middleware/authMiddleware");

// Public — only exposes gst_percent for display in app
router.get("/public", getPublicSettings);
router.post("/sample-media/view", incrementSampleMediaView);

// Admin only
router.get("/", protect, restrictTo("admin"), getAllSettings);
router.patch("/:key", protect, restrictTo("admin"), updateSetting);

module.exports = router;
