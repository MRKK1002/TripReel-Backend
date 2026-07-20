const TripBooking = require("../models/TripBooking");
const Batch = require("../models/Batch");

// Helper: stagger notifications to avoid sending all at once
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NOTIFICATION_STAGGER_MS = 500; // 500ms gap between each push notification
const ADDON_BASE_PRICE = 2000; // ₹/day/service sent to Snapja
const SNAPJA_API = "https://api.snapja.com/api/tripreel/bookings";
const SNAPJA_API_KEY = process.env.SNAPJA_API_KEY;

// Effective trip dates — batch bookings use batch dates, flexible bookings have
// no batch so fall back to flexEndDate/flexStartDate then the booking snapshot.
// (Fixes flexible bookings staying "upcoming" forever because batchId is null.)
const effectiveEndDate = (b) =>
  b?.batchId?.endDate || b?.flexEndDate || b?.snapshot?.endDate || null;
const effectiveStartDate = (b) =>
  b?.batchId?.startDate || b?.flexStartDate || b?.snapshot?.startDate || null;

// Resolve refund % for a given trip start date from admin slabs (0 = no-refund window)
async function refundPercentForDate(startDate) {
  if (!startDate) return 0;
  const { getSetting } = require("./platformSettingsController");
  let slabs = [
    { daysBeforeTrip: 7, refundPercent: 90 },
    { daysBeforeTrip: 3, refundPercent: 50 },
    { daysBeforeTrip: 0, refundPercent: 0 },
  ];
  try {
    const s = await getSetting("cancellation_refund_slabs");
    if (Array.isArray(s) && s.length > 0) slabs = s;
  } catch {}
  slabs.sort((a, b) => b.daysBeforeTrip - a.daysBeforeTrip);
  // Normalize both dates to IST midnight (TZ pinned to Asia/Kolkata) so the
  // "days before trip" is an exact whole-day count, free of the UTC-midnight
  // skew that date-only picker values carry.
  const s2 = new Date(startDate);
  const startMid = new Date(s2.getFullYear(), s2.getMonth(), s2.getDate());
  const now2 = new Date();
  const todayMid = new Date(
    now2.getFullYear(),
    now2.getMonth(),
    now2.getDate(),
  );
  const days = Math.round(
    (startMid.getTime() - todayMid.getTime()) / (1000 * 60 * 60 * 24),
  );
  for (const slab of slabs) {
    if (days >= slab.daysBeforeTrip) return slab.refundPercent;
  }
  return 0;
}

/**
 * Job: dispatch held Snapja addon money once a booking is locked-in
 * (entered the no-refund window). Sends one Snapja booking per service per day.
 */
async function runSnapjaDispatch() {
  const results = { dispatched: 0, callsMade: 0, errors: [] };
  try {
    const Package = require("../models/Package");
    const User = require("../models/User");

    const bookings = await TripBooking.find({
      status: "CONFIRMED",
      addonHeld: true,
      addonDispatched: { $ne: true },
    }).populate("batchId", "startDate");

    console.log(
      `[SNAPJA DISPATCH] Found ${bookings.length} bookings to dispatch`,
    );

    for (const booking of bookings) {
      try {
        // Get trip start date from batch or flex snapshot
        const startDate =
          booking.batchId?.startDate ||
          booking.snapshot?.startDate ||
          booking.tripStartDate;
        if (!startDate) continue;
        // Dispatch immediately — creator needs time to prepare/accept
        if (new Date(startDate) < new Date()) continue; // skip if trip already started

        const pkg = await Package.findById(booking.packageId).select(
          "itinerary location title",
        );
        const user = await User.findById(booking.userId).select(
          "name phone email",
        );
        const addonDays = booking.addonDays || {};
        const snapjaBookings = booking.snapjaBookings || {};

        for (const addonName of Object.keys(addonDays)) {
          const serviceType = addonName.toLowerCase().includes("photographer")
            ? "photographer"
            : "reelmaker";
          for (const dayIdx of addonDays[addonName] || []) {
            const dayInfo = pkg?.itinerary?.[dayIdx];
            const actualDate = new Date(startDate);
            actualDate.setDate(actualDate.getDate() + dayIdx);

            // User-chosen schedule for this addon-day (preferred), else operator defaults
            const sched =
              (booking.addonSchedule &&
                booking.addonSchedule[addonName] &&
                booking.addonSchedule[addonName][dayIdx]) ||
              {};
            const location =
              sched.placeName ||
              dayInfo?.pickupPoint ||
              pkg?.location ||
              pkg?.title ||
              "India";
            const time = sched.time || dayInfo?.pickupTime || "10:00";
            const key = `${addonName}_${dayIdx}`;
            try {
              const snapjaRes = await fetch(SNAPJA_API, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-API-Key": SNAPJA_API_KEY,
                },
                body: JSON.stringify({
                  service_type: serviceType,
                  // Send location as an object so lat/lng survive — Snapja only
                  // reads location.lat/lng and ignores top-level latitude/longitude.
                  location: {
                    address: location,
                    lat: sched.lat || dayInfo?.pickupLat || 0,
                    lng: sched.lng || dayInfo?.pickupLng || 0,
                  },
                  price: ADDON_BASE_PRICE,
                  duration: 1,
                  date: actualDate.toISOString().split("T")[0],
                  time,
                  booking_type: "scheduled",
                  customer_name: user?.name || "Trip Reel User",
                  customer_phone: user?.phone || "",
                  customer_email: user?.email || "",
                  notes: `Trip Reel: ${pkg?.title || "Trip"} — ${addonName} — Day ${dayIdx + 1} — Booking ${booking.bookingId}`,
                  timezone: "Asia/Kolkata",
                  auto_confirm_payment: true,
                }),
              });
              const snapjaData = await snapjaRes.json().catch(() => ({}));
              results.callsMade++;

              if (snapjaRes.ok && snapjaData.success) {
                // Save Snapja booking reference per addon-day
                snapjaBookings[key] = {
                  bookingId: snapjaData.booking?.booking_id || "",
                  snapjaId: snapjaData.booking?.id || "",
                  otp: snapjaData.booking?.otp || "",
                  otpExpiresAt: snapjaData.booking?.otp_expires_at || "",
                  status: snapjaData.booking?.status || "confirmed",
                  dispatchedAt: new Date().toISOString(),
                };
              } else {
                results.errors.push(
                  `Snapja ${booking.bookingId} day ${dayIdx + 1}: ${snapjaData?.message || snapjaRes.status}`,
                );
              }
            } catch (e) {
              results.errors.push(
                `Snapja ${booking.bookingId} day ${dayIdx + 1}: ${e.message}`,
              );
            }
          }
        }

        booking.addonDispatched = true;
        booking.addonDispatchedAt = new Date();
        booking.snapjaBookings = snapjaBookings;
        booking.markModified("snapjaBookings");
        await booking.save();
        results.dispatched++;

        // Notify user with OTP for each dispatched addon-day
        const { notifyUser } = require("./notificationController");
        const otpLines = Object.entries(snapjaBookings)
          .filter(([, v]) => v.otp)
          .map(([k, v]) => {
            const [name, dayIdx] = k.split("_");
            return `${name} Day ${Number(dayIdx) + 1}: OTP ${v.otp} (Snapja ID: ${v.bookingId})`;
          });
        if (otpLines.length > 0) {
          notifyUser(
            booking.userId,
            "Addon Confirmed 📸",
            `Your addon service for ${booking.snapshot?.packageTitle || "trip"} is confirmed. Verify with OTP on the day:\n${otpLines.join("\n")}`,
            { type: "general", bookingId: booking._id.toString() },
          );
        }
      } catch (e) {
        results.errors.push(`Dispatch ${booking.bookingId}: ${e.message}`);
      }
    }
  } catch (err) {
    results.errors.push(`Snapja dispatch error: ${err.message}`);
  }
  return results;
}
exports.runSnapjaDispatch = runSnapjaDispatch;

/**
 * Job: Auto-cancel unassigned Snapja addon bookings 1 day before trip starts.
 * Runs at 11:55 PM IST daily. If no creator was assigned for an addon-day,
 * cancel it on Snapja, flag for refund, and notify the user.
 */
async function runSnapjaAutoCancel() {
  const results = { cancelled: 0, errors: [] };
  try {
    // Find bookings where trip starts TOMORROW and addons are dispatched but not all assigned
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const dayAfterTomorrow = new Date(tomorrow);
    dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

    const bookings = await TripBooking.find({
      status: "CONFIRMED",
      addonDispatched: true,
      snapjaBookings: { $exists: true, $ne: null },
    }).populate("batchId", "startDate");

    for (const booking of bookings) {
      try {
        const startDate =
          booking.batchId?.startDate || booking.snapshot?.startDate;
        if (!startDate) continue;

        const tripStart = new Date(startDate);
        tripStart.setHours(0, 0, 0, 0);

        // Only process if trip starts tomorrow
        if (tripStart < tomorrow || tripStart >= dayAfterTomorrow) continue;

        let updated = false;
        const snapjaBookings = JSON.parse(
          JSON.stringify(booking.snapjaBookings || {}),
        );

        for (const [key, snap] of Object.entries(snapjaBookings)) {
          // Skip if already assigned (has creator) or already refunded
          if (snap.creatorName || snap.refundFlagged) continue;
          if (!snap.bookingId) continue;

          // No creator assigned and trip is tomorrow — cancel on Snapja
          console.log(
            `[SNAPJA AUTO-CANCEL] Cancelling ${key} for booking ${booking.bookingId} — no creator assigned, trip tomorrow`,
          );

          // Try to cancel on Snapja
          try {
            await fetch(`${SNAPJA_API}/${snap.bookingId}`, {
              method: "DELETE",
              headers: { "X-API-Key": SNAPJA_API_KEY },
            });
          } catch {}

          // Flag for refund
          snapjaBookings[key].refundFlagged = true;
          snapjaBookings[key].refundReason = "auto_cancelled_no_assignment";
          snapjaBookings[key].status = "cancelled";
          updated = true;
          results.cancelled++;
        }

        if (updated) {
          booking.snapjaBookings = snapjaBookings;
          booking.markModified("snapjaBookings");
          await booking.save();

          // Notify user
          const { notifyUser } = require("./notificationController");
          notifyUser(
            booking.userId,
            "Add-on Service Cancelled",
            `We couldn't assign a creator before your trip tomorrow. A full refund for the add-on will be processed.`,
            { type: "general", bookingId: booking._id.toString() },
          );
        }
      } catch (e) {
        results.errors.push(`Auto-cancel ${booking.bookingId}: ${e.message}`);
      }
    }
  } catch (err) {
    results.errors.push(`Snapja auto-cancel error: ${err.message}`);
  }
  return results;
}
exports.runSnapjaAutoCancel = runSnapjaAutoCancel;

/**
 * Job: sync Snapja booking statuses (check if creator assigned, status changed)
 * Runs periodically to update our records without waiting for user to open the screen.
 */
async function runSnapjaStatusSync() {
  const results = { synced: 0, updated: 0, errors: [] };
  try {
    // Find dispatched bookings that have snapjaBookings data and trip hasn't ended
    const bookings = await TripBooking.find({
      addonDispatched: true,
      snapjaBookings: { $exists: true, $ne: null, $not: { $eq: {} } },
      status: { $in: ["CONFIRMED", "COMPLETED"] },
    }).populate("batchId", "endDate");

    for (const booking of bookings) {
      // Skip if trip already ended more than 3 days ago (check batch endDate OR tripEndDate for flex)
      const endDate = booking.batchId?.endDate || booking.tripEndDate;
      if (
        endDate &&
        new Date(endDate) < new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
      )
        continue;
      // But DON'T skip if deliverables haven't been fetched yet (keep polling for uploads)
      const hasUndelivered = Object.values(booking.snapjaBookings || {}).some(
        (s) =>
          s.creatorName && !(s.deliverables?.length > 0) && !s.refundFlagged,
      );
      if (endDate && new Date(endDate) < new Date() && !hasUndelivered)
        continue;

      let updated = false;
      // Deep copy so we can compare old vs new for notifications
      const oldSnapjaBookings = JSON.parse(
        JSON.stringify(booking.snapjaBookings || {}),
      );
      const snapjaBookings = JSON.parse(
        JSON.stringify(booking.snapjaBookings || {}),
      );

      for (const [key, snap] of Object.entries(snapjaBookings)) {
        if (!snap.bookingId) continue;
        // Once a creator is assigned we keep polling only to track live status
        // (on_the_way → in_progress → completed) until the trip ends.
        try {
          const snapRes = await fetch(`${SNAPJA_API}/${snap.bookingId}`, {
            headers: { "X-API-Key": SNAPJA_API_KEY },
          });
          if (!snapRes.ok) continue;
          const data = await snapRes.json();
          const b = data.booking;
          if (!b) continue;

          if (b.status && b.status !== snap.status) {
            snapjaBookings[key].status = b.status;
            updated = true;

            // No creator could be found / booking cancelled on Snapja side →
            // flag for refund so the held addon money is released to the user.
            const failStatuses = [
              "no_creator_available",
              "cancelled",
              "expired",
            ];
            if (
              failStatuses.includes(String(b.status).toLowerCase()) &&
              !snapjaBookings[key].refundFlagged
            ) {
              snapjaBookings[key].refundFlagged = true;
              snapjaBookings[key].refundReason = b.status;
              results.errors.push(
                `Snapja no-creator/cancel for ${booking.bookingId} ${key}: ${b.status} — flagged for refund`,
              );
              try {
                const { notifyUser } = require("./notificationController");
                notifyUser(
                  booking.userId,
                  "Add-on Could Not Be Assigned",
                  `We couldn't assign a creator for one of your add-on days. A refund for that add-on will be processed.`,
                  { type: "general", bookingId: booking._id.toString() },
                );
              } catch {}
            }
          }
          if (b.creator) {
            const newName = b.creator.name || b.creator.display_name || "";
            const newPhone = b.creator.phone || "";
            const newPhoto =
              b.creator.picture ||
              b.creator.profile_image ||
              b.creator.avatar ||
              "";
            if (
              newName !== (snap.creatorName || "") ||
              newPhone !== (snap.creatorPhone || "") ||
              newPhoto !== (snap.creatorPhoto || "")
            ) {
              snapjaBookings[key].creatorName = newName;
              snapjaBookings[key].creatorPhone = newPhone;
              snapjaBookings[key].creatorPhoto = newPhoto;
              updated = true;
            }
          }
          if (b.otp && b.otp !== snap.otp) {
            snapjaBookings[key].otp = b.otp;
            if (b.otp_expires_at)
              snapjaBookings[key].otpExpiresAt = b.otp_expires_at;
            updated = true;
          }

          // Pull deliverables (photos/videos) from Snapja
          if (
            b.deliverables &&
            Array.isArray(b.deliverables) &&
            b.deliverables.length > 0
          ) {
            const existingCount = (snap.deliverables || []).length;
            if (b.deliverables.length > existingCount) {
              snapjaBookings[key].deliverables = b.deliverables;
              snapjaBookings[key].deliveredAt =
                snapjaBookings[key].deliveredAt || new Date().toISOString();
              updated = true;

              // Notify user about new deliverables
              if (existingCount === 0) {
                try {
                  const { notifyUser } = require("./notificationController");
                  const isReel = key.toLowerCase().includes("reel");
                  const mediaType = isReel ? "videos" : "photos";
                  notifyUser(
                    booking.userId,
                    `Your ${mediaType} are ready! 🎉`,
                    `Your ${mediaType} from the trip have been delivered. Open booking details to view and download.`,
                    {
                      type: "deliverable_ready",
                      bookingId: booking._id.toString(),
                    },
                  );
                } catch {}
              }
            }
          }

          results.synced++;
        } catch (e) {
          results.errors.push(`${booking.bookingId} ${key}: ${e.message}`);
        }
      }

      if (updated) {
        booking.snapjaBookings = snapjaBookings;
        booking.markModified("snapjaBookings");
        await booking.save();
        results.updated++;

        // Notify user if creator was just assigned
        const newCreators = Object.entries(snapjaBookings).filter(
          ([k, s]) => s.creatorName && !oldSnapjaBookings[k]?.creatorName,
        );
        if (newCreators.length > 0) {
          const { notifyUser } = require("./notificationController");
          const names = newCreators.map(([, c]) => c.creatorName).join(", ");
          notifyUser(
            booking.userId,
            "Photographer Assigned! 📷",
            `${names} has been assigned for your addon service. Check booking details for their OTP.`,
            { type: "general", bookingId: booking._id.toString() },
          );
        }
      }
      await delay(200); // avoid hammering Snapja
    }
  } catch (err) {
    results.errors.push(`Snapja sync error: ${err.message}`);
  }
  return results;
}
exports.runSnapjaStatusSync = runSnapjaStatusSync;

/**
 * Cron Job Logic
 *
 * Job 1 — Auto-complete confirmed bookings where batch.endDate has passed
 * Job 2 — Auto-cancel pending bookings where batch.bookingDeadline has passed
 *
 * This is exposed as a manual admin trigger endpoint for now.
 * Wire to node-cron later: run daily at midnight.
 */
async function runCronJobs() {
  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const results = { completed: 0, cancelled: 0, walletReleased: 0, errors: [] };

  try {
    // ── Job 1: Auto-complete confirmed bookings where endDate + 2 days passed ──
    const confirmedBookings = await TripBooking.find({
      status: "CONFIRMED",
    }).populate("batchId", "endDate");

    for (const booking of confirmedBookings) {
      try {
        const endD = effectiveEndDate(booking);
        if (endD && new Date(endD) < twoDaysAgo) {
          booking.status = "COMPLETED";
          booking.hasReviewed = false;
          await booking.save();
          results.completed++;

          // Release funds to operator wallet (2 days after trip end)
          const OperatorWallet = require("../models/OperatorWallet");
          const WalletTransaction = require("../models/WalletTransaction");

          // operatorAmount already includes the outside-city addon surcharge
          const totalCredit = booking.pricing.operatorAmount;

          const wallet = await OperatorWallet.findOneAndUpdate(
            { operatorId: booking.operatorId },
            {
              $inc: {
                balance: totalCredit,
                totalEarned: totalCredit,
              },
            },
            { upsert: true, new: true },
          );

          const surchargeNote =
            booking.addonSurcharge > 0
              ? ` (incl. ₹${booking.addonSurcharge} outside-city addon surcharge)`
              : "";

          await WalletTransaction.create({
            operatorId: booking.operatorId,
            bookingId: booking._id,
            type: "CREDIT",
            amount: totalCredit,
            description: `Booking ${booking.bookingId} — funds released after trip completion${surchargeNote}`,
            balanceAfter: wallet.balance,
          });

          results.walletReleased++;

          // Notify user: trip completed, rate it
          const { notifyUser } = require("./notificationController");
          const { notifyOperator } = require("./notificationController");
          const snap = booking.snapshot || {};
          await delay(NOTIFICATION_STAGGER_MS);
          notifyUser(
            booking.userId,
            "Trip Completed! ⭐",
            `Your trip to ${snap.packageTitle || "destination"} is complete. Rate your experience!`,
            { type: "trip_completed", bookingId: booking._id.toString() },
          );
          // Notify operator: wallet credited
          await delay(NOTIFICATION_STAGGER_MS);
          notifyOperator(
            booking.operatorId,
            "Wallet Credited 💰",
            `₹${totalCredit.toLocaleString("en-IN")} credited for booking ${booking.bookingId}.`,
            { type: "wallet_credited", bookingId: booking._id.toString() },
          );
        }
      } catch (e) {
        results.errors.push(`Auto-complete ${booking.bookingId}: ${e.message}`);
      }
    }

    // ── Job 2: Auto-cancel expired pending bookings ────────────────────────
    const pendingBookings = await TripBooking.find({
      status: "PENDING",
    }).populate("batchId", "bookingDeadline");

    for (const booking of pendingBookings) {
      try {
        if (booking.batchId && booking.batchId.bookingDeadline < now) {
          booking.status = "CANCELLED";
          booking.cancelReason = "Booking deadline passed — auto-cancelled";
          booking.cancelledBy = "system";
          await booking.save();
          results.cancelled++;
        }
      } catch (e) {
        results.errors.push(`Auto-cancel ${booking.bookingId}: ${e.message}`);
      }
    }
  } catch (err) {
    results.errors.push(`Cron error: ${err.message}`);
  }

  // ── Job 3: Trip countdown notifications (7d, 3d, 1d, today) ────────────
  try {
    const { notifyUser } = require("./notificationController");
    const confirmedForReminders = await TripBooking.find({
      status: "CONFIRMED",
    }).populate("batchId", "startDate");

    for (const booking of confirmedForReminders) {
      try {
        const startDate = effectiveStartDate(booking);
        if (!startDate) continue;

        const start = new Date(startDate);
        const todayStart = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
        );
        const diffMs = start.getTime() - todayStart.getTime();
        const daysUntil = Math.round(diffMs / (1000 * 60 * 60 * 24));
        const snap = booking.snapshot || {};
        const tripName = snap.packageTitle || "your destination";

        if (daysUntil === 7) {
          await delay(NOTIFICATION_STAGGER_MS);
          notifyUser(
            booking.userId,
            "1 Week to Go! \uD83C\uDF1F",
            `Your trip to ${tripName} is in 7 days! Time to start planning what to pack.`,
            {
              type: "trip_reminder",
              bookingId: booking._id.toString(),
              screen: "BookingDetails",
            },
          );
          results.reminders = (results.reminders || 0) + 1;
        } else if (daysUntil === 3) {
          await delay(NOTIFICATION_STAGGER_MS);
          notifyUser(
            booking.userId,
            "3 Days to Go! \uD83C\uDF92",
            `Your trip to ${tripName} is in 3 days! Pack your bags and get ready.`,
            {
              type: "trip_reminder",
              bookingId: booking._id.toString(),
              screen: "BookingDetails",
            },
          );
          results.reminders = (results.reminders || 0) + 1;
        } else if (daysUntil === 1) {
          await delay(NOTIFICATION_STAGGER_MS);
          notifyUser(
            booking.userId,
            "Trip Starts Tomorrow! \uD83C\uDF34",
            `Pack your bags! Your trip to ${tripName} starts tomorrow. Check your booking for details.`,
            {
              type: "trip_reminder",
              bookingId: booking._id.toString(),
              screen: "BookingDetails",
            },
          );
          // Send email reminder
          try {
            const User = require("../models/User");
            const user = await User.findById(booking.userId).select(
              "name email",
            );
            if (user?.email) {
              const { sendTripReminder } = require("../utils/sendMail");
              sendTripReminder({
                to: user.email,
                userName: user.name || "Traveler",
                tripDetails: {
                  packageName: tripName,
                  batchDate: snap.batchLabel || "",
                },
              });
            }
          } catch {}
          results.reminders = (results.reminders || 0) + 1;
        } else if (daysUntil === 0) {
          await delay(NOTIFICATION_STAGGER_MS);
          notifyUser(
            booking.userId,
            "Your Trip is TODAY! \uD83D\uDE80",
            `Today is the day! Your trip to ${tripName} starts today. Have an amazing journey!`,
            {
              type: "trip_reminder",
              bookingId: booking._id.toString(),
              screen: "BookingDetails",
            },
          );
          results.reminders = (results.reminders || 0) + 1;
        }
      } catch {}
    }
  } catch (err) {
    results.errors.push(`Reminder job: ${err.message}`);
  }

  // ── Job 4: Review reminders (Day 1, 2, 3 after trip completion) ──────────
  try {
    const { notifyUser } = require("./notificationController");
    const completedBookings = await TripBooking.find({
      status: "COMPLETED",
      hasReviewed: false,
    }).populate("batchId", "endDate");

    for (const booking of completedBookings) {
      try {
        const endDate = effectiveEndDate(booking);
        if (!endDate) continue;

        const end = new Date(endDate);
        const todayStart = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
        );
        const diffMs = todayStart.getTime() - end.getTime();
        const daysSinceEnd = Math.round(diffMs / (1000 * 60 * 60 * 24));
        const snap = booking.snapshot || {};
        const tripName = snap.packageTitle || "your trip";

        if (daysSinceEnd === 1) {
          await delay(NOTIFICATION_STAGGER_MS);
          notifyUser(
            booking.userId,
            "How was your trip? \u2B50",
            `Your trip to ${tripName} just ended! Share your experience and help other travelers.`,
            {
              type: "trip_completed",
              bookingId: booking._id.toString(),
              screen: "ReviewScreen",
            },
          );
          // Send review request email
          try {
            const User = require("../models/User");
            const user = await User.findById(booking.userId).select(
              "name email",
            );
            if (user?.email) {
              const { sendReviewRequest } = require("../utils/sendMail");
              sendReviewRequest({
                to: user.email,
                userName: user.name || "Traveler",
                tripDetails: { packageName: tripName },
              });
            }
          } catch {}
          results.reviewReminders = (results.reviewReminders || 0) + 1;
        } else if (daysSinceEnd === 2) {
          await delay(NOTIFICATION_STAGGER_MS);
          notifyUser(
            booking.userId,
            "We'd love your feedback! \uD83D\uDCDD",
            `Haven't reviewed your trip to ${tripName} yet? Your review helps other travelers make better choices.`,
            {
              type: "trip_completed",
              bookingId: booking._id.toString(),
              screen: "ReviewScreen",
            },
          );
          results.reviewReminders = (results.reviewReminders || 0) + 1;
        } else if (daysSinceEnd === 3) {
          await delay(NOTIFICATION_STAGGER_MS);
          notifyUser(
            booking.userId,
            "Last reminder: Rate your trip \uD83C\uDFC6",
            `Final reminder! Rate your experience at ${tripName}. It only takes 30 seconds.`,
            {
              type: "trip_completed",
              bookingId: booking._id.toString(),
              screen: "ReviewScreen",
            },
          );
          results.reviewReminders = (results.reviewReminders || 0) + 1;
        }
      } catch {}
    }
  } catch (err) {
    results.errors.push(`Review reminder job: ${err.message}`);
  }

  // ── Job 5: Wishlist urgency alerts (low seats, deadline tomorrow) ──────────
  try {
    const { notifyUser } = require("./notificationController");
    const Wishlist = require("../models/Wishlist");
    const Notification = require("../models/Notification");

    const wishlists = await Wishlist.find({}).populate("packages", "_id title");
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

    for (const wishlist of wishlists) {
      const userId = wishlist.user;

      // Check how many alerts sent today (max 2 per user)
      const todayAlerts = await Notification.countDocuments({
        recipientId: userId,
        type: "offer",
        createdAt: { $gte: today },
      });
      if (todayAlerts >= 2) continue;

      for (const pkg of wishlist.packages || []) {
        if (todayAlerts >= 2) break;
        const packageId = pkg._id || pkg;
        const packageTitle = pkg.title || "a package you saved";

        // Find upcoming active batches for this package
        const upcomingBatches = await Batch.find({
          packageId,
          isActive: true,
          startDate: { $gt: now },
        });

        for (const batch of upcomingBatches) {
          if (todayAlerts >= 2) break;
          const seatsLeft = (batch.totalSeats || 0) - (batch.bookedSeats || 0);
          const deadlineDate = batch.bookingDeadline
            ? new Date(batch.bookingDeadline)
            : null;

          // Low seats alert (5 or fewer)
          if (seatsLeft > 0 && seatsLeft <= 5) {
            const alreadySent = await Notification.findOne({
              recipientId: userId,
              type: "offer",
              body: { $regex: `${seatsLeft} seat` },
              createdAt: { $gte: today },
            });
            if (!alreadySent) {
              notifyUser(
                userId,
                `Only ${seatsLeft} seats left!`,
                `${packageTitle} has only ${seatsLeft} seats remaining. Book now before it's full!`,
                {
                  type: "offer",
                  packageId: packageId.toString(),
                  screen: "PackageDetail",
                },
              );
              results.urgencyAlerts = (results.urgencyAlerts || 0) + 1;
              break;
            }
          }

          // Booking deadline tomorrow
          if (
            deadlineDate &&
            deadlineDate >= today &&
            deadlineDate < tomorrow
          ) {
            const alreadySent = await Notification.findOne({
              recipientId: userId,
              type: "offer",
              body: { $regex: "deadline" },
              createdAt: { $gte: today },
            });
            if (!alreadySent) {
              notifyUser(
                userId,
                "Booking deadline tomorrow!",
                `Last chance to book ${packageTitle}! Booking closes tomorrow.`,
                {
                  type: "offer",
                  packageId: packageId.toString(),
                  screen: "PackageDetail",
                },
              );
              results.urgencyAlerts = (results.urgencyAlerts || 0) + 1;
              break;
            }
          }
        }
      }
    }
  } catch (err) {
    results.errors.push(`Urgency alerts job: ${err.message}`);
  }

  return results;
}

// POST /api/admin/run-cron  — manual trigger (admin only)
exports.runCron = async (req, res) => {
  try {
    // Run the new split jobs (avoids double wallet-credit from legacy runCronJobs)
    const auto = await exports.runAutoCompleteAndCancel();
    const reminders = await exports.runTripReminders();
    const reviews = await exports.runReviewReminders();
    const wishlist = await exports.runWishlistAlerts();
    const results = {
      completed: auto.completed,
      cancelled: auto.cancelled,
      walletReleased: auto.walletReleased,
      reminders: reminders.reminders,
      reviewReminders: reviews.reviewReminders,
      urgencyAlerts: wishlist.urgencyAlerts,
      errors: [
        ...auto.errors,
        ...reminders.errors,
        ...reviews.errors,
        ...wishlist.errors,
      ],
    };
    res.json({
      success: true,
      message: `Cron complete. ${results.completed} completed, ${results.cancelled} cancelled.`,
      results,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DEPRECATED: runCronJobs is superseded by the split job exports below.
// Do NOT use this — it lacks the walletReleased guard and risks double-credit.
// exports.runCronJobs = runCronJobs;

// ── Split exports for separate scheduling ─────────────────────────────────────

// Job 1 + 2 only: auto-complete and auto-cancel + escrow wallet release
exports.runAutoCompleteAndCancel = async function () {
  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const results = { completed: 0, cancelled: 0, walletReleased: 0, errors: [] };

  try {
    const { notifyUser } = require("./notificationController");

    // ── Step 1: Mark CONFIRMED → COMPLETED as soon as the trip endDate passes ──
    const confirmedBookings = await TripBooking.find({
      status: "CONFIRMED",
    }).populate("batchId", "endDate");

    for (const booking of confirmedBookings) {
      try {
        const endD = effectiveEndDate(booking);
        if (endD && new Date(endD) < now) {
          booking.status = "COMPLETED";
          booking.hasReviewed = false;
          await booking.save();
          results.completed++;

          // Notify user right away — trip done, rate it
          const snap = booking.snapshot || {};
          await delay(NOTIFICATION_STAGGER_MS);
          notifyUser(
            booking.userId,
            "Trip Completed! ⭐",
            `Your trip to ${snap.packageTitle || "destination"} is complete. Rate your experience!`,
            {
              type: "trip_completed",
              bookingId: booking._id.toString(),
              screen: "ReviewScreen",
            },
          );
        }
      } catch (e) {
        results.errors.push(`Auto-complete ${booking.bookingId}: ${e.message}`);
      }
    }

    // ── Step 2: Release operator wallet 2 days after trip end (escrow) ──────────
    const completedUnpaid = await TripBooking.find({
      status: "COMPLETED",
      walletReleased: { $ne: true },
    }).populate("batchId", "endDate");

    for (const booking of completedUnpaid) {
      try {
        const endD = effectiveEndDate(booking);
        if (endD && new Date(endD) < twoDaysAgo) {
          const OperatorWallet = require("../models/OperatorWallet");
          const WalletTransaction = require("../models/WalletTransaction");
          const { notifyOperator } = require("./notificationController");
          // operatorAmount already includes the outside-city addon surcharge
          const totalCredit = booking.pricing.operatorAmount;

          const wallet = await OperatorWallet.findOneAndUpdate(
            { operatorId: booking.operatorId },
            { $inc: { balance: totalCredit, totalEarned: totalCredit } },
            { upsert: true, new: true },
          );

          const surchargeNote =
            booking.addonSurcharge > 0
              ? ` (incl. ₹${booking.addonSurcharge} outside-city addon surcharge)`
              : "";

          await WalletTransaction.create({
            operatorId: booking.operatorId,
            bookingId: booking._id,
            type: "CREDIT",
            amount: totalCredit,
            description: `Booking ${booking.bookingId} — funds released after trip completion${surchargeNote}`,
            balanceAfter: wallet.balance,
          });

          booking.walletReleased = true;
          await booking.save();
          results.walletReleased++;

          await delay(NOTIFICATION_STAGGER_MS);
          notifyOperator(
            booking.operatorId,
            "Wallet Credited 💰",
            `₹${totalCredit.toLocaleString("en-IN")} credited for booking ${booking.bookingId}.`,
            { type: "wallet_credited", bookingId: booking._id.toString() },
          );
        }
      } catch (e) {
        results.errors.push(
          `Wallet release ${booking.bookingId}: ${e.message}`,
        );
      }
    }

    // ── Step 3: Auto-cancel expired pending bookings ────────────────────────────
    const pendingBookings = await TripBooking.find({
      status: "PENDING",
    }).populate("batchId", "bookingDeadline");
    for (const booking of pendingBookings) {
      try {
        if (booking.batchId && booking.batchId.bookingDeadline < now) {
          booking.status = "CANCELLED";
          booking.cancelReason = "Booking deadline passed — auto-cancelled";
          booking.cancelledBy = "system";
          await booking.save();
          results.cancelled++;
        }
      } catch (e) {
        results.errors.push(`Auto-cancel ${booking.bookingId}: ${e.message}`);
      }
    }
  } catch (err) {
    results.errors.push(`Auto-complete/cancel error: ${err.message}`);
  }
  return results;
};

// Job 3 only: trip countdown reminders (7d, 3d, 1d, today)
exports.runTripReminders = async function () {
  const now = new Date();
  const results = { reminders: 0, errors: [] };
  try {
    const { notifyUser } = require("./notificationController");
    const confirmedForReminders = await TripBooking.find({
      status: "CONFIRMED",
    }).populate("batchId", "startDate");

    for (const booking of confirmedForReminders) {
      try {
        const startDate = effectiveStartDate(booking);
        if (!startDate) continue;
        const start = new Date(startDate);
        const todayStart = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
        );
        const diffMs = start.getTime() - todayStart.getTime();
        const daysUntil = Math.round(diffMs / (1000 * 60 * 60 * 24));
        const snap = booking.snapshot || {};
        const tripName = snap.packageTitle || "your destination";

        if (daysUntil === 7) {
          await delay(NOTIFICATION_STAGGER_MS);
          notifyUser(
            booking.userId,
            "1 Week to Go! 🌟",
            `Your trip to ${tripName} is in 7 days! Time to start planning what to pack.`,
            {
              type: "trip_reminder",
              bookingId: booking._id.toString(),
              screen: "BookingDetails",
            },
          );
          results.reminders++;
        } else if (daysUntil === 3) {
          await delay(NOTIFICATION_STAGGER_MS);
          notifyUser(
            booking.userId,
            "3 Days to Go! 🎒",
            `Your trip to ${tripName} is in 3 days! Pack your bags and get ready.`,
            {
              type: "trip_reminder",
              bookingId: booking._id.toString(),
              screen: "BookingDetails",
            },
          );
          results.reminders++;
        } else if (daysUntil === 1) {
          await delay(NOTIFICATION_STAGGER_MS);
          notifyUser(
            booking.userId,
            "Trip Starts Tomorrow! 🌴",
            `Pack your bags! Your trip to ${tripName} starts tomorrow. Check your booking for details.`,
            {
              type: "trip_reminder",
              bookingId: booking._id.toString(),
              screen: "BookingDetails",
            },
          );
          results.reminders++;
          try {
            const User = require("../models/User");
            const user = await User.findById(booking.userId).select(
              "name email",
            );
            if (user?.email) {
              const { sendTripReminder } = require("../utils/sendMail");
              sendTripReminder({
                to: user.email,
                userName: user.name || "Traveler",
                tripDetails: {
                  packageName: tripName,
                  batchDate: snap.batchLabel || "",
                },
              });
            }
          } catch {}
        } else if (daysUntil === 0) {
          await delay(NOTIFICATION_STAGGER_MS);
          notifyUser(
            booking.userId,
            "Your Trip is TODAY! 🚀",
            `Today is the day! Your trip to ${tripName} starts today. Have an amazing journey!`,
            {
              type: "trip_reminder",
              bookingId: booking._id.toString(),
              screen: "BookingDetails",
            },
          );
          results.reminders++;
        }
      } catch {}
    }
  } catch (err) {
    results.errors.push(`Trip reminders error: ${err.message}`);
  }
  return results;
};

// Job 4 only: review reminders (day 1, 2, 3 after trip end)
exports.runReviewReminders = async function () {
  const now = new Date();
  const results = { reviewReminders: 0, errors: [] };
  try {
    const { notifyUser } = require("./notificationController");
    // Only check bookings that ended within the last 5 days (day 1/2/3 reminders)
    // to avoid scanning the entire history as it grows.
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const completedBookings = await TripBooking.find({
      status: "COMPLETED",
      hasReviewed: false,
      updatedAt: { $gte: fiveDaysAgo },
    }).populate("batchId", "endDate");

    for (const booking of completedBookings) {
      try {
        const endDate = effectiveEndDate(booking);
        if (!endDate) continue;
        const end = new Date(endDate);
        const todayStart = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
        );
        const diffMs = todayStart.getTime() - end.getTime();
        const daysSinceEnd = Math.round(diffMs / (1000 * 60 * 60 * 24));
        const snap = booking.snapshot || {};
        const tripName = snap.packageTitle || "your trip";

        if (daysSinceEnd === 1) {
          await delay(NOTIFICATION_STAGGER_MS);
          notifyUser(
            booking.userId,
            "How was your trip? ⭐",
            `Your trip to ${tripName} just ended! Share your experience and help other travelers.`,
            {
              type: "trip_completed",
              bookingId: booking._id.toString(),
              screen: "ReviewScreen",
            },
          );
          results.reviewReminders++;
          try {
            const User = require("../models/User");
            const user = await User.findById(booking.userId).select(
              "name email",
            );
            if (user?.email) {
              const { sendReviewRequest } = require("../utils/sendMail");
              sendReviewRequest({
                to: user.email,
                userName: user.name || "Traveler",
                tripDetails: { packageName: tripName },
              });
            }
          } catch {}
        } else if (daysSinceEnd === 2) {
          await delay(NOTIFICATION_STAGGER_MS);
          notifyUser(
            booking.userId,
            "We'd love your feedback! 📝",
            `Haven't reviewed your trip to ${tripName} yet? Your review helps other travelers make better choices.`,
            {
              type: "trip_completed",
              bookingId: booking._id.toString(),
              screen: "ReviewScreen",
            },
          );
          results.reviewReminders++;
        } else if (daysSinceEnd === 3) {
          await delay(NOTIFICATION_STAGGER_MS);
          notifyUser(
            booking.userId,
            "Last reminder: Rate your trip 🏆",
            `Final reminder! Rate your experience at ${tripName}. It only takes 30 seconds.`,
            {
              type: "trip_completed",
              bookingId: booking._id.toString(),
              screen: "ReviewScreen",
            },
          );
          results.reviewReminders++;
        }
      } catch {}
    }
  } catch (err) {
    results.errors.push(`Review reminders error: ${err.message}`);
  }
  return results;
};

// Job 5 only: wishlist urgency alerts
exports.runWishlistAlerts = async function () {
  const now = new Date();
  const results = { urgencyAlerts: 0, errors: [] };
  try {
    const { notifyUser } = require("./notificationController");
    const Wishlist = require("../models/Wishlist");
    const Notification = require("../models/Notification");

    const wishlists = await Wishlist.find({}).populate("packages", "_id title");
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

    for (const wishlist of wishlists) {
      const userId = wishlist.user;
      const todayAlerts = await Notification.countDocuments({
        recipientId: userId,
        type: "offer",
        createdAt: { $gte: today },
      });
      if (todayAlerts >= 2) continue;

      for (const pkg of wishlist.packages || []) {
        if (todayAlerts >= 2) break;
        const packageId = pkg._id || pkg;
        const packageTitle = pkg.title || "a package you saved";
        const upcomingBatches = await Batch.find({
          packageId,
          isActive: true,
          startDate: { $gt: now },
        });

        for (const batch of upcomingBatches) {
          if (todayAlerts >= 2) break;
          const seatsLeft = (batch.totalSeats || 0) - (batch.bookedSeats || 0);
          const deadlineDate = batch.bookingDeadline
            ? new Date(batch.bookingDeadline)
            : null;

          if (seatsLeft > 0 && seatsLeft <= 5) {
            const alreadySent = await Notification.findOne({
              recipientId: userId,
              type: "offer",
              body: { $regex: `${seatsLeft} seat` },
              createdAt: { $gte: today },
            });
            if (!alreadySent) {
              await delay(NOTIFICATION_STAGGER_MS);
              notifyUser(
                userId,
                `Only ${seatsLeft} seats left!`,
                `${packageTitle} has only ${seatsLeft} seats remaining. Book now before it's full!`,
                {
                  type: "offer",
                  packageId: packageId.toString(),
                  screen: "PackageDetail",
                },
              );
              results.urgencyAlerts++;
              break;
            }
          }
          if (
            deadlineDate &&
            deadlineDate >= today &&
            deadlineDate < tomorrow
          ) {
            const alreadySent = await Notification.findOne({
              recipientId: userId,
              type: "offer",
              body: { $regex: "deadline" },
              createdAt: { $gte: today },
            });
            if (!alreadySent) {
              await delay(NOTIFICATION_STAGGER_MS);
              notifyUser(
                userId,
                "Booking deadline tomorrow!",
                `Last chance to book ${packageTitle}! Booking closes tomorrow.`,
                {
                  type: "offer",
                  packageId: packageId.toString(),
                  screen: "PackageDetail",
                },
              );
              results.urgencyAlerts++;
              break;
            }
          }
        }
      }
    }
  } catch (err) {
    results.errors.push(`Wishlist alerts error: ${err.message}`);
  }
  return results;
};

// Job 6 only: abandoned-booking reminders — nudge users who reached the
// booking screen for a package but didn't complete the booking.
exports.runAbandonedBookingReminders = async function () {
  const results = { reminders: 0, errors: [] };
  try {
    const BookingIntent = require("../models/BookingIntent");
    const { notifyUser } = require("./notificationController");
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
    const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);

    // Abandoned = seen the booking screen 2h–3d ago, not converted, not yet nudged
    const intents = await BookingIntent.find({
      converted: false,
      notified: false,
      lastSeenAt: { $lte: twoHoursAgo, $gte: threeDaysAgo },
    }).limit(200);

    for (const intent of intents) {
      try {
        const name = intent.packageTitle || "your trip";
        await delay(NOTIFICATION_STAGGER_MS);
        notifyUser(
          intent.userId,
          "Still thinking about it?",
          `You were almost there! Tap to complete your booking for ${name}.`,
          {
            type: "abandoned_booking",
            screen: "DestinationDetail",
            packageId: String(intent.packageId),
          },
        );
        intent.notified = true;
        await intent.save();
        results.reminders++;
      } catch (e) {
        results.errors.push(`Abandoned reminder ${intent._id}: ${e.message}`);
      }
    }
  } catch (err) {
    results.errors.push(`Abandoned booking reminders: ${err.message}`);
  }
  return results;
};
