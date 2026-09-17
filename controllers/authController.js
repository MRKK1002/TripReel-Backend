const crypto = require("crypto");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Otp = require("../models/Otp");
const { syncUploadedFile } = require("../utils/s3Storage");
const { isMasterOtp, logMasterOtpUse } = require("../utils/masterOtp");

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

// ── Helpers ──────────────────────────────────────────────────────────────────
const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const OTP_RATE_LIMIT_MAX = 3; // max OTP requests per phone per window
const PHONE_LINK_RESEND_SECONDS = 30;
const PHONE_LINK_PURPOSE = "phone_link";

function generateOtp() {
  // 6-digit numeric OTP
  return String(crypto.randomInt(100000, 1000000));
}

function normalizePhone(p) {
  return String(p || "")
    .replace(/\D/g, "")
    .trim();
}

function normalizeIndianPhone(p) {
  let phone = normalizePhone(p);
  if (phone.length === 12 && phone.startsWith("91")) phone = phone.slice(2);
  if (phone.length === 11 && phone.startsWith("0")) phone = phone.slice(1);
  return /^\d{10}$/.test(phone) ? phone : null;
}

function hashPhoneLinkCode({ challengeId, userId, phone, code }) {
  const secret = process.env.PHONE_LINK_OTP_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error("Phone-link OTP secret is not configured");
  return crypto
    .createHmac("sha256", secret)
    .update(`${PHONE_LINK_PURPOSE}:${userId}:${phone}:${challengeId}:${code}`)
    .digest("hex");
}

function constantTimeHashEqual(expectedHex, actualHex) {
  const expected = Buffer.alloc(32);
  const decoded = Buffer.from(String(expectedHex || ""), "hex");
  decoded.copy(expected, 0, 0, Math.min(decoded.length, expected.length));
  const actual = Buffer.from(actualHex, "hex");
  return (
    decoded.length === expected.length &&
    actual.length === expected.length &&
    crypto.timingSafeEqual(expected, actual)
  );
}

function phoneLinkError(code) {
  const error = new Error(code);
  error.phoneLinkCode = code;
  return error;
}

function isSameVerifiedPhone(user, phone) {
  return Boolean(user?.phoneVerifiedAt && user.phone === phone);
}

function isTransactionUnsupported(error) {
  return (
    error?.code === 20 ||
    error?.codeName === "IllegalOperation" ||
    /transaction numbers are only allowed|replica set/i.test(
      error?.message || "",
    )
  );
}

async function claimPhoneLinkChallenge(challenge, consumedAt, session) {
  return Otp.findOneAndUpdate(
    {
      _id: challenge._id,
      userId: challenge.userId,
      purpose: PHONE_LINK_PURPOSE,
      phone: challenge.phone,
      active: true,
      consumedAt: null,
      invalidatedAt: null,
      expiresAt: { $gt: consumedAt },
      attempts: { $lt: OTP_MAX_ATTEMPTS },
    },
    { $set: { active: false, consumedAt } },
    { new: true, session },
  );
}

async function updateUserForPhoneLink(userId, phone, verifiedAt, session) {
  return User.findOneAndUpdate(
    { _id: userId, phoneVerifiedAt: null },
    {
      $set: {
        phone,
        phoneVerifiedAt: verifiedAt,
        phoneVerificationSource: "authenticated_link",
      },
    },
    { new: true, runValidators: true, session },
  ).select("+password");
}

async function resolvePhoneLinkOwner(userId, phone, session) {
  const user = await User.findById(userId)
    .session(session || null)
    .select("+password");
  if (isSameVerifiedPhone(user, phone)) return user;
  throw phoneLinkError("PHONE_LINK_CONFLICT");
}

async function commitPhoneLinkInTransaction(challenge, userId) {
  const session = await mongoose.startSession();
  const verifiedAt = new Date();
  try {
    session.startTransaction();
    const claimed = await claimPhoneLinkChallenge(
      challenge,
      verifiedAt,
      session,
    );
    if (!claimed) throw phoneLinkError("INVALID_PHONE_LINK_CHALLENGE");

    let user = await updateUserForPhoneLink(
      userId,
      challenge.phone,
      verifiedAt,
      session,
    );
    if (!user) {
      user = await resolvePhoneLinkOwner(userId, challenge.phone, session);
    }

    await session.commitTransaction();
    return user;
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    if (!isTransactionUnsupported(error)) throw error;
  } finally {
    await session.endSession();
  }

  // Standalone Mongo deployments do not support transactions. Keep both writes
  // individually atomic, and release the challenge claim if the user update fails.
  const claimedAt = new Date();
  const claimed = await claimPhoneLinkChallenge(challenge, claimedAt);
  if (!claimed) throw phoneLinkError("INVALID_PHONE_LINK_CHALLENGE");
  try {
    let user = await updateUserForPhoneLink(userId, challenge.phone, claimedAt);
    if (!user) user = await resolvePhoneLinkOwner(userId, challenge.phone);
    return user;
  } catch (error) {
    await Otp.updateOne(
      { _id: challenge._id, consumedAt: claimedAt, active: false },
      { $set: { active: true }, $unset: { consumedAt: "" } },
    ).catch(() => {});
    throw error;
  }
}

// Exported so the contact-change controller returns an identical user shape.
exports.publicUser = (user) => publicUser(user);

function publicUser(user) {
  const phone = user.phone || null;
  const phoneVerifiedAt = user.phoneVerifiedAt
    ? new Date(user.phoneVerifiedAt).toISOString()
    : null;
  const phoneVerified = Boolean(phone && phoneVerifiedAt);
  const emailVerifiedAt = user.emailVerifiedAt
    ? new Date(user.emailVerifiedAt).toISOString()
    : null;
  const emailVerified = Boolean(user.email && emailVerifiedAt);
  const authProvider = user.googleId
    ? "google"
    : user.password
      ? "password"
      : "otp";

  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    phone,
    role: user.role,
    status: user.status,
    avatar: user.avatar,
    profileImage: user.profileImage,
    state: user.state,
    country: user.country,
    tripsCount: user.tripsCount,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    phoneVerified,
    phoneVerifiedAt,
    emailVerified,
    emailVerifiedAt,
    // A Google account authenticates by its Google address, so that email is
    // not editable in the app.
    emailChangeable: !user.googleId,
    authProvider,
    requiresPhoneCompletion: authProvider === "google" && !phoneVerified,
    verificationStateVersion: 1,
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
    const user = await User.findById(req.user.id).select("+password");
    res.json({ success: true, user: publicUser(user) });
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

    // OTP delivery via RapidSMS (DLT transactional route)
    const { sendOtpSms } = require("../utils/sendSms");
    const smsResult = await sendOtpSms(phone, code);
    if (!smsResult.success && process.env.OTP_DEV_MODE !== "true") {
      console.error(
        `[SIGNUP] SMS delivery failed for ${phone}:`,
        smsResult.reason,
      );
    }
    // Dev fallback log (always — helpful for local testing even when SMS works)
    if (process.env.OTP_DEV_MODE === "true") {
      console.log(`[DEV] Signup OTP for ${phone}: ${code}`);
    }

    const response = {
      success: true,
      message: "OTP sent successfully",
      expiresIn: OTP_TTL_MINUTES * 60,
    };
    // Only include OTP in response during LOCAL TESTING (never in production)
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

    // The master OTP substitutes for the real code only. Expiry and the
    // attempt cap above still apply, and a send-otp request must have created
    // this record, which is what carries the signup payload.
    const masterOtpUsed = isMasterOtp(code);
    if (record.code !== code && !masterOtpUsed) {
      record.attempts += 1;
      await record.save();
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }
    if (masterOtpUsed) logMasterOtpUse("signup", phone);

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
      phoneVerifiedAt: new Date(),
      phoneVerificationSource: "otp_signup",
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

    // OTP delivery via RapidSMS (DLT transactional route)
    const { sendOtpSms } = require("../utils/sendSms");
    const smsResult = await sendOtpSms(phone, code);
    if (!smsResult.success && process.env.OTP_DEV_MODE !== "true") {
      console.error(
        `[LOGIN] SMS delivery failed for ${phone}:`,
        smsResult.reason,
      );
    }
    if (process.env.OTP_DEV_MODE === "true") {
      console.log(`[DEV] Login OTP for ${phone}: ${code}`);
    }

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

    // See the note in signupVerifyOtp: this replaces the code comparison only.
    const masterOtpUsed = isMasterOtp(code);
    if (record.code !== code && !masterOtpUsed) {
      record.attempts += 1;
      await record.save();
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }
    if (masterOtpUsed) logMasterOtpUse("login", phone);

    const user = await User.findOne({ phone }).select("+password");
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

    if (!user.phoneVerifiedAt) {
      user.phoneVerifiedAt = new Date();
      user.phoneVerificationSource = "otp_login";
      await user.save();
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
// Authenticated phone linking
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/auth/phone-link/send-otp (protected)
// Body: { phone }
exports.phoneLinkSendOtp = async (req, res) => {
  try {
    const phone = normalizeIndianPhone(req.body.phone);
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid 10-digit phone number.",
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Not authorized.",
      });
    }
    if (user.phoneVerifiedAt) {
      return res.status(409).json({
        success: false,
        message: "A verified phone is already linked to this account.",
      });
    }

    const phoneOwner = await User.exists({
      phone,
      _id: { $ne: user._id },
    });
    if (phoneOwner) {
      return res.status(409).json({
        success: false,
        message: "This phone number cannot be linked to this account.",
      });
    }

    const now = new Date();
    const windowStart = new Date(now.getTime() - OTP_RATE_LIMIT_WINDOW_MS);
    const [recentForUser, recentForPhone, latestForUser] = await Promise.all([
      Otp.countDocuments({
        purpose: PHONE_LINK_PURPOSE,
        userId: user._id,
        createdAt: { $gte: windowStart },
      }),
      Otp.countDocuments({
        purpose: PHONE_LINK_PURPOSE,
        phone,
        createdAt: { $gte: windowStart },
      }),
      Otp.findOne({ purpose: PHONE_LINK_PURPOSE, userId: user._id })
        .sort({ createdAt: -1 })
        .select("resendAvailableAt"),
    ]);

    if (
      recentForUser >= OTP_RATE_LIMIT_MAX ||
      recentForPhone >= OTP_RATE_LIMIT_MAX
    ) {
      return res.status(429).json({
        success: false,
        message: "Too many verification requests. Please try again later.",
      });
    }

    if (latestForUser?.resendAvailableAt > now) {
      const resendAfter = Math.max(
        1,
        Math.ceil(
          (latestForUser.resendAvailableAt.getTime() - now.getTime()) / 1000,
        ),
      );
      return res.status(429).json({
        success: false,
        message: "Please wait before requesting another verification code.",
        resendAfter,
      });
    }

    await Otp.updateMany(
      {
        purpose: PHONE_LINK_PURPOSE,
        userId: user._id,
        active: true,
      },
      { $set: { active: false, invalidatedAt: now } },
    );

    const challengeId = crypto.randomUUID();
    const code = generateOtp();
    const expiresAt = new Date(now.getTime() + OTP_TTL_MINUTES * 60 * 1000);
    const resendAvailableAt = new Date(
      now.getTime() + PHONE_LINK_RESEND_SECONDS * 1000,
    );
    const codeHash = hashPhoneLinkCode({
      challengeId,
      userId: user._id,
      phone,
      code,
    });

    const challenge = await Otp.create({
      phone,
      purpose: PHONE_LINK_PURPOSE,
      userId: user._id,
      challengeId,
      codeHash,
      active: true,
      expiresAt,
      resendAvailableAt,
    });

    const { sendOtpSms } = require("../utils/sendSms");
    let smsResult;
    try {
      smsResult = await sendOtpSms(phone, code);
    } catch {
      smsResult = { success: false };
    }
    if (!smsResult.success && process.env.OTP_DEV_MODE !== "true") {
      await Otp.updateOne(
        { _id: challenge._id, active: true },
        { $set: { active: false, invalidatedAt: new Date() } },
      );
      console.error("[PHONE_LINK] SMS delivery failed");
      return res.status(503).json({
        success: false,
        message: "Unable to send a verification code. Please try again.",
      });
    }

    if (process.env.OTP_DEV_MODE === "true") {
      console.log(`[DEV] Phone-link OTP for ${phone}: ${code}`);
    }

    const response = {
      success: true,
      challengeId,
      expiresIn: OTP_TTL_MINUTES * 60,
      resendAfter: PHONE_LINK_RESEND_SECONDS,
    };
    if (process.env.OTP_DEV_MODE === "true") response.otp = code;
    return res.json(response);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(429).json({
        success: false,
        message: "Please wait before requesting another verification code.",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Unable to send a verification code. Please try again.",
    });
  }
};

// POST /api/auth/phone-link/verify (protected)
// Body: { challengeId, code }
exports.phoneLinkVerify = async (req, res) => {
  try {
    const challengeId = String(req.body.challengeId || "").trim();
    const code = String(req.body.code || "").trim();
    if (!challengeId || !code) {
      return res.status(400).json({
        success: false,
        message: "Challenge and verification code are required.",
      });
    }

    const challenge = await Otp.findOne({
      challengeId,
      userId: req.user.id,
      purpose: PHONE_LINK_PURPOSE,
    }).select("+codeHash");
    if (!challenge) {
      return res.status(400).json({
        success: false,
        message: "Verification challenge is invalid or expired.",
      });
    }

    const currentUser = await User.findById(req.user.id).select("+password");
    if (challenge.consumedAt) {
      if (isSameVerifiedPhone(currentUser, challenge.phone)) {
        return res.json({ success: true, user: publicUser(currentUser) });
      }
      return res.status(400).json({
        success: false,
        message: "Verification challenge is invalid or expired.",
      });
    }

    const now = new Date();
    if (
      !challenge.active ||
      challenge.invalidatedAt ||
      challenge.expiresAt <= now ||
      challenge.attempts >= OTP_MAX_ATTEMPTS
    ) {
      return res.status(400).json({
        success: false,
        message: "Verification challenge is invalid or expired.",
      });
    }

    const submittedHash = hashPhoneLinkCode({
      challengeId,
      userId: req.user.id,
      phone: challenge.phone,
      code,
    });
    const masterOtpUsed = isMasterOtp(code);
    if (masterOtpUsed) logMasterOtpUse("phone-link", challenge.phone);
    if (
      !masterOtpUsed &&
      !constantTimeHashEqual(challenge.codeHash, submittedHash)
    ) {
      await Otp.updateOne(
        {
          _id: challenge._id,
          active: true,
          consumedAt: null,
          invalidatedAt: null,
          expiresAt: { $gt: now },
          attempts: { $lt: OTP_MAX_ATTEMPTS },
        },
        { $inc: { attempts: 1 } },
      );
      return res.status(400).json({
        success: false,
        message: "Invalid verification code.",
      });
    }

    if (currentUser?.phoneVerifiedAt) {
      if (isSameVerifiedPhone(currentUser, challenge.phone)) {
        await Otp.updateOne(
          { _id: challenge._id, active: true, consumedAt: null },
          { $set: { active: false, consumedAt: now } },
        );
        return res.json({ success: true, user: publicUser(currentUser) });
      }
      await Otp.updateOne(
        { _id: challenge._id, active: true },
        { $set: { active: false, invalidatedAt: now } },
      );
      return res.status(409).json({
        success: false,
        message: "A verified phone is already linked to this account.",
      });
    }

    const user = await commitPhoneLinkInTransaction(challenge, req.user.id);
    return res.json({ success: true, user: publicUser(user) });
  } catch (error) {
    if (
      error?.code === 11000 ||
      error?.phoneLinkCode === "PHONE_LINK_CONFLICT"
    ) {
      return res.status(409).json({
        success: false,
        message: "This phone number cannot be linked to this account.",
      });
    }
    if (error?.phoneLinkCode === "INVALID_PHONE_LINK_CHALLENGE") {
      return res.status(400).json({
        success: false,
        message: "Verification challenge is invalid or expired.",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Unable to verify this phone number. Please try again.",
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Profile (mobile user self-service)
// ─────────────────────────────────────────────────────────────────────────────

// PATCH /api/profile  — update own non-identity profile fields
exports.updateProfile = async (req, res) => {
  try {
    const identityFields = [
      "phone",
      "phoneVerified",
      "phoneVerifiedAt",
      "phoneVerificationSource",
      "verificationSource",
      "source",
    ];
    if (
      identityFields.some((field) =>
        Object.prototype.hasOwnProperty.call(req.body, field),
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Phone identity fields cannot be updated through the profile endpoint.",
      });
    }

    const { name, state, country } = req.body;
    const update = {};

    if (name && name.trim()) update.name = name.trim();
    if (typeof state !== "undefined") update.state = (state || "").trim();
    if (typeof country !== "undefined")
      update.country = (country || "India").trim();

    const user = await User.findByIdAndUpdate(req.user.id, update, {
      new: true,
      runValidators: true,
    }).select("+password");
    res.json({ success: true, user: publicUser(user) });
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
    // uploadMiddleware stores flat in /uploads, and the S3 key mirrors that, so
    // the stored value is unchanged whether or not cloud storage is enabled.
    const avatarPath = await syncUploadedFile(req.file, "");
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { avatar: avatarPath },
      { new: true },
    ).select("+password");
    res.json({
      success: true,
      avatar: avatarPath,
      user: publicUser(user),
    });
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
    }).select("+password");

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
      user: publicUser(user),
      isNewUser: !user.phone, // compatibility hint for the current app
    });
  } catch (err) {
    console.error("Google login error:", err.message);
    res.status(500).json({ success: false, message: "Google sign-in failed" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Account deletion (DPDP compliance) — OTP-confirmed, erases personal data.
// Financial/tax records are retained but anonymized (permitted where required
// by law). Behavioural/personal data is hard-deleted.
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/auth/delete-account/send-otp   (protected)
exports.sendDeleteOtp = async (req, res) => {
  try {
    const user = req.user;
    const phone = normalizePhone(user.phone);
    const email = (user.email || "").toLowerCase();
    const contact = phone || email;
    if (!contact) {
      return res.status(400).json({
        success: false,
        message:
          "No phone or email on file. Please contact support to delete your account.",
      });
    }
    const viaPhone = !!phone;

    await Otp.deleteMany({ phone: contact, purpose: "delete_account" });

    const recent = await Otp.countDocuments({
      phone: contact,
      purpose: "delete_account",
      createdAt: { $gte: new Date(Date.now() - OTP_RATE_LIMIT_WINDOW_MS) },
    });
    if (recent >= OTP_RATE_LIMIT_MAX) {
      return res.status(429).json({
        success: false,
        message: "Too many requests. Please wait 5 minutes and try again.",
      });
    }

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
    await Otp.create({
      phone: contact,
      code,
      purpose: "delete_account",
      expiresAt,
    });

    if (viaPhone) {
      const { sendOtpSms } = require("../utils/sendSms");
      await sendOtpSms(phone, code);
    } else {
      const { sendMail } = require("../utils/sendMail");
      sendMail({
        to: email,
        subject: "Confirm account deletion — Trip Reel",
        text: `Your account deletion code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes. If you didn't request this, ignore this email.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#EF4444;margin-bottom:8px;">Confirm account deletion</h2>
          <p style="color:#374151;">Use this code to permanently delete your Trip Reel account:</p>
          <p style="font-size:28px;font-weight:800;letter-spacing:6px;color:#111827;">${code}</p>
          <p style="color:#6B7280;font-size:13px;">This code expires in ${OTP_TTL_MINUTES} minutes. If you didn't request this, you can safely ignore this email.</p>
        </div>`,
      }).catch(() => {});
    }

    if (process.env.OTP_DEV_MODE === "true") {
      console.log(`[DEV] Delete-account OTP for ${contact}: ${code}`);
    }

    const response = {
      success: true,
      message: "Verification code sent",
      channel: viaPhone ? "phone" : "email",
      expiresIn: OTP_TTL_MINUTES * 60,
    };
    if (process.env.OTP_DEV_MODE === "true") response.otp = code;
    res.json(response);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/auth/delete-account/confirm   (protected)
// Body: { code }
exports.confirmDeleteAccount = async (req, res) => {
  try {
    const user = req.user;
    const code = String(req.body.code || "").trim();
    const phone = normalizePhone(user.phone);
    const email = (user.email || "").toLowerCase();
    const contact = phone || email;

    if (!code) {
      return res
        .status(400)
        .json({ success: false, message: "Verification code is required" });
    }

    // ── Verify the OTP ────────────────────────────────────────────────────────
    const record = await Otp.findOne({
      phone: contact,
      purpose: "delete_account",
    });
    if (!record) {
      return res.status(400).json({
        success: false,
        message: "Code not found. Please request a new one.",
      });
    }
    if (record.expiresAt < new Date()) {
      await record.deleteOne();
      return res.status(400).json({
        success: false,
        message: "Code has expired. Please request a new one.",
      });
    }
    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      await record.deleteOne();
      return res.status(400).json({
        success: false,
        message: "Too many invalid attempts. Please request a new code.",
      });
    }
    if (record.code !== code) {
      record.attempts += 1;
      await record.save();
      return res
        .status(400)
        .json({ success: false, message: "Invalid code. Please try again." });
    }
    await record.deleteOne();

    // ── Guard: block deletion while a trip is in flight ───────────────────────
    const TripBooking = require("../models/TripBooking");
    const now = new Date();
    const activeBooking = await TripBooking.findOne({
      userId: user._id,
      status: { $in: ["CONFIRMED", "PENDING"] },
      "snapshot.startDate": { $gt: now },
    });
    if (activeBooking) {
      return res.status(409).json({
        success: false,
        message:
          "You have an upcoming booking. Please wait until your trip is completed, or cancel it, before deleting your account.",
      });
    }

    // ── Erase personal data + anonymize financial records ─────────────────────
    await eraseUserData(user._id);

    res.json({
      success: true,
      message: "Your account and personal data have been deleted.",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Erase a user's personal/behavioural data and anonymize retained records.
async function eraseUserData(userId) {
  const Review = require("../models/Review");
  const TripBookingModel = require("../models/TripBooking");

  // ── Admin-only archive (compliance / audit retention) ─────────────────────
  // Snapshot the user's details + booking history BEFORE we anonymize, so the
  // admin keeps a reference record. Restricted to admins; not for re-marketing.
  try {
    const DeletedAccountArchive = require("../models/DeletedAccountArchive");
    const u = await User.findById(userId);
    if (u) {
      const bks = await TripBookingModel.find({ userId }).select(
        "bookingId snapshot seats status pricing",
      );
      await DeletedAccountArchive.create({
        userId,
        name: u.name || "",
        email: u.email || "",
        phone: u.phone || "",
        state: u.state || "",
        country: u.country || "",
        memberSince: u.createdAt,
        tripsCount: u.tripsCount || 0,
        bookings: (bks || []).map((b) => ({
          bookingId: b.bookingId,
          packageTitle: b.snapshot?.packageTitle || "",
          startDate: b.snapshot?.startDate,
          endDate: b.snapshot?.endDate,
          seats: b.seats,
          status: b.status,
          totalAmount: b.pricing?.totalAmount || 0,
        })),
        deletedAt: new Date(),
      });
    }
  } catch (e) {
    console.warn("[eraseUserData] archive snapshot failed:", e.message);
  }

  const Wishlist = require("../models/Wishlist");
  const Trip = require("../models/Trip");
  const BookingIntent = require("../models/BookingIntent");
  const PackageView = require("../models/PackageView");
  const PendingOrder = require("../models/PendingOrder");
  const LastSeen = require("../models/LastSeen");
  const Notification = require("../models/Notification");
  const Conversation = require("../models/Conversation");
  const Message = require("../models/Message");
  const TripBooking = require("../models/TripBooking");

  // Reviews — delete, then recalc the affected packages' ratings
  const reviews = await Review.find({ userId }).select("packageId");
  const affected = [...new Set(reviews.map((r) => String(r.packageId)))];
  await Review.deleteMany({ userId });
  try {
    const { recalcPackageRating } = require("./reviewController");
    if (typeof recalcPackageRating === "function") {
      for (const pid of affected) await recalcPackageRating(pid);
    }
  } catch {}

  // Chat — delete this user's conversations + their messages
  try {
    const convs = await Conversation.find({ userId }).select("_id");
    const convIds = convs.map((c) => c._id);
    if (convIds.length)
      await Message.deleteMany({ conversationId: { $in: convIds } });
    await Conversation.deleteMany({ userId });
    await Message.deleteMany({ senderId: userId, senderType: "user" });
  } catch {}

  // Behavioural / personal collections — hard delete
  await Promise.allSettled([
    Wishlist.deleteMany({ user: userId }),
    Trip.deleteMany({ user: userId }),
    BookingIntent.deleteMany({ userId }),
    PackageView.deleteMany({ userId }),
    PendingOrder.deleteMany({ userId }),
    LastSeen.deleteMany({ userId }),
    Notification.deleteMany({ recipientId: userId, recipientType: "user" }),
  ]);

  // Financial records — retained for tax/legal, but PII redacted (DPDP allows
  // retention where required by law). Traveller names are redacted; amounts,
  // dates and GST are kept intact.
  try {
    await TripBooking.updateMany({ userId }, [
      {
        $set: {
          travelers: {
            $map: {
              input: { $ifNull: ["$travelers", []] },
              as: "t",
              in: { name: "Redacted", gender: "$$t.gender", age: "$$t.age" },
            },
          },
        },
      },
    ]);
  } catch {}

  // Anonymize the user record (keeps referential integrity, frees phone/email)
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        name: "Deleted User",
        email: `deleted_${userId}@deleted.tripreel.in`,
        avatar: "",
        profileImage: "",
        googleId: "",
        fcmToken: "",
        status: "Deleted",
        deletedAt: new Date(),
      },
      $unset: { phone: "", password: "" },
    },
  );
}
exports.eraseUserData = eraseUserData;
