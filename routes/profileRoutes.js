const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const upload = require("../middleware/uploadMiddleware");
const {
  getMe,
  updateProfile,
  uploadAvatar,
} = require("../controllers/authController");

// All profile routes require a valid user JWT
router.use(protect);

// GET  /api/profile       → return current user's full profile
router.get("/", getMe);

// PATCH /api/profile      → update name / email / phone
router.patch("/", updateProfile);

// POST /api/profile/avatar → upload avatar image (multipart/form-data, field: avatar)
router.post("/avatar", upload.single("avatar"), uploadAvatar);

module.exports = router;
