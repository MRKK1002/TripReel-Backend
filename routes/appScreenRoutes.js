const express = require("express");
const router = express.Router();
const AppScreen = require("../models/AppScreen");
const { protect, restrictTo } = require("../middleware/authMiddleware");

// Helper: get or create singleton
async function getConfig() {
  let config = await AppScreen.findOne();
  if (!config) config = await AppScreen.create({});
  return config;
}

// GET /api/app-screens — public (app fetches this)
router.get("/", async (req, res) => {
  try {
    const config = await getConfig();
    res.json({
      success: true,
      splashImageUrl: config.splashImageUrl || "",
      slides: (config.slides || []).sort((a, b) => a.order - b.order),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/app-screens/splash — admin updates splash image
router.put("/splash", protect, restrictTo("admin"), async (req, res) => {
  try {
    const { splashImageUrl } = req.body;
    const config = await getConfig();
    config.splashImageUrl = splashImageUrl || "";
    await config.save();
    res.json({ success: true, splashImageUrl: config.splashImageUrl });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/app-screens/slides — admin replaces all slides
router.put("/slides", protect, restrictTo("admin"), async (req, res) => {
  try {
    const { slides } = req.body;
    const config = await getConfig();
    config.slides = (slides || []).map((s, i) => ({
      imageUrl: s.imageUrl || "",
      title: s.title || "",
      description: s.description || "",
      order: s.order !== undefined ? s.order : i,
    }));
    await config.save();
    res.json({ success: true, slides: config.slides });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
