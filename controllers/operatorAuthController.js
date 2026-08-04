const jwt = require("jsonwebtoken");
const { Operator } = require("../models/Operator");
const {
  collapseSpaces,
  validatePersonName,
  validateEmail,
  validatePhoneIN,
  validatePassword,
  validateUpi,
  validateBounded,
  validatePlaceName,
  validateDestinations,
  firstError,
  LIMITS,
} = require("../utils/validators");

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

// POST /api/operators/auth/register
exports.register = async (req, res) => {
  try {
    let { contactName, email, phone, password } = req.body;

    // Normalize
    contactName = collapseSpaces(contactName);
    email = (email || "").trim().toLowerCase();
    phone = (phone || "").trim().replace(/\D/g, "");

    // ── Validate every field server-side (client rules can be bypassed) ────
    const bad = firstError({
      contactName: validatePersonName(contactName, "Full name"),
      email: validateEmail(email),
      phone: validatePhoneIN(phone),
      password: validatePassword(password),
    });
    if (bad) {
      return res
        .status(400)
        .json({ success: false, field: bad.field, message: bad.message });
    }

    // Reject if email OR phone already belongs to another operator
    const orConditions = [{ email }];
    if (phone) orConditions.push({ phone });
    const existing = await Operator.findOne({ $or: orConditions });
    if (existing) {
      const reason = existing.email === email ? "email" : "phone number";
      return res.status(400).json({
        success: false,
        message:
          reason === "email"
            ? "An account with this email already exists. Please sign in or use a different email address."
            : "An account with this phone number already exists. Please sign in or use a different number.",
      });
    }

    // ── Require BOTH phone and email to be verified via OTP ──────────────────
    const otpStore = require("../utils/otpStore");
    if (!otpStore.isVerified("phone", phone)) {
      return res.status(400).json({
        success: false,
        field: "phone",
        message: "Please verify your phone number before creating an account.",
      });
    }
    if (!otpStore.isVerified("email", email)) {
      return res.status(400).json({
        success: false,
        field: "email",
        message: "Please verify your email before creating an account.",
      });
    }

    const operator = await Operator.create({
      contactName,
      email,
      phone,
      password,
      phoneVerified: true,
      emailVerified: true,
    });

    // Consume the verification markers
    otpStore.clearVerified("phone", phone);
    otpStore.clearVerified("email", email);
    const token = signToken(operator._id);

    res.status(201).json({
      success: true,
      token,
      operator: {
        _id: operator._id,
        contactName: operator.contactName,
        email: operator.email,
        phone: operator.phone,
        onboardingState: operator.onboardingState,
      },
    });
  } catch (err) {
    // Race-safe: duplicate key (unique email index) hit between check and create
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "An operator account with this email or phone already exists.",
      });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/operators/auth/login
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "Email and password are required" });
    }

    const operator = await Operator.findOne({ email }).select("+password");
    if (!operator || !(await operator.comparePassword(password))) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password" });
    }

    const token = signToken(operator._id);

    // Return full operator data (exclude password + payout identifiers, which
    // the client never needs and which used to be persisted to localStorage)
    const fullOperator = await Operator.findById(operator._id).select(
      "-razorpayContactId -razorpayFundAccountId -razorpayFundFingerprint",
    );

    res.json({
      success: true,
      token,
      operator: fullOperator,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/operators/auth/me  (protected by operatorProtect)
exports.getMe = async (req, res) => {
  try {
    // Only return fields needed by the frontend — never expose bank details,
    // razorpay IDs, or document file paths in the client response.
    const operator = await Operator.findById(req.operator._id).select(
      "-accountNumber -ifscCode -upiId -razorpayContactId -razorpayFundAccountId -razorpayFundFingerprint -password",
    );
    if (!operator) {
      return res
        .status(404)
        .json({ success: false, message: "Operator not found" });
    }

    // Sign the operator's own KYC doc paths so they can view them (onboarding
    // correction flow) without the files being publicly downloadable.
    const { toSignedUrl } = require("../utils/signedDocUrl");
    const op = operator.toObject();
    for (const field of [
      "governmentId",
      "selfieVerification",
      "panCardPath",
      "tradeLicensePath",
    ]) {
      if (op[field]) op[field] = toSignedUrl(op[field]);
    }

    res.json({ success: true, operator: op });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /api/operators/auth/profile — operator updates their own profile
exports.updateProfile = async (req, res) => {
  try {
    const allowedFields = [
      "contactName",
      "phone",
      "businessName",
      "businessType",
      "city",
      "state",
      "country",
      "mainOperatingDestinations",
      "upiId",
    ];

    const updates = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    // Handle mainOperatingDestinations as comma-separated string → array
    if (typeof updates.mainOperatingDestinations === "string") {
      updates.mainOperatingDestinations = updates.mainOperatingDestinations
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    // ── Validate only the fields actually being changed ────────────────────
    const checks = {};
    if (updates.contactName !== undefined) {
      updates.contactName = collapseSpaces(updates.contactName);
      checks.contactName = validatePersonName(updates.contactName, "Full name");
    }
    if (updates.phone !== undefined) {
      updates.phone = String(updates.phone).replace(/\D/g, "");
      checks.phone = validatePhoneIN(updates.phone);
    }
    if (updates.businessName !== undefined) {
      updates.businessName = collapseSpaces(updates.businessName);
      checks.businessName = validateBounded(
        updates.businessName,
        "Business name",
        2,
        LIMITS.BUSINESS_NAME_MAX,
        { required: false },
      );
    }
    if (updates.businessType !== undefined) {
      const allowedTypes = [
        "INDIVIDUAL_GUIDE",
        "TOUR_OPERATOR",
        "TRAVEL_AGENCY",
        "EXPERIENCE_HOST",
        "",
      ];
      checks.businessType = allowedTypes.includes(updates.businessType)
        ? ""
        : "Please select a valid business type.";
    }
    if (updates.city !== undefined)
      checks.city = validatePlaceName(updates.city, "City");
    if (updates.state !== undefined)
      checks.state = validatePlaceName(updates.state, "State");
    if (updates.country !== undefined)
      checks.country = validatePlaceName(updates.country, "Country");
    if (updates.mainOperatingDestinations !== undefined)
      checks.mainOperatingDestinations = validateDestinations(
        updates.mainOperatingDestinations,
      );
    if (updates.upiId !== undefined) {
      updates.upiId = String(updates.upiId).trim();
      checks.upiId = validateUpi(updates.upiId, { required: false });
    }

    const bad = firstError(checks);
    if (bad) {
      return res
        .status(400)
        .json({ success: false, field: bad.field, message: bad.message });
    }

    // Changing the UPI ID changes where money goes — stamp it so the wallet can
    // apply its cooling-off window, and drop the cached RazorpayX fund account.
    if (updates.upiId !== undefined) {
      const current = await Operator.findById(req.operator._id).select("upiId");
      if ((current?.upiId || "") !== updates.upiId) {
        updates.payoutDetailsChangedAt = new Date();
        updates.razorpayFundAccountId = "";
        updates.razorpayFundFingerprint = "";
      }
    }

    const operator = await Operator.findByIdAndUpdate(
      req.operator._id,
      updates,
      { new: true, runValidators: true },
    );

    if (!operator) {
      return res
        .status(404)
        .json({ success: false, message: "Operator not found" });
    }

    res.json({ success: true, operator });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// ── OTP Verification (phone + email) — used by registration & forgot password ──
const otpStore = require("../utils/otpStore");
const { sendOtpSms } = require("../utils/sendSms");

// Send an OTP to phone (SMS) or email
async function sendOtpToChannel(channel, value) {
  const otp = otpStore.setOtp(channel, value);
  if (channel === "phone") {
    await sendOtpSms(value, otp);
  } else if (channel === "email") {
    const { sendMail } = require("../utils/sendMail");
    await sendMail({
      to: value,
      subject: "Trip Reel - Verification Code",
      text: `Your Trip Reel verification code is: ${otp}\n\nValid for 10 minutes. Never share this code.`,
      html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px;">
        <h2 style="color:#1F8A70;">Verification Code</h2>
        <p>Your code is:</p>
        <div style="background:#F3F4F6;border-radius:8px;padding:16px;text-align:center;margin:16px 0;">
          <span style="font-size:28px;font-weight:700;letter-spacing:6px;color:#111827;">${otp}</span>
        </div>
        <p style="color:#6B7280;font-size:13px;">Valid for 10 minutes. Never share this code.</p>
      </div>`,
    });
  }
  return otp;
}

// POST /api/operators/auth/send-otp
// Body: { channel: 'phone'|'email', value }
// Used during registration to verify the operator owns the phone/email.
exports.sendOtp = async (req, res) => {
  try {
    const { channel, value } = req.body;
    if (!["phone", "email"].includes(channel) || !value) {
      return res
        .status(400)
        .json({ success: false, message: "channel and value are required" });
    }

    // Validate the value format
    if (channel === "phone") {
      const err = validatePhoneIN(value);
      if (err) return res.status(400).json({ success: false, message: err });
    } else {
      const err = validateEmail(value);
      if (err) return res.status(400).json({ success: false, message: err });
    }

    // Reject if this phone/email already belongs to an existing operator
    const query =
      channel === "phone"
        ? { phone: String(value).replace(/\D/g, "") }
        : { email: String(value).trim().toLowerCase() };
    const existing = await Operator.findOne(query);
    if (existing) {
      return res.status(400).json({
        success: false,
        message: `This ${channel === "phone" ? "phone number" : "email"} is already registered. Please sign in instead.`,
      });
    }

    // Enforce resend cooldown + per-target rate limit
    const gate = otpStore.canSendOtp(channel, value);
    if (!gate.ok) {
      return res.status(429).json({ success: false, message: gate.reason });
    }

    await sendOtpToChannel(channel, value);
    res.json({
      success: true,
      message: `OTP sent to your ${channel === "phone" ? "phone" : "email"}.`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/operators/auth/verify-otp
// Body: { channel, value, otp }
exports.verifyOtp = async (req, res) => {
  try {
    const { channel, value, otp } = req.body;
    if (!["phone", "email"].includes(channel) || !value || !otp) {
      return res.status(400).json({
        success: false,
        message: "channel, value, and otp are required",
      });
    }
    const result = otpStore.verifyOtp(channel, value, otp);
    if (!result.ok) {
      return res.status(400).json({ success: false, message: result.reason });
    }
    res.json({ success: true, message: "Verified successfully." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Forgot Password — send OTP to phone OR email of an existing operator ───────

// POST /api/operators/auth/forgot-password
// Body: { method: 'phone'|'email', value }  (value optional if account lookup by either)
exports.forgotPassword = async (req, res) => {
  try {
    const { method, value } = req.body;
    if (!["phone", "email"].includes(method) || !value) {
      return res.status(400).json({
        success: false,
        message: "Please choose phone or email and provide the value.",
      });
    }

    const query =
      method === "phone"
        ? { phone: String(value).replace(/\D/g, "") }
        : { email: String(value).trim().toLowerCase() };
    const operator = await Operator.findOne(query);

    // Don't reveal whether the account exists — always respond success
    if (!operator) {
      return res.json({
        success: true,
        message: `If an account exists, an OTP has been sent to your ${method}.`,
      });
    }

    const target = method === "phone" ? operator.phone : operator.email;

    // Enforce resend cooldown + per-target rate limit
    const gate = otpStore.canSendOtp(method, target);
    if (!gate.ok) {
      return res.status(429).json({ success: false, message: gate.reason });
    }

    await sendOtpToChannel(method, target);

    res.json({
      success: true,
      message: `An OTP has been sent to your ${method}.`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/operators/auth/reset-password
// Body: { method, value, otp, newPassword }
exports.resetPassword = async (req, res) => {
  try {
    const { method, value, otp, newPassword } = req.body;
    if (
      !["phone", "email"].includes(method) ||
      !value ||
      !otp ||
      !newPassword
    ) {
      return res.status(400).json({
        success: false,
        message: "method, value, OTP, and new password are required",
      });
    }

    // Verify the OTP for the chosen channel
    const result = otpStore.verifyOtp(method, value, otp);
    if (!result.ok) {
      return res.status(400).json({ success: false, message: result.reason });
    }

    // Validate the new password
    const pwdErr = validatePassword(newPassword);
    if (pwdErr) {
      return res.status(400).json({ success: false, message: pwdErr });
    }

    const query =
      method === "phone"
        ? { phone: String(value).replace(/\D/g, "") }
        : { email: String(value).trim().toLowerCase() };
    const operator = await Operator.findOne(query).select("+password");
    if (!operator) {
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });
    }

    operator.password = newPassword; // pre-save hook hashes it
    await operator.save();
    otpStore.clearVerified(method, value);

    res.json({ success: true, message: "Password reset successfully." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
