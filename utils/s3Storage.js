/**
 * S3 + CloudFront storage for TripReel media.
 *
 * Design notes
 * ------------
 * 1. S3 keys deliberately MIRROR the existing on-disk layout, e.g.
 *      /uploads/videos/123.mp4        -> uploads/videos/123.mp4
 *      /uploads/operators/456.pdf     -> uploads/operators/456.pdf
 *    Mongo keeps storing the same relative "/uploads/..." values it always has.
 *    That keeps packageController's "/uploads/" sanitizer, signedDocUrl's
 *    "/uploads/operators/" prefix check, and reelMedia's prefix regex working
 *    with no changes and no URL rewrite in the database.
 *
 * 2. Uploads happen AFTER multer has written the temp file (we read the file and
 *    PutObject it), rather than using multer-s3. This preserves `req.file.path`,
 *    which routes/uploadRoutes.js relies on, and keeps the local file available
 *    for the FFmpeg reel-thumbnail step.
 *
 * 3. Public objects are read through CloudFront. Private objects (operator KYC)
 *    are NOT given a direct URL at all: they are streamed back through the
 *    authenticated /api/secure-docs route via streamFromS3, so no CloudFront key
 *    pair, private-key PEM, or presigned URL has to exist. CloudFront must also
 *    deny "/uploads/operators/*" so the CDN can never expose them.
 *
 * 4. If the bucket is not configured the module reports disabled and every
 *    caller falls back to the existing local-disk behaviour.
 */

const fs = require("fs");
const path = require("path");

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");

// ── Configuration ───────────────────────────────────────────────────────────
const AWS_S3_BUCKET = (process.env.AWS_S3_BUCKET || "").trim();
const AWS_REGION = (process.env.AWS_REGION || "ap-south-1").trim();
const CDN_DOMAIN_RAW = (process.env.CLOUDFRONT_DOMAIN || "").trim();

// Everything under this key prefix is private and never served via CloudFront.
// These objects are streamed through the authenticated /api/secure-docs route,
// so there is no expiring URL and therefore no TTL to configure.
const PRIVATE_KEY_PREFIX = "uploads/operators/";

// Normalise the CDN base once: strip trailing slashes, ensure a scheme.
const CDN_BASE = (() => {
  if (!CDN_DOMAIN_RAW) return "";
  const withScheme = /^https?:\/\//i.test(CDN_DOMAIN_RAW)
    ? CDN_DOMAIN_RAW
    : `https://${CDN_DOMAIN_RAW}`;
  return withScheme.replace(/\/+$/, "");
})();

let s3Client = null;

/**
 * Static keys are used when supplied; otherwise the SDK's default credential
 * chain applies, which lets an EC2/ECS IAM role work with no secrets on disk.
 */
const buildClient = () => {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const config = { region: AWS_REGION };
  if (accessKeyId && secretAccessKey) {
    config.credentials = { accessKeyId, secretAccessKey };
  }
  return new S3Client(config);
};

const getClient = () => {
  if (!s3Client) s3Client = buildClient();
  return s3Client;
};

const isCloudStorageEnabled = () => Boolean(AWS_S3_BUCKET);

/** True when public objects can be served from a CDN domain. */
const isCdnConfigured = () => Boolean(CDN_BASE);

const isPrivateKey = (key) =>
  typeof key === "string" && key.startsWith(PRIVATE_KEY_PREFIX);

// ── Path/key translation ────────────────────────────────────────────────────

/**
 * Extract the "/uploads/..." pathname from a stored value, tolerating the
 * absolute URLs that older admin uploads persisted.
 */
const storedPathname = (value) => {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";

  let pathname = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    // Avoid the URL class: RN's polyfill appends a trailing slash to bare paths.
    const withoutScheme = trimmed.replace(/^https?:\/\/[^/]+/i, "");
    pathname = withoutScheme || "/";
  }
  return pathname.split(/[?#]/, 1)[0].replace(/\\/g, "/");
};

/**
 * Convert a stored media value into its S3 key, or "" when the value is not an
 * app-owned upload.
 *
 * The pathname must START with "uploads/" (a leading slash is optional, since
 * some legacy records stored the path without one — the app-side resolver
 * accepts both, so this must too or the value would be skipped by the migration
 * yet still requested from the CDN). Searching for "/uploads/" anywhere would
 * capture unrelated third-party URLs — a pasted
 * "https://example.com/wp-content/uploads/2024/a.jpg" would otherwise be
 * rewritten to "/uploads/2024/a.jpg" and point at media we do not host.
 */
const storedPathToKey = (value) => {
  const pathname = storedPathname(value);
  if (!pathname || !/^\/?uploads\//i.test(pathname)) return "";
  const key = pathname.replace(/^\/+/, "");
  // Reject traversal outright — keys are always literal.
  if (key.split("/").some((segment) => segment === "..")) return "";
  return key;
};

/**
 * Build the S3 key for a freshly written local file.
 *
 * Both arguments are sanitized. `relativeDir` is currently always an internal
 * constant ("videos", "images", "operators", ...), but a "." or ".." segment
 * would produce a key that storedPathToKey can never reproduce, and one shaped
 * like "../uploads/operators" would defeat the isPrivateKey() prefix check and
 * publish a KYC document. Keys are literal in S3, so drop those segments.
 */
const keyForUpload = (relativeDir, filename) => {
  const safeName = path.basename(String(filename || ""));
  const dir = String(relativeDir || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
  return dir ? `uploads/${dir}/${safeName}` : `uploads/${safeName}`;
};

/**
 * Absolute URL for a stored media value, for contexts that cannot use a
 * relative path (Open Graph tags, emails, push payloads).
 *
 * Public media resolves against the CDN when configured; private operator
 * documents and anything unowned resolve against this API host. External URLs
 * are returned unchanged.
 */
const absoluteMediaUrl = (value) => {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";

  const key = storedPathToKey(trimmed);
  if (!key) {
    // Already absolute and not ours — pass through. Otherwise it is a
    // non-upload relative path, which only this server can serve.
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    const base = (process.env.BASE_URL || "").replace(/\/+$/, "");
    return base
      ? `${base}${trimmed.startsWith("/") ? "" : "/"}${trimmed}`
      : trimmed;
  }

  if (isPrivateKey(key) || !CDN_BASE) {
    const base = (process.env.BASE_URL || "").replace(/\/+$/, "");
    return base ? `${base}/${key}` : `/${key}`;
  }
  return `${CDN_BASE}/${key}`;
};

// ── Write ───────────────────────────────────────────────────────────────────

/**
 * Upload a local file to S3.
 *
 * @returns {Promise<{ key: string, uploaded: boolean }>}
 */
const uploadFileToS3 = async ({
  filePath,
  key,
  contentType,
  deleteLocal = false,
}) => {
  if (!isCloudStorageEnabled()) return { key, uploaded: false };
  if (!key) throw new Error("An S3 key is required.");

  // Stream rather than buffer — reel videos are allowed up to 200 MB and
  // reading those fully into memory per request is a real pressure source.
  const { size } = await fs.promises.stat(filePath);
  await getClient().send(
    new PutObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentLength: size,
      ...(contentType ? { ContentType: contentType } : {}),
      // No ACL: the bucket stays private and CloudFront reads it through OAC.
      CacheControl: isPrivateKey(key)
        ? "private, no-store"
        : "public, max-age=31536000, immutable",
    }),
  );

  if (deleteLocal) {
    await fs.promises.unlink(filePath).catch(() => {
      /* best effort */
    });
  }

  return { key, uploaded: true };
};

/** Upload an in-memory buffer (used by the base64 upload endpoint). */
const uploadBufferToS3 = async ({ buffer, key, contentType }) => {
  if (!isCloudStorageEnabled()) return { key, uploaded: false };
  if (!key) throw new Error("An S3 key is required.");

  await getClient().send(
    new PutObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: key,
      Body: buffer,
      ...(contentType ? { ContentType: contentType } : {}),
      CacheControl: isPrivateKey(key)
        ? "private, no-store"
        : "public, max-age=31536000, immutable",
    }),
  );

  return { key, uploaded: true };
};

/**
 * Mirror a file multer just wrote to disk into S3 and return the value to store
 * in MongoDB — always the same relative "/uploads/..." path used before S3, so
 * callers and existing documents keep one canonical format.
 *
 * Throws when the S3 upload fails. Once a CDN is configured, clients request
 * media from CloudFront and never from this server, so a swallowed failure
 * would be a permanently broken asset rather than a graceful fallback. Callers
 * must let the request fail so the client can retry.
 *
 * @param {{ path: string, filename: string, mimetype?: string }} file
 * @param {string} relativeDir Sub-path under uploads/, e.g. "videos" or "operators"
 * @returns {Promise<string>} e.g. "/uploads/videos/123.mp4"
 */
const syncUploadedFile = async (file, relativeDir = "") => {
  if (!file || !file.filename) return "";
  const key = keyForUpload(relativeDir, file.filename);

  if (isCloudStorageEnabled() && file.path) {
    await uploadFileToS3({
      filePath: file.path,
      key,
      contentType: file.mimetype,
    });
  }

  return `/${key}`;
};

// ── Read ────────────────────────────────────────────────────────────────────

/** Stream an object back, for proxying through an authenticated route. */
const streamFromS3 = async (key) => {
  if (!isCloudStorageEnabled() || !key) return null;
  const response = await getClient().send(
    new GetObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key }),
  );
  return {
    stream: response.Body,
    contentType: response.ContentType || "application/octet-stream",
    contentLength: response.ContentLength,
  };
};

const objectExistsInS3 = async (key) => {
  if (!isCloudStorageEnabled() || !key) return false;
  try {
    await getClient().send(
      new HeadObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key }),
    );
    return true;
  } catch {
    return false;
  }
};

// ── Delete ──────────────────────────────────────────────────────────────────

const deleteFromS3 = async (key) => {
  if (!isCloudStorageEnabled() || !key) return false;
  try {
    await getClient().send(
      new DeleteObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key }),
    );
    return true;
  } catch (error) {
    console.warn(`[s3] Could not delete ${key}: ${error.message}`);
    return false;
  }
};

/** Best-effort delete from a stored "/uploads/..." value. */
const deleteStoredMedia = async (...values) => {
  const keys = [...new Set(values.map(storedPathToKey).filter(Boolean))];
  await Promise.all(keys.map(deleteFromS3));
  return keys.length;
};

module.exports = {
  AWS_S3_BUCKET,
  AWS_REGION,
  CDN_BASE,
  PRIVATE_KEY_PREFIX,
  isCloudStorageEnabled,
  isCdnConfigured,
  isPrivateKey,
  storedPathname,
  storedPathToKey,
  keyForUpload,
  absoluteMediaUrl,
  uploadFileToS3,
  uploadBufferToS3,
  syncUploadedFile,
  streamFromS3,
  objectExistsInS3,
  deleteFromS3,
  deleteStoredMedia,
};
