const crypto = require("crypto");

/**
 * Signed, short-lived URLs for private operator KYC documents.
 *
 * KYC files (government ID, PAN, selfie, trade license) live under
 * /uploads/operators/ and must NOT be publicly downloadable. Instead of the raw
 * path we hand out a URL that carries an HMAC signature + expiry. The
 * /api/secure-docs route verifies the signature before streaming the file, so
 * only someone who received a freshly-signed URL (admin or the owning operator)
 * can open it — and only for a short window.
 *
 * Works with <img src> and <a href> because the signature travels in the query
 * string (no Authorization header needed).
 */

const SECRET = () => process.env.JWT_SECRET || "tripreel_doc_secret";
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

// Only paths under this prefix may ever be signed / served this way
const ALLOWED_PREFIX = "/uploads/operators/";

function sign(filePath, expiry) {
  return crypto
    .createHmac("sha256", SECRET())
    .update(`${filePath}:${expiry}`)
    .digest("hex");
}

/**
 * Turn a stored path ("/uploads/operators/xyz.jpg") into a signed relative URL.
 * Returns the original value unchanged if it's not a private operator doc.
 */
function toSignedUrl(filePath, ttlMs = DEFAULT_TTL_MS) {
  if (!filePath || typeof filePath !== "string") return filePath;
  if (!filePath.startsWith(ALLOWED_PREFIX)) return filePath; // not a private doc
  const expiry = Date.now() + ttlMs;
  const sig = sign(filePath, expiry);
  const params = new URLSearchParams({
    path: filePath,
    e: String(expiry),
    t: sig,
  });
  return `/api/secure-docs?${params.toString()}`;
}

/**
 * Verify a signed request. Returns { ok, filePath } or { ok:false, reason }.
 */
function verifySignedUrl(query) {
  const filePath = query.path;
  const expiry = Number(query.e);
  const sig = query.t;

  if (!filePath || !expiry || !sig) {
    return { ok: false, reason: "Missing signature parameters" };
  }
  // Path traversal / scope guard
  if (
    !filePath.startsWith(ALLOWED_PREFIX) ||
    filePath.includes("..") ||
    filePath.includes("\0")
  ) {
    return { ok: false, reason: "Invalid path" };
  }
  if (Date.now() > expiry) {
    return { ok: false, reason: "Link expired" };
  }
  const expected = sign(filePath, expiry);
  // Constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "Invalid signature" };
  }
  return { ok: true, filePath };
}

module.exports = { toSignedUrl, verifySignedUrl, ALLOWED_PREFIX };
