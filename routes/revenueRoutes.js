const express = require("express");
const router = express.Router();
const {
  getRevenueDashboard,
  getCancellationReport,
} = require("../controllers/revenueController");
const { protect, restrictTo } = require("../middleware/authMiddleware");

router.use(protect, restrictTo("admin"));
router.get("/dashboard", getRevenueDashboard);
router.get("/cancellations", getCancellationReport);

module.exports = router;
