const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config();

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// Static folder for uploaded images and videos
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth", require("./routes/authRoutes"));
app.use("/api/profile", require("./routes/profileRoutes"));
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

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ message: "TripReel API is running", status: "OK" });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
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
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });

