const AddonPurchase = require("../models/AddonPurchase");
const AddonEntryRefund = require("../models/AddonEntryRefund");
const { refundPayment } = require("./razorpayRefund");

async function refundAppliedAddonPurchases(booking, reason) {
  const purchases = await AddonPurchase.find({
    bookingId: booking._id,
    status: {
      $in: [
        "CAPTURED",
        "PROCESSING",
        "APPLIED",
        "REFUND_PROCESSING",
        "REFUNDED",
        "RECONCILIATION_REQUIRED",
      ],
    },
  });
  const knownPaymentIds = new Set(
    purchases.map((purchase) => purchase.razorpayPaymentId).filter(Boolean),
  );
  const legacyPaymentIds = (booking.addonTopupPaymentIds || []).filter(Boolean);
  const missingLegacyPayments = legacyPaymentIds.filter(
    (paymentId) => !knownPaymentIds.has(paymentId),
  );
  let requestedAmount = 0;
  let refundedAmount = 0;
  let pending = false;
  let reconciliation = missingLegacyPayments.length > 0;

  for (let purchase of purchases) {
    const purchaseId = purchase._id;
    const ambiguousEntryRefund = await AddonEntryRefund.findOne({
      bookingId: booking._id,
      addonPurchaseId: purchase._id,
      $or: [
        { status: "RECONCILIATION_REQUIRED" },
        { status: "PROCESSING", refundId: "" },
      ],
    }).select("_id");
    if (ambiguousEntryRefund || purchase.partialRefundInFlight) {
      reconciliation = true;
      continue;
    }
    const priorEntryRefunds = await AddonEntryRefund.aggregate([
      {
        $match: {
          bookingId: booking._id,
          addonPurchaseId: purchase._id,
          status: { $in: ["REFUNDED", "PROCESSING"] },
          refundId: { $ne: "" },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const paidAmount = Number(purchase.amountPaise) / 100;
    const remaining = Math.max(
      0,
      paidAmount - Number(priorEntryRefunds[0]?.total || 0),
    );
    requestedAmount += remaining;

    if (purchase.refundStatus === "REFUNDED") {
      refundedAmount += Number(purchase.refundAmount) || remaining;
      continue;
    }
    if (purchase.refundStatus === "PROCESSING" && purchase.refundId) {
      pending = true;
      continue;
    }
    if (
      purchase.refundStatus === "RECONCILIATION_REQUIRED" ||
      purchase.status === "RECONCILIATION_REQUIRED" ||
      (purchase.refundStatus === "PROCESSING" && !purchase.refundId) ||
      !purchase.razorpayPaymentId
    ) {
      reconciliation = true;
      continue;
    }
    if (remaining <= 0) {
      await AddonPurchase.updateOne(
        { _id: purchase._id },
        {
          $set: {
            status: "REFUNDED",
            refundStatus: "REFUNDED",
            refundAmount: 0,
            refundedAt: new Date(),
            refundReason: reason,
            refundError: "",
          },
        },
      );
      continue;
    }

    purchase = await AddonPurchase.findOneAndUpdate(
      {
        _id: purchase._id,
        refundStatus: "NONE",
        status: { $in: ["CAPTURED", "PROCESSING", "APPLIED"] },
        partialRefundInFlight: { $ne: true },
      },
      {
        $set: {
          status: "REFUND_PROCESSING",
          refundStatus: "PROCESSING",
          refundAmount: remaining,
          refundReason: reason,
          refundError: "Refund submission in progress",
        },
      },
      { new: true },
    );
    if (!purchase) {
      const currentPurchase = await AddonPurchase.findById(purchaseId);
      if (
        currentPurchase?.partialRefundInFlight ||
        currentPurchase?.refundStatus === "RECONCILIATION_REQUIRED"
      ) {
        reconciliation = true;
      } else {
        pending = true;
      }
      continue;
    }

    const result = await refundPayment(purchase.razorpayPaymentId, remaining, {
      purpose: "booking_cancellation_addon_refund",
      bookingId: String(booking._id),
      addonPurchaseId: String(purchase._id),
    });
    if (!result.success) {
      reconciliation = true;
      await AddonPurchase.updateOne(
        { _id: purchase._id },
        {
          $set: {
            status: "RECONCILIATION_REQUIRED",
            refundStatus: "RECONCILIATION_REQUIRED",
            refundError: result.error || "Refund failed",
          },
        },
      );
      continue;
    }
    const processed =
      result.status === "processed" || result.status === "no_refund";
    await AddonPurchase.updateOne(
      { _id: purchase._id },
      {
        $set: {
          status: processed ? "REFUNDED" : "REFUND_PROCESSING",
          refundStatus: processed ? "REFUNDED" : "PROCESSING",
          refundId: result.refundId || "",
          refundedAt: processed ? new Date() : null,
          refundError: "",
        },
      },
    );
    if (processed) refundedAmount += remaining;
    else pending = true;
  }

  return {
    requestedAmount,
    refundedAmount,
    pending,
    reconciliation,
    missingLegacyPayments,
    status: reconciliation
      ? "RECONCILIATION_REQUIRED"
      : pending
        ? "PROCESSING"
        : "REFUNDED",
  };
}

module.exports = { refundAppliedAddonPurchases };
