const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Otp = require("../models/Otp");

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

// ── Helpers ──────────────────────────────────────────────────────────────────
const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;

function generateOtp() {
  // 6-digit numeric OTP
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalizePhone(p) {
  return String(p || "")
    .replace(/\D/g, "")
    .trim();
}

function publicUser(user) {
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    avatar: user.avatar,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy email/password endpoints (kept for admin login on the web panel)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/auth/register
exports.register = async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    const existing = await User.findOne({ email });
    if (existing) {
      return res
        .status(400)
        .json({ success: false, message: "Email already in use" });
    }

    const user = await User.create({ name, email, phone, password });
    const token = signToken(user._id);

    res.status(201).json({
      success: true,
      token,
      user: publicUser(user),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/auth/login
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "Email and password are required" });
    }

    const user = await User.findOne({ email }).select("+password");
    if (!user || !(await user.comparePassword(password))) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password" });
    }

    if (user.status === "Suspended") {
      return res
        .status(403)
        .json({ success: false, message: "Your account has been suspended" });
    }

    const token = signToken(user._id);

    res.json({
      success: true,
      token,
      user: publicUser(user),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/auth/me
exports.getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// OTP-based auth (mobile app)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/auth/signup/send-otp
// Body: { name, email, phone, state }
// Returns: { success, otp }   ← OTP returned in response for now (no DLT yet)
exports.signupSendOtp = async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const email = (req.body.email || "").toLowerCase().trim();
    const phone = normalizePhone(req.body.phone);
    const state = (req.body.state || "").trim();

    if (!name || !email || !phone) {
      return res.status(400).json({
        success: false,
        message: "Name, email and phone are required",
      });
    }

    if (phone.length < 10) {
      return res
        .status(400)
        .json({ success: false, message: "Please enter a valid phone number" });
    }

    // Block if a user already exists with this phone or email
    const existing = await User.findOne({ $or: [{ phone }, { email }] });
    if (existing) {
      const reason = existing.phone === phone ? "phone number" : "email";
      return res.status(400).json({
        success: false,
        message: `An account with this ${reason} already exists. Please log in instead.`,
      });
    }

    // Invalidate any older signup OTPs for this phone
    await Otp.deleteMany({ phone, purpose: "signup" });

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await Otp.create({
      phone,
      code,
      purpose: "signup",
      payload: { name, email, state },
      expiresAt,
    });

    // ⚠️ DEV MODE: returning OTP directly. Replace with DLT SMS provider later.
    res.json({
      success: true,
      message: "OTP sent successfully",
      otp: code,
      expiresIn: OTP_TTL_MINUTES * 60,
    });
  } catch (err) {
    // Handle duplicate key gracefully (rare race)
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "An account with this phone or email already exists.",
      });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/auth/signup/verify-otp
// Body: { phone, code }
exports.signupVerifyOtp = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const code = String(req.body.code || "").trim();

    if (!phone || !code) {
      return res
        .status(400)
        .json({ success: false, message: "Phone and OTP are required" });
    }

    const record = await Otp.findOne({ phone, purpose: "signup" });
    if (!record) {
      return res.status(400).json({
        success: false,
        message: "OTP not found. Please request a new one.",
      });
    }

    if (record.expiresAt < new Date()) {
      await record.deleteOne();
      return res.status(400).json({
        success: false,
        message: "OTP has expired. Please request a new one.",
      });
    }

    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      await record.deleteOne();
      return res.status(400).json({
        success: false,
        message: "Too many invalid attempts. Please request a new OTP.",
      });
    }

    if (record.code !== code) {
      record.attempts += 1;
      await record.save();
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    // OTP valid — create the user
    const { name, email, state } = record.payload || {};
    if (!name || !email) {
      await record.deleteOne();
      return res.status(400).json({
        success: false,
        message: "Signup data missing. Please start over.",
      });
    }

    // Final guard against race conditions
    const existing = await User.findOne({ $or: [{ phone }, { email }] });
    if (existing) {
      await record.deleteOne();
      return res.status(400).json({
        success: false,
        message: "An account with this phone or email already exists.",
      });
    }

    const user = await User.create({ name, email, phone, state: state || "" });
    await record.deleteOne();

    const token = signToken(user._id);
    res.status(201).json({
      success: true,
      token,
      user: publicUser(user),
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "An account with this phone or email already exists.",
      });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/auth/login/send-otp
// Body: { phone }
exports.loginSendOtp = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone || phone.length < 10) {
      return res
        .status(400)
        .json({ success: false, message: "Please enter a valid phone number" });
    }

    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "No account found with this phone number. Please sign up.",
      });
    }

    if (user.status === "Suspended") {
      return res
        .status(403)
        .json({ success: false, message: "Your account has been suspended" });
    }

    await Otp.deleteMany({ phone, purpose: "login" });

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await Otp.create({ phone, code, purpose: "login", expiresAt });

    // ⚠️ DEV MODE: returning OTP directly. Replace with DLT SMS provider later.
    res.json({
      success: true,
      message: "OTP sent successfully",
      otp: code,
      expiresIn: OTP_TTL_MINUTES * 60,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/auth/login/verify-otp
// Body: { phone, code }
exports.loginVerifyOtp = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const code = String(req.body.code || "").trim();

    if (!phone || !code) {
      return res
        .status(400)
        .json({ success: false, message: "Phone and OTP are required" });
    }

    const record = await Otp.findOne({ phone, purpose: "login" });
    if (!record) {
      return res.status(400).json({
        success: false,
        message: "OTP not found. Please request a new one.",
      });
    }

    if (record.expiresAt < new Date()) {
      await record.deleteOne();
      return res.status(400).json({
        success: false,
        message: "OTP has expired. Please request a new one.",
      });
    }

    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      await record.deleteOne();
      return res.status(400).json({
        success: false,
        message: "Too many invalid attempts. Please request a new OTP.",
      });
    }

    if (record.code !== code) {
      record.attempts += 1;
      await record.save();
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    const user = await User.findOne({ phone });
    if (!user) {
      await record.deleteOne();
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });
    }

    if (user.status === "Suspended") {
      await record.deleteOne();
      return res
        .status(403)
        .json({ success: false, message: "Your account has been suspended" });
    }

    await record.deleteOne();
    const token = signToken(user._id);

    res.json({
      success: true,
      token,
      user: publicUser(user),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Profile (mobile user self-service)
// ─────────────────────────────────────────────────────────────────────────────

// PATCH /api/profile  — update own name / email / phone / state
exports.updateProfile = async (req, res) => {
  try {
    const { name, email, phone, state } = req.body;
    const update = {};

    if (name && name.trim()) update.name = name.trim();
    if (typeof state !== "undefined") update.state = (state || "").trim();

    if (email && email.trim()) {
      const e = email.trim().toLowerCase();
      const conflict = await User.findOne({
        email: e,
        _id: { $ne: req.user.id },
      });
      if (conflict) {
        return res.status(400).json({
          success: false,
          message: "Email already in use by another account",
        });
      }
      update.email = e;
    }

    if (phone && String(phone).trim()) {
      const p = String(phone).replace(/\D/g, "").trim();
      const conflict = await User.findOne({
        phone: p,
        _id: { $ne: req.user.id },
      });
      if (conflict) {
        return res.status(400).json({
          success: false,
          message: "Phone already in use by another account",
        });
      }
      update.phone = p;
    }

    const user = await User.findByIdAndUpdate(req.user.id, update, {
      new: true,
      runValidators: true,
    });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/profile/avatar  — upload avatar image via multer, store path in DB
exports.uploadAvatar = async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "Image file is required" });
    }
    const avatarPath = "/uploads/" + req.file.filename;
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { avatar: avatarPath },
      { new: true },
    );
    res.json({ success: true, avatar: avatarPath, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
