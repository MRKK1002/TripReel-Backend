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
const OTP_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const OTP_RATE_LIMIT_MAX = 3; // max OTP requests per phone per window

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
    const country = (req.body.country || "India").trim();

    if (!name || !email || !phone) {
      return res.status(400).json({
        success: false,
        message: "Name, email and phone are required",
      });
    }

    // Server-side email validation (TLD must be 2+ letters, no double dots)
    const emailRe =
      /^[a-zA-Z0-9](?:[a-zA-Z0-9._%+-]*[a-zA-Z0-9])?@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
    if (!emailRe.test(email) || email.includes("..")) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address",
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

    // Rate limit: max 3 OTP requests per phone in 5 minutes
    const recentOtps = await Otp.countDocuments({
      phone,
      createdAt: { $gte: new Date(Date.now() - OTP_RATE_LIMIT_WINDOW_MS) },
    });
    if (recentOtps >= OTP_RATE_LIMIT_MAX) {
      return res.status(429).json({
        success: false,
        message:
          "Too many OTP requests. Please wait 5 minutes before trying again.",
      });
    }

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await Otp.create({
      phone,
      code,
      purpose: "signup",
      payload: { name, email, state, country },
      expiresAt,
    });

    // OTP delivery: In production, send via DLT SMS. In dev, logged to console.
    console.log(`[DEV] Signup OTP for ${phone}: ${code}`);
    const response = {
      success: true,
      message: "OTP sent successfully",
      expiresIn: OTP_TTL_MINUTES * 60,
    };
    // Only include OTP in response during testing (set OTP_DEV_MODE=true in .env)
    if (process.env.OTP_DEV_MODE === "true") response.otp = code;
    res.json(response);
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
    const { name, email, state, country } = record.payload || {};
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

    const user = await User.create({
      name,
      email,
      phone,
      state: state || "",
      country: country || "India",
    });
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

    // Rate limit: max 3 OTP requests per phone in 5 minutes
    const recentOtps = await Otp.countDocuments({
      phone,
      createdAt: { $gte: new Date(Date.now() - OTP_RATE_LIMIT_WINDOW_MS) },
    });
    if (recentOtps >= OTP_RATE_LIMIT_MAX) {
      return res.status(429).json({
        success: false,
        message:
          "Too many OTP requests. Please wait 5 minutes before trying again.",
      });
    }

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await Otp.create({ phone, code, purpose: "login", expiresAt });

    // OTP delivery: In production, send via DLT SMS. In dev, logged to console.
    console.log(`[DEV] Login OTP for ${phone}: ${code}`);
    const response = {
      success: true,
      message: "OTP sent successfully",
      expiresIn: OTP_TTL_MINUTES * 60,
    };
    if (process.env.OTP_DEV_MODE === "true") response.otp = code;
    res.json(response);
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
    const { name, state, country } = req.body;
    const update = {};

    if (name && name.trim()) update.name = name.trim();
    if (typeof state !== "undefined") update.state = (state || "").trim();
    if (typeof country !== "undefined")
      update.country = (country || "India").trim();

    // Email and phone are identity fields — cannot be changed without re-verification.
    // Exception: Google users can SET phone once (it starts empty).
    const { phone } = req.body;
    if (phone && String(phone).trim()) {
      const currentUser = await User.findById(req.user.id).select("phone");
      if (!currentUser.phone) {
        // First-time phone setup (Google user) — allow it
        const p = String(phone).replace(/\D/g, "").trim();
        if (p.length === 10) {
          const conflict = await User.findOne({
            phone: p,
            _id: { $ne: req.user.id },
          });
          if (conflict) {
            return res.status(400).json({
              success: false,
              message:
                "This phone number is already linked to another account.",
            });
          }
          update.phone = p;
        }
      }
      // If phone already exists, silently ignore (locked)
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

// PATCH /api/admin/users/:id/suspend — admin toggles user active status
exports.adminToggleUserSuspend = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    user.status = user.status === "Suspended" ? "Active" : "Suspended";
    await user.save();
    res.json({ success: true, message: `User ${user.status}`, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Google Sign-In (mobile app)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/auth/google
// Body: { idToken }
// Verifies the Google ID token, creates/finds user, returns JWT
exports.googleLogin = async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      return res
        .status(400)
        .json({ success: false, message: "idToken is required" });
    }

    // Verify the Google ID token using Google's tokeninfo endpoint
    const googleRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
    );
    const payload = await googleRes.json();

    if (!googleRes.ok || !payload.email) {
      return res.status(401).json({
        success: false,
        message: "Invalid Google token",
      });
    }

    // Verify the token was issued for our app
    const expectedAudience = process.env.GOOGLE_WEB_CLIENT_ID;
    if (expectedAudience && payload.aud !== expectedAudience) {
      return res.status(401).json({
        success: false,
        message: "Token not intended for this application",
      });
    }

    const { email, name, picture, sub: googleId } = payload;

    // Find existing user by email or googleId
    let user = await User.findOne({
      $or: [{ email: email.toLowerCase() }, { googleId }],
    });

    if (user) {
      // Link Google account if not already linked
      if (!user.googleId) {
        user.googleId = googleId;
        if (!user.profileImage && picture) user.profileImage = picture;
        await user.save();
      }

      if (user.status === "Suspended") {
        return res.status(403).json({
          success: false,
          message: "Your account has been suspended",
        });
      }
    } else {
      // Create new user from Google profile
      user = await User.create({
        name: name || "User",
        email: email.toLowerCase(),
        googleId,
        profileImage: picture || "",
        // phone left undefined — sparse unique index skips null/undefined
        status: "Active",
      });
    }

    const token = signToken(user._id);
    res.json({
      success: true,
      token,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        profileImage: user.profileImage,
        state: user.state,
        country: user.country,
      },
      isNewUser: !user.phone, // hint to app: show "add phone" prompt if no phone
    });
  } catch (err) {
    console.error("Google login error:", err.message);
    res.status(500).json({ success: false, message: "Google sign-in failed" });
  }
};
