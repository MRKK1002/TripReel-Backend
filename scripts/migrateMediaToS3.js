/**
 * One-time (and safely repeatable) migration of local media to S3 + CloudFront.
 *
 * Two independent phases:
 *
 *   FILES  Walk every local uploads root and upload anything missing from the
 *          bucket, using keys that mirror the on-disk layout
 *          (uploads/videos/x.mp4, uploads/operators/y.pdf, ...).
 *
 *   DB     Normalise media values stored in MongoDB down to the canonical
 *          relative form ("/uploads/..."). Historically some admin uploads were
 *          saved as absolute "http://host/uploads/..." URLs; those break when
 *          the host changes and cannot be resolved against a CDN.
 *
 * Nothing is ever deleted. Both phases are idempotent, so the script doubles as
 * a repair tool for uploads that failed to reach S3 at request time.
 *
 * Usage:
 *   node scripts/migrateMediaToS3.js                  # dry run, reports only
 *   node scripts/migrateMediaToS3.js --apply          # perform the migration
 *   node scripts/migrateMediaToS3.js --files-only
 *   node scripts/migrateMediaToS3.js --db-only --apply
 *   node scripts/migrateMediaToS3.js --apply --concurrency=8 --limit=500
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const {
  isCloudStorageEnabled,
  isCdnConfigured,
  AWS_S3_BUCKET,
  AWS_REGION,
  CDN_BASE,
  storedPathToKey,
  uploadFileToS3,
  objectExistsInS3,
  PRIVATE_KEY_PREFIX,
} = require("../utils/s3Storage");
const { PUBLIC_UPLOAD_ROOTS } = require("../utils/reelMedia");

// ── Arguments ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const FILES_ONLY = argv.includes("--files-only");
const DB_ONLY = argv.includes("--db-only");
const numericArg = (name, fallback) => {
  const raw = argv.find((a) => a.startsWith(`--${name}=`));
  const value = raw ? Number(raw.slice(name.length + 3)) : NaN;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};
const CONCURRENCY = numericArg("concurrency", 4);
const LIMIT = numericArg("limit", 0);
// Private operator KYC documents are excluded by default. Only include them once
// the CloudFront distribution is verified to DENY the uploads/operators/* path,
// otherwise they would become reachable through the CDN.
const INCLUDE_PRIVATE = argv.includes("--include-private");

const CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
};
const contentTypeFor = (file) =>
  CONTENT_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";

// ── Phase 1: local files → S3 ───────────────────────────────────────────────

/** Recursively collect files under a directory. Ignores partial temp artifacts. */
const collectFiles = (dir, out = []) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (entry.isFile()) {
      if (/\.(part|tmp)(\.[a-z0-9]+)?$/i.test(entry.name)) continue;
      out.push(full);
    }
  }
  return out;
};

const migrateFiles = async () => {
  const counts = {
    found: 0,
    alreadyInS3: 0,
    uploaded: 0,
    skippedPrivate: 0,
    failed: 0,
  };
  const queue = [];

  for (const root of PUBLIC_UPLOAD_ROOTS) {
    const uploadsDir = path.basename(root) === "uploads" ? root : root;
    for (const file of collectFiles(uploadsDir)) {
      const relative = path
        .relative(uploadsDir, file)
        .split(path.sep)
        .join("/");
      if (!relative || relative.startsWith("..")) continue;
      const key = `uploads/${relative}`;
      if (!INCLUDE_PRIVATE && key.startsWith(PRIVATE_KEY_PREFIX)) {
        counts.skippedPrivate += 1;
        continue;
      }
      queue.push({ file, key });
    }
  }

  // The same logical file can appear under two roots; keep one entry per key.
  const unique = new Map();
  for (const item of queue)
    if (!unique.has(item.key)) unique.set(item.key, item);
  let items = [...unique.values()];
  counts.found = items.length;
  if (LIMIT) items = items.slice(0, LIMIT);

  console.log(
    `FILES: ${counts.found} local file(s) found${
      LIMIT ? `, processing first ${items.length}` : ""
    }${
      counts.skippedPrivate
        ? `; skipped ${counts.skippedPrivate} private ${PRIVATE_KEY_PREFIX}* file(s) — pass --include-private only after CloudFront denies that path`
        : ""
    }.`,
  );

  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const { file, key } = items[cursor++];
      try {
        if (await objectExistsInS3(key)) {
          counts.alreadyInS3 += 1;
          continue;
        }
        if (!APPLY) {
          counts.uploaded += 1;
          console.log(`WOULD UPLOAD ${key}`);
          continue;
        }
        await uploadFileToS3({
          filePath: file,
          key,
          contentType: contentTypeFor(file),
        });
        counts.uploaded += 1;
        console.log(`UPLOADED ${key}`);
      } catch (error) {
        counts.failed += 1;
        console.error(`FAILED ${key}: ${error.message}`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length || 1) }, worker),
  );

  return counts;
};

// ── Phase 2: MongoDB URL normalisation ──────────────────────────────────────

/** Canonicalise one stored value. Leaves external/unowned values untouched. */
const toRelative = (value) => {
  if (typeof value !== "string") return value;
  const key = storedPathToKey(value);
  return key ? `/${key}` : value;
};

/**
 * Collect (without mutating) every owned media value that needs rewriting at a
 * dotted path, returning fully-qualified Mongo paths including array indices.
 *
 * Arrays are handled at any depth, so "images", "sampleMedia.url",
 * "slides.imageUrl" and "snapshot.packageImageUrl" all work with one pass.
 * Returning paths lets the caller use updateOne({$set}) instead of doc.save(),
 * which would fire pre-save hooks (TripBooking mints bookingIds and bumps a
 * shared counter) and touch updatedAt on every document.
 */
const collectChanges = (container, segments, prefix = "") => {
  const changes = [];
  if (container === null || container === undefined) return changes;

  if (Array.isArray(container)) {
    container.forEach((item, index) => {
      const next = prefix ? `${prefix}.${index}` : String(index);
      changes.push(...collectChanges(item, segments, next));
    });
    return changes;
  }

  const [head, ...rest] = segments;
  const qualified = prefix ? `${prefix}.${head}` : head;

  if (rest.length > 0) {
    return collectChanges(container[head], rest, qualified);
  }

  const current = container[head];

  if (Array.isArray(current)) {
    current.forEach((entry, index) => {
      if (typeof entry !== "string") return;
      const next = toRelative(entry);
      if (next !== entry) {
        changes.push({ path: `${qualified}.${index}`, from: entry, to: next });
      }
    });
    return changes;
  }

  if (typeof current === "string") {
    const next = toRelative(current);
    if (next !== current) {
      changes.push({ path: qualified, from: current, to: next });
    }
  }
  return changes;
};

// model file → media field paths
const MODEL_FIELDS = [
  [
    "../models/Package",
    [
      "image_url",
      "images",
      "videos",
      "sampleMedia.url",
      "sampleMedia.thumbnail",
    ],
  ],
  ["../models/User", ["avatar"]],
  ["../models/Reel", ["video", "thumbnail", "user.avatar"]],
  ["../models/Message", ["imageUrl", "senderAvatar"]],
  ["../models/Banner", ["image"]],
  ["../models/Experience", ["image"]],
  ["../models/PopularDestination", ["image"]],
  ["../models/Campaign", ["imageUrl"]],
  ["../models/AppScreen", ["splashImageUrl", "slides.imageUrl"]],
  ["../models/TripBooking", ["snapshot.packageImageUrl"]],
  ["../models/Conversation", ["packageImage"]],
  ["../models/Trip", ["image"]],
  ["../models/Wishlist", ["image"]],
];

/** Operator is exported as a named property, and its KYC fields are private. */
const OPERATOR_FIELDS = [
  "profilePhoto",
  "governmentId",
  "selfieVerification",
  "tradeLicensePath",
  "panCardPath",
];

const migrateModel = async (Model, label, fields, counts) => {
  // lean(): plain objects are all we need to walk, and it avoids hydrating
  // documents whose validators or hooks might fire on save.
  const query = Model.find({}).lean();
  if (LIMIT) query.limit(LIMIT);
  const docs = await query;

  let changedDocs = 0;
  let changedValues = 0;

  for (const doc of docs) {
    const changes = fields.flatMap((field) =>
      collectChanges(doc, field.split(".")),
    );
    if (changes.length === 0) continue;

    changedDocs += 1;
    changedValues += changes.length;

    for (const change of changes) {
      console.log(
        `${APPLY ? "UPDATE" : "WOULD UPDATE"} ${label} ${doc._id} ${change.path}\n    ${change.from}\n -> ${change.to}`,
      );
    }

    if (APPLY) {
      const $set = Object.fromEntries(changes.map((c) => [c.path, c.to]));
      try {
        await Model.updateOne(
          { _id: doc._id },
          { $set },
          { timestamps: false },
        );
      } catch (error) {
        counts.failed += 1;
        console.error(`FAILED ${label} ${doc._id}: ${error.message}`);
      }
    }
  }

  if (changedDocs > 0) {
    console.log(
      `${label}: ${changedDocs} document(s), ${changedValues} value(s).`,
    );
  }
  counts.documents += changedDocs;
  counts.values += changedValues;
};

/** PlatformSettings stores media inside a Mixed `value` keyed by `key`. */
const migratePlatformSettings = async (counts) => {
  const PlatformSettings = require("../models/PlatformSettings");
  const keys = ["splash_image_url", "splash_images", "sample_demo_media"];
  const docs = await PlatformSettings.find({ key: { $in: keys } }).lean();

  for (const doc of docs) {
    const value = doc.value;
    const changes = [];

    if (typeof value === "string") {
      const next = toRelative(value);
      if (next !== value)
        changes.push({ path: "value", from: value, to: next });
    } else if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (typeof entry === "string") {
          const next = toRelative(entry);
          if (next !== entry) {
            changes.push({ path: `value.${index}`, from: entry, to: next });
          }
        } else if (entry && typeof entry === "object") {
          for (const field of ["url", "thumbnail"]) {
            if (typeof entry[field] !== "string") continue;
            const next = toRelative(entry[field]);
            if (next !== entry[field]) {
              changes.push({
                path: `value.${index}.${field}`,
                from: entry[field],
                to: next,
              });
            }
          }
        }
      });
    }

    if (changes.length === 0) continue;

    for (const change of changes) {
      console.log(
        `${APPLY ? "UPDATE" : "WOULD UPDATE"} PlatformSettings ${doc.key} ${change.path}\n    ${change.from}\n -> ${change.to}`,
      );
    }

    if (APPLY) {
      const $set = Object.fromEntries(changes.map((c) => [c.path, c.to]));
      try {
        await PlatformSettings.updateOne(
          { _id: doc._id },
          { $set },
          { timestamps: false },
        );
      } catch (error) {
        counts.failed += 1;
        console.error(`FAILED PlatformSettings ${doc.key}: ${error.message}`);
        continue;
      }
    }
    counts.documents += 1;
    counts.values += changes.length;
  }
};

const migrateDatabase = async () => {
  const counts = { documents: 0, values: 0, failed: 0 };

  for (const [modulePath, fields] of MODEL_FIELDS) {
    let Model;
    try {
      Model = require(modulePath);
    } catch (error) {
      console.warn(`SKIP ${modulePath}: ${error.message}`);
      continue;
    }
    const label = path.basename(modulePath);
    await migrateModel(Model, label, fields, counts);
  }

  const { Operator } = require("../models/Operator");
  await migrateModel(Operator, "Operator", OPERATOR_FIELDS, counts);

  await migratePlatformSettings(counts);

  return counts;
};

// ── Main ────────────────────────────────────────────────────────────────────
const main = async () => {
  console.log(
    APPLY
      ? "MODE: APPLY — files will be uploaded and documents updated."
      : "MODE: DRY RUN — nothing will be written. Re-run with --apply to migrate.",
  );

  const runFiles = !DB_ONLY;
  const runDb = !FILES_ONLY;

  let fileCounts = null;
  let dbCounts = null;

  if (runFiles) {
    if (!isCloudStorageEnabled()) {
      throw new Error(
        "AWS_S3_BUCKET is not set, so files cannot be uploaded. Set it (and AWS credentials) or pass --db-only.",
      );
    }
    console.log(
      `TARGET: bucket=${AWS_S3_BUCKET} region=${AWS_REGION} cdn=${
        isCdnConfigured()
          ? CDN_BASE
          : "(none — media will serve from the API host)"
      }`,
    );
    console.log(`ROOTS: ${PUBLIC_UPLOAD_ROOTS.join(", ")}`);
    fileCounts = await migrateFiles();
  }

  if (runDb) {
    const mongoUri = process.env.mongodburl;
    if (!mongoUri) throw new Error("mongodburl not found in the environment.");
    await mongoose.connect(mongoUri, { autoIndex: false });
    dbCounts = await migrateDatabase();
  }

  console.log("\n── Summary ──");
  if (fileCounts) console.log(`files: ${JSON.stringify(fileCounts)}`);
  if (dbCounts) console.log(`database: ${JSON.stringify(dbCounts)}`);
  if (!APPLY) console.log("Dry run only — re-run with --apply to migrate.");

  const failed = (fileCounts?.failed || 0) + (dbCounts?.failed || 0);
  if (failed > 0) {
    console.error(`${failed} item(s) failed.`);
    process.exitCode = 1;
  }
};

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
