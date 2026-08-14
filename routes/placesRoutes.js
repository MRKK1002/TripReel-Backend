const express = require("express");
const router = express.Router();
const { autocomplete, details } = require("../controllers/placesController");
const { protect } = require("../middleware/authMiddleware");

// Logged-in users only — proxies Google Places (key stays server-side)
router.get("/autocomplete", protect, autocomplete);
router.get("/details", protect, details);

module.exports = router;
