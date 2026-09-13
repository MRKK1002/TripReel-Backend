const AddonEntryRefund = require("../models/AddonEntryRefund");
const AddonPurchase = require("../models/AddonPurchase");
const TripBooking = require("../models/TripBooking");
const { refundPayment } = require("./razorpayRefund");

async function processAddonEntryRefund({
  booking,
  entryKey,
  reason,
  providerStatus,
}) {
  const entry = (booking.addonServiceEntries || []).find(
    (item) => item.key === entryKey,
  );
  if (!entry) {
    return {
      supported: false,
      reconciliation: true,
      error: "Frozen add-on entry is missing",
    };
  }

  const source = entry.paymentSource || {};
  let paymentSource;
  let paymentId;
  let addonPurchase = null;
  if (source.kind === "initial") {
    paymentSource = "INITIAL";
    paymentId = booking.razorpayPaymentId;
  } else if (source.kind === "topup" && source.orderId) {
    paymentSource = "TOPUP";
    addonPurchase = await AddonPurchase.findOne({
      bookingId: booking._id,
      razorpayOrderId: source.orderId,
      status: { $in: ["APPLIED", "REFUND_PROCESSING", "REFUNDED"] },
    });
    paymentId = addonPurchase?.razorpayPaymentId;
  }
  const amount = Number(entry.total) || 0;
  if (!paymentId || amount <= 0) {
    await AddonEntryRefund.findOneAndUpdate(
      { bookingId: booking._id, entryKey },
      {
        $setOnInsert: {
          addonPurchaseId: addonPurchase?._id || null,
          paymentSource: paymentSource || "INITIAL",
          paymentId: paymentId || "missing",
          amount,
        },
        $set: {
          reason,
          providerStatus,
          status: "RECONCILIATION_REQUIRED",
          error: "Payment source or frozen entry amount is unavailable",
        },
      },
      { upsert: true, new: true },
    );
    return { supported: true, reconciliation: true };
  }

  let record;
  try {
    record = await AddonEntryRefund.findOneAndUpdate(
      { bookingId: booking._id, entryKey },
      {
        $setOnInsert: {
          addonPurchaseId: addonPurchase?._id || null,
          paymentSource,
          paymentId,
          amount,
          status: "PENDING",
        },
        $set: { reason, providerStatus },
      },
      { upsert: true, new: true },
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
    record = await AddonEntryRefund.findOne({
      bookingId: booking._id,
      entryKey,
    });
  }
  if (
    record.status === "REFUNDED" ||
    (record.status === "PROCESSING" && record.refundId)
  ) {
    return {
      supported: true,
      refunded: record.status === "REFUNDED",
      pending: record.status === "PROCESSING",
      refundId: record.refundId,
      amount: record.amount,
    };
  }
  if (record.status === "RECONCILIATION_REQUIRED") {
    return { supported: true, reconciliation: true, error: record.error };
  }
  if (record.status === "PROCESSING") {
    await AddonEntryRefund.updateOne(
      { _id: record._id },
      {
        $set: {
          status: "RECONCILIATION_REQUIRED",
          error:
            "A prior refund submission may have reached the provider without a persisted result",
        },
      },
    );
    return { supported: true, reconciliation: true };
  }

  let paymentLockClaimed = false;
  if (paymentSource === "INITIAL") {
    const lockedBooking = await TripBooking.findOneAndUpdate(
      {
        _id: booking._id,
        refundStatus: "NONE",
        initialAddonRefundInFlight: { $ne: true },
      },
      { $set: { initialAddonRefundInFlight: true } },
      { new: true },
    );
    if (!lockedBooking) {
      const currentBooking = await TripBooking.findById(booking._id).select(
        "refundStatus initialAddonRefundInFlight",
      );
      if (["PROCESSING", "REFUNDED"].includes(currentBooking?.refundStatus)) {
        return {
          supported: true,
          pending: currentBooking.refundStatus === "PROCESSING",
          refunded: currentBooking.refundStatus === "REFUNDED",
          amount,
        };
      }
      await AddonEntryRefund.updateOne(
        { _id: record._id },
        {
          $set: {
            status: "RECONCILIATION_REQUIRED",
            error:
              "The original payment already has an unresolved refund operation",
          },
        },
      );
      return { supported: true, reconciliation: true };
    }
    paymentLockClaimed = true;
  } else {
    const lockedPurchase = await AddonPurchase.findOneAndUpdate(
      {
        _id: addonPurchase._id,
        refundStatus: "NONE",
        partialRefundInFlight: { $ne: true },
      },
      { $set: { partialRefundInFlight: true } },
      { new: true },
    );
    if (!lockedPurchase) {
      const currentPurchase = await AddonPurchase.findById(addonPurchase._id);
      if (["PROCESSING", "REFUNDED"].includes(currentPurchase?.refundStatus)) {
        return {
          supported: true,
          pending: currentPurchase.refundStatus === "PROCESSING",
          refunded: currentPurchase.refundStatus === "REFUNDED",
          amount,
        };
      }
      await AddonEntryRefund.updateOne(
        { _id: record._id },
        {
          $set: {
            status: "RECONCILIATION_REQUIRED",
            error:
              "The top-up payment already has an unresolved refund operation",
          },
        },
      );
      return { supported: true, reconciliation: true };
    }
    paymentLockClaimed = true;
  }

  const releasePaymentLock = async () => {
    if (!paymentLockClaimed) return;
    if (paymentSource === "INITIAL") {
      await TripBooking.updateOne(
        { _id: booking._id },
        { $set: { initialAddonRefundInFlight: false } },
      );
    } else if (addonPurchase?._id) {
      await AddonPurchase.updateOne(
        { _id: addonPurchase._id },
        { $set: { partialRefundInFlight: false } },
      );
    }
  };

  record = await AddonEntryRefund.findOneAndUpdate(
    {
      _id: record._id,
      status: "PENDING",
    },
    { $set: { status: "PROCESSING", error: "Refund submission in progress" } },
    { new: true },
  );
  if (!record) {
    await releasePaymentLock();
    return { supported: true, pending: true };
  }

  const result = await refundPayment(paymentId, amount, {
    purpose: "addon_entry_assignment_refund",
    bookingId: String(booking._id),
    entryKey,
    providerStatus: String(providerStatus || ""),
  });
  if (!result.success) {
    await AddonEntryRefund.updateOne(
      { _id: record._id },
      {
        $set: {
          status: "RECONCILIATION_REQUIRED",
          error: result.error || "Provider refund failed",
        },
      },
    );
    if (paymentSource === "INITIAL") {
      await TripBooking.updateOne(
        { _id: booking._id },
        { $set: { financialSettlementState: "RECONCILIATION_REQUIRED" } },
      );
    } else if (addonPurchase?._id) {
      await AddonPurchase.updateOne(
        { _id: addonPurchase._id },
        {
          $set: {
            status: "RECONCILIATION_REQUIRED",
            refundStatus: "RECONCILIATION_REQUIRED",
            refundError: result.error || "Provider refund failed",
          },
        },
      );
    }
    return { supported: true, reconciliation: true, error: result.error };
  }

  const processed =
    result.status === "processed" || result.status === "no_refund";
  await AddonEntryRefund.updateOne(
    { _id: record._id },
    {
      $set: {
        status: processed ? "REFUNDED" : "PROCESSING",
        refundId: result.refundId || "",
        refundedAt: processed ? new Date() : null,
        error: "",
      },
    },
  );
  await releasePaymentLock();
  const current = await TripBooking.findById(booking._id);
  if (current) {
    const snapjaBookings = { ...(current.snapjaBookings || {}) };
    snapjaBookings[entryKey] = {
      ...(snapjaBookings[entryKey] || {}),
      refundFlagged: true,
      refundReason: reason,
      refundState: processed ? "REFUNDED" : "PROCESSING",
      refundAmount: amount,
      refundPaymentSource: paymentSource,
      refundPaymentId: paymentId,
      refundId: result.refundId || "",
    };
    current.snapjaBookings = snapjaBookings;
    current.markModified("snapjaBookings");
    await current.save();
  }
  return {
    supported: true,
    refunded: processed,
    pending: !processed,
    refundId: result.refundId || "",
    amount,
  };
}

module.exports = { processAddonEntryRefund };
