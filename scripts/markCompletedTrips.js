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
const { randomUUID } = require("crypto");

const TripBooking = require("../models/TripBooking");
const Batch = require("../models/Batch");
const {
  creditOperatorWalletIdempotent,
} = require("../utils/idempotentWalletCredit");

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
        const completedBooking = await TripBooking.findOneAndUpdate(
          { _id: booking._id, status: "CONFIRMED" },
          { $set: { status: "COMPLETED", hasReviewed: false } },
          { new: true },
        );
        if (!completedBooking) continue;
        completed++;

        const snap = completedBooking.snapshot || {};
        if (notifyUser) {
          try {
            await notifyUser(
              completedBooking.userId,
              "Trip Completed! ⭐",
              `Your trip to ${snap.packageTitle || "destination"} is complete. Rate your experience!`,
              {
                type: "trip_completed",
                bookingId: completedBooking._id.toString(),
                screen: "ReviewScreen",
              },
            );
          } catch {}
        }
        console.log(`  ✓ ${completedBooking.bookingId} → COMPLETED`);
      }
    } catch (e) {
      errors.push(`Complete ${booking.bookingId}: ${e.message}`);
    }
  }

  // ── Step 2: Release operator wallet for trips ended > 2 days ago ────────────
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
        const releaseToken = randomUUID();
        const claimed = await TripBooking.findOneAndUpdate(
          {
            _id: booking._id,
            status: "COMPLETED",
            walletReleased: { $ne: true },
            $or: [
              { walletReleaseState: { $exists: false } },
              { walletReleaseState: { $in: ["PENDING", "FAILED"] } },
              {
                walletReleaseState: "PROCESSING",
                walletReleaseLeaseUntil: { $ne: null, $lte: now },
              },
            ],
          },
          {
            $set: {
              walletReleaseState: "PROCESSING",
              walletReleaseToken: releaseToken,
              walletReleaseLeaseUntil: new Date(Date.now() + 10 * 60 * 1000),
              walletReleaseError: "",
            },
          },
          { new: true },
        );
        if (!claimed) continue;

        try {
          const totalCredit = Number(claimed.pricing?.operatorAmount) || 0;
          let creditApplied = false;
          if (totalCredit > 0) {
            const credit = await creditOperatorWalletIdempotent({
              operatorId: claimed.operatorId,
              amount: totalCredit,
              bookingId: claimed._id,
              eventKey: `escrow:${claimed._id}`,
              purpose: "ESCROW_RELEASE",
              description: `Booking ${claimed.bookingId} — funds released after trip completion (backfill)`,
            });
            creditApplied = credit.applied;
          }

          const finalized = await TripBooking.updateOne(
            {
              _id: claimed._id,
              walletReleased: { $ne: true },
              walletReleaseState: "PROCESSING",
              walletReleaseToken: releaseToken,
            },
            {
              $set: {
                walletReleased: true,
                walletReleaseState: "RELEASED",
                walletReleaseToken: "",
                walletReleaseLeaseUntil: null,
                walletReleaseError: "",
              },
            },
          );
          if (finalized.modifiedCount !== 1) continue;

          if (creditApplied && notifyOperator) {
            try {
              await notifyOperator(
                claimed.operatorId,
                "Wallet Credited 💰",
                `₹${totalCredit.toLocaleString("en-IN")} credited for booking ${claimed.bookingId}.`,
                { type: "wallet_credited", bookingId: claimed._id.toString() },
              );
            } catch {}
          }
          walletReleased++;
          console.log(
            `  ✓ ${claimed.bookingId} → wallet released (₹${totalCredit})`,
          );
        } catch (error) {
          await TripBooking.updateOne(
            {
              _id: claimed._id,
              walletReleaseState: "PROCESSING",
              walletReleaseToken: releaseToken,
            },
            {
              $set: {
                walletReleaseState: "FAILED",
                walletReleaseToken: "",
                walletReleaseLeaseUntil: null,
                walletReleaseError: String(error.message || error).slice(
                  0,
                  500,
                ),
              },
            },
          ).catch(() => {});
          throw error;
        }
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
