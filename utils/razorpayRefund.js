const Razorpay = require("razorpay");

let razorpay;
function getRazorpay() {
  if (!razorpay) {
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return razorpay;
}

/**
 * Issue a refund against a captured Razorpay payment.
 *
 * @param {string} paymentId  Razorpay payment id (pay_xxx)
 * @param {number} amountRupees  amount to refund in INR (will be converted to paise)
 * @param {object} notes  optional metadata stored on the refund
 * @returns {Promise<{ success: boolean, refundId?: string, status?: string, error?: string }>}
 */
async function refundPayment(paymentId, amountRupees, notes = {}) {
  if (!paymentId) {
    return { success: false, error: "Missing razorpay payment id" };
  }
  const amountPaise = Math.round(Number(amountRupees) * 100);
  if (!amountPaise || amountPaise <= 0) {
    // Nothing to refund (e.g. 0% slab) — treat as success with no refund
    return { success: true, refundId: "", status: "no_refund" };
  }
  try {
    const refund = await getRazorpay().payments.refund(paymentId, {
      amount: amountPaise,
      speed: "normal",
      notes,
    });
    return {
      success: true,
      refundId: refund.id,
      status: refund.status, // pending | processed
    };
  } catch (err) {
    const msg =
      err?.error?.description || err?.message || "Razorpay refund failed";
    return { success: false, error: msg };
  }
}

async function fetchRefundStatus(refundId) {
  if (!refundId) {
    return { supported: true, success: false, error: "Missing refund id" };
  }
  const resource = getRazorpay().refunds;
  if (!resource || typeof resource.fetch !== "function") {
    return { supported: false, success: false };
  }
  try {
    const refund = await resource.fetch(refundId);
    return {
      supported: true,
      success: true,
      refundId: refund.id || refundId,
      status: refund.status || "unknown",
    };
  } catch (err) {
    return {
      supported: true,
      success: false,
      error: err?.error?.description || err?.message || "Refund fetch failed",
    };
  }
}

module.exports = { refundPayment, fetchRefundStatus };
