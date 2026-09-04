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
  phoneLinkSendOtp,
  phoneLinkVerify,
  sendDeleteOtp,
  confirmDeleteAccount,
} = require("../controllers/authController");
const {
  phoneChangeStart,
  phoneChangeVerifyCurrent,
  phoneChangeSendNewOtp,
  phoneChangeConfirm,
  emailChangeStart,
  emailChangeVerifyCurrent,
  emailChangeSendNewOtp,
  emailChangeConfirm,
} = require("../controllers/contactChangeController");
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

// Authenticated phone linking (never reuses signup identity inputs)
router.post("/phone-link/send-otp", protect, phoneLinkSendOtp);
router.post("/phone-link/verify", protect, phoneLinkVerify);

// Changing a verified contact detail. The current value must be proven before a
// new one can even be submitted, and the new one is then verified in turn.
router.post("/phone-change/start", protect, phoneChangeStart);
router.post("/phone-change/verify-current", protect, phoneChangeVerifyCurrent);
router.post("/phone-change/send-new-otp", protect, phoneChangeSendNewOtp);
router.post("/phone-change/confirm", protect, phoneChangeConfirm);

router.post("/email-change/start", protect, emailChangeStart);
router.post("/email-change/verify-current", protect, emailChangeVerifyCurrent);
router.post("/email-change/send-new-otp", protect, emailChangeSendNewOtp);
router.post("/email-change/confirm", protect, emailChangeConfirm);

// Account deletion (DPDP) — OTP-confirmed, erases personal data
router.post("/delete-account/send-otp", protect, sendDeleteOtp);
router.post("/delete-account/confirm", protect, confirmDeleteAccount);

module.exports = router;
