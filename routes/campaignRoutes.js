const express = require("express");
const router = express.Router();
const Campaign = require("../models/Campaign");
const { protect, restrictTo } = require("../middleware/authMiddleware");

// GET /api/campaigns/active — public, returns current active campaign for app
router.get("/active", async (req, res) => {
  try {
    const now = new Date();
    const campaign = await Campaign.findOne({
      isActive: true,
      startDate: { $lte: now },
      endDate: { $gte: now },
    }).sort({ createdAt: -1 });

    if (!campaign) {
      return res.json({ success: true, campaign: null });
    }

    // Increment impressions
    campaign.impressions += 1;
    await campaign.save();

    res.json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/campaigns/click/:id — track CTA click
router.post("/click/:id", async (req, res) => {
  try {
    await Campaign.findByIdAndUpdate(req.params.id, { $inc: { clicks: 1 } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Admin CRUD ────────────────────────────────────────────────────────────────

// GET /api/campaigns — admin gets all campaigns
router.get("/", protect, restrictTo("admin"), async (req, res) => {
  try {
    const campaigns = await Campaign.find().sort({ createdAt: -1 });
    res.json({ success: true, campaigns });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/campaigns — admin creates campaign
router.post("/", protect, restrictTo("admin"), async (req, res) => {
  try {
    const {
      title,
      description,
      imageUrl,
      ctaText,
      ctaLink,
      packageId,
      startDate,
      endDate,
    } = req.body;
    if (!title || !startDate || !endDate) {
      return res
        .status(400)
        .json({
          success: false,
          message: "title, startDate, endDate required",
        });
    }
    const campaign = await Campaign.create({
      title,
      description,
      imageUrl,
      ctaText: ctaText || "View Offer",
      ctaLink,
      packageId: packageId || null,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
    });
    res.status(201).json({ success: true, campaign });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PUT /api/campaigns/:id — admin updates campaign
router.put("/:id", protect, restrictTo("admin"), async (req, res) => {
  try {
    const campaign = await Campaign.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!campaign)
      return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, campaign });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// DELETE /api/campaigns/:id — admin deletes campaign
router.delete("/:id", protect, restrictTo("admin"), async (req, res) => {
  try {
    await Campaign.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
