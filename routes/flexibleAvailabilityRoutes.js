const express = require("express");
const router = express.Router();
const {
  operatorProtect,
  requireApprovedOperator,
} = require("../middleware/operatorAuthMiddleware");
const FlexibleAvailability = require("../models/FlexibleAvailability");
const FlexibleDateInventory = require("../models/FlexibleDateInventory");
const Package = require("../models/Package");
const TripBooking = require("../models/TripBooking");
const PendingOrder = require("../models/PendingOrder");
const BookingIntent = require("../models/BookingIntent");
const { getPagination, paginationMeta } = require("../utils/pagination");
const {
  parseDateKey,
  storedDateKey,
  dateKeyToISTStart,
  getISTDateKey,
  getISTDayRange,
} = require("../utils/businessDate");
const {
  normalizeView,
  flexLifecycle,
  applyLifecycleView,
  isHistory,
} = require("../utils/lifecycle");
const {
  parseBoolean,
  pendingReferenceQuery,
  IN_FLIGHT_STATES,
} = require("../utils/resourceIntegrity");
const {
  acquireFlexCapacityLease,
  releaseFlexCapacityLease,
  materializeDateInventory,
} = require("../utils/flexibleInventory");

function withCapacity(item, inventories = []) {
  const raw = item?.toObject ? item.toObject() : { ...item };
  return {
    ...raw,
    lifecycle: flexLifecycle(raw),
    capacityMode: "per_start_date",
    maxBookingsPerStartDate: Number(raw.maxBookings) || 0,
    ...(inventories.length
      ? {
          dateInventory: inventories.map((inventory) => ({
            _id: inventory._id,
            startDateKey: inventory.startDateKey,
            capacity: inventory.capacity,
            bookedSeats: inventory.bookedSeats,
            availableSeats:
              inventory.capacity === 0
                ? null
                : Math.max(0, inventory.capacity - inventory.bookedSeats),
          })),
        }
      : {}),
  };
}

async function hasInFlightFlexOrder(id) {
  return PendingOrder.exists({
    $or: [
      pendingReferenceQuery("flexAvailabilityId", id),
      {
        flexAvailabilityId: id,
        status: "pending",
        finalizationState: { $in: IN_FLIGHT_STATES },
      },
    ],
  });
}

router.get("/", operatorProtect, async (req, res) => {
  try {
    const { packageId } = req.query;
    if (!packageId) {
      return res
        .status(400)
        .json({ success: false, message: "packageId is required" });
    }
    const pkg = await Package.findById(packageId);
    if (!pkg || String(pkg.operatorId) !== String(req.operator._id)) {
      return res
        .status(403)
        .json({ success: false, message: "Not your package" });
    }
    const { page, limit, skip } = getPagination(req.query, 20);
    const view = normalizeView(req.query);
    const query = { packageId, operatorId: req.operator._id };
    const docs = await FlexibleAvailability.find(query).sort({
      startDate: -1,
      createdAt: -1,
      _id: -1,
    });
    let classifiedItems = applyLifecycleView(
      docs,
      "flex",
      flexLifecycle,
      "all",
    ).items;
    if (req.query.search) {
      const term = String(req.query.search).trim().toLowerCase();
      classifiedItems = classifiedItems.filter((item) =>
        [
          item.lifecycle,
          storedDateKey(item.startDate),
          storedDateKey(item.endDate),
        ].some((value) =>
          String(value || "")
            .toLowerCase()
            .includes(term),
        ),
      );
    }
    const currentTotal = classifiedItems.filter(
      (item) => !isHistory("flex", item.lifecycle),
    ).length;
    const historyTotal = classifiedItems.length - currentTotal;
    const selectedItems =
      view === "all"
        ? classifiedItems
        : classifiedItems.filter((item) =>
            view === "history"
              ? isHistory("flex", item.lifecycle)
              : !isHistory("flex", item.lifecycle),
          );
    const pageItems = selectedItems.slice(skip, skip + limit);
    const ids = pageItems.map((item) => item._id);
    const inventories = await FlexibleDateInventory.find({
      flexAvailabilityId: { $in: ids },
    })
      .sort({ startDateKey: 1 })
      .select("flexAvailabilityId startDateKey capacity bookedSeats");
    const byFlex = new Map();
    inventories.forEach((inventory) => {
      const key = String(inventory.flexAvailabilityId);
      if (!byFlex.has(key)) byFlex.set(key, []);
      byFlex.get(key).push(inventory);
    });
    const items = pageItems.map((item) =>
      withCapacity(item, byFlex.get(String(item._id)) || []),
    );
    res.json({
      success: true,
      items,
      count: items.length,
      ...paginationMeta(selectedItems.length, page, limit),
      currentTotal,
      historyTotal,
      capacityMode: "per_start_date",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/package/:packageId/date/:dateKey", async (req, res) => {
  try {
    const parsed = parseDateKey(req.params.dateKey);
    if (!parsed)
      return res
        .status(400)
        .json({ success: false, message: "dateKey must be YYYY-MM-DD" });
    const pkg = await Package.findOne({
      _id: req.params.packageId,
      status: "APPROVED",
      isActive: true,
    }).select("_id operatorId bookingMode");
    if (!pkg || pkg.bookingMode !== "flexible")
      return res
        .status(404)
        .json({ success: false, message: "Package not found" });
    const candidates = await FlexibleAvailability.find({
      packageId: pkg._id,
      isActive: true,
      isArchived: { $ne: true },
    });
    const item = candidates.find(
      (candidate) =>
        storedDateKey(candidate.startDate) <= parsed.key &&
        storedDateKey(candidate.endDate) >= parsed.key,
    );
    if (!item)
      return res
        .status(404)
        .json({ success: false, message: "Date is not available" });
    const lease = await acquireFlexCapacityLease(item._id);
    let inventory;
    try {
      inventory = await materializeDateInventory(lease.item, parsed.key, {
        syncCapacity: true,
      });
    } finally {
      await releaseFlexCapacityLease(item._id, lease.token);
    }
    const dateInventory = {
      _id: inventory._id,
      startDateKey: inventory.startDateKey,
      capacity: inventory.capacity,
      bookedSeats: inventory.bookedSeats,
      availableSeats:
        inventory.capacity === 0
          ? null
          : Math.max(0, inventory.capacity - inventory.bookedSeats),
    };
    res.json({
      success: true,
      item: withCapacity(item, [inventory]),
      flexAvailabilityId: item._id,
      startDateKey: dateInventory.startDateKey,
      capacity: dateInventory.capacity,
      bookedSeats: dateInventory.bookedSeats,
      availableSeats: dateInventory.availableSeats,
      dateInventory,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/package/:packageId", async (req, res) => {
  try {
    const pkg = await Package.findOne({
      _id: req.params.packageId,
      status: "APPROVED",
      isActive: true,
    }).select("_id");
    if (!pkg)
      return res
        .status(404)
        .json({ success: false, message: "Package not found" });
    const dayStart = getISTDayRange(getISTDateKey()).start;
    const docs = await FlexibleAvailability.find({
      packageId: pkg._id,
      isActive: true,
      isArchived: { $ne: true },
      endDate: { $gte: dayStart },
    }).sort({ startDate: 1 });
    const items = docs.map((item) => withCapacity(item));
    res.json({
      success: true,
      items,
      count: items.length,
      capacityMode: "per_start_date",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/", operatorProtect, requireApprovedOperator, async (req, res) => {
  try {
    const {
      packageId,
      startDate,
      endDate,
      adultPrice,
      childPrice,
      maxBookings = 0,
    } = req.body;
    if (!packageId || !startDate || !endDate || adultPrice == null)
      return res.status(400).json({
        success: false,
        message: "packageId, startDate, endDate, and adultPrice are required",
      });
    const startKey = storedDateKey(startDate);
    const endKey = storedDateKey(endDate);
    if (!startKey || !endKey)
      return res
        .status(400)
        .json({ success: false, message: "Please provide valid dates" });
    if (endKey < startKey)
      return res.status(400).json({
        success: false,
        message: "endDate must be on or after startDate",
      });
    if (startKey < getISTDateKey())
      return res
        .status(400)
        .json({ success: false, message: "Start date cannot be in the past" });
    const parsedAdultPrice = Number(adultPrice);
    const parsedChildPrice = childPrice == null ? 0 : Number(childPrice);
    const parsedMaxBookings = Number(maxBookings);
    if (!Number.isFinite(parsedAdultPrice) || parsedAdultPrice <= 0)
      return res.status(400).json({
        success: false,
        message: "Adult price must be greater than ₹0",
      });
    if (
      !Number.isFinite(parsedChildPrice) ||
      parsedChildPrice < 0 ||
      parsedChildPrice > parsedAdultPrice
    )
      return res.status(400).json({
        success: false,
        message:
          "Child price must be nonnegative and no higher than adult price",
      });
    if (
      !Number.isInteger(parsedMaxBookings) ||
      parsedMaxBookings < 0 ||
      parsedMaxBookings > 1000
    )
      return res.status(400).json({
        success: false,
        message:
          "Maximum bookings must be a whole number between 0 and 1000 (0 means unlimited)",
      });
    const pkg = await Package.findOne({
      _id: packageId,
      operatorId: req.operator._id,
    });
    if (!pkg)
      return res
        .status(403)
        .json({ success: false, message: "Not your package" });
    if (pkg.bookingMode !== "flexible")
      return res.status(400).json({
        success: false,
        message: "This package uses fixed batches, not flexible dates.",
      });
    const start = dateKeyToISTStart(startKey);
    const end = dateKeyToISTStart(endKey);
    const overlap = await FlexibleAvailability.findOne({
      packageId,
      isActive: { $ne: false },
      isArchived: { $ne: true },
      startDate: { $lte: end },
      endDate: { $gte: start },
    });
    if (overlap)
      return res.status(409).json({
        success: false,
        message: "This range overlaps an existing active range.",
      });
    const item = await FlexibleAvailability.create({
      packageId,
      operatorId: req.operator._id,
      startDate: start,
      endDate: end,
      adultPrice: parsedAdultPrice,
      childPrice: parsedChildPrice,
      maxBookings: parsedMaxBookings,
    });
    res.status(201).json({ success: true, item: withCapacity(item) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put(
  "/:id",
  operatorProtect,
  requireApprovedOperator,
  async (req, res) => {
    try {
      const item = await FlexibleAvailability.findOne({
        _id: req.params.id,
        operatorId: req.operator._id,
      });
      if (!item)
        return res
          .status(404)
          .json({ success: false, message: "Not found or not yours" });
      const lifecycle = flexLifecycle(item);
      if (isHistory("flex", lifecycle))
        return res.status(409).json({
          success: false,
          message: `This flexible availability is in History (${lifecycle}) and is read-only. It cannot be changed.`,
        });
      const changingTerms = [
        "startDate",
        "endDate",
        "adultPrice",
        "childPrice",
      ].some((key) => req.body[key] !== undefined);
      if (changingTerms) {
        const [bookingHistory, inFlight] = await Promise.all([
          TripBooking.exists({ flexAvailabilityId: item._id }),
          hasInFlightFlexOrder(item._id),
        ]);
        if (bookingHistory || inFlight)
          return res.status(409).json({
            success: false,
            message:
              "Dates and pricing are immutable after booking history or an in-flight payment exists. Pause remains available.",
          });
      }
      const nextStartKey =
        req.body.startDate === undefined
          ? storedDateKey(item.startDate)
          : storedDateKey(req.body.startDate);
      const nextEndKey =
        req.body.endDate === undefined
          ? storedDateKey(item.endDate)
          : storedDateKey(req.body.endDate);
      if (!nextStartKey || !nextEndKey || nextEndKey < nextStartKey)
        return res.status(400).json({
          success: false,
          message: "Please provide a valid inclusive date range",
        });
      if (changingTerms && nextStartKey < getISTDateKey())
        return res.status(400).json({
          success: false,
          message: "Start date cannot be in the past",
        });
      const nextAdult =
        req.body.adultPrice === undefined
          ? item.adultPrice
          : Number(req.body.adultPrice);
      const nextChild =
        req.body.childPrice === undefined
          ? item.childPrice
          : Number(req.body.childPrice);
      if (
        !Number.isFinite(nextAdult) ||
        nextAdult <= 0 ||
        !Number.isFinite(nextChild) ||
        nextChild < 0 ||
        nextChild > nextAdult
      )
        return res
          .status(400)
          .json({ success: false, message: "Prices are invalid" });
      let nextCapacity = Number(item.maxBookings) || 0;
      if (req.body.maxBookings !== undefined) {
        nextCapacity = Number(req.body.maxBookings);
        if (
          !Number.isInteger(nextCapacity) ||
          nextCapacity < 0 ||
          nextCapacity > 1000
        )
          return res.status(400).json({
            success: false,
            message:
              "Maximum bookings must be a whole number between 0 and 1000",
          });
      }
      const datesChanged =
        nextStartKey !== storedDateKey(item.startDate) ||
        nextEndKey !== storedDateKey(item.endDate);
      const capacityChanged = nextCapacity !== Number(item.maxBookings || 0);
      const nextActive =
        req.body.isActive === undefined
          ? item.isActive
          : parseBoolean(req.body.isActive, item.isActive);
      const activating = item.isActive === false && nextActive === true;
      const nextStart = dateKeyToISTStart(nextStartKey);
      const nextEnd = dateKeyToISTStart(nextEndKey);
      const overlapQuery = {
        _id: { $ne: item._id },
        packageId: item.packageId,
        isActive: { $ne: false },
        isArchived: { $ne: true },
        startDate: { $lte: nextEnd },
        endDate: { $gte: nextStart },
      };

      // Every rejection check happens before the first write. Re-run the
      // mutable capacity and overlap predicates while the item lease is held.
      if (
        (datesChanged || activating) &&
        (await FlexibleAvailability.exists(overlapQuery))
      ) {
        return res.status(409).json({
          success: false,
          message: "This range overlaps another active range.",
        });
      }
      if (capacityChanged && nextCapacity > 0) {
        const overCapacity = await FlexibleDateInventory.findOne({
          flexAvailabilityId: item._id,
          bookedSeats: { $gt: nextCapacity },
        });
        if (overCapacity) {
          return res.status(409).json({
            success: false,
            message: `Maximum bookings cannot be lower than ${overCapacity.bookedSeats} seats already booked on ${overCapacity.startDateKey}`,
          });
        }
      }

      const lease = await acquireFlexCapacityLease(item._id);
      try {
        if (changingTerms) {
          const [bookingHistory, inFlight] = await Promise.all([
            TripBooking.exists({ flexAvailabilityId: item._id }),
            hasInFlightFlexOrder(item._id),
          ]);
          if (bookingHistory || inFlight) {
            const error = new Error(
              "Dates and pricing are immutable after booking history or an in-flight payment exists. Pause remains available.",
            );
            error.statusCode = 409;
            throw error;
          }
        }
        if (
          (datesChanged || activating) &&
          (await FlexibleAvailability.exists(overlapQuery))
        ) {
          const error = new Error("This range overlaps another active range.");
          error.statusCode = 409;
          throw error;
        }
        if (capacityChanged && nextCapacity > 0) {
          const overCapacity = await FlexibleDateInventory.findOne({
            flexAvailabilityId: item._id,
            bookedSeats: { $gt: nextCapacity },
          });
          if (overCapacity) {
            const error = new Error(
              `Maximum bookings cannot be lower than ${overCapacity.bookedSeats} seats already booked on ${overCapacity.startDateKey}`,
            );
            error.statusCode = 409;
            throw error;
          }
        }

        const previous = {
          startDate: lease.item.startDate,
          endDate: lease.item.endDate,
          adultPrice: lease.item.adultPrice,
          childPrice: lease.item.childPrice,
          maxBookings: lease.item.maxBookings,
          isActive: lease.item.isActive,
        };
        const inventorySnapshot = capacityChanged
          ? await FlexibleDateInventory.find({
              flexAvailabilityId: item._id,
            }).select("_id capacity")
          : [];
        const parentUpdate = {
          startDate: nextStart,
          endDate: nextEnd,
          adultPrice: nextAdult,
          childPrice: nextChild,
          maxBookings: nextCapacity,
          isActive: nextActive,
        };
        try {
          // Child capacities move first while reservations are blocked by the
          // lease; the parent remains the authoritative committed value until
          // every materialized date succeeds.
          if (capacityChanged) {
            await FlexibleDateInventory.updateMany(
              { flexAvailabilityId: item._id },
              { $set: { capacity: nextCapacity } },
            );
          }
          const parentResult = await FlexibleAvailability.updateOne(
            { _id: item._id, capacityLeaseToken: lease.token },
            { $set: parentUpdate },
          );
          if (parentResult.matchedCount !== 1) {
            throw new Error("Flexible capacity update lease was lost");
          }
        } catch (writeError) {
          // Standalone Mongo deployments cannot guarantee transactions. Restore
          // both parent and materialized date capacities before surfacing error.
          await FlexibleAvailability.updateOne(
            { _id: item._id, capacityLeaseToken: lease.token },
            { $set: previous },
          ).catch(() => {});
          if (inventorySnapshot.length > 0) {
            await FlexibleDateInventory.bulkWrite(
              inventorySnapshot.map((inventory) => ({
                updateOne: {
                  filter: { _id: inventory._id },
                  update: { $set: { capacity: inventory.capacity } },
                },
              })),
            ).catch(() => {});
          }
          throw writeError;
        }
      } finally {
        await releaseFlexCapacityLease(item._id, lease.token);
      }

      const updatedItem = await FlexibleAvailability.findById(item._id);
      const inventories = await FlexibleDateInventory.find({
        flexAvailabilityId: item._id,
      }).sort({ startDateKey: 1 });
      res.json({
        success: true,
        item: withCapacity(updatedItem, inventories),
      });
    } catch (err) {
      res
        .status(err.statusCode || 500)
        .json({ success: false, message: err.message });
    }
  },
);

router.delete(
  "/:id",
  operatorProtect,
  requireApprovedOperator,
  async (req, res) => {
    try {
      const item = await FlexibleAvailability.findOne({
        _id: req.params.id,
        operatorId: req.operator._id,
      });
      if (!item)
        return res
          .status(404)
          .json({ success: false, message: "Not found or not yours" });
      const lifecycle = flexLifecycle(item);
      if (isHistory("flex", lifecycle))
        return res.status(409).json({
          success: false,
          message: `This flexible availability is in History (${lifecycle}) and is read-only. It cannot be deleted.`,
        });
      if (await hasInFlightFlexOrder(item._id))
        return res.status(409).json({
          success: false,
          message:
            "Cannot delete while a payment order for this date range is in flight.",
        });
      const bookingRef = await TripBooking.exists({
        flexAvailabilityId: item._id,
      });
      if (bookingRef) {
        item.isActive = false;
        item.isArchived = true;
        item.archivedAt = new Date();
        item.archivedBy = String(req.operator._id);
        item.archivedByType = "operator";
        item.archivedReason = String(
          req.body?.reason || "Booking history preserved",
        ).slice(0, 500);
        await item.save();
        return res.json({
          success: true,
          archived: true,
          message: "Availability has booking history and was archived.",
        });
      }
      await Promise.all([
        FlexibleDateInventory.deleteMany({ flexAvailabilityId: item._id }),
        BookingIntent.deleteMany({ flexAvailabilityId: item._id }),
        PendingOrder.deleteMany({
          status: "expired",
          $or: [
            { flexAvailabilityId: item._id },
            {
              "payload.flexAvailabilityId": {
                $in: [item._id, String(item._id)],
              },
            },
          ],
        }),
      ]);
      await item.deleteOne();
      res.json({ success: true, archived: false, message: "Deleted" });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

module.exports = router;
