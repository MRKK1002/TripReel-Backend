// ─────────────────────────────────────────────────────────────────────────────
// Verified contact change — phone and email.
//
// A signed-in user may only replace a contact detail by proving BOTH ends:
//
//   1. start              → code sent to the CURRENT contact on file
//   2. verify-current     → returns a single-use changeToken
//   3. send-new-otp       → code sent to the NEW contact (needs changeToken)
//   4. confirm            → commits the change (needs changeToken + code)
//
// The new value is never written unless step 2 succeeded, and a value already
// linked to another account is rejected at step 3 AND again at step 4, with the
// unique index as the final backstop against a race.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require("crypto");
const User = require("../models/User");
const Otp = require("../models/Otp");

const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 30;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX = 3;
// A proven current contact is only good for a short window.
const GRANT_TTL_MINUTES = 10;

const PHONE_CHANGE = "phone_change";
const EMAIL_CHANGE = "email_change";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Small helpers ────────────────────────────────────────────────────────────

const generateOtp = () => String(crypto.randomInt(100000, 1000000));

const normalizeIndianPhone = (value) => {
  let phone = String(value || "").replace(/\D/g, "");
  if (phone.length === 12 && phone.startsWith("91")) phone = phone.slice(2);
  if (phone.length === 11 && phone.startsWith("0")) phone = phone.slice(1);
  return /^\d{10}$/.test(phone) ? phone : null;
};

const normalizeEmail = (value) => {
  const email = String(value || "")
    .trim()
    .toLowerCase();
  return EMAIL_RE.test(email) && email.length <= 254 ? email : null;
};

const secret = () =>
  process.env.PHONE_LINK_OTP_SECRET || process.env.JWT_SECRET;

const hashCode = ({ purpose, challengeId, userId, target, code }) => {
  if (!secret()) throw new Error("OTP secret is not configured");
  return crypto
    .createHmac("sha256", secret())
    .update(`${purpose}:${userId}:${target}:${challengeId}:${code}`)
    .digest("hex");
};

const hashToken = (token) =>
  crypto.createHmac("sha256", secret()).update(String(token)).digest("hex");

const constantTimeHashEqual = (expectedHex, actualHex) => {
  const expected = Buffer.alloc(32);
  const decoded = Buffer.from(String(expectedHex || ""), "hex");
  decoded.copy(expected, 0, 0, Math.min(decoded.length, expected.length));
  const actual = Buffer.from(String(actualHex || ""), "hex");
  return (
    decoded.length === expected.length &&
    actual.length === expected.length &&
    crypto.timingSafeEqual(expected, actual)
  );
};

const invalidChallenge = (res) =>
  res.status(400).json({
    success: false,
    message: "This verification session is invalid or has expired.",
  });

// Masked so the app can say where the code went without exposing the value.
const maskPhone = (phone) =>
  phone ? `••••••${String(phone).slice(-4)}` : null;

const maskEmail = (email) => {
  const [name, domain] = String(email || "").split("@");
  if (!name || !domain) return null;
  const head = name.slice(0, Math.min(2, name.length));
  return `${head}${"•".repeat(Math.max(1, name.length - head.length))}@${domain}`;
};

// ── Delivery ─────────────────────────────────────────────────────────────────

const deliverPhoneCode = async (phone, code) => {
  const { sendOtpSms } = require("../utils/sendSms");
  try {
    const result = await sendOtpSms(phone, code);
    return Boolean(result?.success);
  } catch {
    return false;
  }
};

const deliverEmailCode = async (email, code, heading) => {
  const { sendMail } = require("../utils/sendMail");
  try {
    await sendMail({
      to: email,
      subject: `${code} is your Trip Reel verification code`,
      text: `${heading}\n\nYour verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.\n\nIf you did not request this, ignore this email.`,
      html: `<h2 style="margin:0 0 12px;color:#0F172A;">${heading}</h2>
        <p style="color:#374151;font-size:14px;">Use this code to continue:</p>
        <p style="font-size:30px;font-weight:700;letter-spacing:6px;color:#1F8A70;margin:16px 0;">${code}</p>
        <p style="color:#6B7280;font-size:12px;">This code expires in ${OTP_TTL_MINUTES} minutes. If you did not request it, you can ignore this email.</p>`,
    });
    return true;
  } catch (error) {
    console.error("[CONTACT_CHANGE] email delivery failed:", error.message);
    return false;
  }
};

const devMode = () => process.env.OTP_DEV_MODE === "true";

// ── Shared guards ────────────────────────────────────────────────────────────

// Is this contact already attached to a DIFFERENT account?
const findOtherOwner = async (field, value, userId) =>
  User.exists({ [field]: value, _id: { $ne: userId } });

const alreadyLinked = (res, kind) =>
  res.status(409).json({
    success: false,
    code: "CONTACT_ALREADY_LINKED",
    message:
      kind === "phone"
        ? "This phone number is already linked to another Trip Reel account. Use a different number, or sign in with that account."
        : "This email address is already linked to another Trip Reel account. Use a different address, or sign in with that account.",
  });

const enforceRateLimit = async ({ purpose, userId, target, targetField }) => {
  const now = new Date();
  const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);
  const [recentForUser, recentForTarget, latest] = await Promise.all([
    Otp.countDocuments({ purpose, userId, createdAt: { $gte: windowStart } }),
    target
      ? Otp.countDocuments({
          purpose,
          [targetField]: target,
          createdAt: { $gte: windowStart },
        })
      : 0,
    Otp.findOne({ purpose, userId })
      .sort({ createdAt: -1 })
      .select("resendAvailableAt"),
  ]);

  if (recentForUser >= RATE_LIMIT_MAX || recentForTarget >= RATE_LIMIT_MAX) {
    return {
      status: 429,
      body: {
        success: false,
        message: "Too many verification requests. Please try again later.",
      },
    };
  }
  if (latest?.resendAvailableAt > now) {
    return {
      status: 429,
      body: {
        success: false,
        message: "Please wait before requesting another verification code.",
        resendAfter: Math.max(
          1,
          Math.ceil(
            (latest.resendAvailableAt.getTime() - now.getTime()) / 1000,
          ),
        ),
      },
    };
  }
  return null;
};

// Load an in-progress flow and check the caller holds a valid grant.
const loadGranted = async ({ purpose, userId, challengeId, changeToken }) => {
  if (!challengeId || !changeToken) return null;
  const challenge = await Otp.findOne({
    challengeId: String(challengeId).trim(),
    userId,
    purpose,
    active: true,
  }).select("+changeTokenHash +codeHash");
  if (!challenge || !challenge.currentVerifiedAt) return null;
  if (challenge.invalidatedAt || challenge.consumedAt) return null;
  const grantExpiry = new Date(
    challenge.currentVerifiedAt.getTime() + GRANT_TTL_MINUTES * 60 * 1000,
  );
  if (grantExpiry <= new Date()) return null;
  if (!constantTimeHashEqual(challenge.changeTokenHash, hashToken(changeToken)))
    return null;
  return challenge;
};

// ── Step 1: start — code to the CURRENT contact ──────────────────────────────

const startChange = async (req, res, kind) => {
  const purpose = kind === "phone" ? PHONE_CHANGE : EMAIL_CHANGE;
  try {
    const user = await User.findById(req.user.id);
    if (!user)
      return res
        .status(401)
        .json({ success: false, message: "Not authorized." });

    // Legacy accounts may have a valid stored phone without phoneVerifiedAt.
    // Sending the current-contact OTP to that exact number proves possession,
    // so only accounts with no current phone need to use the add-phone flow.
    if (kind === "phone" && !user.phone) {
      return res.status(409).json({
        success: false,
        code: "NO_VERIFIED_PHONE",
        message:
          "No phone number is linked yet. Add and verify a phone number first.",
      });
    }
    if (kind === "email" && !user.email) {
      return res.status(409).json({
        success: false,
        message: "No email address is on file for this account.",
      });
    }
    // A Google account signs in with its Google address; changing it here would
    // break that link.
    if (kind === "email" && user.googleId) {
      return res.status(409).json({
        success: false,
        code: "GOOGLE_EMAIL_LOCKED",
        message:
          "This account signs in with Google, so its email address can't be changed here.",
      });
    }

    const target = kind === "phone" ? user.phone : user.email;
    const targetField = kind === "phone" ? "phone" : "email";

    const limited = await enforceRateLimit({
      purpose,
      userId: user._id,
      target,
      targetField,
    });
    if (limited) return res.status(limited.status).json(limited.body);

    const now = new Date();
    // Abandon any earlier attempt so only one flow is ever live.
    await Otp.updateMany(
      { purpose, userId: user._id, active: true },
      { $set: { active: false, invalidatedAt: now } },
    );

    const challengeId = crypto.randomUUID();
    const code = generateOtp();
    const challenge = await Otp.create({
      purpose,
      userId: user._id,
      challengeId,
      stage: "verify_current",
      phone: kind === "phone" ? target : user.phone || undefined,
      email: kind === "email" ? target : undefined,
      codeHash: hashCode({
        purpose,
        challengeId,
        userId: user._id,
        target,
        code,
      }),
      active: true,
      expiresAt: new Date(now.getTime() + OTP_TTL_MINUTES * 60 * 1000),
      resendAvailableAt: new Date(now.getTime() + RESEND_SECONDS * 1000),
    });

    const delivered =
      kind === "phone"
        ? await deliverPhoneCode(target, code)
        : await deliverEmailCode(
            target,
            code,
            "Confirm it's you before changing your email",
          );

    if (!delivered && !devMode()) {
      await Otp.updateOne(
        { _id: challenge._id, active: true },
        { $set: { active: false, invalidatedAt: new Date() } },
      );
      return res.status(503).json({
        success: false,
        message: "Unable to send a verification code. Please try again.",
      });
    }
    if (devMode()) console.log(`[DEV] ${purpose} current-code: ${code}`);

    const response = {
      success: true,
      challengeId,
      stage: "verify_current",
      sentTo: kind === "phone" ? maskPhone(target) : maskEmail(target),
      expiresIn: OTP_TTL_MINUTES * 60,
      resendAfter: RESEND_SECONDS,
    };
    if (devMode()) response.otp = code;
    return res.json(response);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(429).json({
        success: false,
        message: "A verification is already in progress. Please wait a moment.",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Unable to start verification. Please try again.",
    });
  }
};

// ── Step 2: verify-current → issue the grant ─────────────────────────────────

const verifyCurrent = async (req, res, kind) => {
  const purpose = kind === "phone" ? PHONE_CHANGE : EMAIL_CHANGE;
  try {
    const challengeId = String(req.body.challengeId || "").trim();
    const code = String(req.body.code || "").trim();
    if (!challengeId || !code)
      return res.status(400).json({
        success: false,
        message: "Verification code is required.",
      });

    const challenge = await Otp.findOne({
      challengeId,
      userId: req.user.id,
      purpose,
      stage: "verify_current",
      active: true,
    }).select("+codeHash");
    if (!challenge) return invalidChallenge(res);

    const now = new Date();
    if (
      challenge.consumedAt ||
      challenge.invalidatedAt ||
      challenge.expiresAt <= now ||
      challenge.attempts >= OTP_MAX_ATTEMPTS
    )
      return invalidChallenge(res);

    const target = kind === "phone" ? challenge.phone : challenge.email;
    const submitted = hashCode({
      purpose,
      challengeId,
      userId: req.user.id,
      target,
      code,
    });
    if (!constantTimeHashEqual(challenge.codeHash, submitted)) {
      await Otp.updateOne(
        {
          _id: challenge._id,
          active: true,
          attempts: { $lt: OTP_MAX_ATTEMPTS },
        },
        { $inc: { attempts: 1 } },
      );
      return res
        .status(400)
        .json({ success: false, message: "Invalid verification code." });
    }

    const changeToken = crypto.randomUUID();
    const updated = await Otp.findOneAndUpdate(
      { _id: challenge._id, active: true, currentVerifiedAt: null },
      {
        $set: {
          stage: "awaiting_new",
          currentVerifiedAt: now,
          changeTokenHash: hashToken(changeToken),
          attempts: 0,
          codeHash: "",
          expiresAt: new Date(now.getTime() + GRANT_TTL_MINUTES * 60 * 1000),
          resendAvailableAt: now,
        },
      },
      { new: true },
    );
    if (!updated) return invalidChallenge(res);

    return res.json({
      success: true,
      challengeId,
      changeToken,
      stage: "awaiting_new",
      expiresIn: GRANT_TTL_MINUTES * 60,
    });
  } catch {
    return res.status(500).json({
      success: false,
      message: "Unable to verify this code. Please try again.",
    });
  }
};

// ── Step 3: send code to the NEW contact ─────────────────────────────────────

const sendNewOtp = async (req, res, kind) => {
  const purpose = kind === "phone" ? PHONE_CHANGE : EMAIL_CHANGE;
  try {
    const challenge = await loadGranted({
      purpose,
      userId: req.user.id,
      challengeId: req.body.challengeId,
      changeToken: req.body.changeToken,
    });
    if (!challenge) return invalidChallenge(res);

    const user = await User.findById(req.user.id);
    if (!user)
      return res
        .status(401)
        .json({ success: false, message: "Not authorized." });

    const target =
      kind === "phone"
        ? normalizeIndianPhone(req.body.phone)
        : normalizeEmail(req.body.email);
    if (!target)
      return res.status(400).json({
        success: false,
        message:
          kind === "phone"
            ? "Please enter a valid 10-digit phone number."
            : "Please enter a valid email address.",
      });

    const current = kind === "phone" ? user.phone : user.email;
    if (target === current)
      return res.status(400).json({
        success: false,
        message:
          kind === "phone"
            ? "This is already your current phone number."
            : "This is already your current email address.",
      });

    // The new contact must not belong to anyone else.
    if (
      await findOtherOwner(
        kind === "phone" ? "phone" : "email",
        target,
        user._id,
      )
    )
      return alreadyLinked(res, kind);

    const targetField = kind === "phone" ? "phone" : "email";
    const limited = await enforceRateLimit({
      purpose,
      userId: user._id,
      target,
      targetField,
    });
    if (limited) return res.status(limited.status).json(limited.body);

    const now = new Date();
    const code = generateOtp();
    const updated = await Otp.findOneAndUpdate(
      { _id: challenge._id, active: true, currentVerifiedAt: { $ne: null } },
      {
        $set: {
          stage: "verify_new",
          pendingPhone: kind === "phone" ? target : "",
          pendingEmail: kind === "email" ? target : "",
          codeHash: hashCode({
            purpose,
            challengeId: challenge.challengeId,
            userId: user._id,
            target,
            code,
          }),
          attempts: 0,
          expiresAt: new Date(now.getTime() + OTP_TTL_MINUTES * 60 * 1000),
          resendAvailableAt: new Date(now.getTime() + RESEND_SECONDS * 1000),
        },
      },
      { new: true },
    );
    if (!updated) return invalidChallenge(res);

    const delivered =
      kind === "phone"
        ? await deliverPhoneCode(target, code)
        : await deliverEmailCode(target, code, "Verify your new email address");
    if (!delivered && !devMode()) {
      return res.status(503).json({
        success: false,
        message: "Unable to send a verification code. Please try again.",
      });
    }
    if (devMode()) console.log(`[DEV] ${purpose} new-code: ${code}`);

    const response = {
      success: true,
      challengeId: challenge.challengeId,
      stage: "verify_new",
      sentTo: kind === "phone" ? maskPhone(target) : maskEmail(target),
      expiresIn: OTP_TTL_MINUTES * 60,
      resendAfter: RESEND_SECONDS,
    };
    if (devMode()) response.otp = code;
    return res.json(response);
  } catch (error) {
    if (error?.code === 11000) return alreadyLinked(res, kind);
    return res.status(500).json({
      success: false,
      message: "Unable to send a verification code. Please try again.",
    });
  }
};

// ── Step 4: confirm — commit the change ──────────────────────────────────────

const confirmChange = async (req, res, kind) => {
  const purpose = kind === "phone" ? PHONE_CHANGE : EMAIL_CHANGE;
  const { publicUser } = require("./authController");
  try {
    const code = String(req.body.code || "").trim();
    if (!code)
      return res
        .status(400)
        .json({ success: false, message: "Verification code is required." });

    const challenge = await loadGranted({
      purpose,
      userId: req.user.id,
      challengeId: req.body.challengeId,
      changeToken: req.body.changeToken,
    });
    if (!challenge || challenge.stage !== "verify_new")
      return invalidChallenge(res);

    const now = new Date();
    if (
      challenge.expiresAt <= now ||
      challenge.attempts >= OTP_MAX_ATTEMPTS ||
      challenge.consumedAt
    )
      return invalidChallenge(res);

    const target =
      kind === "phone" ? challenge.pendingPhone : challenge.pendingEmail;
    if (!target) return invalidChallenge(res);

    const submitted = hashCode({
      purpose,
      challengeId: challenge.challengeId,
      userId: req.user.id,
      target,
      code,
    });
    if (!constantTimeHashEqual(challenge.codeHash, submitted)) {
      await Otp.updateOne(
        {
          _id: challenge._id,
          active: true,
          attempts: { $lt: OTP_MAX_ATTEMPTS },
        },
        { $inc: { attempts: 1 } },
      );
      return res
        .status(400)
        .json({ success: false, message: "Invalid verification code." });
    }

    // Re-check ownership at commit time — someone may have taken it meanwhile.
    if (
      await findOtherOwner(
        kind === "phone" ? "phone" : "email",
        target,
        req.user.id,
      )
    ) {
      await Otp.updateOne(
        { _id: challenge._id, active: true },
        { $set: { active: false, invalidatedAt: now } },
      );
      return alreadyLinked(res, kind);
    }

    // Burn the challenge first so a replay cannot reuse this code.
    const claimed = await Otp.findOneAndUpdate(
      { _id: challenge._id, active: true, consumedAt: null },
      { $set: { active: false, consumedAt: now } },
      { new: true },
    );
    if (!claimed) return invalidChallenge(res);

    const update =
      kind === "phone"
        ? {
            phone: target,
            phoneVerifiedAt: now,
            phoneVerificationSource: "authenticated_change",
          }
        : {
            email: target,
            emailVerifiedAt: now,
            emailVerificationSource: "authenticated_change",
          };

    let user;
    try {
      user = await User.findByIdAndUpdate(
        req.user.id,
        { $set: update },
        { new: true, runValidators: true },
      ).select("+password");
    } catch (error) {
      // Unique index is the last line of defence against a concurrent claim.
      if (error?.code === 11000) return alreadyLinked(res, kind);
      throw error;
    }
    if (!user)
      return res
        .status(401)
        .json({ success: false, message: "Not authorized." });

    // Tell the previous address, so an unauthorised change is visible. Email
    // only: the SMS sender is bound to a DLT-approved OTP template, so it
    // cannot carry a notice message. Always sent to the account email, which is
    // still valid after a phone change.
    const noticeTo = kind === "email" ? challenge.email : user.email;
    if (noticeTo) {
      const { sendMail } = require("../utils/sendMail");
      const what = kind === "phone" ? "phone number" : "email address";
      const shown = kind === "phone" ? maskPhone(target) : target;
      sendMail({
        to: noticeTo,
        subject: `Your Trip Reel ${what} was changed`,
        text: `The ${what} on your Trip Reel account was changed to ${shown}. If this wasn't you, contact support@tripreel.in immediately.`,
        html: `<h2 style="margin:0 0 12px;color:#0F172A;">Your ${what} was changed</h2>
          <p style="color:#374151;font-size:14px;">Your Trip Reel account ${what} is now <strong>${shown}</strong>.</p>
          <p style="color:#6B7280;font-size:12px;">If you did not make this change, contact support@tripreel.in immediately.</p>`,
      }).catch(() => {});
    }

    return res.json({ success: true, user: publicUser(user) });
  } catch {
    return res.status(500).json({
      success: false,
      message: "Unable to complete the change. Please try again.",
    });
  }
};

// ── Route handlers ───────────────────────────────────────────────────────────

exports.phoneChangeStart = (req, res) => startChange(req, res, "phone");
exports.phoneChangeVerifyCurrent = (req, res) =>
  verifyCurrent(req, res, "phone");
exports.phoneChangeSendNewOtp = (req, res) => sendNewOtp(req, res, "phone");
exports.phoneChangeConfirm = (req, res) => confirmChange(req, res, "phone");

exports.emailChangeStart = (req, res) => startChange(req, res, "email");
exports.emailChangeVerifyCurrent = (req, res) =>
  verifyCurrent(req, res, "email");
exports.emailChangeSendNewOtp = (req, res) => sendNewOtp(req, res, "email");
exports.emailChangeConfirm = (req, res) => confirmChange(req, res, "email");
