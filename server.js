const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const http = require("http");

dotenv.config();

// ── Force Indian Standard Time for ALL server-side date math ────────────────
// TripReel operates only in India. Pinning the process timezone makes every
// `new Date()`, `.getDate()`, `.getHours()`, and server-side toLocaleString
// resolve in IST regardless of where the server is hosted (cloud hosts default
// to UTC). This prevents off-by-one-day errors in refund slabs, auto-complete,
// trip countdowns, and Snapja dispatch dates. Must run before any Date usage.
process.env.TZ = process.env.TZ || "Asia/Kolkata";

const app = express();
const server = http.createServer(app);

// Initialize WebSocket
const { initSocket } = require("./config/socket");
initSocket(server);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(
  express.json({
    limit: "20mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// Static folder for uploaded images and videos
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth", require("./routes/authRoutes"));
app.use("/api/profile", require("./routes/profileRoutes"));
app.use("/api/reviews", require("./routes/reviewRoutes"));
app.use("/api/upload", require("./routes/uploadRoutes"));
app.use("/api/users", require("./routes/userRoutes"));
app.use("/api/banners", require("./routes/bannerRoutes"));
app.use("/api/categories", require("./routes/categoryRoutes"));
app.use("/api/packages", require("./routes/packageRoutes"));
app.use("/api/templates", require("./routes/templateRoutes"));
app.use("/api/listings", require("./routes/listingRoutes"));
app.use(
  "/api/popular-destinations",
  require("./routes/popularDestinationRoutes"),
);
app.use("/api/experiences", require("./routes/experienceRoutes"));
app.use("/api/trips", require("./routes/tripRoutes"));
app.use("/api/bookings", require("./routes/bookingRoutes"));
app.use("/api/wishlists", require("./routes/wishlistRoutes"));
app.use("/api/reels", require("./routes/reelRoutes"));
app.use("/api/operators/auth", require("./routes/operatorAuthRoutes"));
app.use("/api/operators", require("./routes/operatorRoutes"));

// ── New booking system (Phase 1) ──────────────────────────────────────────────
app.use("/api/batches", require("./routes/batchRoutes"));
app.use(
  "/api/flexible-availability",
  require("./routes/flexibleAvailabilityRoutes"),
);
app.use("/api/trip-bookings", require("./routes/tripBookingRoutes"));
app.use("/api/booking-intents", require("./routes/bookingIntentRoutes"));
// Public share landing pages (smart deep links → app or store)
app.use("/share", require("./routes/shareRoutes"));
app.use("/api/operator-bookings", require("./routes/operatorBookingRoutes"));
app.use("/api/settings", require("./routes/platformSettingsRoutes"));
app.use("/api/wallet", require("./routes/walletRoutes"));
app.use("/api/cron", require("./routes/cronRoutes"));
app.use("/api/coupons", require("./routes/couponRoutes"));
app.use("/api/admin/revenue", require("./routes/revenueRoutes"));
app.use("/api/reports", require("./routes/reportRoutes"));
app.use("/api/notifications", require("./routes/notificationRoutes"));
app.use("/api/chat", require("./routes/chatRoutes"));
app.use("/api/sidebar-counts", require("./routes/sidebarCountsRoutes"));
app.use("/api/campaigns", require("./routes/campaignRoutes"));
app.use("/api/app-screens", require("./routes/appScreenRoutes"));
app.use("/api/payments", require("./routes/paymentRoutes"));

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ message: "Trip Reel API is running", status: "OK" });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  // Ensure CORS headers are present even on error responses (multer errors,
  // timeouts, etc. can bypass the cors() middleware response headers).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  // Multer-specific errors (file too large, wrong type, etc.)
  const multer = require("multer");
  if (err instanceof multer.MulterError) {
    let msg = err.message;
    if (err.code === "LIMIT_FILE_SIZE") msg = "File too large (max 5 MB).";
    return res.status(400).json({ success: false, message: msg });
  }

  console.error(err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal Server Error",
  });
});

// ── MongoDB connection + server start ─────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.mongodburl;

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected");
    server.listen(PORT, () =>
      console.log(`🚀 Server running on port ${PORT} (WebSocket enabled)`),
    );

    // ── Schedule cron jobs ─────────────────────────────────────────────────
    const cron = require("node-cron");
    const {
      runAutoCompleteAndCancel,
      runTripReminders,
      runReviewReminders,
      runWishlistAlerts,
      runSnapjaDispatch,
      runSnapjaStatusSync,
      runSnapjaAutoCancel,
      runAbandonedBookingReminders,
      runCronJobs,
    } = require("./controllers/cronController");

    // 12:00 AM IST (Midnight) — Auto-complete trips + auto-cancel expired bookings + wallet credits
    cron.schedule(
      "0 0 * * *",
      async () => {
        try {
          const result = await runAutoCompleteAndCancel();
          console.log(
            `✅ Cron (midnight): ${result.completed} completed, ${result.cancelled} cancelled, ${result.walletReleased} wallets credited`,
          );
        } catch (err) {
          console.error("❌ Cron midnight error:", err.message);
        }
      },
      { timezone: "Asia/Kolkata" },
    );

    // Every 2 hours — keep trip status fresh (mark COMPLETED soon after trip ends)
    cron.schedule(
      "0 */2 * * *",
      async () => {
        try {
          const result = await runAutoCompleteAndCancel();
          if (result.completed || result.walletReleased || result.cancelled) {
            console.log(
              `✅ Cron (2h status sync): ${result.completed} completed, ${result.cancelled} cancelled, ${result.walletReleased} wallets credited`,
            );
          }
        } catch (err) {
          console.error("❌ Cron 2h status sync error:", err.message);
        }
      },
      { timezone: "Asia/Kolkata" },
    );

    // Every 5 minutes — dispatch Snapja addon bookings immediately after user books
    cron.schedule(
      "*/5 * * * *",
      async () => {
        try {
          const result = await runSnapjaDispatch();
          if (result.dispatched) {
            console.log(
              `✅ Cron (Snapja dispatch): ${result.dispatched} bookings, ${result.callsMade} Snapja calls`,
            );
          }
        } catch (err) {
          console.error("❌ Cron Snapja dispatch error:", err.message);
        }
      },
      { timezone: "Asia/Kolkata" },
    );

    // 11:55 PM IST daily — auto-cancel unassigned Snapja addons 1 day before trip
    cron.schedule(
      "55 23 * * *",
      async () => {
        try {
          const result = await runSnapjaAutoCancel();
          if (result.cancelled) {
            console.log(
              `✅ Cron (Snapja auto-cancel): ${result.cancelled} addons cancelled (no creator assigned, trip tomorrow)`,
            );
          }
        } catch (err) {
          console.error("❌ Cron Snapja auto-cancel error:", err.message);
        }
      },
      { timezone: "Asia/Kolkata" },
    );

    // Every hour — sync Snapja booking statuses (check creator assignment).
    // The app also syncs on-demand when the user opens booking details, so this
    // is a background safety net to push notifications even when they're away.
    cron.schedule(
      "0 * * * *",
      async () => {
        try {
          const result = await runSnapjaStatusSync();
          if (result.updated) {
            console.log(
              `✅ Cron (Snapja sync): ${result.synced} checked, ${result.updated} updated`,
            );
          }
        } catch (err) {
          console.error("❌ Cron Snapja sync error:", err.message);
        }
      },
      { timezone: "Asia/Kolkata" },
    );

    // 9:00 AM IST — Trip countdown reminders (7d, 3d, 1d, today)
    cron.schedule(
      "0 9 * * *",
      async () => {
        try {
          const result = await runTripReminders();
          console.log(`✅ Cron (9AM): ${result.reminders} trip reminders sent`);
        } catch (err) {
          console.error("❌ Cron 9AM error:", err.message);
        }
      },
      { timezone: "Asia/Kolkata" },
    );

    // 11:00 AM IST — Review reminders (day 1, 2, 3 after trip end)
    cron.schedule(
      "0 11 * * *",
      async () => {
        try {
          const result = await runReviewReminders();
          console.log(
            `✅ Cron (11AM): ${result.reviewReminders} review reminders sent`,
          );
        } catch (err) {
          console.error("❌ Cron 11AM error:", err.message);
        }
      },
      { timezone: "Asia/Kolkata" },
    );

    // 12 PM & 7 PM IST — Abandoned-booking reminders (reached booking screen,
    // didn't complete). Each intent is nudged only once (notified flag).
    cron.schedule(
      "0 12,19 * * *",
      async () => {
        try {
          const result = await runAbandonedBookingReminders();
          if (result.reminders) {
            console.log(
              `✅ Cron (abandoned booking): ${result.reminders} reminders sent`,
            );
          }
        } catch (err) {
          console.error("❌ Cron abandoned booking error:", err.message);
        }
      },
      { timezone: "Asia/Kolkata" },
    );

    // 6:00 PM IST — Wishlist urgency alerts (low seats, deadline tomorrow)
    cron.schedule(
      "0 18 * * *",
      async () => {
        try {
          const result = await runWishlistAlerts();
          console.log(
            `✅ Cron (6PM): ${result.urgencyAlerts} wishlist alerts sent`,
          );
        } catch (err) {
          console.error("❌ Cron 6PM error:", err.message);
        }
      },
      { timezone: "Asia/Kolkata" },
    );

    console.log(
      "⏰ Cron jobs scheduled (IST): midnight, every 2h, 9AM, 11AM, 6PM",
    );
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });
