/**
 * In-memory OTP store for operator phone/email verification.
 *
 * Used for:
 *   - Registration: verify phone + email before account creation
 *   - Forgot password: verify identity via phone or email
 *
 * Keys are namespaced like "phone:9876543210" or "email:foo@bar.com".
 * OTPs expire in 10 minutes and allow max 5 verify attempts.
 *
 * NOTE: In-memory means OTPs are cleared on server restart. Fine for this flow.
 * For multi-instance deployments, move this to Redis.
 */

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const VERIFIED_TTL_MS = 30 * 60 * 1000; // verified status valid for 30 min
const MAX_ATTEMPTS = 5; // max verify attempts per OTP
const RESEND_COOLDOWN_MS = 30 * 1000; // 30s between resends
const MAX_SENDS_PER_WINDOW = 5; // max 5 OTPs
const SEND_WINDOW_MS = 15 * 60 * 1000; // per 15 min per phone/email

const otps = new Map(); // key -> { otp, expiresAt, attempts }
const verified = new Map(); // key -> expiresAt (proof of recent verification)
const sendLog = new Map(); // key -> { lastSentAt, count, windowStart }

function makeKey(channel, value) {
  return `${channel}:${String(value).trim().toLowerCase()}`;
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Check if a new OTP can be sent (cooldown + per-target limit).
// Returns { ok, reason, retryAfter } — retryAfter in seconds.
function canSendOtp(channel, value) {
  const key = makeKey(channel, value);
  const now = Date.now();
  const log = sendLog.get(key);

  if (log) {
    // Enforce 30s cooldown between resends
    const sinceLast = now - log.lastSentAt;
    if (sinceLast < RESEND_COOLDOWN_MS) {
      return {
        ok: false,
        reason: `Please wait ${Math.ceil((RESEND_COOLDOWN_MS - sinceLast) / 1000)}s before requesting another OTP.`,
        retryAfter: Math.ceil((RESEND_COOLDOWN_MS - sinceLast) / 1000),
      };
    }
    // Reset window if expired
    if (now - log.windowStart > SEND_WINDOW_MS) {
      log.count = 0;
      log.windowStart = now;
    }
    // Enforce max sends per window
    if (log.count >= MAX_SENDS_PER_WINDOW) {
      return {
        ok: false,
        reason: "Too many OTP requests. Please try again after 15 minutes.",
      };
    }
  }
  return { ok: true };
}

// Store a freshly generated OTP for a channel/value
function setOtp(channel, value) {
  const key = makeKey(channel, value);
  const otp = generateOtp();
  otps.set(key, { otp, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });

  // Track send for cooldown / rate limiting
  const now = Date.now();
  const log = sendLog.get(key);
  if (log && now - log.windowStart <= SEND_WINDOW_MS) {
    log.lastSentAt = now;
    log.count += 1;
  } else {
    sendLog.set(key, { lastSentAt: now, count: 1, windowStart: now });
  }

  return otp;
}

// Verify a submitted OTP. Returns { ok, reason }.
function verifyOtp(channel, value, submittedOtp) {
  const key = makeKey(channel, value);
  const record = otps.get(key);
  if (!record)
    return { ok: false, reason: "No OTP found. Please request a new one." };

  if (Date.now() > record.expiresAt) {
    otps.delete(key);
    return { ok: false, reason: "OTP has expired. Please request a new one." };
  }

  record.attempts += 1;
  if (record.attempts > MAX_ATTEMPTS) {
    otps.delete(key);
    return {
      ok: false,
      reason: "Too many attempts. Please request a new OTP.",
    };
  }

  if (record.otp !== String(submittedOtp).trim()) {
    return { ok: false, reason: "Invalid OTP. Please try again." };
  }

  // Success — clear the OTP and mark this channel/value as verified
  otps.delete(key);
  verified.set(key, Date.now() + VERIFIED_TTL_MS);
  return { ok: true };
}

// Check if a channel/value was verified recently (within VERIFIED_TTL_MS)
function isVerified(channel, value) {
  const key = makeKey(channel, value);
  const exp = verified.get(key);
  if (!exp) return false;
  if (Date.now() > exp) {
    verified.delete(key);
    return false;
  }
  return true;
}

// Consume (clear) a verified marker — call after successful register/reset
function clearVerified(channel, value) {
  verified.delete(makeKey(channel, value));
}

module.exports = {
  setOtp,
  verifyOtp,
  isVerified,
  clearVerified,
  canSendOtp,
};
