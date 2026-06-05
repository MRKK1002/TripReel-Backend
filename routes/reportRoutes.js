const express = require("express");
const router = express.Router();
const {
  createReport,
  getMyReports,
  getAllReports,
  updateReport,
} = require("../controllers/reportController");
const { protect, restrictTo } = require("../middleware/authMiddleware");

router.use(protect);
router.post("/", createReport);
router.get("/my", getMyReports);
router.get("/", restrictTo("admin"), getAllReports);
router.patch("/:id", restrictTo("admin"), updateReport);

module.exports = router;
