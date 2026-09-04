"use strict";

/**
 * Deterministic, redacted, read-only report for the legacy verified-phone cohort.
 *
 * This script has no apply mode and performs no writes. It intentionally ignores
 * the application's normal mongodburl setting so it cannot accidentally connect
 * to the default deployment database.
 *
 * Required environment variables:
 *   VERIFIED_PHONE_REPORT_MONGODB_URI=<approved non-production read-only URI>
 *   VERIFIED_PHONE_REPORT_ENVIRONMENT=local|development|test|staging|snapshot
 *   VERIFIED_PHONE_REPORT_APPROVED_NON_PRODUCTION=true
 *   VERIFIED_PHONE_REPORT_READ_ONLY=true
 *
 * Run:
 *   node scripts/migrateVerifiedPhones.js
 */

require("dotenv").config();

const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/User");

const REPORT_VERSION = 1;
const INTENDED_SOURCE = "legacy_otp_signup";
const ALLOWED_ENVIRONMENTS = new Set([
  "local",
  "development",
  "test",
  "staging",
  "snapshot",
]);
const REPORT_FINGERPRINT_DOMAIN = "tripreel-verified-phone-migration-report-v1";
const EXCLUSION_REASONS = [
  "already_verified",
  "empty_phone",
  "invalid_or_non_normalized_phone",
  "google_account",
  "password_account",
  "conflicting_phone",
  "invalid_created_at",
];

function normalizePhone(phone) {
  return String(phone || "")
    .replace(/\D/g, "")
    .trim();
}

function isNormalizedIndianPhone(rawPhone, normalizedPhone) {
  return (
    typeof rawPhone === "string" &&
    rawPhone.trim() === normalizedPhone &&
    /^\d{10}$/.test(normalizedPhone)
  );
}

function fingerprint(kind, value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(`${REPORT_FINGERPRINT_DOMAIN}:${kind}:${String(value)}`)
    .digest("hex")
    .slice(0, 16)}`;
}

function userFingerprint(user) {
  return fingerprint("user", user._id);
}

function phoneFingerprint(phone) {
  return fingerprint("phone", phone);
}

function toIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function hasGoogleIdentity(user) {
  return typeof user.googleId === "string" && user.googleId.trim().length > 0;
}

function hasPasswordHash(user) {
  return typeof user.password === "string" && user.password.length > 0;
}

function buildPhoneOwners(users) {
  const owners = new Map();

  for (const user of users) {
    const normalizedPhone = normalizePhone(user.phone);
    if (!normalizedPhone) continue;

    const ids = owners.get(normalizedPhone) || [];
    ids.push(String(user._id));
    owners.set(normalizedPhone, ids);
  }

  return owners;
}

function sortById(left, right) {
  return String(left._id).localeCompare(String(right._id));
}

function buildReport(inputUsers) {
  const users = [...inputUsers].sort(sortById);
  const phoneOwners = buildPhoneOwners(users);
  const candidates = [];
  const invalidPhones = [];
  const exclusions = Object.fromEntries(
    EXCLUSION_REASONS.map((reason) => [reason, []]),
  );

  const conflictEntries = [...phoneOwners.entries()]
    .filter(([, ownerIds]) => new Set(ownerIds).size > 1)
    .map(([phone, ownerIds]) => ({
      phoneFingerprint: phoneFingerprint(phone),
      userIdFingerprints: [...new Set(ownerIds)]
        .sort()
        .map((id) => fingerprint("user", id)),
    }))
    .sort((left, right) =>
      left.phoneFingerprint.localeCompare(right.phoneFingerprint),
    );
  const conflictingPhones = new Set(
    [...phoneOwners.entries()]
      .filter(([, ownerIds]) => new Set(ownerIds).size > 1)
      .map(([phone]) => phone),
  );

  for (const user of users) {
    const id = userFingerprint(user);
    const rawPhone = user.phone;
    const normalizedPhone = normalizePhone(rawPhone);
    const reasons = [];

    if (user.phoneVerifiedAt) reasons.push("already_verified");
    if (!normalizedPhone) {
      reasons.push("empty_phone");
    } else if (!isNormalizedIndianPhone(rawPhone, normalizedPhone)) {
      reasons.push("invalid_or_non_normalized_phone");
      invalidPhones.push({
        userIdFingerprint: id,
        phoneFingerprint: phoneFingerprint(normalizedPhone),
        reason: "must_be_exactly_10_stored_digits",
      });
    }
    if (hasGoogleIdentity(user)) reasons.push("google_account");
    if (hasPasswordHash(user)) reasons.push("password_account");
    if (normalizedPhone && conflictingPhones.has(normalizedPhone)) {
      reasons.push("conflicting_phone");
    }

    const intendedTimestamp = toIsoDate(user.createdAt);
    if (!intendedTimestamp) reasons.push("invalid_created_at");

    if (reasons.length === 0) {
      candidates.push({
        candidateIdFingerprint: id,
        phoneFingerprint: phoneFingerprint(normalizedPhone),
        intendedPhoneVerifiedAt: intendedTimestamp,
        intendedPhoneVerificationSource: INTENDED_SOURCE,
      });
      continue;
    }

    for (const reason of reasons) exclusions[reason].push(id);
  }

  invalidPhones.sort((left, right) =>
    left.userIdFingerprint.localeCompare(right.userIdFingerprint),
  );
  for (const ids of Object.values(exclusions)) ids.sort();

  const exclusionsByReason = Object.fromEntries(
    EXCLUSION_REASONS.map((reason) => [
      reason,
      {
        count: exclusions[reason].length,
        userIdFingerprints: exclusions[reason],
      },
    ]),
  );

  return {
    reportVersion: REPORT_VERSION,
    mode: "DRY_RUN_REPORT_ONLY",
    deterministic: true,
    redaction:
      "User IDs and normalized phones are represented by stable SHA-256 fingerprints; names, emails, and raw phones are omitted.",
    cohortRule: {
      normalizedPhone: "exactly 10 stored digits",
      phoneVerifiedAt: "absent",
      googleId: "absent or empty",
      passwordHash: "explicitly selected and absent",
      conflictPolicy: "exclude every normalized-phone ownership conflict",
      intendedPhoneVerifiedAt: "createdAt",
      intendedPhoneVerificationSource: INTENDED_SOURCE,
    },
    writeSafety: {
      applyCapabilityPresent: false,
      writesEnabled: false,
      writesExecuted: 0,
      candidatesWouldRequireSeparateReviewedBackfill: candidates.length,
    },
    summary: {
      usersScanned: users.length,
      candidateCount: candidates.length,
      invalidPhoneCount: invalidPhones.length,
      conflictingPhoneCount: conflictEntries.length,
      excludedRecordCount: users.length - candidates.length,
    },
    candidateIdFingerprints: candidates.map(
      (candidate) => candidate.candidateIdFingerprint,
    ),
    candidates,
    invalidPhones,
    conflictingPhones: conflictEntries,
    exclusionsByReason,
  };
}

function assertReportOnlyInvocation(argv = process.argv.slice(2)) {
  if (argv.includes("--apply")) {
    throw new Error(
      "Apply/backfill is not implemented. This script is permanently report-only.",
    );
  }
  if (argv.length > 0) {
    throw new Error(`Unsupported argument(s): ${argv.join(" ")}`);
  }
}

function getApprovedTargetFromEnvironment(env = process.env) {
  const uri = env.VERIFIED_PHONE_REPORT_MONGODB_URI;
  const environment = String(
    env.VERIFIED_PHONE_REPORT_ENVIRONMENT || "",
  ).toLowerCase();

  if (!uri) {
    throw new Error(
      "VERIFIED_PHONE_REPORT_MONGODB_URI is required; the application mongodburl is intentionally ignored.",
    );
  }
  if (!ALLOWED_ENVIRONMENTS.has(environment)) {
    throw new Error(
      "VERIFIED_PHONE_REPORT_ENVIRONMENT must identify an approved local/non-production target.",
    );
  }
  if (env.VERIFIED_PHONE_REPORT_APPROVED_NON_PRODUCTION !== "true") {
    throw new Error(
      "VERIFIED_PHONE_REPORT_APPROVED_NON_PRODUCTION=true is required.",
    );
  }
  if (env.VERIFIED_PHONE_REPORT_READ_ONLY !== "true") {
    throw new Error("VERIFIED_PHONE_REPORT_READ_ONLY=true is required.");
  }
  if (String(env.NODE_ENV || "").toLowerCase() === "production") {
    throw new Error("Refusing to run while NODE_ENV=production.");
  }

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("VERIFIED_PHONE_REPORT_MONGODB_URI is not a valid URI.");
  }

  if (!new Set(["mongodb:", "mongodb+srv:"]).has(parsed.protocol)) {
    throw new Error("The report target must use a MongoDB URI.");
  }

  const targetDescription =
    `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  if (/(^|[._/-])(prod|production|live)([._/-]|$)/.test(targetDescription)) {
    throw new Error(
      "Refusing a target whose host or database name appears production-like.",
    );
  }

  return { uri, environment };
}

async function readUsersForReport() {
  return User.find({})
    .select(
      "_id phone phoneVerifiedAt phoneVerificationSource googleId createdAt",
    )
    .select("+password")
    .sort({ _id: 1 })
    .read("secondaryPreferred")
    .lean()
    .exec();
}

async function main() {
  assertReportOnlyInvocation();
  const { uri } = getApprovedTargetFromEnvironment();

  mongoose.set("autoCreate", false);
  mongoose.set("autoIndex", false);

  try {
    await mongoose.connect(uri, {
      autoCreate: false,
      autoIndex: false,
      readPreference: "secondaryPreferred",
      serverSelectionTimeoutMS: 10000,
    });
    const report = buildReport(await readUsersForReport());
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Verified-phone report failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildReport,
  getApprovedTargetFromEnvironment,
  normalizePhone,
};
