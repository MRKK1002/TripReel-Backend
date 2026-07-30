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

// A campaign's window was never checked, so endDate could precede startDate —
// producing a campaign that is silently never active.
function validateCampaignDates(
  startDate,
  endDate,
  { requireFuture = true } = {},
) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start.getTime())) return "Please provide a valid start date.";
  if (isNaN(end.getTime())) return "Please provide a valid end date.";
  if (end <= start) return "The end date must be after the start date.";
  if (requireFuture && end <= new Date())
    return "The end date must be in the future.";
  return "";
}

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
      return res.status(400).json({
        success: false,
        message: "title, startDate, endDate required",
      });
    }

    const dateError = validateCampaignDates(startDate, endDate);
    if (dateError) {
      return res.status(400).json({ success: false, message: dateError });
    }

    const campaign = await Campaign.create({
      title: String(title).trim().slice(0, 150),
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
    const existing = await Campaign.findById(req.params.id);
    if (!existing)
      return res.status(404).json({ success: false, message: "Not found" });

    // Whitelist + validate instead of writing the raw body through
    const allowed = [
      "title",
      "description",
      "imageUrl",
      "ctaText",
      "ctaLink",
      "packageId",
      "startDate",
      "endDate",
      "isActive",
    ];
    const updates = {};
    allowed.forEach((k) => {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    });

    const nextStart = updates.startDate ?? existing.startDate;
    const nextEnd = updates.endDate ?? existing.endDate;
    const dateError = validateCampaignDates(nextStart, nextEnd, {
      requireFuture: false,
    });
    if (dateError) {
      return res.status(400).json({ success: false, message: dateError });
    }
    if (updates.startDate) updates.startDate = new Date(updates.startDate);
    if (updates.endDate) updates.endDate = new Date(updates.endDate);

    const campaign = await Campaign.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });
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
