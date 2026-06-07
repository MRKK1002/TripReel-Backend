const express = require("express");
const router = express.Router();
const {
  register,
  login,
  getMe,
  updateProfile,
} = require("../controllers/operatorAuthController");
const { operatorProtect } = require("../middleware/operatorAuthMiddleware");

// Public routes
router.post("/register", register);
router.post("/login", login);

// Protected routes
router.get("/me", operatorProtect, getMe);
router.patch("/profile", operatorProtect, updateProfile);

// Operator FCM token registration
router.post("/register-fcm", operatorProtect, async (req, res) => {
  try {
    const { Operator } = require("../models/Operator");
    const { fcmToken } = req.body;
    if (!fcmToken)
      return res
        .status(400)
        .json({ success: false, message: "fcmToken required" });
    await Operator.findByIdAndUpdate(req.operator._id, { fcmToken });
    res.json({ success: true, message: "Token registered" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Operator profile photo upload
const upload = require("../middleware/uploadMiddleware");
router.post(
  "/profile-photo",
  operatorProtect,
  upload.single("photo"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, message: "Photo file required" });
      }
      const { Operator } = require("../models/Operator");
      const photoPath = "/uploads/" + req.file.filename;
      const operator = await Operator.findByIdAndUpdate(
        req.operator._id,
        { profilePhoto: photoPath },
        { new: true },
      );
      res.json({ success: true, profilePhoto: photoPath, operator });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

module.exports = router;
