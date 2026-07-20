/**
 * One-time migration: mark already-ended trips as COMPLETED.
 *
 * Fixes bookings stuck in CONFIRMED because the old cron only marked
 * COMPLETED 2 days after endDate. This:
 *   1. Marks CONFIRMED bookings whose batch.endDate has passed → COMPLETED
 *   2. Resets hasReviewed = false so the review prompt shows
 *   3. Releases operator wallet (escrow) for trips ended > 2 days ago
 *      (only if not already released)
 *   4. Sends a "Trip Completed — rate it" notification (best-effort)
 *
 * Run from TripReel-Backend:
 *   node scripts/markCompletedTrips.js
 */

require("dotenv").config();
process.env.TZ = process.env.TZ || "Asia/Kolkata"; // IST for all date math
const mongoose = require("mongoose");

const TripBooking = require("../models/TripBooking");
const Batch = require("../models/Batch");

async function main() {
  const MONGO_URI = process.env.mongodburl;
  if (!MONGO_URI) {
    console.error("❌ mongodburl not found in .env");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log("✅ MongoDB connected");

  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

  let completed = 0;
  let walletReleased = 0;
  const errors = [];

  // Best-effort notification (won't crash if Firebase isn't configured)
  let notifyUser = null;
  let notifyOperator = null;
  try {
    const nc = require("../controllers/notificationController");
    notifyUser = nc.notifyUser;
    notifyOperator = nc.notifyOperator;
  } catch (e) {
    console.warn(
      "⚠️  Notifications disabled (Firebase not available):",
      e.message,
    );
  }

  // ── Step 1: CONFIRMED → COMPLETED when trip endDate has passed ──────────────
  const confirmed = await TripBooking.find({ status: "CONFIRMED" }).populate(
    "batchId",
    "endDate",
  );

  console.log(`Found ${confirmed.length} CONFIRMED bookings to evaluate...`);

  // Flexible bookings have no batch — fall back to flexEndDate/snapshot.endDate
  const endOf = (b) =>
    b.batchId?.endDate || b.flexEndDate || b.snapshot?.endDate || null;

  for (const booking of confirmed) {
    try {
      const endD = endOf(booking);
      if (endD && new Date(endD) < now) {
        booking.status = "COMPLETED";
        booking.hasReviewed = false;
        await booking.save();
        completed++;

        const snap = booking.snapshot || {};
        if (notifyUser) {
          try {
            await notifyUser(
              booking.userId,
              "Trip Completed! ⭐",
              `Your trip to ${snap.packageTitle || "destination"} is complete. Rate your experience!`,
              {
                type: "trip_completed",
                bookingId: booking._id.toString(),
                screen: "ReviewScreen",
              },
            );
          } catch {}
        }
        console.log(`  ✓ ${booking.bookingId} → COMPLETED`);
      }
    } catch (e) {
      errors.push(`Complete ${booking.bookingId}: ${e.message}`);
    }
  }

  // ── Step 2: Release operator wallet for trips ended > 2 days ago ────────────
  const OperatorWallet = require("../models/OperatorWallet");
  const WalletTransaction = require("../models/WalletTransaction");

  const completedUnpaid = await TripBooking.find({
    status: "COMPLETED",
    walletReleased: { $ne: true },
  }).populate("batchId", "endDate");

  console.log(
    `Found ${completedUnpaid.length} COMPLETED bookings to check for wallet release...`,
  );

  for (const booking of completedUnpaid) {
    try {
      const endD = endOf(booking);
      if (endD && new Date(endD) < twoDaysAgo) {
        const totalCredit = booking.pricing?.operatorAmount || 0;
        if (totalCredit > 0) {
          const wallet = await OperatorWallet.findOneAndUpdate(
            { operatorId: booking.operatorId },
            { $inc: { balance: totalCredit, totalEarned: totalCredit } },
            { upsert: true, new: true },
          );
          await WalletTransaction.create({
            operatorId: booking.operatorId,
            bookingId: booking._id,
            type: "CREDIT",
            amount: totalCredit,
            description: `Booking ${booking.bookingId} — funds released after trip completion (backfill)`,
            balanceAfter: wallet.balance,
          });
          if (notifyOperator) {
            try {
              await notifyOperator(
                booking.operatorId,
                "Wallet Credited 💰",
                `₹${totalCredit.toLocaleString("en-IN")} credited for booking ${booking.bookingId}.`,
                { type: "wallet_credited", bookingId: booking._id.toString() },
              );
            } catch {}
          }
        }
        booking.walletReleased = true;
        await booking.save();
        walletReleased++;
        console.log(
          `  ✓ ${booking.bookingId} → wallet released (₹${totalCredit})`,
        );
      }
    } catch (e) {
      errors.push(`Wallet ${booking.bookingId}: ${e.message}`);
    }
  }

  console.log("\n──────── SUMMARY ────────");
  console.log(`Marked COMPLETED : ${completed}`);
  console.log(`Wallets released : ${walletReleased}`);
  if (errors.length) {
    console.log(`Errors           : ${errors.length}`);
    errors.forEach((e) => console.log("   - " + e));
  }

  await mongoose.disconnect();
  console.log("✅ Done. Disconnected.");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Script failed:", err);
  process.exit(1);
});
