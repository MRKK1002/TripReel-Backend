const express = require("express");
const router = express.Router();
const {
  recordIntent,
  getIntentById,
} = require("../controllers/bookingIntentController");
const { protect } = require("../middleware/authMiddleware");

// Record that the logged-in user reached the booking screen for a package
router.post("/", protect, recordIntent);

// Fetch a single intent (resume / pre-fill the booking screen)
router.get("/:id", protect, getIntentById);

module.exports = router;
