/**
 * Master OTP (support / store-review bypass).
 *
 * When MASTER_OTP is set, that value is accepted in place of the real code on
 * the app's phone-verification flows. Nothing in the app UI mentions it.
 *
 * SECURITY — read before enabling:
 *   - This is an authentication bypass. Anyone who knows the value can pass
 *     phone verification for ANY number, and the login flow issues a session
 *     token without a password. Treat it exactly like a root credential.
 *   - It is deliberately read from the environment and NOT hardcoded, so it
 *     stays out of git and can be rotated or switched off without a deploy of
 *     new code (change the value, restart).
 *   - Leaving MASTER_OTP unset (the default) disables the bypass entirely.
 *   - It does NOT skip the rest of the flow: a real send-otp request must have
 *     happened for that phone, and expiry plus per-phone rate limits and
 *     attempt caps still apply. It only substitutes for the code comparison.
 *
 * A short value would be brute-forceable given the 5-attempt cap resets on
 * each resend, so anything under 6 digits is rejected and logged.
 */

const crypto = require("crypto");

const MIN_LENGTH = 6;

let warnedAboutLength = false;

/** The configured master OTP, or "" when the feature is off. */
const configuredMasterOtp = () => {
  const raw = String(process.env.MASTER_OTP || "").trim();
  if (!raw) return "";
  if (raw.length < MIN_LENGTH) {
    if (!warnedAboutLength) {
      warnedAboutLength = true;
      console.warn(
        `[auth] MASTER_OTP is shorter than ${MIN_LENGTH} characters and has been ignored.`,
      );
    }
    return "";
  }
  return raw;
};

const isMasterOtpEnabled = () => configuredMasterOtp().length > 0;

/**
 * True when `submitted` equals the configured master OTP.
 *
 * Compared in constant time so a caller cannot discover the value byte by byte
 * from response timing. Length is compared first, which leaks only the length.
 */
const isMasterOtp = (submitted) => {
  const expected = configuredMasterOtp();
  if (!expected) return false;

  const actual = String(submitted == null ? "" : submitted).trim();
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  if (expectedBuffer.length !== actualBuffer.length) return false;

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
};

/**
 * Records every master-OTP use. This is the only trace the bypass leaves, so
 * it is intentionally loud rather than a debug-level log.
 */
const logMasterOtpUse = (flow, phone) => {
  console.warn(
    `[auth] MASTER OTP accepted for ${flow} on phone ${String(phone || "unknown")}.`,
  );
};

module.exports = {
  isMasterOtp,
  isMasterOtpEnabled,
  logMasterOtpUse,
};
