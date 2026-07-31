const express = require("express");
const router = express.Router();
const { recordIntent } = require("../controllers/bookingIntentController");
const { protect } = require("../middleware/authMiddleware");

// Record that the logged-in user reached the booking screen for a package
router.post("/", protect, recordIntent);

module.exports = router;
