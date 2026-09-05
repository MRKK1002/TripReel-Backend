const TripBooking = require("../models/TripBooking");
const SnapjaDispatchClaim = require("../models/SnapjaDispatchClaim");
const { randomUUID } = require("crypto");
const Batch = require("../models/Batch");
const { getSetting } = require("./platformSettingsController");
const { getItineraryDateKey } = require("../utils/addonBookingTiming");
const {
  creditOperatorWalletIdempotent,
} = require("../utils/idempotentWalletCredit");

// Helper: stagger notifications to avoid sending all at once
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NOTIFICATION_STAGGER_MS = 500; // 500ms gap between each push notification
const SNAPJA_API =
  process.env.SNAPJA_API_URL || "https://api.snapja.com/api/tripreel/bookings";
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
async function runSnapjaDispatch(bookingId = null) {
  const results = { dispatched: 0, callsMade: 0, errors: [] };
  try {
    const Package = require("../models/Package");
    const User = require("../models/User");
    const photographerPrice =
      (await getSetting("photographer_base_price")) ?? 2000;
    const videographerPrice =
      (await getSetting("videographer_base_price")) ?? 2000;

    const dispatchQuery = {
      status: "CONFIRMED",
      addonHeld: true,
      addonDispatched: { $ne: true },
    };
    if (bookingId) dispatchQuery._id = bookingId;

    const bookings = await TripBooking.find(dispatchQuery).populate(
      "batchId",
      "startDate",
    );

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

        const pkg = await Package.findById(booking.packageId).select(
          "itinerary location title",
        );
        const user = await User.findById(booking.userId).select(
          "name phone email",
        );
        const addonDays = booking.addonDays || {};
        const snapjaBookings = booking.snapjaBookings || {};
        const addonBookingTypes = booking.addonBookingTypes || {};
        const newlyDispatchedKeys = [];
        const requiredKeys = [];

        for (const addonName of Object.keys(addonDays)) {
          const serviceType = addonName.toLowerCase().includes("photographer")
            ? "photographer"
            : "reelmaker";
          const addonPrice =
            serviceType === "reelmaker" ? videographerPrice : photographerPrice;
          for (const dayIdx of addonDays[addonName] || []) {
            const dayInfo = pkg?.itinerary?.[dayIdx];
            const actualDate = getItineraryDateKey(booking, dayIdx);
            const key = `${addonName}_${dayIdx}`;
            const bookingType = addonBookingTypes[key] || "scheduled";
            requiredKeys.push(key);

            // Same-day instant entries were fixed server-side at payment
            // verification. Future scheduled entries retain user-selected
            // schedule with operator/package fallbacks for legacy bookings.
            const sched =
              (booking.addonSchedule &&
                booking.addonSchedule[addonName] &&
                booking.addonSchedule[addonName][dayIdx]) ||
              {};
            if (
              bookingType === "instant" &&
              (!sched.fixedByOperator ||
                !sched.placeName ||
                !sched.time ||
                !Number.isFinite(Number(sched.lat)) ||
                !Number.isFinite(Number(sched.lng)))
            ) {
              results.errors.push(
                `Snapja ${booking.bookingId} day ${dayIdx + 1}: fixed operator schedule is missing`,
              );
              continue;
            }
            if (!actualDate) {
              results.errors.push(
                `Snapja ${booking.bookingId} day ${dayIdx + 1}: itinerary date is invalid`,
              );
              continue;
            }

            const location =
              bookingType === "instant"
                ? sched.placeName
                : sched.placeName ||
                  dayInfo?.pickupPoint ||
                  pkg?.location ||
                  pkg?.title ||
                  "India";
            const time =
              bookingType === "instant"
                ? sched.time
                : sched.time || dayInfo?.pickupTime || "10:00";
            // Skip addon-days that were already dispatched to Snapja. This makes
            // dispatch idempotent per addon-day, so a post-booking add-on top-up
            // (which resets addonDispatched=false) only sends the NEW days and
            // never creates duplicate Snapja bookings for existing ones.
            if (snapjaBookings[key]?.bookingId) continue;

            // Claim this external side effect in Mongo before calling Snapja.
            // This prevents the immediate verifier and the five-minute cron
            // from posting the same entry concurrently, even across processes.
            try {
              await SnapjaDispatchClaim.updateOne(
                { tripBookingId: booking._id, entryKey: key },
                {
                  $setOnInsert: {
                    operationId: randomUUID(),
                    state: "RETRYABLE",
                  },
                },
                { upsert: true },
              );
            } catch (claimSeedError) {
              if (claimSeedError.code !== 11000) throw claimSeedError;
            }

            let existingClaim = await SnapjaDispatchClaim.findOne({
              tripBookingId: booking._id,
              entryKey: key,
            });
            if (existingClaim?.state === "DISPATCHED") {
              if (existingClaim.snapjaBooking?.bookingId) {
                snapjaBookings[key] = existingClaim.snapjaBooking;
              }
              continue;
            }
            if (existingClaim?.state === "UNCERTAIN") {
              results.errors.push(
                `Snapja ${booking.bookingId} day ${dayIdx + 1}: dispatch result is uncertain; manual reconciliation required`,
              );
              continue;
            }
            if (
              existingClaim?.state === "DISPATCHING" &&
              existingClaim.leaseUntil &&
              existingClaim.leaseUntil <= new Date()
            ) {
              await SnapjaDispatchClaim.updateOne(
                { _id: existingClaim._id, state: "DISPATCHING" },
                {
                  $set: {
                    state: "UNCERTAIN",
                    lastError:
                      "Dispatcher lease expired before the Snapja response was persisted",
                  },
                },
              );
              results.errors.push(
                `Snapja ${booking.bookingId} day ${dayIdx + 1}: expired dispatch requires manual reconciliation`,
              );
              continue;
            }

            const claim = await SnapjaDispatchClaim.findOneAndUpdate(
              {
                tripBookingId: booking._id,
                entryKey: key,
                state: "RETRYABLE",
              },
              {
                $set: {
                  state: "DISPATCHING",
                  leaseUntil: new Date(Date.now() + 10 * 60 * 1000),
                  lastError: "",
                },
                $inc: { attempts: 1 },
              },
              { new: true },
            );
            if (!claim) continue;

            try {
              const snapjaRes = await fetch(SNAPJA_API, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-API-Key": SNAPJA_API_KEY,
                  "X-Idempotency-Key": claim.operationId,
                },
                body: JSON.stringify({
                  service_type: serviceType,
                  // Send location as an object so lat/lng survive — Snapja only
                  // reads location.lat/lng and ignores top-level latitude/longitude.
                  location: {
                    address: location,
                    lat:
                      bookingType === "instant"
                        ? Number(sched.lat)
                        : Number(sched.lat ?? dayInfo?.pickupLat ?? 0),
                    lng:
                      bookingType === "instant"
                        ? Number(sched.lng)
                        : Number(sched.lng ?? dayInfo?.pickupLng ?? 0),
                  },
                  price: addonPrice,
                  duration: 1,
                  date: actualDate,
                  time,
                  booking_type: bookingType,
                  customer_name: user?.name || "Trip Reel User",
                  customer_phone: user?.phone || "",
                  customer_email: user?.email || "",
                  notes: `Trip Reel: ${pkg?.title || "Trip"} — ${addonName} — Day ${dayIdx + 1} — Booking ${booking.bookingId} — Dispatch ${claim.operationId}`,
                  timezone: "Asia/Kolkata",
                  auto_confirm_payment: true,
                }),
              });
              const snapjaData = await snapjaRes.json().catch(() => ({}));
              results.callsMade++;

              const returnedBookingId =
                snapjaData.booking?.booking_id || snapjaData.booking?.id || "";
              if (snapjaRes.ok && snapjaData.success && returnedBookingId) {
                const dispatchedEntry = {
                  bookingId:
                    snapjaData.booking?.booking_id || returnedBookingId,
                  snapjaId: snapjaData.booking?.id || "",
                  otp: snapjaData.booking?.otp || "",
                  otpExpiresAt: snapjaData.booking?.otp_expires_at || "",
                  status: snapjaData.booking?.status || "confirmed",
                  bookingType,
                  dispatchedAt: new Date().toISOString(),
                };
                // Persist the external result in the claim first. If the
                // TripBooking save fails, the next worker repairs it from here
                // instead of posting a duplicate booking.
                await SnapjaDispatchClaim.updateOne(
                  { _id: claim._id, state: "DISPATCHING" },
                  {
                    $set: {
                      state: "DISPATCHED",
                      snapjaBooking: dispatchedEntry,
                      leaseUntil: null,
                    },
                  },
                );
                snapjaBookings[key] = dispatchedEntry;
                newlyDispatchedKeys.push(key);
              } else {
                const responseState =
                  snapjaRes.status >= 500 ||
                  (snapjaRes.ok && snapjaData.success && !returnedBookingId)
                    ? "UNCERTAIN"
                    : "RETRYABLE";
                const responseError =
                  snapjaData?.message ||
                  (snapjaRes.ok && !returnedBookingId
                    ? "Snapja response did not include a booking id"
                    : `HTTP ${snapjaRes.status}`);
                await SnapjaDispatchClaim.updateOne(
                  { _id: claim._id, state: "DISPATCHING" },
                  {
                    $set: {
                      state: responseState,
                      leaseUntil: null,
                      lastError: responseError,
                    },
                  },
                );
                results.errors.push(
                  `Snapja ${booking.bookingId} day ${dayIdx + 1}: ${responseError}${
                    responseState === "UNCERTAIN"
                      ? "; manual reconciliation required"
                      : ""
                  }`,
                );
                if (responseState === "UNCERTAIN") {
                  try {
                    const { notifyAdmin } = require("./notificationController");
                    notifyAdmin(
                      "Snapja Dispatch Needs Reconciliation",
                      `Booking ${booking.bookingId}, ${addonName} day ${dayIdx + 1}: ${responseError}. Dispatch reference ${claim.operationId}.`,
                      { type: "general", bookingId: booking._id.toString() },
                    );
                  } catch {}
                }
              }
            } catch (e) {
              // A transport failure may happen after Snapja accepted the POST.
              // Do not blindly retry and risk a duplicate paid booking.
              await SnapjaDispatchClaim.updateOne(
                { _id: claim._id, state: "DISPATCHING" },
                {
                  $set: {
                    state: "UNCERTAIN",
                    leaseUntil: null,
                    lastError: e.message,
                  },
                },
              ).catch(() => {});
              results.errors.push(
                `Snapja ${booking.bookingId} day ${dayIdx + 1}: ${e.message}; manual reconciliation required`,
              );
              try {
                const { notifyAdmin } = require("./notificationController");
                notifyAdmin(
                  "Snapja Dispatch Needs Reconciliation",
                  `Booking ${booking.bookingId}, ${addonName} day ${dayIdx + 1}: Snapja may have accepted dispatch ${claim.operationId}, but TripReel did not receive a reliable response.`,
                  { type: "general", bookingId: booking._id.toString() },
                );
              } catch {}
            }
          }
        }

        const allDispatched =
          requiredKeys.length > 0 &&
          requiredKeys.every((key) => Boolean(snapjaBookings[key]?.bookingId));
        booking.addonDispatched = allDispatched;
        booking.addonDispatchedAt = allDispatched ? new Date() : null;
        booking.snapjaBookings = snapjaBookings;
        booking.markModified("snapjaBookings");
        await booking.save();
        if (allDispatched) results.dispatched++;

        // Notify only for entries created in this attempt; a partial retry must
        // not repeat OTP notifications for older successful entries.
        const { notifyUser } = require("./notificationController");
        const otpLines = newlyDispatchedKeys
          .map((key) => [key, snapjaBookings[key]])
          .filter(([, value]) => value?.otp)
          .map(([key, value]) => {
            const separator = key.lastIndexOf("_");
            const name = key.slice(0, separator);
            const dayIdx = key.slice(separator + 1);
            return `${name} Day ${Number(dayIdx) + 1}: OTP ${value.otp} (Snapja ID: ${value.bookingId})`;
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

          // IMPORTANT: Check live Snapja status before cancelling — our local
          // `creatorName` may be stale if the hourly sync hasn't run yet.
          try {
            const liveRes = await fetch(`${SNAPJA_API}/${snap.bookingId}`, {
              headers: { "X-API-Key": SNAPJA_API_KEY },
            });
            if (liveRes.ok) {
              const liveData = await liveRes.json();
              const b = liveData.booking || liveData;
              if (b.creator?.name || b.creator?.display_name) {
                // Creator WAS assigned on Snapja — update our record, DON'T cancel
                snapjaBookings[key].creatorName =
                  b.creator.name || b.creator.display_name;
                snapjaBookings[key].creatorPhone = b.creator.phone || "";
                snapjaBookings[key].creatorPhoto =
                  b.creator.picture || b.creator.profile_image || "";
                if (b.otp) snapjaBookings[key].otp = b.otp;
                if (b.otp_expires_at)
                  snapjaBookings[key].otpExpiresAt = b.otp_expires_at;
                snapjaBookings[key].status = b.status || "confirmed";
                updated = true;
                continue; // skip cancellation
              }
            }
          } catch {}

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

          // Sync live status (confirmed → in_progress → completed). Once the
          // shoot is completed the app stops showing OTP + Call.
          if (b.status) {
            const liveStatus = String(b.status).toLowerCase();
            if (liveStatus !== String(snap.status || "").toLowerCase()) {
              snapjaBookings[key].status = liveStatus;
              updated = true;
            }
            const doneStatuses = ["completed", "delivered", "done", "finished"];
            if (doneStatuses.includes(liveStatus) && !snap.completedAt) {
              snapjaBookings[key].completedAt = new Date().toISOString();
              updated = true;
            }
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
          // operatorAmount already includes the outside-city addon surcharge
          const totalCredit = Number(booking.pricing?.operatorAmount) || 0;
          const surchargeNote =
            booking.addonSurcharge > 0
              ? ` (incl. ₹${booking.addonSurcharge} outside-city addon surcharge)`
              : "";
          let creditApplied = false;
          if (totalCredit > 0) {
            const credit = await creditOperatorWalletIdempotent({
              operatorId: booking.operatorId,
              amount: totalCredit,
              bookingId: booking._id,
              eventKey: `escrow:${booking._id}`,
              purpose: "ESCROW_RELEASE",
              description: `Booking ${booking.bookingId} — funds released after trip completion${surchargeNote}`,
            });
            creditApplied = credit.applied;
          }
          booking.walletReleased = true;
          booking.walletReleaseState = "RELEASED";
          await booking.save();
          if (creditApplied) results.walletReleased++;

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
          // Notify operator only when this invocation applied the credit.
          if (creditApplied) {
            await delay(NOTIFICATION_STAGGER_MS);
            notifyOperator(
              booking.operatorId,
              "Wallet Credited 💰",
              `₹${totalCredit.toLocaleString("en-IN")} credited for booking ${booking.bookingId}.`,
              { type: "wallet_credited", bookingId: booking._id.toString() },
            );
          }
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
                  screen: "DestinationDetail",
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
                  screen: "DestinationDetail",
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

// Days a DRAFT operator can sit un-submitted before it auto-expires
const DRAFT_EXPIRY_DAYS = Number(process.env.OPERATOR_DRAFT_EXPIRY_DAYS) || 14;

/**
 * Job: auto-expire abandoned operator drafts.
 * An operator who registered but never submitted their onboarding form within
 * DRAFT_EXPIRY_DAYS is moved DRAFT → EXPIRED, so they drop out of the admin's
 * queue and the drafts pile stops growing. They can still re-apply (EXPIRED is
 * an editable state), which puts them back into PENDING_APPROVAL.
 */
exports.runStaleDraftExpiry = async function () {
  const results = { expired: 0, errors: [] };
  try {
    const { Operator } = require("../models/Operator");
    const cutoff = new Date(
      Date.now() - DRAFT_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    );

    // Never submitted (submissionCount 0 / no lastSubmittedAt) and registered
    // before the cutoff.
    const stale = await Operator.find({
      onboardingState: "DRAFT",
      createdAt: { $lt: cutoff },
      $or: [
        { submissionCount: { $in: [0, null] } },
        { submissionCount: { $exists: false } },
      ],
      lastSubmittedAt: { $in: [null, undefined] },
    }).select("_id onboardingState transitionHistory");

    for (const op of stale) {
      try {
        op.transitionHistory.push({
          fromState: "DRAFT",
          toState: "EXPIRED",
          note: `Auto-expired: onboarding not completed within ${DRAFT_EXPIRY_DAYS} days`,
          timestamp: new Date(),
        });
        op.onboardingState = "EXPIRED";
        await op.save();
        results.expired++;
      } catch (e) {
        results.errors.push(`Expire ${op._id}: ${e.message}`);
      }
    }
  } catch (err) {
    results.errors.push(`Stale draft expiry: ${err.message}`);
  }
  return results;
};

// POST /api/admin/run-cron  — manual trigger (admin only)
exports.runCron = async (req, res) => {
  try {
    // Run the new split jobs (avoids double wallet-credit from legacy runCronJobs)
    const auto = await exports.runAutoCompleteAndCancel();
    const reminders = await exports.runTripReminders();
    const reviews = await exports.runReviewReminders();
    const wishlist = await exports.runWishlistAlerts();
    const drafts = await exports.runStaleDraftExpiry();
    const results = {
      completed: auto.completed,
      cancelled: auto.cancelled,
      walletReleased: auto.walletReleased,
      reminders: reminders.reminders,
      reviewReminders: reviews.reviewReminders,
      urgencyAlerts: wishlist.urgencyAlerts,
      draftsExpired: drafts.expired,
      errors: [
        ...auto.errors,
        ...reminders.errors,
        ...reviews.errors,
        ...wishlist.errors,
        ...drafts.errors,
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
  const leaseUntil = () => new Date(Date.now() + 10 * 60 * 1000);
  const results = { completed: 0, cancelled: 0, walletReleased: 0, errors: [] };

  try {
    const { notifyUser, notifyOperator } = require("./notificationController");

    // ── Step 1: atomically mark ended trips COMPLETED ───────────────────────
    const confirmedBookings = await TripBooking.find({
      status: "CONFIRMED",
    }).populate("batchId", "endDate");

    for (const booking of confirmedBookings) {
      try {
        const endD = effectiveEndDate(booking);
        if (!endD || new Date(endD) >= now) continue;

        const completedBooking = await TripBooking.findOneAndUpdate(
          { _id: booking._id, status: "CONFIRMED" },
          { $set: { status: "COMPLETED", hasReviewed: false } },
          { new: true },
        );
        if (!completedBooking) continue;

        results.completed++;
        const snap = completedBooking.snapshot || {};
        await delay(NOTIFICATION_STAGGER_MS);
        notifyUser(
          completedBooking.userId,
          "Trip Completed! ⭐",
          `Your trip to ${snap.packageTitle || "destination"} is complete. Rate your experience!`,
          {
            type: "trip_completed",
            bookingId: completedBooking._id.toString(),
            screen: "ReviewScreen",
          },
        );
      } catch (error) {
        results.errors.push(
          `Auto-complete ${booking.bookingId}: ${error.message}`,
        );
      }
    }

    // ── Step 2: lease and idempotently release escrow after two days ────────
    const completedUnpaid = await TripBooking.find({
      status: "COMPLETED",
      walletReleased: { $ne: true },
    }).populate("batchId", "endDate");

    for (const booking of completedUnpaid) {
      const endD = effectiveEndDate(booking);
      if (!endD || new Date(endD) >= twoDaysAgo) continue;

      const releaseToken = randomUUID();
      let claimed = null;
      try {
        claimed = await TripBooking.findOneAndUpdate(
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
              walletReleaseLeaseUntil: leaseUntil(),
              walletReleaseError: "",
            },
          },
          { new: true },
        );
        if (!claimed) continue;

        const totalCredit = Number(claimed.pricing?.operatorAmount) || 0;
        const surchargeNote =
          claimed.addonSurcharge > 0
            ? ` (incl. ₹${claimed.addonSurcharge} outside-city addon surcharge)`
            : "";
        let creditApplied = false;

        if (totalCredit > 0) {
          const credit = await creditOperatorWalletIdempotent({
            operatorId: claimed.operatorId,
            amount: totalCredit,
            bookingId: claimed._id,
            eventKey: `escrow:${claimed._id}`,
            purpose: "ESCROW_RELEASE",
            description: `Booking ${claimed.bookingId} — funds released after trip completion${surchargeNote}`,
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

        if (finalized.modifiedCount === 1) {
          results.walletReleased++;
          if (creditApplied) {
            await delay(NOTIFICATION_STAGGER_MS);
            notifyOperator(
              claimed.operatorId,
              "Wallet Credited 💰",
              `₹${totalCredit.toLocaleString("en-IN")} credited for booking ${claimed.bookingId}.`,
              { type: "wallet_credited", bookingId: claimed._id.toString() },
            );
          }
        }
      } catch (error) {
        if (claimed) {
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
        }
        results.errors.push(
          `Wallet release ${booking.bookingId}: ${error.message}`,
        );
      }
    }

    // ── Step 3: atomically auto-cancel expired pending bookings ─────────────
    const pendingBookings = await TripBooking.find({
      status: "PENDING",
    }).populate("batchId", "bookingDeadline");
    for (const booking of pendingBookings) {
      try {
        if (!booking.batchId || booking.batchId.bookingDeadline >= now)
          continue;
        const cancelled = await TripBooking.findOneAndUpdate(
          { _id: booking._id, status: "PENDING" },
          {
            $set: {
              status: "CANCELLED",
              cancelReason: "Booking deadline passed — auto-cancelled",
              cancelledBy: "system",
              cancelledAt: new Date(),
            },
          },
          { new: true },
        );
        if (cancelled) results.cancelled++;
      } catch (error) {
        results.errors.push(
          `Auto-cancel ${booking.bookingId}: ${error.message}`,
        );
      }
    }
  } catch (error) {
    results.errors.push(`Auto-complete/cancel error: ${error.message}`);
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
                  screen: "DestinationDetail",
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
                  screen: "DestinationDetail",
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
  const results = { reminders: 0, skipped: false, errors: [] };
  try {
    // ── Quiet hours guard (IST) ─────────────────────────────────────────────
    // The server TZ is Asia/Kolkata, so getHours() is IST. Never nudge people
    // while they're likely asleep — only send between 9 AM and 9 PM IST.
    const istHour = new Date().getHours();
    if (istHour < 9 || istHour >= 21) {
      results.skipped = true;
      return results;
    }

    const BookingIntent = require("../models/BookingIntent");
    const User = require("../models/User");
    const { notifyUser } = require("./notificationController");
    const { sendMail } = require("../utils/sendMail");
    const baseUrl = process.env.BASE_URL || "https://api.tripreel.in";
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

        const user = await User.findById(intent.userId).select(
          "name email lastReengagedAt",
        );
        // Global once-a-day cap across all re-engagement tiers
        if (!canReengage(user)) {
          intent.notified = true; // don't keep re-checking this one today
          await intent.save();
          continue;
        }

        // ── Push notification ──────────────────────────────────────────────
        await delay(NOTIFICATION_STAGGER_MS);
        notifyUser(
          intent.userId,
          "Still thinking about it?",
          `You were almost there! Tap to complete your booking for ${name}.`,
          {
            type: "abandoned_booking",
            screen: "ResumeBooking",
            packageId: String(intent.packageId),
            intentId: String(intent._id),
          },
        );

        // ── Email reminder (best-effort) ───────────────────────────────────
        try {
          if (user?.email) {
            const link = `${baseUrl}/share/package/${String(intent.packageId)}?intent=${String(intent._id)}`;
            sendMail({
              to: user.email,
              subject: `You're one step away — ${name}`,
              text: `Hi ${user.name || "there"}, you were about to book "${name}" but didn't finish. Complete your booking here: ${link}`,
              html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
                <h2 style="color:#1F8A70;margin-bottom:8px;">Still thinking about it?</h2>
                <p style="color:#374151;">Hi <strong>${user.name || "there"}</strong>,</p>
                <p style="color:#374151;">You were about to book <strong>${name}</strong> but didn't finish. Your spot is still available — pick up right where you left off.</p>
                <a href="${link}" style="display:inline-block;margin:16px 0;padding:12px 28px;background:#1F8A70;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;">Complete Your Booking</a>
                <p style="color:#9CA3AF;font-size:12px;margin-top:16px;">If the button doesn't work, open this link: ${link}</p>
                <p style="color:#6B7280;font-size:13px;">Happy travels,<br/>Team Trip Reel</p>
              </div>`,
            }).catch(() => {});
          }
        } catch {
          /* email is best-effort — never block the push/flag on it */
        }

        await markReengaged(intent.userId);
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

// ── Re-engagement helpers (shared across all tiers) ──────────────────────────
// Global frequency cap so a user never gets more than one re-engagement nudge
// per ~day, regardless of which tier fires. Priority is enforced by schedule
// order (Tier 3 abandoned booking runs first, then Tier 2 views, then Tier 1
// inactivity), and the first one to fire sets lastReengagedAt for the day.
const REENGAGE_CAP_HOURS = 20;

function canReengage(user) {
  if (!user) return false;
  if (!user.lastReengagedAt) return true;
  const ageMs = Date.now() - new Date(user.lastReengagedAt).getTime();
  return ageMs >= REENGAGE_CAP_HOURS * 60 * 60 * 1000;
}

async function markReengaged(userId) {
  try {
    const User = require("../models/User");
    await User.updateOne(
      { _id: userId },
      { $set: { lastReengagedAt: new Date() } },
    );
  } catch {
    /* best-effort */
  }
}

// Only send between 9 AM and 9 PM IST (server TZ is Asia/Kolkata)
function isQuietHours() {
  const istHour = new Date().getHours();
  return istHour < 9 || istHour >= 21;
}

// ── Tier 2: viewed-package re-engagement ─────────────────────────────────────
// Nudge users who opened a package's detail page 6h–7d ago but never booked and
// never reached the booking screen (Tier 3 handles those). One nudge per user:
// if they viewed several packages, we reference the top 1–2 most-recent ones.
exports.runViewedPackageReminders = async function () {
  const results = { reminders: 0, skipped: false, errors: [] };
  try {
    if (isQuietHours()) {
      results.skipped = true;
      return results;
    }

    const PackageView = require("../models/PackageView");
    const BookingIntent = require("../models/BookingIntent");
    const User = require("../models/User");
    const { notifyUser } = require("./notificationController");
    const now = Date.now();
    const sixHoursAgo = new Date(now - 6 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    // Candidate views: seen 6h–7d ago, not converted, not yet notified
    const views = await PackageView.find({
      converted: false,
      notified: false,
      lastViewedAt: { $lte: sixHoursAgo, $gte: sevenDaysAgo },
    })
      .sort({ lastViewedAt: -1 })
      .limit(500);

    // Group by user (most-recent first thanks to the sort)
    const byUser = new Map();
    for (const v of views) {
      const uid = String(v.userId);
      if (!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid).push(v);
    }

    for (const [uid, userViews] of byUser.entries()) {
      try {
        const user = await User.findById(uid).select("name lastReengagedAt");
        if (!canReengage(user)) {
          // Skip today, but mark so we don't reprocess endlessly
          await PackageView.updateMany(
            { _id: { $in: userViews.map((v) => v._id) } },
            { $set: { notified: true } },
          );
          continue;
        }

        // Drop packages the user already reached the booking screen for —
        // Tier 3 (abandoned booking) owns those, higher intent.
        const pkgIds = userViews.map((v) => v.packageId);
        const intents = await BookingIntent.find({
          userId: uid,
          packageId: { $in: pkgIds },
        }).select("packageId");
        const intentSet = new Set(intents.map((i) => String(i.packageId)));
        const fresh = userViews.filter(
          (v) => !intentSet.has(String(v.packageId)),
        );

        if (fresh.length === 0) {
          await PackageView.updateMany(
            { _id: { $in: userViews.map((v) => v._id) } },
            { $set: { notified: true } },
          );
          continue;
        }

        // Compose a message — one package vs. multiple
        let title;
        let body;
        const primary = fresh[0];
        const primaryName = primary.packageTitle || "a trip";
        if (fresh.length === 1) {
          title = "Still dreaming about it? ✨";
          body = `${primaryName} is waiting for you. Tap to take another look.`;
        } else {
          const secondName = fresh[1].packageTitle || "another trip";
          title = "Can't decide? We've got you 🌍";
          body = `You checked out ${primaryName} and ${secondName}. Which one's calling you?`;
        }

        await delay(NOTIFICATION_STAGGER_MS);
        notifyUser(uid, title, body, {
          type: "general",
          screen: "DestinationDetail",
          packageId: String(primary.packageId),
        });

        await markReengaged(uid);
        await PackageView.updateMany(
          { _id: { $in: userViews.map((v) => v._id) } },
          { $set: { notified: true } },
        );
        results.reminders++;
      } catch (e) {
        results.errors.push(`Viewed reminder user ${uid}: ${e.message}`);
      }
    }
  } catch (err) {
    results.errors.push(`Viewed package reminders: ${err.message}`);
  }
  return results;
};

// ── Tier 1: inactive-user re-engagement ──────────────────────────────────────
// Generic "we miss you" nudge for users who haven't opened the app in a while.
exports.runInactiveUserReminders = async function () {
  const results = { reminders: 0, skipped: false, errors: [] };
  try {
    if (isQuietHours()) {
      results.skipped = true;
      return results;
    }

    const User = require("../models/User");
    const { notifyUser } = require("./notificationController");
    const now = Date.now();
    const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const capAgo = new Date(now - REENGAGE_CAP_HOURS * 60 * 60 * 1000);

    // Inactive 3–30 days, has a push token, not nudged within the cap window
    const users = await User.find({
      role: "user",
      status: "Active",
      fcmToken: { $nin: ["", null] },
      lastActiveAt: { $lte: threeDaysAgo, $gte: thirtyDaysAgo },
      $or: [
        { lastReengagedAt: { $exists: false } },
        { lastReengagedAt: { $lte: capAgo } },
      ],
    })
      .select("_id name")
      .limit(300);

    const messages = [
      {
        title: "Your next adventure awaits 🌴",
        body: "New trips just dropped. Come see where you could go next.",
      },
      {
        title: "We miss you! ✈️",
        body: "Handpicked getaways are waiting. Take a quick look?",
      },
      {
        title: "Ready for a getaway? 🏔️",
        body: "Discover fresh experiences curated just for you.",
      },
    ];

    for (const u of users) {
      try {
        const msg = messages[results.reminders % messages.length];
        await delay(NOTIFICATION_STAGGER_MS);
        notifyUser(u._id, msg.title, msg.body, {
          type: "general",
          screen: "Main",
        });
        await markReengaged(u._id);
        results.reminders++;
      } catch (e) {
        results.errors.push(`Inactive reminder ${u._id}: ${e.message}`);
      }
    }
  } catch (err) {
    results.errors.push(`Inactive user reminders: ${err.message}`);
  }
  return results;
};

// ── Nightly sanity check: bookedSeats vs actual bookings ─────────────────────
// Detects drift (bugs, crashes, race edges) so admin can reconcile manually.
exports.runBookingSanityCheck = async function () {
  const results = { checked: 0, mismatches: 0, fixed: 0, errors: [] };
  try {
    const Batch = require("../models/Batch");
    const TripBooking = require("../models/TripBooking");

    // Only check batches that are still active and in the future (past ones don't matter)
    const now = new Date();
    const batches = await Batch.find({
      isActive: true,
      startDate: { $gt: now },
    })
      .select("_id bookedSeats totalSeats")
      .lean();

    for (const batch of batches) {
      results.checked++;
      // Count actual confirmed bookings for this batch
      const actualSeats = await TripBooking.aggregate([
        {
          $match: {
            batchId: batch._id,
            status: { $in: ["CONFIRMED", "PENDING"] },
          },
        },
        { $group: { _id: null, total: { $sum: "$seats" } } },
      ]);
      const actual = actualSeats[0]?.total || 0;
      if (actual !== batch.bookedSeats) {
        results.mismatches++;
        console.warn(
          `[SANITY] Batch ${batch._id}: bookedSeats=${batch.bookedSeats} but actual=${actual}`,
        );
        // Auto-fix by setting to the actual count (safe — the atomic reservation
        // guards new bookings, so this only corrects stale drift).
        await Batch.updateOne(
          { _id: batch._id },
          { $set: { bookedSeats: actual } },
        );
        results.fixed++;
      }
    }

    if (results.mismatches > 0) {
      try {
        const { notifyAdmin } = require("./notificationController");
        notifyAdmin(
          "Booking Sanity Check — Mismatches Found",
          `${results.mismatches} batch(es) had bookedSeats drift. Auto-corrected. Check PM2 logs for details.`,
          { type: "general" },
        );
      } catch {}
    }
  } catch (err) {
    results.errors.push(`Sanity check error: ${err.message}`);
  }
  return results;
};
