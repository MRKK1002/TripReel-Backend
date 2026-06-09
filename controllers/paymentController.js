const Razorpay = require("razorpay");
const crypto = require("crypto");
const {
  sendBookingConfirmation,
  sendPaymentReceipt,
} = require("../utils/sendMail");

// Initialize lazily so dotenv has time to load
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
 * POST /api/payments/create-order
 * Creates a Razorpay order and returns order details to frontend
 */
exports.createOrder = async (req, res) => {
  try {
    const { amount, packageId, batchId, seats, couponCode, travelers } =
      req.body;

    if (!amount || !packageId || !batchId) {
      return res.status(400).json({
        success: false,
        message: "amount, packageId, and batchId are required",
      });
    }

    const amountInPaise = Math.round(amount * 100); // Razorpay expects paise

    const options = {
      amount: amountInPaise,
      currency: "INR",
      receipt: `tripreel_${Date.now()}`,
      notes: {
        packageId,
        batchId,
        seats: String(seats || 1),
        userId: req.user._id.toString(),
        couponCode: couponCode || "",
      },
    };

    const order = await getRazorpay().orders.create(options);

    res.status(200).json({
      success: true,
      orderId: order.id, // internal reference
      razorpayOrderId: order.id,
      amountInPaise: order.amount,
      currency: order.currency,
    });
  } catch (err) {
    console.error("Razorpay create order error:", err);
    res.status(500).json({
      success: false,
      message: "Could not create payment order",
      error: err.message,
    });
  }
};

/**
 * POST /api/payments/verify
 * Verifies Razorpay payment signature and creates the booking
 */
exports.verifyPayment = async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      orderId,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Missing payment verification fields",
      });
    }

    // Verify signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Payment verification failed — invalid signature",
      });
    }

    // Fetch the order to get notes (packageId, batchId, seats, couponCode)
    const order = await getRazorpay().orders.fetch(razorpay_order_id);
    const { packageId, batchId, seats, couponCode } = order.notes || {};

    // Now create the actual booking using the existing tripBookingController logic
    // We simulate a request to reuse the existing createBooking logic
    const tripBookingController = require("./tripBookingController");
    const fakeReq = {
      user: req.user,
      body: {
        packageId,
        batchId,
        seats: Number(seats) || 1,
        couponCode: couponCode || "",
        travelers: req.body.travelers || [],
        paymentId: razorpay_payment_id,
        razorpayOrderId: razorpay_order_id,
      },
    };

    // Use a promise-based wrapper for the existing controller
    const booking = await new Promise((resolve, reject) => {
      const fakeRes = {
        status: (code) => ({
          json: (data) => {
            if (code >= 400)
              reject(new Error(data.message || "Booking creation failed"));
            else resolve(data);
          },
        }),
        json: (data) => resolve(data),
      };
      tripBookingController.createBooking(fakeReq, fakeRes).catch(reject);
    });

    res.status(200).json({
      success: true,
      message: "Payment verified and booking confirmed",
      bookingId: booking?.booking?._id || booking?._id || null,
      paymentId: razorpay_payment_id,
    });

    // Email is already sent by createBooking — no need to send again here
  } catch (err) {
    console.error("Payment verification error:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Payment verification failed",
    });
  }
};
