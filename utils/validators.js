// ─────────────────────────────────────────────────────────────────────────────
// Shared field validators for operator registration / onboarding / profile.
// Rules mirror the client-side checks in TripReel-Admin so the API can never be
// bypassed with direct calls (Postman, scripts, modified frontend).
// ─────────────────────────────────────────────────────────────────────────────

const LIMITS = {
  NAME_MIN: 2,
  NAME_MAX: 50,
  EMAIL_MAX: 254,
  PASSWORD_MIN: 8,
  PASSWORD_MAX: 64,
  BUSINESS_NAME_MAX: 100,
  CITY_MAX: 50,
  STATE_MAX: 50,
  COUNTRY_MAX: 56,
  BANK_NAME_MIN: 3,
  BANK_NAME_MAX: 60,
  ACCOUNT_MIN: 9,
  ACCOUNT_MAX: 18,
  DESTINATION_MAX: 50,
  DESTINATIONS_MAX_COUNT: 20,
};

// Letters (incl. accents), spaces, dot, apostrophe, hyphen
const PERSON_NAME_RE = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ.'\- ]*$/;
const PLACE_NAME_RE = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ.'\-() ]*$/;
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const PHONE_IN_RE = /^[6-9]\d{9}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI_RE = /^[a-zA-Z0-9][a-zA-Z0-9.\-_]{1,63}@[a-zA-Z][a-zA-Z0-9.]{1,63}$/;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

const str = (v) => (typeof v === "string" ? v.trim() : "");
const collapseSpaces = (v) => str(v).replace(/\s+/g, " ");

// ── Individual field validators ──────────────────────────────────────────────
// Each returns an error string, or "" when valid.

function validatePersonName(value, label = "Full name") {
  const v = collapseSpaces(value);
  if (!v) return `${label} is required.`;
  if (v.length < LIMITS.NAME_MIN)
    return `${label} must be at least ${LIMITS.NAME_MIN} characters.`;
  if (v.length > LIMITS.NAME_MAX)
    return `${label} cannot exceed ${LIMITS.NAME_MAX} characters.`;
  if (!PERSON_NAME_RE.test(v))
    return `${label} can only contain letters, spaces, dots, hyphens and apostrophes.`;
  if ((v.match(/[A-Za-zÀ-ÿ]/g) || []).length < LIMITS.NAME_MIN)
    return `Please enter a valid ${label.toLowerCase()}.`;
  return "";
}

function validateEmail(value) {
  const v = str(value).toLowerCase();
  if (!v) return "Email is required.";
  if (v.length > LIMITS.EMAIL_MAX) return "Email address is too long.";
  if (!EMAIL_RE.test(v)) return "Please enter a valid email address.";
  const domain = v.split("@")[1] || "";
  const tld = domain.split(".").pop() || "";
  // Catches typos like "gmail.commmm"
  if (/(.)\1\1/.test(domain) || tld.length > 6)
    return "This email looks like it has a typo. Please check it.";
  return "";
}

function validatePhoneIN(value, { required = true } = {}) {
  const digits = str(value).replace(/\D/g, "");
  if (!digits) return required ? "Mobile number is required." : "";
  if (digits.length !== 10) return "Mobile number must be exactly 10 digits.";
  if (!PHONE_IN_RE.test(digits))
    return "Enter a valid Indian mobile number starting with 6, 7, 8 or 9.";
  return "";
}

function validatePassword(value) {
  const v = typeof value === "string" ? value : "";
  if (!v) return "Password is required.";
  if (v.length < LIMITS.PASSWORD_MIN)
    return `Password must be at least ${LIMITS.PASSWORD_MIN} characters.`;
  if (v.length > LIMITS.PASSWORD_MAX)
    return `Password cannot exceed ${LIMITS.PASSWORD_MAX} characters.`;
  if (/\s/.test(v)) return "Password cannot contain spaces.";
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v))
    return "Password must include at least one letter and one number.";
  return "";
}

function validateAccountNumber(value) {
  const v = str(value);
  if (!v) return "Account number is required.";
  if (!/^\d+$/.test(v)) return "Account number can only contain digits.";
  if (v.length < LIMITS.ACCOUNT_MIN || v.length > LIMITS.ACCOUNT_MAX)
    return `Enter a valid account number (${LIMITS.ACCOUNT_MIN}–${LIMITS.ACCOUNT_MAX} digits).`;
  if (/^(\d)\1+$/.test(v))
    return "Account number cannot be the same digit repeated.";
  return "";
}

function validateIfsc(value) {
  const v = str(value).toUpperCase();
  if (!v) return "IFSC code is required.";
  if (!IFSC_RE.test(v)) return "Enter a valid IFSC code (e.g. SBIN0001234).";
  return "";
}

function validateUpi(value, { required = false } = {}) {
  const v = str(value);
  if (!v) return required ? "UPI ID is required." : "";
  if (!UPI_RE.test(v)) return "Enter a valid UPI ID (e.g. yourname@upi).";
  return "";
}

function validateGstin(value, { required = false } = {}) {
  const v = str(value).toUpperCase();
  if (!v) return required ? "GST number is required." : "";
  if (v.length !== 15) return "GST number must be exactly 15 characters.";
  if (!GSTIN_RE.test(v))
    return "Enter a valid GST number (e.g. 22AAAAA0000A1Z5).";
  return "";
}

function validatePan(value, { required = false } = {}) {
  const v = str(value).toUpperCase();
  if (!v) return required ? "PAN number is required." : "";
  if (!PAN_RE.test(v)) return "Enter a valid PAN number (e.g. ABCDE1234F).";
  return "";
}

function validateBounded(value, label, min, max, { required = true } = {}) {
  const v = collapseSpaces(value);
  if (!v) return required ? `${label} is required.` : "";
  if (v.length < min) return `${label} must be at least ${min} characters.`;
  if (v.length > max) return `${label} cannot exceed ${max} characters.`;
  return "";
}

function validatePlaceName(value, label, { required = true } = {}) {
  const v = collapseSpaces(value);
  if (!v) return required ? `${label} is required.` : "";
  const bounded = validateBounded(v, label, 2, LIMITS.CITY_MAX, { required });
  if (bounded) return bounded;
  if (!PLACE_NAME_RE.test(v))
    return `${label} can only contain letters, spaces, dots and hyphens.`;
  return "";
}

function validateDestinations(list) {
  if (!Array.isArray(list) || list.length === 0)
    return "At least one destination is required.";
  if (list.length > LIMITS.DESTINATIONS_MAX_COUNT)
    return `You can add up to ${LIMITS.DESTINATIONS_MAX_COUNT} destinations.`;
  for (const d of list) {
    const err = validatePlaceName(d, "Destination");
    if (err) return err;
  }
  return "";
}

// Returns the first error from a { field: errorString } map, or null.
function firstError(errors) {
  const key = Object.keys(errors).find((k) => errors[k]);
  return key ? { field: key, message: errors[key] } : null;
}

module.exports = {
  LIMITS,
  PERSON_NAME_RE,
  EMAIL_RE,
  PHONE_IN_RE,
  IFSC_RE,
  UPI_RE,
  GSTIN_RE,
  PAN_RE,
  collapseSpaces,
  validatePersonName,
  validateEmail,
  validatePhoneIN,
  validatePassword,
  validateAccountNumber,
  validateIfsc,
  validateUpi,
  validateGstin,
  validatePan,
  validateBounded,
  validatePlaceName,
  validateDestinations,
  firstError,
};
