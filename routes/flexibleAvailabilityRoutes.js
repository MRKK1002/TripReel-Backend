const express = require("express");
const router = express.Router();
const { operatorProtect } = require("../middleware/operatorAuthMiddleware");
const FlexibleAvailability = require("../models/FlexibleAvailability");
const Package = require("../models/Package");

// ── GET /api/flexible-availability?packageId=xxx — get all for a package (operator)
router.get("/", operatorProtect, async (req, res) => {
  try {
    const { packageId } = req.query;
    if (!packageId) {
      return res
        .status(400)
        .json({ success: false, message: "packageId is required" });
    }
    // Verify operator owns this package
    const pkg = await Package.findById(packageId);
    if (!pkg || String(pkg.operatorId) !== String(req.operator._id)) {
      return res
        .status(403)
        .json({ success: false, message: "Not your package" });
    }
    const items = await FlexibleAvailability.find({ packageId }).sort({
      startDate: 1,
    });
    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/flexible-availability/package/:packageId — public (app uses this)
router.get("/package/:packageId", async (req, res) => {
  try {
    const items = await FlexibleAvailability.find({
      packageId: req.params.packageId,
      isActive: true,
      endDate: { $gte: new Date() },
    }).sort({ startDate: 1 });
    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/flexible-availability — create (operator)
router.post("/", operatorProtect, async (req, res) => {
  try {
    const { packageId, startDate, endDate, adultPrice, childPrice } = req.body;

    if (!packageId || !startDate || !endDate || adultPrice == null) {
      return res.status(400).json({
        success: false,
        message: "packageId, startDate, endDate, and adultPrice are required",
      });
    }

    // Verify ownership
    const pkg = await Package.findById(packageId);
    if (!pkg || String(pkg.operatorId) !== String(req.operator._id)) {
      return res
        .status(403)
        .json({ success: false, message: "Not your package" });
    }

    if (new Date(endDate) <= new Date(startDate)) {
      return res
        .status(400)
        .json({ success: false, message: "endDate must be after startDate" });
    }

    const item = await FlexibleAvailability.create({
      packageId,
      operatorId: req.operator._id,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      adultPrice: Number(adultPrice),
      childPrice: Number(childPrice) || 0,
    });

    res.status(201).json({ success: true, item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/flexible-availability/:id — update (operator)
router.put("/:id", operatorProtect, async (req, res) => {
  try {
    const item = await FlexibleAvailability.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    if (String(item.operatorId) !== String(req.operator._id)) {
      return res
        .status(403)
        .json({ success: false, message: "Not your record" });
    }

    const { startDate, endDate, adultPrice, childPrice, isActive } = req.body;
    if (startDate) item.startDate = new Date(startDate);
    if (endDate) item.endDate = new Date(endDate);
    if (adultPrice != null) item.adultPrice = Number(adultPrice);
    if (childPrice != null) item.childPrice = Number(childPrice);
    if (isActive != null) item.isActive = isActive;

    if (item.endDate <= item.startDate) {
      return res
        .status(400)
        .json({ success: false, message: "endDate must be after startDate" });
    }

    await item.save();
    res.json({ success: true, item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/flexible-availability/:id — delete (operator)
router.delete("/:id", operatorProtect, async (req, res) => {
  try {
    const item = await FlexibleAvailability.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    if (String(item.operatorId) !== String(req.operator._id)) {
      return res
        .status(403)
        .json({ success: false, message: "Not your record" });
    }
    await item.deleteOne();
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
