const express = require("express");
const router = express.Router();
const { recordView } = require("../controllers/packageViewController");
const { protect } = require("../middleware/authMiddleware");

// Record that the logged-in user opened a package detail page
router.post("/", protect, recordView);

module.exports = router;
