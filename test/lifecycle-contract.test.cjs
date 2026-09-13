const test = require("node:test");
const assert = require("node:assert/strict");
const { getPagination } = require("../utils/pagination");
const dates = require("../utils/businessDate");
const lifecycle = require("../utils/lifecycle");

test("pagination clamps page and limit", () => {
  assert.deepEqual(getPagination({ page: "-4", limit: "999" }), {
    page: 1,
    limit: 100,
    skip: 0,
  });
  assert.deepEqual(getPagination({ page: "3", limit: "10" }), {
    page: 3,
    limit: 10,
    skip: 20,
  });
  assert.deepEqual(getPagination({ page: "bad", limit: "0" }, 25), {
    page: 1,
    limit: 25,
    skip: 0,
  });
});

test("IST date parsing is strict and inclusive final day expires next midnight", () => {
  assert.equal(dates.parseDateKey("2026-02-30"), null);
  assert.equal(
    dates.getISTDayRange("2026-06-11").start.toISOString(),
    "2026-06-10T18:30:00.000Z",
  );
  assert.equal(
    dates.isDateKeyPastInclusiveEnd(
      "2026-06-11",
      new Date("2026-06-11T18:29:59.999Z"),
    ),
    false,
  );
  assert.equal(
    dates.isDateKeyPastInclusiveEnd(
      "2026-06-11",
      new Date("2026-06-11T18:30:00.000Z"),
    ),
    true,
  );
});

test("lifecycle labels preserve current/history product rules", () => {
  const now = new Date("2026-06-11T12:00:00.000Z");
  assert.equal(
    lifecycle.packageLifecycle({ status: "APPROVED", isActive: false }),
    "Paused",
  );
  assert.equal(
    lifecycle.batchLifecycle(
      { endDate: "2026-06-11", isActive: true, totalSeats: 5, bookedSeats: 0 },
      now,
    ),
    "Running",
  );
  assert.equal(
    lifecycle.flexLifecycle({ endDate: "2026-06-10", isActive: true }, now),
    "Expired",
  );
  assert.equal(
    lifecycle.couponLifecycle(
      { validUntil: "2026-06-11", isActive: true, usageLimit: 0 },
      now,
    ),
    "Active",
  );
});

test("date-only coupon activation starts at IST midnight", () => {
  const coupon = require("../controllers/couponController");
  assert.equal(
    coupon.parseCouponDate("2026-06-11").toISOString(),
    "2026-06-10T18:30:00.000Z",
  );
  const query = coupon.inFlightCouponQuery({
    packageId: "507f1f77bcf86cd799439011",
    code: "SAVE10",
  });
  assert.deepEqual(query.$and[0].$or[1], {
    finalizationState: { $exists: false },
  });
});

test("cron completion starts after the inclusive IST final day", () => {
  const cron = require("../controllers/cronController");
  assert.equal(
    cron
      .effectiveEndExclusive({ snapshot: { endDate: "2026-06-11" } })
      .toISOString(),
    "2026-06-11T18:30:00.000Z",
  );
});

test("operator booking named routes precede owned detail route", () => {
  const router = require("../routes/operatorBookingRoutes");
  const getPaths = router.stack
    .filter((layer) => layer.route?.methods?.get)
    .map((layer) => layer.route.path);
  assert.ok(getPaths.indexOf("/summary") < getPaths.indexOf("/:id"));
});

test("package suspension guard protects the full inclusive IST final day", () => {
  const packages = require("../controllers/packageController");
  assert.equal(
    packages
      .activeBookingEndCutoff(new Date("2026-06-11T18:29:59.999Z"))
      .toISOString(),
    "2026-06-10T18:30:00.000Z",
  );
  assert.equal(
    packages
      .activeBookingEndCutoff(new Date("2026-06-11T18:30:00.000Z"))
      .toISOString(),
    "2026-06-11T18:30:00.000Z",
  );
});

test("coupon deletion rejects in-flight orders before archival mutation", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(
    require.resolve("../controllers/couponController"),
    "utf8",
  );
  const inFlightGuard = source.indexOf("if (inFlight)");
  const archiveMutation = source.indexOf(
    "coupon.isArchived = true",
    inFlightGuard,
  );
  assert.ok(inFlightGuard >= 0);
  assert.ok(archiveMutation > inFlightGuard);
  assert.match(source.slice(inFlightGuard, archiveMutation), /status\(409\)/);
});

test("flex combined update validates overlap before parent or inventory writes", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(
    require.resolve("../routes/flexibleAvailabilityRoutes"),
    "utf8",
  );
  const updateRoute = source.indexOf("router.put(");
  const overlapValidation = source.indexOf(
    "FlexibleAvailability.exists(overlapQuery)",
    updateRoute,
  );
  const firstParentWrite = source.indexOf(
    "const parentResult = await FlexibleAvailability.updateOne",
    updateRoute,
  );
  const firstInventoryWrite = source.indexOf(
    "await FlexibleDateInventory.updateMany",
    updateRoute,
  );
  assert.ok(updateRoute >= 0);
  assert.ok(overlapValidation > updateRoute);
  assert.ok(firstParentWrite > overlapValidation);
  assert.ok(firstInventoryWrite > overlapValidation);
});
