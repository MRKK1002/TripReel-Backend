const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const http = require("http");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const mongoSanitize = require("express-mongo-sanitize");

dotenv.config();

// ── Force Indian Standard Time for ALL server-side date math ────────────────
process.env.TZ = process.env.TZ || "Asia/Kolkata";

const app = express();
const server = http.createServer(app);

// Behind a proxy/load balancer (Render, nginx, Cloudflare) the client IP arrives
// in X-Forwarded-For. Without this every request looks like it comes from the
// proxy, which makes the rate limiters key on a single IP — either useless or a
// self-inflicted DoS on all users at once.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 1));

// Initialize WebSocket
const { initSocket } = require("./config/socket");
initSocket(server);

// ── Rate limiters ─────────────────────────────────────────────────────────────
// Limiters are ON by default. Set DISABLE_RATE_LIMIT=true locally if they get in
// the way — they used to be tied to NODE_ENV, so any environment not started
// with NODE_ENV=production ran completely unthrottled.
const rateLimitDisabled = process.env.DISABLE_RATE_LIMIT === "true";
const skipRateLimit = () => rateLimitDisabled;

// Auth endpoints (login, OTP send/verify, Google login) — strict
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per IP per 15 min
  message: {
    success: false,
    message:
      "Too many requests from this IP. Please try again after 15 minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipRateLimit,
});

// OTP send — extra strict (prevents SMS bombing)
const otpSendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5, // 5 OTP requests per IP per 10 min
  message: {
    success: false,
    message: "Too many OTP requests. Please try again after 10 minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipRateLimit,
});

// General API — loose (protects against scraping/DDoS)
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200, // 200 requests per IP per minute
  message: {
    success: false,
    message: "Too many requests. Please slow down.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipRateLimit,
});

// Payment endpoints — per-user, prevents abuse scripts and double-charges
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 payment calls per IP per minute (generous for legit, blocks bots)
  message: {
    success: false,
    message: "Too many payment requests. Please wait a moment.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipRateLimit,
});

// ── Middleware ─────────────────────────────────────────────────────────────────
// CORS whitelist — only these browser origins may call the API. Mobile apps,
// curl, and server-to-server calls send no Origin header and are always allowed
// (CORS is a browser-only protection). Add/remove domains via CORS_ORIGINS in
// .env (comma-separated) without touching code.
const defaultOrigins = [
  "https://tripreel.in",
  "https://www.tripreel.in",
  "https://operator.tripreel.in",
  "https://admin.tripreel.in",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
];
const envOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const allowedOrigins = [...new Set([...defaultOrigins, ...envOrigins])];

app.use(
  cors({
    origin: (origin, callback) => {
      // No origin = mobile app / curl / same-origin / server-to-server → allow
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  }),
);

// Security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, etc.)
app.use(
  helmet({
    contentSecurityPolicy: false, // CSP can break image/video URLs — revisit when moving to CDN
    crossOriginResourcePolicy: { policy: "cross-origin" }, // allow mobile app to load images
  }),
);

app.use(
  express.json({
    limit: "20mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// Strip MongoDB operators ($, .) from req.body, req.query, req.params
// Prevents NoSQL injection like {"email": {"$gt": ""}}
app.use(mongoSanitize());

// Apply general limiter to all /api routes
app.use("/api", generalLimiter);

// ── Private KYC document serving (signed URLs only) ──────────────────────────
// Operator KYC docs (government ID, PAN, selfie, trade license) are private.
// They are served ONLY through /api/secure-docs with a valid HMAC signature.
// Block any direct static access to /uploads/operators/.
const { verifySignedUrl } = require("./utils/signedDocUrl");

app.get("/api/secure-docs", (req, res) => {
  const result = verifySignedUrl(req.query);
  if (!result.ok) {
    return res.status(403).json({ success: false, message: result.reason });
  }
  // filePath looks like "/uploads/operators/xyz.jpg" — resolve safely
  const safePath = path.normalize(result.filePath).replace(/^(\.\.[/\\])+/, "");
  const absPath = path.join(__dirname, safePath);
  // Final containment check — never serve outside the operators upload dir
  const operatorsDir = path.join(__dirname, "uploads", "operators");
  if (!absPath.startsWith(operatorsDir)) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  return res.sendFile(absPath, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ success: false, message: "File not found" });
    }
  });
});

// Block direct static access to the private operators folder
app.use("/uploads/operators", (req, res) => {
  res.status(403).json({
    success: false,
    message: "Access denied. This document requires a signed link.",
  });
});

// Static folder for public uploaded images and videos (packages, banners, etc.)
// Uploaded files are content-addressed by a timestamped name and never rewritten,
// so they can be cached aggressively. This avoids re-downloading reel video on
// every view, which is the main cause of slow playback starts.
app.use(
  "/uploads",
  (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    next();
  },
  express.static(path.join(__dirname, "uploads"), {
    acceptRanges: true,
    etag: true,
    lastModified: true,
  }),
);

// ── Routes ────────────────────────────────────────────────────────────────────
// Auth — stricter limits; OTP send endpoints get their own even tighter limiter
app.use("/api/auth/signup/send-otp", otpSendLimiter);
app.use("/api/auth/login/send-otp", otpSendLimiter);
app.use("/api/auth/phone-link/send-otp", otpSendLimiter);
// Every step that dispatches a code is throttled like any other OTP sender.
app.use("/api/auth/phone-change/start", otpSendLimiter);
app.use("/api/auth/phone-change/send-new-otp", otpSendLimiter);
app.use("/api/auth/email-change/start", otpSendLimiter);
app.use("/api/auth/email-change/send-new-otp", otpSendLimiter);
app.use("/api/auth", authLimiter);
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
app.use("/api/operators/auth/send-otp", otpSendLimiter);
app.use("/api/operators/auth/forgot-password", otpSendLimiter);
app.use("/api/operators/auth", authLimiter);
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
app.use("/api/package-views", require("./routes/packageViewRoutes"));
app.use("/api/places", require("./routes/placesRoutes"));
// Public share landing pages (smart deep links → app or store)
app.use("/share", require("./routes/shareRoutes"));
app.use("/api/operator-bookings", require("./routes/operatorBookingRoutes"));
app.use("/api/trip-groups", require("./routes/tripGroupRoutes"));
app.use("/api/trip-doc-templates", require("./routes/tripDocTemplateRoutes"));
app.use("/api/settings", require("./routes/platformSettingsRoutes"));
app.use("/api/wallet", require("./routes/walletRoutes"));
app.use("/api/cron", require("./routes/cronRoutes"));
app.use("/api/coupons", require("./routes/couponRoutes"));
app.use("/api/platform-coupons", require("./routes/platformCouponRoutes"));
app.use("/api/admin/revenue", require("./routes/revenueRoutes"));
app.use("/api/reports", require("./routes/reportRoutes"));
app.use("/api/notifications", require("./routes/notificationRoutes"));
app.use("/api/chat", require("./routes/chatRoutes"));
app.use("/api/sidebar-counts", require("./routes/sidebarCountsRoutes"));
app.use("/api/campaigns", require("./routes/campaignRoutes"));
app.use("/api/app-screens", require("./routes/appScreenRoutes"));
app.use("/api/payments", paymentLimiter, require("./routes/paymentRoutes"));
app.use("/api/audit", require("./routes/auditRoutes"));

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ message: "Trip Reel API is running", status: "OK" });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  // CORS rejection → clean 403 (don't leak a stack trace)
  if (err && /not allowed by CORS/i.test(err.message || "")) {
    return res
      .status(403)
      .json({ success: false, message: "Origin not allowed." });
  }

  // Reflect the request origin on error responses ONLY if it's whitelisted, so
  // error bodies stay readable for our own apps without opening it to everyone.
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
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
    message:
      process.env.NODE_ENV === "production"
        ? "Internal Server Error"
        : err.message || "Internal Server Error",
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
      runViewedPackageReminders,
      runInactiveUserReminders,
      runBookingSanityCheck,
      runStaleDraftExpiry,
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

        // Expire abandoned operator drafts (never submitted within the window)
        try {
          const draft = await runStaleDraftExpiry();
          if (draft.expired) {
            console.log(
              `✅ Cron (midnight): ${draft.expired} stale operator drafts expired`,
            );
          }
        } catch (err) {
          console.error("❌ Cron draft-expiry error:", err.message);
        }

        // Nightly sanity check — verify batch.bookedSeats matches actual bookings
        try {
          const sanity = await runBookingSanityCheck();
          if (sanity.mismatches) {
            console.log(
              `⚠️ Cron (sanity): ${sanity.mismatches} mismatches found & fixed`,
            );
          }
        } catch (err) {
          console.error("❌ Cron sanity check error:", err.message);
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

    // 1 PM & 8 PM IST — Tier 2: viewed-package re-engagement (opened a package
    // but didn't book). Runs after the abandoned-booking cron so higher-intent
    // users are nudged for that first (global once-a-day cap prevents overlap).
    cron.schedule(
      "0 13,20 * * *",
      async () => {
        try {
          const result = await runViewedPackageReminders();
          if (result.reminders) {
            console.log(
              `✅ Cron (viewed package): ${result.reminders} reminders sent`,
            );
          }
        } catch (err) {
          console.error("❌ Cron viewed package error:", err.message);
        }
      },
      { timezone: "Asia/Kolkata" },
    );

    // Every 10 minutes — recover bookings for orders paid but never verified
    // (app killed right after checkout). Safety net alongside the webhook.
    cron.schedule(
      "*/10 * * * *",
      async () => {
        try {
          const paymentController = require("./controllers/paymentController");
          const result = await paymentController.runOrphanPaymentRecovery();
          if (result.recovered || result.expired) {
            console.log(
              `✅ Cron (payment recovery): ${result.recovered} recovered, ${result.expired} expired`,
            );
          }
        } catch (err) {
          console.error("❌ Cron payment recovery error:", err.message);
        }
      },
      { timezone: "Asia/Kolkata" },
    );

    // 3 PM IST — Tier 1: inactive-user "we miss you" nudge (3–30 days idle).
    cron.schedule(
      "0 15 * * *",
      async () => {
        try {
          const result = await runInactiveUserReminders();
          if (result.reminders) {
            console.log(
              `✅ Cron (inactive user): ${result.reminders} reminders sent`,
            );
          }
        } catch (err) {
          console.error("❌ Cron inactive user error:", err.message);
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
