const express = require("express");
const router = express.Router();
const {
  register,
  login,
  getMe,
  signupSendOtp,
  signupVerifyOtp,
  loginSendOtp,
  loginVerifyOtp,
} = require("../controllers/authController");
const { protect } = require("../middleware/authMiddleware");

// Legacy email/password (used by admin web panel)
router.post("/register", register);
router.post("/login", login);

// OTP-based auth (mobile app)
router.post("/signup/send-otp", signupSendOtp);
router.post("/signup/verify-otp", signupVerifyOtp);
router.post("/login/send-otp", loginSendOtp);
router.post("/login/verify-otp", loginVerifyOtp);

// Session
router.get("/me", protect, getMe);

module.exports = router;
