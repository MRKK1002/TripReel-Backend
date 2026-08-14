const express = require("express");
const router = express.Router();
const { protect, restrictTo } = require("../middleware/authMiddleware");
const AuditLog = require("../models/AuditLog");
const escapeRegex = require("../utils/escapeRegex");

// Admin-only: view the audit log
router.use(protect, restrictTo("admin"));

// GET /api/audit?action=refund_issued&targetRef=TR-BKG-001&page=1&limit=50
router.get("/", async (req, res) => {
  try {
    const {
      action,
      targetRef,
      actorType,
      targetType,
      search,
      page = 1,
      limit = 50,
    } = req.query;
    const query = {};
    if (action) query.action = action;
    if (actorType) query.actorType = actorType;
    if (targetType) query.targetType = targetType;
    if (targetRef)
      query.targetRef = {
        $regex: escapeRegex(String(targetRef)),
        $options: "i",
      };
    if (search) {
      const safe = escapeRegex(String(search));
      query.$or = [
        { targetRef: { $regex: safe, $options: "i" } },
        { actorName: { $regex: safe, $options: "i" } },
        { action: { $regex: safe, $options: "i" } },
      ];
    }
    const skip = (Number(page) - 1) * Number(limit);
    const [logs, total] = await Promise.all([
      AuditLog.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      AuditLog.countDocuments(query),
    ]);
    res.json({ success: true, total, page: Number(page), logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
