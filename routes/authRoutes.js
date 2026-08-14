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
  googleLogin,
  sendDeleteOtp,
  confirmDeleteAccount,
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

// Google Sign-In (mobile app)
router.post("/google", googleLogin);

// Session
router.get("/me", protect, getMe);

// Account deletion (DPDP) — OTP-confirmed, erases personal data
router.post("/delete-account/send-otp", protect, sendDeleteOtp);
router.post("/delete-account/confirm", protect, confirmDeleteAccount);

module.exports = router;
