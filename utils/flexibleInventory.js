const { randomUUID } = require("crypto");
const FlexibleAvailability = require("../models/FlexibleAvailability");
const FlexibleDateInventory = require("../models/FlexibleDateInventory");
const { dateKeyToISTStart } = require("./businessDate");

async function acquireFlexCapacityLease(id, leaseMs = 15000) {
  const now = new Date();
  const token = randomUUID();
  const item = await FlexibleAvailability.findOneAndUpdate(
    {
      _id: id,
      $or: [
        { capacityLeaseToken: "" },
        { capacityLeaseToken: { $exists: false } },
        { capacityLeaseUntil: null },
        { capacityLeaseUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        capacityLeaseToken: token,
        capacityLeaseUntil: new Date(now.getTime() + leaseMs),
      },
    },
    { new: true },
  ).select("+capacityLeaseToken +capacityLeaseUntil");
  if (!item) {
    const error = new Error(
      "Flexible capacity is being updated. Please retry.",
    );
    error.statusCode = 409;
    throw error;
  }
  return { item, token };
}

async function releaseFlexCapacityLease(id, token) {
  await FlexibleAvailability.updateOne(
    { _id: id, capacityLeaseToken: token },
    { $set: { capacityLeaseToken: "", capacityLeaseUntil: null } },
  );
}

async function materializeDateInventory(
  item,
  startDateKey,
  { syncCapacity = true } = {},
) {
  const update = {
    $setOnInsert: {
      packageId: item.packageId,
      operatorId: item.operatorId,
      startDate: dateKeyToISTStart(startDateKey),
      bookedSeats: 0,
    },
  };
  if (syncCapacity) update.$set = { capacity: item.maxBookings };
  else update.$setOnInsert.capacity = item.maxBookings;
  try {
    return await FlexibleDateInventory.findOneAndUpdate(
      { flexAvailabilityId: item._id, startDateKey },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
    const existing = await FlexibleDateInventory.findOne({
      flexAvailabilityId: item._id,
      startDateKey,
    });
    if (!existing) throw error;
    if (
      syncCapacity &&
      Number(existing.capacity) !== Number(item.maxBookings)
    ) {
      existing.capacity = item.maxBookings;
      await existing.save();
    }
    return existing;
  }
}

module.exports = {
  acquireFlexCapacityLease,
  releaseFlexCapacityLease,
  materializeDateInventory,
};
