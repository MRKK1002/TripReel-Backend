const test = require("node:test");
const assert = require("node:assert/strict");

const PendingOrder = require("../models/PendingOrder");
const TripBooking = require("../models/TripBooking");
const Package = require("../models/Package");
const Batch = require("../models/Batch");
const FlexibleAvailability = require("../models/FlexibleAvailability");
const Coupon = require("../models/Coupon");
const PlatformCoupon = require("../models/PlatformCoupon");
const FlexibleDateInventory = require("../models/FlexibleDateInventory");
const Notification = require("../models/Notification");

test("recovery state and aggregate claim fields are persisted", () => {
  assert.ok(PendingOrder.schema.path("chargedPricingSnapshot"));
  assert.ok(PendingOrder.schema.path("finalizationState"));
  assert.ok(TripBooking.schema.path("requiredEffectsState"));
  assert.ok(TripBooking.schema.path("confirmationDeliveryState"));
  assert.ok(TripBooking.schema.path("userConfirmationSentAt"));
  assert.ok(TripBooking.schema.path("financialSettlementState"));
  assert.ok(TripBooking.schema.path("refundRetryToken"));
  assert.ok(Package.schema.path("bookingCountClaimKeys"));
  assert.ok(Package.schema.path("bookingCountReleaseKeys"));
  assert.ok(Batch.schema.path("inventoryReservationClaimKeys"));
  assert.ok(Batch.schema.path("inventoryReleaseClaimKeys"));
  assert.ok(FlexibleAvailability.schema.path("inventoryReleaseClaimKeys"));
  assert.ok(Coupon.schema.path("releaseClaimKeys"));
  assert.ok(PlatformCoupon.schema.path("releaseClaimKeys"));
  assert.ok(Coupon.schema.path("everUsedCount"));
  assert.ok(Coupon.schema.path("firstUsedAt"));
  assert.ok(TripBooking.schema.path("flexInventoryId"));
  assert.ok(TripBooking.schema.path("flexStartDateKey"));
  assert.ok(FlexibleDateInventory.schema.path("reservationClaimKeys"));
  assert.ok(
    TripBooking.schema
      .path("refundStatus")
      .enumValues.includes("RECONCILIATION_REQUIRED"),
  );
});

test("live recovery workers and required booking effects are exported", () => {
  const payment = require("../controllers/paymentController");
  const booking = require("../controllers/tripBookingController");
  const cron = require("../controllers/cronController");

  assert.equal(typeof payment.finalizeBookingFromOrder, "function");
  assert.equal(payment.POST_INSERT_EFFECT_ATTEMPT_LIMIT, 5);
  assert.equal(typeof booking.ensureRequiredBookingEffects, "function");
  assert.equal(typeof booking.deliverBookingConfirmation, "function");
  assert.equal(typeof cron.runCancellationRecovery, "function");
  assert.equal(typeof cron.runRefundRetryRecovery, "function");
  assert.equal(cron.runCronJobs, undefined);
});

test("canonical flexible booking date key validates at schema level", () => {
  const mongoose = require("mongoose");
  const id = () => new mongoose.Types.ObjectId();
  const booking = new TripBooking({
    userId: id(),
    packageId: id(),
    operatorId: id(),
    bookingMode: "flexible",
    flexAvailabilityId: id(),
    flexInventoryId: id(),
    flexStartDate: new Date("2026-06-10T18:30:00.000Z"),
    flexStartDateKey: "2026-06-11",
    flexReservationClaimKey: "order_flex_schema_test",
    seats: 1,
    status: "PENDING",
    requiredEffectsVersion: 1,
    requiredEffectsState: "PENDING",
  });
  assert.equal(booking.validateSync(), undefined);

  booking.flexStartDateKey = "11-06-2026";
  assert.equal(
    booking.validateSync().errors.flexStartDateKey.path,
    "flexStartDateKey",
  );
});

test("batch order reservation builders fence reserve, replay, and release by claim", () => {
  const claims = require("../utils/inventoryClaims");
  const claimKey = "order_batch_replay_test";
  const reserveFilter = claims.buildReservationClaimFilter({
    id: "batch-id",
    claimKey,
    seats: 3,
  });
  const reservePipeline = claims.buildReservationClaimPipeline({
    claimKey,
    seats: 3,
  });
  const releaseFilter = claims.buildReservationReleaseFilter({
    id: "batch-id",
    claimKey,
  });
  const releasePipeline = claims.buildReservationReleasePipeline({
    claimKey,
    seats: 3,
  });

  assert.deepEqual(reserveFilter.$or[0], {
    inventoryReservationClaimKeys: claimKey,
    inventoryReleaseClaimKeys: { $ne: claimKey },
  });
  assert.deepEqual(
    reservePipeline[0].$set.inventoryReleaseClaimKeys.$setDifference[1],
    [claimKey],
  );
  assert.equal(releaseFilter.inventoryReservationClaimKeys, claimKey);
  assert.deepEqual(releaseFilter.inventoryReleaseClaimKeys, { $ne: claimKey });
  assert.deepEqual(
    releasePipeline[0].$set.inventoryReleaseClaimKeys.$setUnion[1],
    [claimKey],
  );
});

test("platform coupon claim is bounded per user and cancellation is claim keyed", () => {
  const mongoose = require("mongoose");
  const {
    buildPlatformCouponClaim,
    buildPlatformCouponRelease,
  } = require("../utils/platformCouponClaims");
  const couponId = new mongoose.Types.ObjectId();
  const packageId = new mongoose.Types.ObjectId();
  const operatorId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const effectKey = new mongoose.Types.ObjectId().toString();
  const claim = buildPlatformCouponClaim({
    couponId,
    effectKey,
    userId,
    packageId,
    operatorId,
    pkg: { category: "Adventure", state: "Goa", city: "Panaji" },
    seats: 2,
    fareSubtotal: 5000,
    now: new Date("2026-06-11T12:00:00.000Z"),
    dayStart: new Date("2026-06-10T18:30:00.000Z"),
  });
  assert.equal(claim.filter.$or[0].usageClaimKeys, effectKey);
  assert.equal(claim.filter.$or[1].$and[0].isActive, true);
  assert.ok(claim.filter.$or[1].$and.some((part) => part.$expr));
  assert.deepEqual(claim.pipeline[0].$set.usageClaimKeys.$setUnion[1], [
    effectKey,
  ]);

  const release = buildPlatformCouponRelease({
    couponId,
    effectKey,
    userId,
  });
  assert.equal(release.filter.usageClaimKeys, effectKey);
  assert.deepEqual(release.filter.releaseClaimKeys, { $ne: effectKey });
  assert.deepEqual(release.pipeline[0].$set.releaseClaimKeys.$setUnion[1], [
    effectKey,
  ]);
  assert.ok(PlatformCoupon.schema.path("userUsageClaims"));
  assert.ok(PlatformCoupon.schema.path("everUsedCount"));
  assert.ok(PlatformCoupon.schema.path("isArchived"));
});

test("versioned unfinished bookings are processing-only and non-cancellable", () => {
  const booking = require("../controllers/tripBookingController");
  assert.equal(
    booking.isBookingFinalizationPending({
      requiredEffectsVersion: 1,
      requiredEffectsState: "PENDING",
      status: "PENDING",
    }),
    true,
  );
  assert.equal(
    booking.isBookingFinalizationPending({
      requiredEffectsVersion: 1,
      requiredEffectsState: "COMPLETED",
      status: "CONFIRMED",
    }),
    false,
  );
});

test("compensating refund recovery exposes generic reservation cleanup", () => {
  const payment = require("../controllers/paymentController");
  assert.equal(typeof payment.releasePendingReservation, "function");
  assert.ok(PendingOrder.schema.path("batchReservationClaimKey"));
  assert.ok(Batch.schema.path("inventoryReservationClaimKeys"));
  assert.ok(TripBooking.schema.path("batchReservationClaimKey"));
});

test("confirmation delivery rejects false-success channel results", () => {
  const booking = require("../controllers/tripBookingController");
  const notifications = require("../controllers/notificationController");
  assert.throws(
    () => booking.requireDeliverySuccess(null, "Booking email"),
    /Booking email confirmation delivery failed/,
  );
  const success = { messageId: "mail-1" };
  assert.equal(
    booking.requireDeliverySuccess(success, "Booking email"),
    success,
  );
  assert.equal(typeof notifications.notifyUserStrict, "function");
  assert.equal(typeof notifications.notifyOperatorStrict, "function");
  assert.equal(typeof notifications.notifyAdminStrict, "function");
  assert.equal(typeof notifications.upsertStrictNotification, "function");
  assert.ok(Notification.schema.path("effectKey"));
});
