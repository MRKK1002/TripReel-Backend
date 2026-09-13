/*
 * TripReel local synthetic end-to-end runner.
 *
 * Safety properties:
 * - Always uses a unique MongoDB database on 127.0.0.1.
 * - Refuses non-loopback/non-E2E database URIs.
 * - Disables cron scheduling.
 * - Fakes Razorpay, refunds, email and Firebase; blocks external fetch calls.
 * - Uses synthetic KYC/image bytes only.
 * - Drops only the run-owned database and deletes only uploads created by this run.
 *
 * Run: node test/e2e-local.cjs
 */

"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const RUN_ID = `${Date.now()}-${process.pid}`;
const DB_NAME = `tripreel_e2e_${RUN_ID.replace(/\D/g, "")}`;
const PORT = 5011;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const MONGO_URI = `mongodb://127.0.0.1:27017/${DB_NAME}`;
const E2E_OTP = "654321";
const ROOT = path.resolve(__dirname, "..");
const UPLOAD_ROOT = path.join(ROOT, "uploads");

function assertSafeDatabaseUri(uri) {
  const parsed = new URL(uri);
  assert.ok(
    ["127.0.0.1", "localhost"].includes(parsed.hostname),
    `E2E database must be loopback, got ${parsed.hostname}`,
  );
  const dbName = parsed.pathname.replace(/^\//, "");
  assert.ok(
    dbName.startsWith("tripreel_e2e_"),
    `E2E database name must start with tripreel_e2e_, got ${dbName}`,
  );
}

assertSafeDatabaseUri(MONGO_URI);

// Set every safety-sensitive value before dotenv/server modules load.
Object.assign(process.env, {
  mongodburl: MONGO_URI,
  PORT: String(PORT),
  NODE_ENV: "test",
  JWT_SECRET: `local-e2e-jwt-${RUN_ID}`,
  JWT_EXPIRES_IN: "1h",
  OTP_DEV_MODE: "true",
  DISABLE_RATE_LIMIT: "true",
  PAYOUT_MODE: "manual",
  RAZORPAY_KEY_ID: "rzp_test_tripreel_local",
  RAZORPAY_KEY_SECRET: `local-e2e-razorpay-${RUN_ID}`,
  RAZORPAY_WEBHOOK_SECRET: `local-e2e-webhook-${RUN_ID}`,
  RAPIDSMS_API_KEY: "",
  SMTP_HOST: "",
  SMTP_USER: "",
  SMTP_PASS: "",
  SNAPJA_API_KEY: "",
  FIREBASE_PROJECT_ID: "",
  FIREBASE_CLIENT_EMAIL: "",
  FIREBASE_PRIVATE_KEY: "",
  CORS_ORIGINS: "http://127.0.0.1:5173",
});

function listFilesRecursively(root) {
  const files = new Set();
  if (!fs.existsSync(root)) return files;
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else files.add(path.resolve(full));
    }
  };
  visit(root);
  return files;
}

const uploadsBefore = listFilesRecursively(UPLOAD_ROOT);

// Deterministic operator OTP while preserving otpStore's private maps and limits.
const otpStore = require("../utils/otpStore");
const originalSetOtp = otpStore.setOtp;
otpStore.setOtp = (channel, value) => {
  const originalRandom = Math.random;
  Math.random = () => 0.615913; // generateOtp() => 654321
  try {
    return originalSetOtp(channel, value);
  } finally {
    Math.random = originalRandom;
  }
};

const fakeState = {
  orders: new Map(),
  payments: new Map(),
  refunds: [],
  emails: [],
  pushes: [],
  orderSequence: 0,
  refundSequence: 0,
};
global.__TRIPREEL_E2E_FAKE_STATE__ = fakeState;

class FakeRazorpay {
  constructor() {
    this.orders = {
      create: async (options) => {
        const id = `order_e2e_${++fakeState.orderSequence}`;
        const order = {
          id,
          amount: options.amount,
          amount_paid: options.amount,
          currency: options.currency || "INR",
          receipt: options.receipt,
          notes: options.notes || {},
          status: "paid",
        };
        fakeState.orders.set(id, order);
        return { ...order };
      },
      fetch: async (id) => {
        const order = fakeState.orders.get(id);
        if (!order) throw new Error(`Fake Razorpay order not found: ${id}`);
        return { ...order };
      },
      fetchPayments: async (id) => ({
        items: [...fakeState.payments.values()].filter(
          (payment) => payment.order_id === id,
        ),
      }),
    };
    this.payments = {
      fetch: async (id) => {
        const payment = fakeState.payments.get(id);
        if (!payment) throw new Error(`Fake Razorpay payment not found: ${id}`);
        return { ...payment };
      },
      refund: async (id, options) => {
        if (!fakeState.payments.has(id)) {
          throw new Error(`Fake Razorpay payment not found for refund: ${id}`);
        }
        // Make concurrent cancellation races observable without external money.
        await new Promise((resolve) => setTimeout(resolve, 100));
        const refund = {
          id: `rfnd_e2e_${++fakeState.refundSequence}`,
          payment_id: id,
          amount: options.amount,
          status: "processed",
          notes: options.notes || {},
        };
        fakeState.refunds.push(refund);
        return refund;
      },
    };
  }
}

const fakeCron = {
  schedule: () => ({ start() {}, stop() {}, destroy() {} }),
  validate: () => true,
};

const fakeNodemailer = {
  createTransport: () => ({
    verify: async () => true,
    sendMail: async (mail) => {
      fakeState.emails.push({ to: mail.to, subject: mail.subject });
      return {
        messageId: `mail_e2e_${fakeState.emails.length}`,
        accepted: [mail.to],
      };
    },
  }),
};

const fakeFirebaseAdmin = {
  apps: [],
  credential: { cert: () => ({}) },
  initializeApp() {
    const app = { name: "e2e" };
    this.apps.push(app);
    return app;
  },
  messaging() {
    return {
      send: async (message) => {
        fakeState.pushes.push(message);
        return `push_e2e_${fakeState.pushes.length}`;
      },
      sendEachForMulticast: async (message) => ({
        successCount: message.tokens?.length || 0,
        failureCount: 0,
        responses: [],
      }),
      sendToTopic: async () => `topic_e2e_${fakeState.pushes.length + 1}`,
    };
  },
};

const originalModuleLoad = Module._load;
Module._load = function tripreelE2ELoad(request, parent, isMain) {
  if (request === "razorpay") return FakeRazorpay;
  if (request === "node-cron") return fakeCron;
  if (request === "nodemailer") return fakeNodemailer;
  if (request === "firebase-admin") return fakeFirebaseAdmin;
  return originalModuleLoad.call(this, request, parent, isMain);
};

// Fail closed for all outbound fetch calls. Local API calls use native fetch.
const nativeFetch = global.fetch.bind(global);
global.fetch = async (input, init) => {
  const raw = typeof input === "string" ? input : input?.url;
  const target = new URL(raw);
  if (["127.0.0.1", "localhost"].includes(target.hostname)) {
    return nativeFetch(input, init);
  }
  throw new Error(`E2E outbound network blocked: ${target.hostname}`);
};

const results = [];
function record(name, passed, evidence = "") {
  const entry = {
    name,
    passed: Boolean(passed),
    evidence: String(evidence || ""),
  };
  results.push(entry);
  console.log(
    `${entry.passed ? "PASS" : "FAIL"} | ${name}${entry.evidence ? ` | ${entry.evidence}` : ""}`,
  );
  return entry.passed;
}

function requireValue(value, label) {
  if (value == null || value === "")
    throw new Error(`Missing required test value: ${label}`);
  return value;
}

async function waitForHealth() {
  const deadline = Date.now() + 30000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await nativeFetch(`${BASE_URL}/`);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Backend did not become healthy: ${lastError?.message || "timeout"}`,
  );
}

async function api(route, { method = "GET", token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const response = await nativeFetch(`${BASE_URL}${route}`, {
    method,
    headers,
    body: form || (json !== undefined ? JSON.stringify(json) : undefined),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, text };
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

function tinyPngBlob() {
  // Middleware checks extension + MIME. Contents are intentionally synthetic.
  return new Blob([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")], {
    type: "image/png",
  });
}

function appendJson(form, key, value) {
  form.append(key, JSON.stringify(value));
}

function isoDaysFromNow(days, hour = 10) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

function dateOnlyDaysFromNow(days) {
  return isoDaysFromNow(days).slice(0, 10);
}

function listContainsId(responseBody, id) {
  return JSON.stringify(responseBody).includes(String(id));
}

async function main() {
  console.log(`SAFETY | database=${MONGO_URI} | api=${BASE_URL}`);
  require("../server");
  const health = await waitForHealth();
  record(
    "Backend health on isolated local database",
    health?.status === "OK",
    JSON.stringify(health),
  );

  const mongoose = require("mongoose");
  const User = require("../models/User");
  const { Operator } = require("../models/Operator");
  const Package = require("../models/Package");
  const Batch = require("../models/Batch");
  const FlexibleAvailability = require("../models/FlexibleAvailability");
  const FlexibleDateInventory = require("../models/FlexibleDateInventory");
  const Coupon = require("../models/Coupon");
  const PlatformCoupon = require("../models/PlatformCoupon");
  const PendingOrder = require("../models/PendingOrder");
  const TripBooking = require("../models/TripBooking");
  const Conversation = require("../models/Conversation");
  const Message = require("../models/Message");
  const OperatorWallet = require("../models/OperatorWallet");
  const WalletTransaction = require("../models/WalletTransaction");
  const Withdrawal = require("../models/Withdrawal");
  const {
    getISTDateKey,
    addDaysToDateKey,
    getISTDayRange,
    isDateKeyPastInclusiveEnd,
  } = require("../utils/businessDate");

  const boundaryKey = "2026-01-15";
  record(
    "Inclusive IST final day expires only at the next IST midnight",
    isDateKeyPastInclusiveEnd(
      boundaryKey,
      new Date("2026-01-15T18:29:59.999Z"),
    ) === false &&
      isDateKeyPastInclusiveEnd(
        boundaryKey,
        new Date("2026-01-15T18:30:00.000Z"),
      ) === true,
    `boundary=${boundaryKey}`,
  );

  assert.strictEqual(
    mongoose.connection.name,
    DB_NAME,
    "Connected database is not the run-owned E2E database",
  );

  const suffix = String(Date.now()).slice(-6);
  const adminEmail = `e2e.admin.${suffix}@example.test`;
  const operatorEmail = `e2e.operator.${suffix}@example.test`;
  const customerEmail = `e2e.customer.${suffix}@example.test`;
  const secondOperatorEmail = `e2e.operator2.${suffix}@example.test`;
  const operatorPhone = "+971553406800";
  const customerPhone = `8${String(Date.now() + 1).slice(-9)}`;
  const secondOperatorPhone = `+917${String(Date.now() + 2).slice(-9)}`;
  const adminPassword = "LocalOnly-Admin-123!";
  const operatorPassword = "LocalOnly-Operator-123!";

  // Admin fixture is intentionally direct; admin creation is not a public API flow.
  await User.create({
    name: "Synthetic E2E Admin",
    email: adminEmail,
    phone: `6${String(Date.now() + 3).slice(-9)}`,
    phoneVerifiedAt: new Date(),
    phoneVerificationSource: "legacy_audited_otp",
    password: adminPassword,
    role: "admin",
  });
  const adminLogin = await api("/api/auth/login", {
    method: "POST",
    json: { email: adminEmail, password: adminPassword },
  });
  record(
    "Admin login through API",
    adminLogin.status === 200 && Boolean(adminLogin.body.token),
    `status=${adminLogin.status}`,
  );
  const adminToken = requireValue(adminLogin.body.token, "admin token");

  // Operator registration verifies email only. Phone is contact information and
  // must not trigger SMS delivery or become verified implicitly.
  const phoneOtpDisabled = await api("/api/operators/auth/send-otp", {
    method: "POST",
    json: { channel: "phone", value: operatorPhone },
  });
  record(
    "Operator registration phone OTP is disabled",
    phoneOtpDisabled.status === 400,
    `status=${phoneOtpDisabled.status}`,
  );

  const emailOtpSend = await api("/api/operators/auth/send-otp", {
    method: "POST",
    json: { channel: "email", value: operatorEmail },
  });
  record(
    "Operator email OTP dispatch through mocked mailer",
    emailOtpSend.status === 200,
    `status=${emailOtpSend.status}`,
  );
  const emailOtpVerify = await api("/api/operators/auth/verify-otp", {
    method: "POST",
    json: { channel: "email", value: operatorEmail, otp: E2E_OTP },
  });
  record(
    "Operator email OTP verification",
    emailOtpVerify.status === 200,
    `status=${emailOtpVerify.status}`,
  );

  const malformedPhoneRegister = await api("/api/operators/auth/register", {
    method: "POST",
    json: {
      contactName: "Synthetic Operator",
      email: operatorEmail,
      phone: "+971123",
      password: operatorPassword,
    },
  });
  record(
    "Operator registration rejects malformed international phone",
    malformedPhoneRegister.status === 400 &&
      malformedPhoneRegister.body.field === "phone",
    `status=${malformedPhoneRegister.status}, field=${malformedPhoneRegister.body.field || ""}`,
  );

  const operatorRegister = await api("/api/operators/auth/register", {
    method: "POST",
    json: {
      contactName: "Synthetic Operator",
      email: operatorEmail,
      phone: operatorPhone,
      password: operatorPassword,
    },
  });
  record(
    "Operator registration requires email OTP only",
    operatorRegister.status === 201 && Boolean(operatorRegister.body.token),
    `status=${operatorRegister.status}`,
  );
  const operatorToken = requireValue(
    operatorRegister.body.token,
    "operator token",
  );
  const operatorId = requireValue(
    operatorRegister.body.operator?._id,
    "operator id",
  );
  const registeredOperator = await Operator.findById(operatorId).lean();
  record(
    "Operator stores UAE E.164 phone without marking it verified",
    registeredOperator?.phone === operatorPhone &&
      registeredOperator?.phoneVerified === false &&
      registeredOperator?.emailVerified === true,
    `phone=${registeredOperator?.phone || "missing"}, phoneVerified=${registeredOperator?.phoneVerified}, emailVerified=${registeredOperator?.emailVerified}`,
  );

  const internationalPhoneRecovery = await api(
    "/api/operators/auth/forgot-password",
    {
      method: "POST",
      json: { method: "phone", value: operatorPhone },
    },
  );
  record(
    "Unverified international phone is not offered as a recovery channel",
    internationalPhoneRecovery.status === 400,
    `status=${internationalPhoneRecovery.status}`,
  );

  await Operator.updateOne(
    { _id: operatorId },
    { $set: { phoneVerified: true } },
  );
  const changedPhone = "+971501234567";
  const changedPhoneProfile = await api("/api/operators/auth/profile", {
    method: "PATCH",
    token: operatorToken,
    json: { phone: changedPhone },
  });
  record(
    "Changing a verified operator phone clears verification",
    changedPhoneProfile.status === 200 &&
      changedPhoneProfile.body.operator?.phone === changedPhone &&
      changedPhoneProfile.body.operator?.phoneVerified === false,
    `status=${changedPhoneProfile.status}, phone=${changedPhoneProfile.body.operator?.phone || "missing"}, phoneVerified=${changedPhoneProfile.body.operator?.phoneVerified}`,
  );
  const restoredPhoneProfile = await api("/api/operators/auth/profile", {
    method: "PATCH",
    token: operatorToken,
    json: { phone: operatorPhone },
  });
  record(
    "Profile preserves canonical UAE phone after editing",
    restoredPhoneProfile.status === 200 &&
      restoredPhoneProfile.body.operator?.phone === operatorPhone &&
      restoredPhoneProfile.body.operator?.phoneVerified === false,
    `status=${restoredPhoneProfile.status}, phone=${restoredPhoneProfile.body.operator?.phone || "missing"}`,
  );

  const blockedDraft = new FormData();
  blockedDraft.append("submissionMode", "DRAFT");
  blockedDraft.append("title", `Blocked Package ${suffix}`);
  const blockedCreate = await api("/api/packages/operator", {
    method: "POST",
    token: operatorToken,
    form: blockedDraft,
  });
  record(
    "Unapproved operator cannot create packages",
    blockedCreate.status === 403 &&
      blockedCreate.body.code === "OPERATOR_NOT_APPROVED",
    `status=${blockedCreate.status}, code=${blockedCreate.body.code || ""}`,
  );

  const onboarding = new FormData();
  const onboardingFields = {
    contactName: "Synthetic Operator",
    phone: operatorPhone,
    businessName: "Synthetic Travel Company",
    businessType: "TOUR_OPERATOR",
    country: "India",
    state: "Goa",
    city: "Panaji",
    mainOperatingDestinations: JSON.stringify(["Panaji", "North Goa"]),
    accountHolderName: "Synthetic Operator",
    bankName: "Synthetic Test Bank",
    accountNumber: "123456789012",
    ifscCode: "SBIN0001234",
    upiId: "synthetic@upi",
    agreedToPolicies: "true",
    confirmedAccuracy: "true",
  };
  for (const [key, value] of Object.entries(onboardingFields))
    onboarding.append(key, value);
  onboarding.append(
    "governmentId",
    tinyPngBlob(),
    `synthetic-government-${RUN_ID}.png`,
  );
  onboarding.append("panCard", tinyPngBlob(), `synthetic-pan-${RUN_ID}.png`);
  const onboardingSubmit = await api("/api/operators/onboarding", {
    method: "POST",
    token: operatorToken,
    form: onboarding,
  });
  record(
    "Synthetic KYC onboarding submission",
    onboardingSubmit.status === 200 &&
      onboardingSubmit.body.operator?.onboardingState === "PENDING_APPROVAL" &&
      onboardingSubmit.body.operator?.phone === operatorPhone &&
      onboardingSubmit.body.operator?.phoneVerified === false,
    `status=${onboardingSubmit.status}, state=${onboardingSubmit.body.operator?.onboardingState || ""}`,
  );

  // Safety assertion: approval must not accept mandatory documents still PENDING.
  const earlyApproval = await api(`/api/operators/${operatorId}/state`, {
    method: "PATCH",
    token: adminToken,
    json: {
      newState: "APPROVED",
      note: "E2E must reject while mandatory documents are pending",
    },
  });
  record(
    "Operator approval rejects mandatory KYC documents still PENDING",
    earlyApproval.status === 400,
    `status=${earlyApproval.status}, resultingState=${earlyApproval.body.operator?.onboardingState || "unchanged/unknown"}`,
  );

  for (const key of ["governmentId", "panCard"]) {
    const docApproval = await api(
      `/api/operators/${operatorId}/document-status`,
      {
        method: "PATCH",
        token: adminToken,
        json: {
          key,
          status: "APPROVED",
          remark: "Synthetic document reviewed in local E2E",
        },
      },
    );
    record(
      `Admin explicitly approves ${key}`,
      docApproval.status === 200 &&
        docApproval.body.operator?.documentStatus?.[key]?.status === "APPROVED",
      `status=${docApproval.status}`,
    );
  }

  let operatorState = await Operator.findById(operatorId).lean();
  if (operatorState.onboardingState !== "APPROVED") {
    const approval = await api(`/api/operators/${operatorId}/state`, {
      method: "PATCH",
      token: adminToken,
      json: {
        newState: "APPROVED",
        note: "Synthetic local approval after document review",
      },
    });
    record(
      "Admin approves operator after document review",
      approval.status === 200 &&
        approval.body.operator?.onboardingState === "APPROVED",
      `status=${approval.status}`,
    );
  }
  operatorState = await Operator.findById(operatorId).lean();
  record(
    "Operator final onboarding state is APPROVED",
    operatorState?.onboardingState === "APPROVED",
    `state=${operatorState?.onboardingState}`,
  );
  const approvedOperatorLogin = await api("/api/operators/auth/login", {
    method: "POST",
    json: { email: operatorEmail, password: operatorPassword },
  });
  record(
    "Approved operator can log in with approved identity",
    approvedOperatorLogin.status === 200 &&
      Boolean(approvedOperatorLogin.body.token) &&
      String(approvedOperatorLogin.body.operator?._id) === String(operatorId) &&
      approvedOperatorLogin.body.operator?.onboardingState === "APPROVED",
    `status=${approvedOperatorLogin.status}, token=${Boolean(approvedOperatorLogin.body.token)}, operatorId=${approvedOperatorLogin.body.operator?._id || "missing"}, state=${approvedOperatorLogin.body.operator?.onboardingState || "missing"}`,
  );

  async function createAndApprovePackage({ title, bookingMode }) {
    const draftForm = new FormData();
    draftForm.append("submissionMode", "DRAFT");
    draftForm.append("title", title);
    const draft = await api("/api/packages/operator", {
      method: "POST",
      token: operatorToken,
      form: draftForm,
    });
    record(
      `${title}: operator saves DRAFT`,
      draft.status === 201 && draft.body.package?.status === "DRAFT",
      `status=${draft.status}, packageStatus=${draft.body.package?.status || ""}`,
    );
    const packageId = requireValue(
      draft.body.package?._id,
      `${title} package id`,
    );

    const submitForm = new FormData();
    const fields = {
      submissionMode: "SUBMIT",
      title,
      bookingMode,
      location: "Panaji, Goa",
      destination: "Panaji, Goa",
      country: "India",
      state: "Goa",
      city: "Panaji",
      price: bookingMode === "batch" ? "1000" : "1200",
      durationDays: "2",
      durationNights: "1",
      itinerary: JSON.stringify([
        {
          day: 1,
          title: "Synthetic arrival",
          points: ["Synthetic stop"],
          pickupPoint: "Panaji Bus Stand",
          pickupTime: "10:00",
          pickupLat: 15.4909,
          pickupLng: 73.8278,
        },
        {
          day: 2,
          title: "Synthetic departure",
          points: [],
          pickupPoint: "Dona Paula Circle",
          pickupTime: "09:30",
          pickupLat: 15.4589,
          pickupLng: 73.806,
        },
      ]),
      pricing: JSON.stringify({
        adultPrice: bookingMode === "batch" ? 1000 : 1200,
        childPrice: bookingMode === "batch" ? 600 : 700,
      }),
      inclusions: JSON.stringify(["Synthetic inclusion"]),
      exclusions: JSON.stringify(["Synthetic exclusion"]),
    };
    for (const [key, value] of Object.entries(fields))
      submitForm.append(key, value);
    submitForm.append(
      "image_url",
      tinyPngBlob(),
      `synthetic-package-${RUN_ID}-${bookingMode}.png`,
    );
    const submit = await api(`/api/packages/operator/${packageId}`, {
      method: "PUT",
      token: operatorToken,
      form: submitForm,
    });
    record(
      `${title}: operator submits for review`,
      submit.status === 200 &&
        submit.body.package?.status === "PENDING" &&
        submit.body.package?.isActive === false,
      `status=${submit.status}, packageStatus=${submit.body.package?.status || ""}, active=${submit.body.package?.isActive}`,
    );

    const beforeApprovalList = await api("/api/packages?limit=100");
    record(
      `${title}: PENDING package excluded from public discovery`,
      beforeApprovalList.status === 200 &&
        !listContainsId(beforeApprovalList.body, packageId),
      `status=${beforeApprovalList.status}`,
    );
    const pendingDetail = await api(`/api/packages/${packageId}`);
    record(
      `${title}: PENDING package blocked from public detail`,
      pendingDetail.status === 404 || pendingDetail.status === 403,
      `status=${pendingDetail.status}`,
    );

    const review = await api(`/api/packages/${packageId}/review`, {
      method: "PATCH",
      token: adminToken,
      json: {
        action: "approve",
        adminNotes: "Synthetic local package approval",
      },
    });
    record(
      `${title}: admin approval`,
      review.status === 200 &&
        review.body.package?.status === "APPROVED" &&
        review.body.package?.isActive === true,
      `status=${review.status}, packageStatus=${review.body.package?.status || ""}`,
    );
    const afterApprovalList = await api("/api/packages?limit=100");
    record(
      `${title}: APPROVED package appears in public discovery`,
      afterApprovalList.status === 200 &&
        listContainsId(afterApprovalList.body, packageId),
      `status=${afterApprovalList.status}`,
    );
    const approvedDetail = await api(`/api/packages/${packageId}`);
    record(
      `${title}: APPROVED package public detail`,
      approvedDetail.status === 200 &&
        listContainsId(approvedDetail.body, packageId),
      `status=${approvedDetail.status}`,
    );
    return packageId;
  }

  const batchPackageId = await createAndApprovePackage({
    title: `Synthetic Batch Goa ${suffix}`,
    bookingMode: "batch",
  });
  const flexPackageId = await createAndApprovePackage({
    title: `Synthetic Flexible Goa ${suffix}`,
    bookingMode: "flexible",
  });

  const batchCreate = await api("/api/batches", {
    method: "POST",
    token: operatorToken,
    json: {
      packageId: batchPackageId,
      startDate: isoDaysFromNow(30),
      endDate: isoDaysFromNow(32),
      bookingDeadline: isoDaysFromNow(25),
      adultPrice: 1000,
      childPrice: 600,
      totalSeats: 10,
      label: "Synthetic E2E Batch",
    },
  });
  record(
    "Operator creates approved package batch inventory",
    batchCreate.status === 201 && batchCreate.body.batch?.bookedSeats === 0,
    `status=${batchCreate.status}`,
  );
  const batchId = requireValue(batchCreate.body.batch?._id, "batch id");

  const flexCreate = await api("/api/flexible-availability", {
    method: "POST",
    token: operatorToken,
    json: {
      packageId: flexPackageId,
      startDate: dateOnlyDaysFromNow(40),
      endDate: dateOnlyDaysFromNow(50),
      adultPrice: 1200,
      childPrice: 700,
      maxBookings: 5,
    },
  });
  record(
    "Operator creates flexible availability",
    flexCreate.status === 201,
    `status=${flexCreate.status}`,
  );
  const flexAvailabilityId = requireValue(
    flexCreate.body.item?._id,
    "flex availability id",
  );
  record(
    "Flexible availability preserves operator maxBookings",
    Number(flexCreate.body.item?.maxBookings) === 5,
    `requested=5, persisted=${flexCreate.body.item?.maxBookings}`,
  );

  const couponCode = `E2E${suffix}`;
  const couponCreate = await api("/api/coupons", {
    method: "POST",
    token: operatorToken,
    json: {
      batchId,
      code: couponCode,
      type: "percentage",
      value: 10,
      maxDiscount: 500,
      minGuests: 1,
      minOrderAmount: 0,
      usageLimit: 10,
      validUntil: isoDaysFromNow(20),
      description: "Synthetic operator coupon",
    },
  });
  record(
    "Operator creates batch coupon",
    couponCreate.status === 201 &&
      couponCreate.body.coupon?.code === couponCode,
    `status=${couponCreate.status}`,
  );
  const couponId = requireValue(
    couponCreate.body.coupon?._id,
    "operator coupon id",
  );

  const platformCouponCode = `PLAT${suffix}`;
  const platformCouponCreate = await api("/api/platform-coupons/admin", {
    method: "POST",
    token: adminToken,
    json: {
      code: platformCouponCode,
      type: "flat",
      value: 100,
      maxDiscount: 100,
      minOrderAmount: 0,
      minGuests: 1,
      firstBookingOnly: false,
      appliesTo: "all",
      usageLimit: 10,
      perUserLimit: 10,
      validUntil: isoDaysFromNow(20),
      isActive: true,
      featured: true,
      description: "Synthetic platform coupon",
    },
  });
  record(
    "Admin creates platform coupon",
    platformCouponCreate.status === 201 || platformCouponCreate.status === 200,
    `status=${platformCouponCreate.status}`,
  );

  const signupSend = await api("/api/auth/signup/send-otp", {
    method: "POST",
    json: {
      name: "Synthetic Customer",
      email: customerEmail,
      phone: customerPhone,
      state: "Goa",
      country: "India",
    },
  });
  record(
    "Customer signup OTP request in local dev mode",
    signupSend.status === 200 && Boolean(signupSend.body.otp),
    `status=${signupSend.status}, otpReturned=${Boolean(signupSend.body.otp)}`,
  );
  const signupVerify = await api("/api/auth/signup/verify-otp", {
    method: "POST",
    json: { phone: customerPhone, code: signupSend.body.otp },
  });
  record(
    "Customer verifies OTP and receives session",
    signupVerify.status === 201 && Boolean(signupVerify.body.token),
    `status=${signupVerify.status}`,
  );
  const customerToken = requireValue(signupVerify.body.token, "customer token");
  const customerId = requireValue(signupVerify.body.user?._id, "customer id");

  const couponValidate = await api("/api/coupons/validate", {
    method: "POST",
    token: customerToken,
    json: {
      batchId,
      code: couponCode,
      guests: 1,
      subtotal: 1000,
    },
  });
  record(
    "Customer validates operator coupon",
    couponValidate.status === 200 && couponValidate.body.success !== false,
    `status=${couponValidate.status}`,
  );

  const platformCouponValidate = await api("/api/platform-coupons/validate", {
    method: "POST",
    token: customerToken,
    json: {
      code: platformCouponCode,
      packageId: batchPackageId,
      fareSubtotal: 1000,
      seats: 1,
    },
  });
  record(
    "Customer validates platform coupon",
    platformCouponValidate.status === 200 &&
      platformCouponValidate.body.success !== false,
    `status=${platformCouponValidate.status}`,
  );

  let paymentSequence = 0;
  async function createPaymentOrder({
    packageId,
    batchId: chosenBatchId,
    bookingMode = "batch",
    flexAvailabilityId: chosenFlexId,
    flexStartDate,
    couponCode: chosenCoupon = "",
    platformCouponCode: chosenPlatformCoupon = "",
    seats = 1,
  }) {
    const sequence = ++paymentSequence;
    const travelers = Array.from({ length: seats }, (_, index) => ({
      name: `Synthetic Traveller ${sequence}-${index + 1}`,
      age: 30,
      gender: "Other",
    }));
    const orderCreate = await api("/api/payments/create-order", {
      method: "POST",
      token: customerToken,
      json: {
        packageId,
        batchId: chosenBatchId || null,
        bookingMode,
        flexAvailabilityId: chosenFlexId || null,
        flexStartDate: flexStartDate || null,
        seats,
        couponCode: chosenCoupon,
        platformCouponCode: chosenPlatformCoupon,
        travelers,
        addonDays: null,
        addonSchedule: null,
      },
    });
    record(
      `Payment order created (${bookingMode}, #${sequence})`,
      orderCreate.status === 200 && Boolean(orderCreate.body.razorpayOrderId),
      `status=${orderCreate.status}, amount=${orderCreate.body.amount}, message=${orderCreate.body.message || ""}`,
    );
    const orderId = requireValue(
      orderCreate.body.razorpayOrderId,
      "fake Razorpay order id",
    );
    const order = requireValue(
      fakeState.orders.get(orderId),
      "fake Razorpay order",
    );
    return { sequence, travelers, orderCreate, orderId, order };
  }

  function captureFakePayment(orderContext) {
    const paymentId = `pay_e2e_${orderContext.sequence}`;
    fakeState.payments.set(paymentId, {
      id: paymentId,
      order_id: orderContext.orderId,
      amount: orderContext.order.amount,
      currency: "INR",
      status: "captured",
    });
    return paymentId;
  }

  async function verifyPaymentOrder(orderContext, paymentId) {
    const signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderContext.orderId}|${paymentId}`)
      .digest("hex");
    const verification = await api("/api/payments/verify", {
      method: "POST",
      token: customerToken,
      json: {
        razorpay_order_id: orderContext.orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
        orderId: orderContext.orderId,
        travelers: orderContext.travelers,
        addonSchedule: null,
      },
    });
    record(
      `Payment verified and booking confirmed (#${orderContext.sequence})`,
      verification.status === 200 && Boolean(verification.body.bookingId),
      `status=${verification.status}, bookingId=${verification.body.bookingId || ""}`,
    );
    return verification;
  }

  async function createPaidBooking(options) {
    const orderContext = await createPaymentOrder(options);
    const paymentId = captureFakePayment(orderContext);
    await verifyPaymentOrder(orderContext, paymentId);
    const booking = await TripBooking.findOne({
      razorpayPaymentId: paymentId,
    }).lean();
    requireValue(booking?._id, "persisted booking id");
    const pendingOrder = await PendingOrder.findOne({
      razorpayOrderId: orderContext.orderId,
    }).lean();
    record(
      `PendingOrder completed durably (#${orderContext.sequence})`,
      pendingOrder?.status === "completed" &&
        String(pendingOrder?.bookingId) === String(booking._id),
      `status=${pendingOrder?.status || "missing"}`,
    );
    return booking;
  }

  // Pre-charge validation must fail before any provider order or reservation.
  const rejectionTravelers = [
    { name: "Synthetic Rejection Traveller", age: 30, gender: "Other" },
  ];
  const orderCountBeforeModeGuards = fakeState.orders.size;
  const batchAsFlexible = await api("/api/payments/create-order", {
    method: "POST",
    token: customerToken,
    json: {
      packageId: batchPackageId,
      bookingMode: "flexible",
      flexAvailabilityId,
      flexStartDate: dateOnlyDaysFromNow(42),
      seats: 1,
      travelers: rejectionTravelers,
    },
  });
  const flexAsBatch = await api("/api/payments/create-order", {
    method: "POST",
    token: customerToken,
    json: {
      packageId: flexPackageId,
      bookingMode: "batch",
      batchId,
      seats: 1,
      travelers: rejectionTravelers,
    },
  });
  record(
    "Booking mode mismatches are rejected before provider order creation",
    batchAsFlexible.status === 400 &&
      flexAsBatch.status === 400 &&
      fakeState.orders.size === orderCountBeforeModeGuards,
    `statuses=${batchAsFlexible.status},${flexAsBatch.status}, orders=${fakeState.orders.size - orderCountBeforeModeGuards}`,
  );

  await Batch.updateOne(
    { _id: batchId },
    { $set: { bookingDeadline: isoDaysFromNow(-1) } },
  );
  const deadlineRejected = await api("/api/payments/create-order", {
    method: "POST",
    token: customerToken,
    json: {
      packageId: batchPackageId,
      bookingMode: "batch",
      batchId,
      seats: 1,
      travelers: rejectionTravelers,
    },
  });
  await Batch.updateOne(
    { _id: batchId },
    { $set: { bookingDeadline: isoDaysFromNow(25) } },
  );
  await Batch.updateOne(
    { _id: batchId },
    { $set: { totalSeats: 1, bookedSeats: 1 } },
  );
  const capacityRejected = await api("/api/payments/create-order", {
    method: "POST",
    token: customerToken,
    json: {
      packageId: batchPackageId,
      bookingMode: "batch",
      batchId,
      seats: 1,
      travelers: rejectionTravelers,
    },
  });
  await Batch.updateOne(
    { _id: batchId },
    { $set: { totalSeats: 10, bookedSeats: 0 } },
  );
  record(
    "Expired deadlines and exhausted capacity are rejected pre-charge",
    deadlineRejected.status === 400 && capacityRejected.status === 400,
    `deadline=${deadlineRejected.status}, capacity=${capacityRejected.status}`,
  );

  // Real pending checkout rows fence every referenced resource from deletion.
  const guardedBatchOrder = await createPaymentOrder({
    packageId: batchPackageId,
    batchId,
    couponCode,
  });
  const guardedFlexOrder = await createPaymentOrder({
    packageId: flexPackageId,
    bookingMode: "flexible",
    flexAvailabilityId,
    flexStartDate: dateOnlyDaysFromNow(42),
  });
  const guardedDeletes = await Promise.all([
    api(`/api/packages/operator/${batchPackageId}`, {
      method: "DELETE",
      token: operatorToken,
    }),
    api(`/api/batches/${batchId}`, {
      method: "DELETE",
      token: operatorToken,
    }),
    api(`/api/coupons/${couponId}`, {
      method: "DELETE",
      token: operatorToken,
    }),
    api(`/api/flexible-availability/${flexAvailabilityId}`, {
      method: "DELETE",
      token: operatorToken,
    }),
  ]);
  record(
    "Charged-capable pending checkout fences package, batch, coupon, and flexible deletion",
    guardedDeletes.every((response) => response.status === 409),
    `statuses=${guardedDeletes.map((response) => response.status).join(",")}`,
  );
  await PendingOrder.deleteMany({
    razorpayOrderId: {
      $in: [guardedBatchOrder.orderId, guardedFlexOrder.orderId],
    },
  });
  fakeState.orders.delete(guardedBatchOrder.orderId);
  fakeState.orders.delete(guardedFlexOrder.orderId);

  // A captured payment without /verify must be recovered once across racing workers.
  const orphanOrder = await createPaymentOrder({
    packageId: batchPackageId,
    batchId,
  });
  const orphanPaymentId = captureFakePayment(orphanOrder);
  await PendingOrder.updateOne(
    { razorpayOrderId: orphanOrder.orderId },
    {
      $set: {
        providerPaymentId: orphanPaymentId,
        paidAt: new Date(),
        finalizationState: "PENDING",
      },
    },
  );
  const {
    runOrphanPaymentRecovery,
  } = require("../controllers/paymentController");
  const orphanRuns = await Promise.all([
    runOrphanPaymentRecovery(),
    runOrphanPaymentRecovery(),
  ]);
  const orphanBooking = await TripBooking.findOne({
    razorpayPaymentId: orphanPaymentId,
  }).lean();
  const recoveredPending = await PendingOrder.findOne({
    razorpayOrderId: orphanOrder.orderId,
  }).lean();
  record(
    "Concurrent orphan-payment recovery finalizes captured payment exactly once",
    orphanRuns.reduce((sum, run) => sum + run.recovered, 0) === 1 &&
      Boolean(orphanBooking?._id) &&
      recoveredPending?.status === "completed" &&
      recoveredPending?.finalizationState === "COMPLETED",
    `recovered=${orphanRuns.reduce((sum, run) => sum + run.recovered, 0)}, booking=${Boolean(orphanBooking)}, state=${recoveredPending?.finalizationState}`,
  );
  const orphanCancel = orphanBooking
    ? await api(`/api/trip-bookings/${orphanBooking._id}/cancel`, {
        method: "POST",
        token: customerToken,
        json: { reason: "Reset orphan recovery inventory" },
      })
    : { status: 0 };
  record(
    "Recovered booking remains cancellable through durable refund flow",
    orphanCancel.status === 200,
    `status=${orphanCancel.status}`,
  );

  const batchBooking = await createPaidBooking({
    packageId: batchPackageId,
    batchId,
    couponCode,
  });
  let batchState = await Batch.findById(batchId).lean();
  let operatorCoupon = await Coupon.findById(couponId).lean();
  record(
    "Batch booking reserves exactly one seat",
    batchState?.bookedSeats === 1,
    `bookedSeats=${batchState?.bookedSeats}`,
  );
  record(
    "Confirmed booking consumes operator coupon once",
    operatorCoupon?.usedCount === 1,
    `usedCount=${operatorCoupon?.usedCount}`,
  );

  const myBookings = await api("/api/trip-bookings/my", {
    token: customerToken,
  });
  record(
    "Customer can list own confirmed booking",
    myBookings.status === 200 &&
      listContainsId(myBookings.body, batchBooking._id),
    `status=${myBookings.status}`,
  );
  const bookingConversation = await Conversation.findOne({
    bookingId: batchBooking._id,
  }).lean();
  const itineraryMessage = bookingConversation
    ? await Message.findOne({
        conversationId: bookingConversation._id,
        senderType: "operator",
        text: { $regex: "Your Itinerary", $options: "i" },
      }).lean()
    : null;
  record(
    "Booking confirmation automatically sends itinerary in chat",
    Boolean(itineraryMessage),
    `conversation=${Boolean(bookingConversation)}, itineraryMessage=${Boolean(itineraryMessage)}`,
  );
  const operatorBookings = await api("/api/operator-bookings", {
    token: operatorToken,
  });
  record(
    "Operator can list booking for owned package",
    operatorBookings.status === 200 &&
      listContainsId(operatorBookings.body, batchBooking._id),
    `status=${operatorBookings.status}`,
  );
  const preview = await api(
    `/api/trip-bookings/${batchBooking._id}/refund-preview`,
    { token: customerToken },
  );
  record(
    "Customer receives server-calculated refund preview",
    preview.status === 200 &&
      Number.isFinite(Number(preview.body.refundAmount)),
    `status=${preview.status}, refund=${preview.body.refundAmount}`,
  );

  const cancellation = await api(
    `/api/trip-bookings/${batchBooking._id}/cancel`,
    {
      method: "POST",
      token: customerToken,
      json: { reason: "Synthetic normal cancellation" },
    },
  );
  record(
    "Customer cancellation completes through mocked refund",
    cancellation.status === 200 &&
      cancellation.body.refundStatus === "REFUNDED",
    `status=${cancellation.status}, refundStatus=${cancellation.body.refundStatus || ""}`,
  );
  batchState = await Batch.findById(batchId).lean();
  operatorCoupon = await Coupon.findById(couponId).lean();
  record(
    "Normal cancellation restores batch seat",
    batchState?.bookedSeats === 0,
    `bookedSeats=${batchState?.bookedSeats}`,
  );
  record(
    "Normal cancellation restores operator coupon usage",
    operatorCoupon?.usedCount === 0,
    `usedCount=${operatorCoupon?.usedCount}`,
  );
  const lockedCouponUpdate = await api(`/api/coupons/${couponId}`, {
    method: "PUT",
    token: operatorToken,
    json: { value: 25 },
  });
  const allowedCouponUpdate = await api(`/api/coupons/${couponId}`, {
    method: "PUT",
    token: operatorToken,
    json: { description: "Synthetic immutable-history coupon" },
  });
  operatorCoupon = await Coupon.findById(couponId).lean();
  const immutableBookingSnapshot = await TripBooking.findById(
    batchBooking._id,
  ).lean();
  record(
    "Lifetime coupon use keeps commercial terms immutable after net usage returns to zero",
    lockedCouponUpdate.status === 409 &&
      allowedCouponUpdate.status === 200 &&
      operatorCoupon?.usedCount === 0 &&
      Number(operatorCoupon?.everUsedCount) >= 1 &&
      immutableBookingSnapshot?.pricing?.couponCode === couponCode &&
      Number(immutableBookingSnapshot?.pricing?.discountAmount) > 0,
    `locked=${lockedCouponUpdate.status}, allowed=${allowedCouponUpdate.status}, used=${operatorCoupon?.usedCount}, everUsed=${operatorCoupon?.everUsedCount}`,
  );
  const repeatedCancellation = await api(
    `/api/trip-bookings/${batchBooking._id}/cancel`,
    {
      method: "POST",
      token: customerToken,
      json: { reason: "Synthetic duplicate sequential cancellation" },
    },
  );
  record(
    "Sequential duplicate cancellation is rejected",
    repeatedCancellation.status === 400,
    `status=${repeatedCancellation.status}`,
  );

  // Concurrent cancellation against a separate booking exposes read-then-save races.
  const concurrentBooking = await createPaidBooking({
    packageId: batchPackageId,
    batchId,
    platformCouponCode,
  });
  let platformCoupon = await PlatformCoupon.findOne({
    code: platformCouponCode,
  }).lean();
  record(
    "Confirmed booking consumes platform coupon once",
    platformCoupon?.usedCount === 1 &&
      concurrentBooking.pricing?.platformCouponCode === platformCouponCode,
    `usedCount=${platformCoupon?.usedCount}, bookingCoupon=${concurrentBooking.pricing?.platformCouponCode || "missing"}`,
  );
  const concurrentResults = await Promise.all([
    api(`/api/trip-bookings/${concurrentBooking._id}/cancel`, {
      method: "POST",
      token: customerToken,
      json: { reason: "Synthetic concurrent cancellation A" },
    }),
    api(`/api/trip-bookings/${concurrentBooking._id}/cancel`, {
      method: "POST",
      token: customerToken,
      json: { reason: "Synthetic concurrent cancellation B" },
    }),
  ]);
  const concurrentSuccesses = concurrentResults.filter(
    (item) => item.status === 200,
  ).length;
  batchState = await Batch.findById(batchId).lean();
  platformCoupon = await PlatformCoupon.findOne({
    code: platformCouponCode,
  }).lean();
  record(
    "Concurrent cancellation restores platform coupon usage",
    platformCoupon?.usedCount === 0,
    `usedCount=${platformCoupon?.usedCount}`,
  );
  record(
    "Concurrent duplicate cancellation allows exactly one winner",
    concurrentSuccesses === 1,
    `successResponses=${concurrentSuccesses}, statuses=${concurrentResults.map((item) => item.status).join(",")}`,
  );
  record(
    "Concurrent cancellation keeps batch capacity non-negative",
    Number(batchState?.bookedSeats) === 0,
    `bookedSeats=${batchState?.bookedSeats}`,
  );
  const packageAfterConcurrentCancellation =
    await Package.findById(batchPackageId).lean();
  record(
    "Concurrent cancellation keeps package bookingCount non-negative",
    Number(packageAfterConcurrentCancellation?.bookingCount) === 0,
    `bookingCount=${packageAfterConcurrentCancellation?.bookingCount}`,
  );

  const flexBooking = await createPaidBooking({
    packageId: flexPackageId,
    bookingMode: "flexible",
    flexAvailabilityId,
    flexStartDate: dateOnlyDaysFromNow(42),
  });
  let flexState =
    await FlexibleAvailability.findById(flexAvailabilityId).lean();
  record(
    "Flexible booking increments bookedSeats",
    flexState?.bookedSeats === 1,
    `bookedSeats=${flexState?.bookedSeats}`,
  );
  const flexCancellation = await api(
    `/api/trip-bookings/${flexBooking._id}/cancel`,
    {
      method: "POST",
      token: customerToken,
      json: { reason: "Synthetic flexible cancellation" },
    },
  );
  record(
    "Flexible customer cancellation completes",
    flexCancellation.status === 200,
    `status=${flexCancellation.status}`,
  );
  flexState = await FlexibleAvailability.findById(flexAvailabilityId).lean();
  record(
    "Flexible cancellation restores flexible bookedSeats",
    flexState?.bookedSeats === 0,
    `bookedSeats=${flexState?.bookedSeats}`,
  );

  // Flexible capacity is isolated per selected start date, including both range edges.
  const todayKey = getISTDateKey();
  const flexEdgeStart = addDaysToDateKey(todayKey, 60);
  const flexEdgeEnd = addDaysToDateKey(todayKey, 65);
  const isolatedFlexCreate = await api("/api/flexible-availability", {
    method: "POST",
    token: operatorToken,
    json: {
      packageId: flexPackageId,
      startDate: flexEdgeStart,
      endDate: flexEdgeEnd,
      adultPrice: 1200,
      childPrice: 700,
      maxBookings: 1,
    },
  });
  const isolatedFlexId = requireValue(
    isolatedFlexCreate.body.item?._id,
    "isolated per-date flexible availability id",
  );
  const edgeStartBooking = await createPaidBooking({
    packageId: flexPackageId,
    bookingMode: "flexible",
    flexAvailabilityId: isolatedFlexId,
    flexStartDate: flexEdgeStart,
  });
  const providerOrdersBeforeFullDate = fakeState.orders.size;
  const fullStartDateAttempt = await api("/api/payments/create-order", {
    method: "POST",
    token: customerToken,
    json: {
      packageId: flexPackageId,
      bookingMode: "flexible",
      flexAvailabilityId: isolatedFlexId,
      flexStartDate: flexEdgeStart,
      seats: 1,
      travelers: rejectionTravelers,
    },
  });
  const edgeEndBooking = await createPaidBooking({
    packageId: flexPackageId,
    bookingMode: "flexible",
    flexAvailabilityId: isolatedFlexId,
    flexStartDate: flexEdgeEnd,
  });
  const beforeWindowAttempt = await api("/api/payments/create-order", {
    method: "POST",
    token: customerToken,
    json: {
      packageId: flexPackageId,
      bookingMode: "flexible",
      flexAvailabilityId: isolatedFlexId,
      flexStartDate: addDaysToDateKey(flexEdgeStart, -1),
      seats: 1,
      travelers: rejectionTravelers,
    },
  });
  const afterWindowAttempt = await api("/api/payments/create-order", {
    method: "POST",
    token: customerToken,
    json: {
      packageId: flexPackageId,
      bookingMode: "flexible",
      flexAvailabilityId: isolatedFlexId,
      flexStartDate: addDaysToDateKey(flexEdgeEnd, 1),
      seats: 1,
      travelers: rejectionTravelers,
    },
  });
  let edgeStartInventory = await FlexibleDateInventory.findOne({
    flexAvailabilityId: isolatedFlexId,
    startDateKey: flexEdgeStart,
  }).lean();
  let edgeEndInventory = await FlexibleDateInventory.findOne({
    flexAvailabilityId: isolatedFlexId,
    startDateKey: flexEdgeEnd,
  }).lean();
  record(
    "Flexible capacity is per selected date and range boundaries are inclusive",
    fullStartDateAttempt.status === 400 &&
      fakeState.orders.size === providerOrdersBeforeFullDate + 1 &&
      beforeWindowAttempt.status === 400 &&
      afterWindowAttempt.status === 400 &&
      edgeStartInventory?.capacity === 1 &&
      edgeStartInventory?.bookedSeats === 1 &&
      edgeEndInventory?.capacity === 1 &&
      edgeEndInventory?.bookedSeats === 1,
    `full=${fullStartDateAttempt.status}, outside=${beforeWindowAttempt.status}/${afterWindowAttempt.status}, start=${edgeStartInventory?.bookedSeats}/${edgeStartInventory?.capacity}, end=${edgeEndInventory?.bookedSeats}/${edgeEndInventory?.capacity}`,
  );
  await api(`/api/trip-bookings/${edgeStartBooking._id}/cancel`, {
    method: "POST",
    token: customerToken,
    json: { reason: "Release selected start-date inventory" },
  });
  edgeStartInventory = await FlexibleDateInventory.findOne({
    flexAvailabilityId: isolatedFlexId,
    startDateKey: flexEdgeStart,
  }).lean();
  edgeEndInventory = await FlexibleDateInventory.findOne({
    flexAvailabilityId: isolatedFlexId,
    startDateKey: flexEdgeEnd,
  }).lean();
  record(
    "Cancelling one flexible date does not release another date",
    edgeStartInventory?.bookedSeats === 0 &&
      edgeEndInventory?.bookedSeats === 1,
    `start=${edgeStartInventory?.bookedSeats}, end=${edgeEndInventory?.bookedSeats}`,
  );

  // Expired cancellation leases are safely claimed once by concurrent recovery workers.
  await TripBooking.updateOne(
    { _id: edgeEndBooking._id },
    {
      $set: {
        status: "CANCELLED",
        cancelledBy: "operator",
        cancelReason: "Synthetic expired cancellation lease",
        cancelledAt: new Date(),
        cancellationState: "PROCESSING",
        cancellationLeaseToken: "expired-e2e-lease",
        cancellationLeaseUntil: new Date(Date.now() - 60 * 1000),
        financialSettlementState: "NONE",
        refundStatus: "NONE",
      },
    },
  );
  const refundsBeforeCancellationRecovery = fakeState.refunds.length;
  const { runCancellationRecovery } = require("../controllers/cronController");
  const cancellationRecoveryRuns = await Promise.all([
    runCancellationRecovery(),
    runCancellationRecovery(),
  ]);
  const recoveredCancellation = await TripBooking.findById(
    edgeEndBooking._id,
  ).lean();
  edgeEndInventory = await FlexibleDateInventory.findOne({
    flexAvailabilityId: isolatedFlexId,
    startDateKey: flexEdgeEnd,
  }).lean();
  record(
    "Concurrent cancellation recovery completes an expired lease exactly once",
    cancellationRecoveryRuns.reduce((sum, run) => sum + run.completed, 0) ===
      1 &&
      recoveredCancellation?.cancellationState === "COMPLETED" &&
      edgeEndInventory?.bookedSeats === 0 &&
      fakeState.refunds.length === refundsBeforeCancellationRecovery + 1,
    `completed=${cancellationRecoveryRuns.reduce((sum, run) => sum + run.completed, 0)}, state=${recoveredCancellation?.cancellationState}, booked=${edgeEndInventory?.bookedSeats}`,
  );

  // Fast-forward one isolated booking to test concurrent trip completion and escrow release.
  const escrowBooking = await createPaidBooking({
    packageId: flexPackageId,
    bookingMode: "flexible",
    flexAvailabilityId,
    flexStartDate: dateOnlyDaysFromNow(45),
  });
  const walletBeforeEscrow = await OperatorWallet.findOne({
    operatorId,
  }).lean();
  const balanceBeforeEscrow = Number(walletBeforeEscrow?.balance) || 0;
  await TripBooking.updateOne(
    { _id: escrowBooking._id },
    {
      $set: {
        flexStartDate: isoDaysFromNow(-5),
        flexEndDate: isoDaysFromNow(-3),
        "snapshot.startDate": isoDaysFromNow(-5),
        "snapshot.endDate": isoDaysFromNow(-3),
      },
    },
  );
  const { runAutoCompleteAndCancel } = require("../controllers/cronController");
  const escrowRuns = await Promise.all([
    runAutoCompleteAndCancel(),
    runAutoCompleteAndCancel(),
  ]);
  const completedCount = escrowRuns.reduce(
    (sum, result) => sum + result.completed,
    0,
  );
  const walletReleaseCount = escrowRuns.reduce(
    (sum, result) => sum + result.walletReleased,
    0,
  );
  const completedEscrowBooking = await TripBooking.findById(
    escrowBooking._id,
  ).lean();
  const escrowWallet = await OperatorWallet.findOne({ operatorId }).lean();
  const escrowTransactionCount = await WalletTransaction.countDocuments({
    operatorId,
    bookingId: escrowBooking._id,
    type: "CREDIT",
  });
  const operatorAmount = Number(
    completedEscrowBooking?.pricing?.operatorAmount,
  );
  record(
    "Concurrent cron workers complete ended trip exactly once",
    completedCount === 1 && completedEscrowBooking?.status === "COMPLETED",
    `completed=${completedCount}, state=${completedEscrowBooking?.status}`,
  );
  record(
    "Concurrent escrow workers release operator funds exactly once",
    walletReleaseCount === 1 &&
      completedEscrowBooking?.walletReleased === true &&
      Number(escrowWallet?.balance) - balanceBeforeEscrow === operatorAmount &&
      escrowTransactionCount === 1,
    `walletReleased=${walletReleaseCount}, balanceDelta=${Number(escrowWallet?.balance) - balanceBeforeEscrow}, operatorAmount=${operatorAmount}, transactions=${escrowTransactionCount}`,
  );
  const secondEscrowRun = await runAutoCompleteAndCancel();
  const escrowWalletAfterRetry = await OperatorWallet.findOne({
    operatorId,
  }).lean();
  record(
    "Sequential escrow retry does not add another credit",
    secondEscrowRun.walletReleased === 0 &&
      escrowWalletAfterRetry?.balance === escrowWallet?.balance,
    `retryReleased=${secondEscrowRun.walletReleased}, balance=${escrowWalletAfterRetry?.balance}`,
  );

  // Reset to a deterministic isolated wallet fixture for withdrawal branches.
  await OperatorWallet.findOneAndUpdate(
    { operatorId },
    { $set: { balance: 2000, totalEarned: 2000, totalWithdrawn: 0 } },
    { upsert: true, new: true },
  );
  await WalletTransaction.create({
    operatorId,
    type: "CREDIT",
    amount: 2000,
    description: "Synthetic isolated E2E wallet fixture",
    balanceAfter: 2000,
  });
  const walletSummary = await api("/api/wallet", { token: operatorToken });
  record(
    "Operator wallet displays isolated fixture balance",
    walletSummary.status === 200 &&
      Number(walletSummary.body.wallet?.balance) === 2000,
    `status=${walletSummary.status}, balance=${walletSummary.body.wallet?.balance}`,
  );

  const withdrawalRequest = await api("/api/wallet/withdraw", {
    method: "POST",
    token: operatorToken,
    json: { amount: 1000, method: "bank_account" },
  });
  record(
    "Manual-mode withdrawal atomically debits and creates PENDING request",
    withdrawalRequest.status === 200 &&
      withdrawalRequest.body.withdrawal?.status === "PENDING" &&
      Number(withdrawalRequest.body.balance) === 1000,
    `status=${withdrawalRequest.status}, state=${withdrawalRequest.body.withdrawal?.status || ""}, balance=${withdrawalRequest.body.balance}`,
  );
  const withdrawalId = requireValue(
    withdrawalRequest.body.withdrawal?._id,
    "withdrawal id",
  );
  const secondInFlight = await api("/api/wallet/withdraw", {
    method: "POST",
    token: operatorToken,
    json: { amount: 500, method: "bank_account" },
  });
  record(
    "Second withdrawal is blocked while one is pending",
    secondInFlight.status === 400,
    `status=${secondInFlight.status}`,
  );
  const pendingWithdrawals = await api(
    "/api/wallet/admin/pending-withdrawals",
    { token: adminToken },
  );
  record(
    "Admin sees pending withdrawal",
    pendingWithdrawals.status === 200 &&
      listContainsId(pendingWithdrawals.body, withdrawalId),
    `status=${pendingWithdrawals.status}`,
  );
  const processWithdrawal = await api(
    `/api/wallet/admin/withdrawals/${withdrawalId}/process`,
    {
      method: "POST",
      token: adminToken,
      json: { utr: `LOCAL-E2E-${suffix}-1`, note: "Synthetic local transfer" },
    },
  );
  record(
    "Admin processes manual withdrawal",
    processWithdrawal.status === 200 &&
      processWithdrawal.body.withdrawal?.status === "PROCESSED",
    `status=${processWithdrawal.status}`,
  );
  let walletDb = await OperatorWallet.findOne({ operatorId }).lean();
  record(
    "Processed withdrawal increments totalWithdrawn once",
    walletDb?.totalWithdrawn === 1000,
    `totalWithdrawn=${walletDb?.totalWithdrawn}`,
  );
  const processAgain = await api(
    `/api/wallet/admin/withdrawals/${withdrawalId}/process`,
    {
      method: "POST",
      token: adminToken,
      json: { utr: `LOCAL-E2E-${suffix}-DUP`, note: "Duplicate attempt" },
    },
  );
  record(
    "Sequential duplicate withdrawal processing is rejected",
    processAgain.status === 400,
    `status=${processAgain.status}`,
  );

  // Rejection branch.
  const rejectedRequest = await api("/api/wallet/withdraw", {
    method: "POST",
    token: operatorToken,
    json: { amount: 500, method: "bank_account" },
  });
  const rejectedId = requireValue(
    rejectedRequest.body.withdrawal?._id,
    "rejection withdrawal id",
  );
  const rejectWithdrawal = await api(
    `/api/wallet/admin/withdrawals/${rejectedId}/reject`,
    {
      method: "POST",
      token: adminToken,
      json: { reason: "Synthetic rejection" },
    },
  );
  walletDb = await OperatorWallet.findOne({ operatorId }).lean();
  record(
    "Admin rejection returns held amount to wallet",
    rejectWithdrawal.status === 200 && walletDb?.balance === 1000,
    `status=${rejectWithdrawal.status}, balance=${walletDb?.balance}`,
  );

  // Concurrent terminal transition against a third withdrawal.
  const raceWithdrawalRequest = await api("/api/wallet/withdraw", {
    method: "POST",
    token: operatorToken,
    json: { amount: 500, method: "bank_account" },
  });
  const raceWithdrawalId = requireValue(
    raceWithdrawalRequest.body.withdrawal?._id,
    "race withdrawal id",
  );
  const terminalRace = await Promise.all([
    api(`/api/wallet/admin/withdrawals/${raceWithdrawalId}/process`, {
      method: "POST",
      token: adminToken,
      json: { utr: `LOCAL-E2E-${suffix}-RACE`, note: "Concurrent process" },
    }),
    api(`/api/wallet/admin/withdrawals/${raceWithdrawalId}/reject`, {
      method: "POST",
      token: adminToken,
      json: { reason: "Concurrent reject" },
    }),
  ]);
  const terminalWinners = terminalRace.filter(
    (item) => item.status === 200,
  ).length;
  const terminalWithdrawal = await Withdrawal.findById(raceWithdrawalId).lean();
  walletDb = await OperatorWallet.findOne({ operatorId }).lean();
  record(
    "Concurrent withdrawal process/reject allows exactly one terminal winner",
    terminalWinners === 1,
    `successResponses=${terminalWinners}, statuses=${terminalRace.map((item) => item.status).join(",")}, finalState=${terminalWithdrawal?.status}`,
  );
  record(
    "Concurrent withdrawal terminal race preserves coherent totals",
    !(
      terminalWithdrawal?.status === "FAILED" && walletDb?.totalWithdrawn > 1000
    ),
    `finalState=${terminalWithdrawal?.status}, balance=${walletDb?.balance}, totalWithdrawn=${walletDb?.totalWithdrawn}`,
  );

  // Tenant isolation with a second approved operator fixture and real login route.
  const secondOperator = await Operator.create({
    contactName: "Synthetic Second Operator",
    email: secondOperatorEmail,
    phone: secondOperatorPhone,
    password: operatorPassword,
    phoneVerified: true,
    emailVerified: true,
    onboardingState: "APPROVED",
    businessName: "Synthetic Other Travel",
    businessType: "TOUR_OPERATOR",
    country: "India",
    state: "Goa",
    city: "Margao",
    mainOperatingDestinations: ["Margao"],
    accountHolderName: "Synthetic Second Operator",
    bankName: "Synthetic Test Bank",
    accountNumber: "123456789013",
    ifscCode: "SBIN0001234",
    agreedToPolicies: true,
    confirmedAccuracy: true,
  });
  const secondLogin = await api("/api/operators/auth/login", {
    method: "POST",
    json: { email: secondOperatorEmail, password: operatorPassword },
  });
  record(
    "Second operator login returns its own authenticated identity",
    secondLogin.status === 200 &&
      Boolean(secondLogin.body.token) &&
      String(secondLogin.body.operator?._id) === String(secondOperator._id),
    `status=${secondLogin.status}, token=${Boolean(secondLogin.body.token)}, operatorId=${secondLogin.body.operator?._id || "missing"}`,
  );
  const secondOperatorToken = requireValue(
    secondLogin.body.token,
    "second operator token",
  );
  const secondOperatorBookings = await api("/api/operator-bookings", {
    token: secondOperatorToken,
  });
  record(
    "Second operator booking list excludes first operator data",
    secondOperatorBookings.status === 200 &&
      Number(secondOperatorBookings.body.total) === 0 &&
      Array.isArray(secondOperatorBookings.body.bookings) &&
      !listContainsId(secondOperatorBookings.body.bookings, batchBooking._id) &&
      !listContainsId(secondOperatorBookings.body.bookings, escrowBooking._id),
    `status=${secondOperatorBookings.status}, total=${secondOperatorBookings.body.total}, hasBatchBooking=${listContainsId(secondOperatorBookings.body.bookings || [], batchBooking._id)}, hasEscrowBooking=${listContainsId(secondOperatorBookings.body.bookings || [], escrowBooking._id)}`,
  );

  const ownedDetail = await api(`/api/operator-bookings/${batchBooking._id}`, {
    token: operatorToken,
  });
  const foreignDetail = await api(
    `/api/operator-bookings/${batchBooking._id}`,
    { token: secondOperatorToken },
  );
  record(
    "Owned booking detail is populated while foreign ownership returns 404",
    ownedDetail.status === 200 &&
      String(ownedDetail.body.booking?._id) === String(batchBooking._id) &&
      Boolean(ownedDetail.body.booking?.userId?.name) &&
      foreignDetail.status === 404,
    `owner=${ownedDetail.status}, foreign=${foreignDetail.status}`,
  );

  const scalePrefix = `E2ESCALE-${suffix}`;
  const scaleDocs = Array.from({ length: 205 }, (_, index) => ({
    bookingId: `${scalePrefix}-${String(index).padStart(3, "0")}`,
    userId: customerId,
    packageId: batchPackageId,
    batchId,
    operatorId,
    bookingMode: "batch",
    seats: 1,
    status: "CONFIRMED",
    snapshot: {
      packageTitle: "Synthetic Scale Package",
      startDate: addDaysToDateKey(todayKey, 100 + index),
      endDate: addDaysToDateKey(todayKey, 101 + index),
    },
    pricing: { seats: 1, operatorAmount: 0, totalAmount: 0 },
    createdAt: new Date(Date.now() - index * 1000),
    updatedAt: new Date(Date.now() - index * 1000),
  }));
  await TripBooking.insertMany(scaleDocs);
  const scalePages = await Promise.all(
    [1, 2, 3].map((pageNumber) =>
      api(
        `/api/operator-bookings?view=current&search=${scalePrefix}&page=${pageNumber}&limit=100`,
        { token: operatorToken },
      ),
    ),
  );
  const scaleRows = scalePages.flatMap(
    (pageResult) => pageResult.body.bookings || [],
  );
  record(
    "Operator booking pagination remains complete and stable beyond two pages",
    scalePages.every((pageResult) => pageResult.status === 200) &&
      scalePages[0].body.bookings?.length === 100 &&
      scalePages[1].body.bookings?.length === 100 &&
      scalePages[2].body.bookings?.length === 5 &&
      scalePages.every(
        (pageResult) =>
          pageResult.body.total === 205 &&
          pageResult.body.totalPages === 3 &&
          pageResult.body.currentTotal === 205 &&
          pageResult.body.historyTotal === 0,
      ) &&
      new Set(scaleRows.map((booking) => String(booking._id))).size === 205 &&
      scaleRows[0]?.bookingId === `${scalePrefix}-000` &&
      scaleRows[204]?.bookingId === `${scalePrefix}-204`,
    `sizes=${scalePages.map((pageResult) => pageResult.body.bookings?.length).join(",")}, unique=${new Set(scaleRows.map((booking) => String(booking._id))).size}`,
  );

  const historyPrefix = `E2EHIST-${suffix}`;
  await TripBooking.insertMany([
    {
      bookingId: `${historyPrefix}-LATEST`,
      userId: customerId,
      packageId: batchPackageId,
      operatorId,
      bookingMode: "batch",
      status: "CANCELLED",
      snapshot: {
        startDate: addDaysToDateKey(todayKey, -2),
        endDate: addDaysToDateKey(todayKey, -1),
      },
    },
    {
      bookingId: `${historyPrefix}-OLDEST`,
      userId: customerId,
      packageId: batchPackageId,
      operatorId,
      bookingMode: "batch",
      status: "COMPLETED",
      snapshot: {
        startDate: addDaysToDateKey(todayKey, -4),
        endDate: addDaysToDateKey(todayKey, -3),
      },
    },
    {
      bookingId: `${historyPrefix}-ENDED-CONFIRMED`,
      userId: customerId,
      packageId: batchPackageId,
      operatorId,
      bookingMode: "batch",
      status: "CONFIRMED",
      snapshot: {
        startDate: addDaysToDateKey(todayKey, -3),
        endDate: addDaysToDateKey(todayKey, -2),
      },
    },
  ]);
  const historyList = await api(
    `/api/operator-bookings?view=history&search=${historyPrefix}&limit=10`,
    { token: operatorToken },
  );
  record(
    "History includes ended confirmed trips and orders latest effective end first",
    historyList.status === 200 &&
      historyList.body.total === 3 &&
      historyList.body.currentTotal === 0 &&
      historyList.body.historyTotal === 3 &&
      historyList.body.bookings
        ?.map((booking) => booking.bookingId)
        .join(",") ===
        `${historyPrefix}-LATEST,${historyPrefix}-ENDED-CONFIRMED,${historyPrefix}-OLDEST`,
    `order=${historyList.body.bookings?.map((booking) => booking.bookingId).join(",")}`,
  );

  const todayRange = getISTDayRange(todayKey);
  const datePrefix = `E2EDATE-${suffix}`;
  await TripBooking.insertMany([
    {
      bookingId: `${datePrefix}-START`,
      userId: customerId,
      packageId: batchPackageId,
      operatorId,
      bookingMode: "batch",
      status: "CONFIRMED",
      snapshot: {
        startDate: addDaysToDateKey(todayKey, 400),
        endDate: addDaysToDateKey(todayKey, 401),
      },
      createdAt: todayRange.start,
      updatedAt: todayRange.start,
    },
    {
      bookingId: `${datePrefix}-END`,
      userId: customerId,
      packageId: batchPackageId,
      operatorId,
      bookingMode: "batch",
      status: "CONFIRMED",
      snapshot: {
        startDate: addDaysToDateKey(todayKey, 402),
        endDate: addDaysToDateKey(todayKey, 403),
      },
      createdAt: new Date(todayRange.endExclusive.getTime() - 1),
      updatedAt: new Date(todayRange.endExclusive.getTime() - 1),
    },
    {
      bookingId: `${datePrefix}-NEXT`,
      userId: customerId,
      packageId: batchPackageId,
      operatorId,
      bookingMode: "batch",
      status: "CONFIRMED",
      snapshot: {
        startDate: addDaysToDateKey(todayKey, 404),
        endDate: addDaysToDateKey(todayKey, 405),
      },
      createdAt: todayRange.endExclusive,
      updatedAt: todayRange.endExclusive,
    },
  ]);
  const createdDateList = await api(
    `/api/operator-bookings?view=current&search=${datePrefix}&fromDate=${todayKey}&toDate=${todayKey}&limit=10`,
    { token: operatorToken },
  );
  record(
    "Booking-created date filters include the full IST day and exclude next midnight",
    createdDateList.status === 200 &&
      createdDateList.body.total === 2 &&
      listContainsId(createdDateList.body, `${datePrefix}-START`) &&
      listContainsId(createdDateList.body, `${datePrefix}-END`) &&
      !listContainsId(createdDateList.body, `${datePrefix}-NEXT`),
    `status=${createdDateList.status}, total=${createdDateList.body.total}`,
  );
  const scaledSummary = await api("/api/operator-bookings/summary", {
    token: operatorToken,
  });
  record(
    "Server booking summary counts records beyond list page limits",
    scaledSummary.status === 200 &&
      Number(scaledSummary.body.summary?.totalBookings) >= 211 &&
      scaledSummary.body.summary?.tripBookingsByPackage?.some(
        (item) =>
          String(item.packageId) === String(batchPackageId) &&
          Number(item.tripBookingCount) >= 208,
      ),
    `status=${scaledSummary.status}, total=${scaledSummary.body.summary?.totalBookings}`,
  );

  const secondOperatorWallet = await api("/api/wallet", {
    token: secondOperatorToken,
  });
  record(
    "Second operator wallet is isolated and starts empty",
    secondOperatorWallet.status === 200 &&
      String(secondOperatorWallet.body.wallet?.operatorId) ===
        String(secondOperator._id) &&
      Number(secondOperatorWallet.body.wallet?.balance) === 0 &&
      Number(secondOperatorWallet.body.wallet?.totalEarned) === 0 &&
      Number(secondOperatorWallet.body.wallet?.totalWithdrawn) === 0,
    `status=${secondOperatorWallet.status}, operatorId=${secondOperatorWallet.body.wallet?.operatorId || "missing"}, balance=${secondOperatorWallet.body.wallet?.balance}, totalEarned=${secondOperatorWallet.body.wallet?.totalEarned}, totalWithdrawn=${secondOperatorWallet.body.wallet?.totalWithdrawn}`,
  );
  const secondMine = await api("/api/packages/operator/mine", {
    token: secondOperatorToken,
  });
  record(
    "Second operator package list excludes first operator data",
    secondMine.status === 200 &&
      !listContainsId(secondMine.body, batchPackageId),
    `status=${secondMine.status}`,
  );
  const hijackForm = new FormData();
  hijackForm.append("submissionMode", "DRAFT");
  hijackForm.append("title", "Attempted Cross-Tenant Edit");
  const crossTenantEdit = await api(
    `/api/packages/operator/${batchPackageId}`,
    {
      method: "PUT",
      token: secondOperatorToken,
      form: hijackForm,
    },
  );
  record(
    "Second operator cannot edit first operator package",
    crossTenantEdit.status === 404,
    `status=${crossTenantEdit.status}`,
  );

  // Suspension enforcement uses the flexible package so the independent toggle
  // is not masked by the deliberately corrupted batch-package counter above.
  const packageSuspend = await api(`/api/packages/${flexPackageId}/suspend`, {
    method: "PATCH",
    token: adminToken,
    json: {},
  });
  const listWhilePackageSuspended = await api("/api/packages?limit=100");
  record(
    "Admin package suspension hides package from discovery",
    packageSuspend.status === 200 &&
      !listContainsId(listWhilePackageSuspended.body, flexPackageId),
    `suspendStatus=${packageSuspend.status}`,
  );
  await api(`/api/packages/${flexPackageId}/suspend`, {
    method: "PATCH",
    token: adminToken,
    json: {},
  });

  const operatorSuspend = await api(`/api/operators/${operatorId}/state`, {
    method: "PATCH",
    token: adminToken,
    json: { newState: "SUSPENDED", note: "Synthetic suspension assertion" },
  });
  const suspendedWallet = await api("/api/wallet", { token: operatorToken });
  const suspendedMe = await api("/api/operators/auth/me", {
    token: operatorToken,
  });
  record(
    "Suspended operator is blocked from wallet/customer financial data",
    operatorSuspend.status === 200 && suspendedWallet.status === 403,
    `suspendStatus=${operatorSuspend.status}, walletStatus=${suspendedWallet.status}`,
  );
  record(
    "Suspended operator can read own suspension profile",
    suspendedMe.status === 200 &&
      suspendedMe.body.operator?.onboardingState === "SUSPENDED",
    `status=${suspendedMe.status}`,
  );
  const operatorRestore = await api(`/api/operators/${operatorId}/state`, {
    method: "PATCH",
    token: adminToken,
    json: { newState: "APPROVED", note: "End synthetic suspension assertion" },
  });
  record(
    "Admin restores suspended operator",
    operatorRestore.status === 200 &&
      operatorRestore.body.operator?.onboardingState === "APPROVED",
    `status=${operatorRestore.status}`,
  );

  const customerSuspend = await api(`/api/users/${customerId}/status`, {
    method: "PATCH",
    token: adminToken,
    json: { status: "Suspended" },
  });
  const suspendedCustomerCall = await api("/api/trip-bookings/my", {
    token: customerToken,
  });
  record(
    "Suspended customer token is rejected",
    customerSuspend.status === 200 && suspendedCustomerCall.status === 403,
    `suspendStatus=${customerSuspend.status}, protectedStatus=${suspendedCustomerCall.status}`,
  );
  await api(`/api/users/${customerId}/status`, {
    method: "PATCH",
    token: adminToken,
    json: { status: "Active" },
  });

  // Approved-package edit lifecycle: the live approved version remains public
  // until an administrator explicitly promotes the validated revision.
  const editedForm = new FormData();
  const editedTitle = `REVIEWED EDIT ${suffix}`;
  const existingBatchPackage = await Package.findById(batchPackageId).lean();
  const originalApprovedTitle = existingBatchPackage?.title;
  const editedFields = {
    submissionMode: "SUBMIT",
    title: editedTitle,
    bookingMode: "batch",
    location: "Reviewed Location",
    destination: "Reviewed Destination",
    country: "India",
    state: "Goa",
    city: "Panaji",
    price: "1000",
    durationDays: "2",
    durationNights: "1",
    itinerary: JSON.stringify([
      {
        day: 1,
        title: "Reviewed day one",
        points: [],
        pickupPoint: "Reviewed Panaji Pickup",
        pickupTime: "10:15",
        pickupLat: 15.4909,
        pickupLng: 73.8278,
      },
      {
        day: 2,
        title: "Reviewed day two",
        points: [],
        pickupPoint: "Reviewed Dona Paula Pickup",
        pickupTime: "09:45",
        pickupLat: 15.4589,
        pickupLng: 73.806,
      },
    ]),
    pricing: JSON.stringify({ adultPrice: 1000, childPrice: 600 }),
    existing_image_url: existingBatchPackage?.image_url || "",
  };
  for (const [key, value] of Object.entries(editedFields))
    editedForm.append(key, value);
  const approvedEdit = await api(`/api/packages/operator/${batchPackageId}`, {
    method: "PUT",
    token: operatorToken,
    form: editedForm,
  });
  const listAfterApprovedEdit = await api("/api/packages?limit=100");
  const detailAfterApprovedEdit = await api(`/api/packages/${batchPackageId}`);
  const adminPendingAfterEdit = await api(
    "/api/packages/admin/all?status=PENDING&limit=100",
    { token: adminToken },
  );
  const pendingReviewPackage = adminPendingAfterEdit.body.packages?.find(
    (pkg) => String(pkg._id) === String(batchPackageId),
  );
  record(
    "Approved package edit keeps canonical package APPROVED",
    approvedEdit.status === 200 &&
      approvedEdit.body.package?.status === "APPROVED" &&
      approvedEdit.body.package?.pendingRevision?.status === "PENDING",
    `status=${approvedEdit.status}, liveStatus=${approvedEdit.body.package?.status || ""}, revisionStatus=${approvedEdit.body.package?.pendingRevision?.status || ""}`,
  );
  record(
    "Approved package stays in discovery during edit review",
    listAfterApprovedEdit.status === 200 &&
      listContainsId(listAfterApprovedEdit.body, batchPackageId),
    `listStatus=${listAfterApprovedEdit.status}`,
  );
  record(
    "Public detail keeps previously approved content during edit review",
    detailAfterApprovedEdit.status === 200 &&
      detailAfterApprovedEdit.body.package?.title === originalApprovedTitle &&
      !detailAfterApprovedEdit.body.package?.pendingRevision,
    `detailStatus=${detailAfterApprovedEdit.status}, title=${detailAfterApprovedEdit.body.package?.title || ""}`,
  );
  record(
    "Admin pending queue shows proposed package revision",
    adminPendingAfterEdit.status === 200 &&
      pendingReviewPackage?.title === editedTitle &&
      pendingReviewPackage?.status === "PENDING" &&
      pendingReviewPackage?.liveStatus === "APPROVED",
    `status=${adminPendingAfterEdit.status}, title=${pendingReviewPackage?.title || ""}, reviewStatus=${pendingReviewPackage?.status || ""}`,
  );

  const approveEditedRevision = await api(
    `/api/packages/${batchPackageId}/review`,
    {
      method: "PATCH",
      token: adminToken,
      json: { action: "approve", adminNotes: "Synthetic revision approved" },
    },
  );
  const detailAfterRevisionApproval = await api(
    `/api/packages/${batchPackageId}`,
  );
  const packageAfterRevisionApproval =
    await Package.findById(batchPackageId).lean();
  record(
    "Admin approval publishes revision on the same package ID",
    approveEditedRevision.status === 200 &&
      detailAfterRevisionApproval.status === 200 &&
      String(detailAfterRevisionApproval.body.package?._id) ===
        String(batchPackageId) &&
      detailAfterRevisionApproval.body.package?.title === editedTitle &&
      packageAfterRevisionApproval?.title === editedTitle &&
      !packageAfterRevisionApproval?.pendingRevision,
    `reviewStatus=${approveEditedRevision.status}, detailStatus=${detailAfterRevisionApproval.status}, title=${detailAfterRevisionApproval.body.package?.title || ""}`,
  );

  // Referenced history is archived and retained; active bookings block archival.
  const activePackageDelete = await api(
    `/api/packages/operator/${batchPackageId}`,
    { method: "DELETE", token: operatorToken },
  );
  const usedCouponDelete = await api(`/api/coupons/${couponId}`, {
    method: "DELETE",
    token: operatorToken,
  });
  const archivedCoupon = await Coupon.findById(couponId).lean();
  record(
    "Active package deletion is blocked while historically used coupon is archived",
    activePackageDelete.status === 409 &&
      usedCouponDelete.status === 200 &&
      archivedCoupon?.isArchived === true &&
      archivedCoupon?.isActive === false,
    `package=${activePackageDelete.status}, coupon=${usedCouponDelete.status}, archived=${archivedCoupon?.isArchived}`,
  );

  await TripBooking.updateMany(
    { packageId: batchPackageId },
    { $set: { status: "COMPLETED" } },
  );
  const referencedBatchDelete = await api(`/api/batches/${batchId}`, {
    method: "DELETE",
    token: operatorToken,
  });
  const referencedFlexDelete = await api(
    `/api/flexible-availability/${isolatedFlexId}`,
    { method: "DELETE", token: operatorToken },
  );
  const archivedBatch = await Batch.findById(batchId).lean();
  const archivedFlex =
    await FlexibleAvailability.findById(isolatedFlexId).lean();
  const retainedFlexInventories = await FlexibleDateInventory.countDocuments({
    flexAvailabilityId: isolatedFlexId,
  });
  record(
    "Referenced batch and flexible history are archived without deleting detail or date inventory",
    referencedBatchDelete.status === 200 &&
      referencedFlexDelete.status === 200 &&
      archivedBatch?.isArchived === true &&
      archivedFlex?.isArchived === true &&
      retainedFlexInventories === 2,
    `batch=${referencedBatchDelete.status}/${archivedBatch?.isArchived}, flex=${referencedFlexDelete.status}/${archivedFlex?.isArchived}, inventories=${retainedFlexInventories}`,
  );

  const archivedMutationResults = await Promise.all([
    api(`/api/batches/${batchId}`, {
      method: "PUT",
      token: operatorToken,
      json: { isActive: true, label: "Resurrection attempt" },
    }),
    api(`/api/flexible-availability/${isolatedFlexId}`, {
      method: "PUT",
      token: operatorToken,
      json: { isActive: true, maxBookings: 2 },
    }),
    api(`/api/coupons/${couponId}`, {
      method: "PUT",
      token: operatorToken,
      json: { isActive: true, description: "Resurrection attempt" },
    }),
  ]);
  record(
    "Archived batch, flexible range, and coupon reject reactivation or mutation",
    archivedMutationResults.every((response) => response.status === 409),
    `statuses=${archivedMutationResults.map((response) => response.status).join(",")}`,
  );

  const historicalPackageDelete = await api(
    `/api/packages/operator/${batchPackageId}`,
    { method: "DELETE", token: operatorToken },
  );
  const archivedPackage = await Package.findById(batchPackageId).lean();
  const archivedPublicDetail = await api(`/api/packages/${batchPackageId}`);
  const archivedPackageToggle = await api(
    `/api/packages/operator/${batchPackageId}/toggle-active`,
    { method: "PATCH", token: operatorToken, json: {} },
  );
  record(
    "Historical package archives in place, leaves detail retained, and cannot be reactivated",
    historicalPackageDelete.status === 200 &&
      archivedPackage?.status === "ARCHIVED" &&
      archivedPackage?.isActive === false &&
      archivedPublicDetail.status === 404 &&
      archivedPackageToggle.status === 409,
    `delete=${historicalPackageDelete.status}, state=${archivedPackage?.status}, public=${archivedPublicDetail.status}, toggle=${archivedPackageToggle.status}`,
  );

  // Final isolated-database invariants and summary.
  const counts = {
    users: await User.countDocuments(),
    operators: await Operator.countDocuments(),
    packages: await Package.countDocuments(),
    bookings: await TripBooking.countDocuments(),
    withdrawals: await Withdrawal.countDocuments(),
    refunds: fakeState.refunds.length,
  };
  record(
    "Synthetic records exist only in run-owned database",
    mongoose.connection.name === DB_NAME &&
      counts.users > 0 &&
      counts.operators > 0,
    `database=${mongoose.connection.name}, counts=${JSON.stringify(counts)}`,
  );

  return { counts };
}

async function cleanup() {
  const cleanupEvidence = [];
  let success = true;
  try {
    const mongoose = require("mongoose");
    if (mongoose.connection.readyState === 1) {
      assert.strictEqual(
        mongoose.connection.name,
        DB_NAME,
        "Refusing to drop a non-E2E database",
      );
      await mongoose.connection.dropDatabase();
      cleanupEvidence.push(`dropped=${DB_NAME}`);
      await mongoose.disconnect();
    }
  } catch (error) {
    success = false;
    cleanupEvidence.push(`databaseCleanupError=${error.message}`);
  }

  try {
    const uploadsAfter = listFilesRecursively(UPLOAD_ROOT);
    let deleted = 0;
    for (const file of uploadsAfter) {
      if (!uploadsBefore.has(file)) {
        fs.unlinkSync(file);
        deleted += 1;
      }
    }
    cleanupEvidence.push(`syntheticUploadsDeleted=${deleted}`);
  } catch (error) {
    success = false;
    cleanupEvidence.push(`uploadCleanupError=${error.message}`);
  }
  const evidence = cleanupEvidence.join(" | ");
  console.log(`CLEANUP | ${evidence}`);
  return { success, evidence };
}

(async () => {
  let fatalError = null;
  try {
    await main();
  } catch (error) {
    fatalError = error;
    record(
      "E2E runner completed without fatal setup/dependency error",
      false,
      error.stack || error.message,
    );
  } finally {
    // Let fire-and-forget local DB notifications settle before dropping the DB.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const cleanupResult = await cleanup();
    record(
      "E2E cleanup completes successfully",
      cleanupResult.success,
      cleanupResult.evidence,
    );
    const passed = results.filter((item) => item.passed).length;
    const failed = results.length - passed;
    console.log(
      `SUMMARY | passed=${passed} | failed=${failed} | total=${results.length}`,
    );
    console.log(
      `RESULT_JSON=${JSON.stringify({ runId: RUN_ID, database: DB_NAME, passed, failed, total: results.length, fatalError: fatalError?.message || null, results })}`,
    );
    process.exit(fatalError ? 2 : failed > 0 ? 1 : 0);
  }
})();
