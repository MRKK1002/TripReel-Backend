const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { protect, restrictTo } = require("../middleware/authMiddleware");
const {
  getAllReels,
  getReelById,
  createReel,
  updateReel,
  deleteReel,
  incrementReelView,
} = require("../controllers/reelController");

// ── Multer storage for videos ─────────────────────────────────────────────────
const videoDir = path.join(__dirname, "../uploads/videos");
if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, videoDir),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = /mp4|mov|avi|mkv|webm/i;
  if (allowed.test(path.extname(file.originalname))) {
    cb(null, true);
  } else {
    cb(new Error("Only video files are allowed (mp4, mov, avi, mkv, webm)"));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
});

// ── Public ────────────────────────────────────────────────────────────────────
router.get("/", getAllReels);
router.get("/:id", getReelById);
router.post("/:id/view", incrementReelView);

// ── Admin: upload video file + create reel ────────────────────────────────────
router.post(
  "/",
  protect,
  restrictTo("admin"),
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "thumbnail", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const baseUrl =
        process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
      const body = { ...req.body };

      if (req.files?.video?.[0]) {
        body.video = `${baseUrl}/uploads/videos/${req.files.video[0].filename}`;
      }
      if (req.files?.thumbnail?.[0]) {
        body.thumbnail = `${baseUrl}/uploads/videos/${req.files.thumbnail[0].filename}`;
      }

      // Parse nested user object sent as JSON string
      if (typeof body.user === "string") {
        try {
          body.user = JSON.parse(body.user);
        } catch {
          body.user = {};
        }
      }

      const reel = await require("../models/Reel").create(body);
      res.status(201).json({ success: true, reel });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  },
);

// ── Admin: update reel (optionally replace video/thumbnail) ───────────────────
router.put(
  "/:id",
  protect,
  restrictTo("admin"),
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "thumbnail", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const baseUrl =
        process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
      const body = { ...req.body };

      if (req.files?.video?.[0]) {
        body.video = `${baseUrl}/uploads/videos/${req.files.video[0].filename}`;
      }
      if (req.files?.thumbnail?.[0]) {
        body.thumbnail = `${baseUrl}/uploads/videos/${req.files.thumbnail[0].filename}`;
      }

      if (typeof body.user === "string") {
        try {
          body.user = JSON.parse(body.user);
        } catch {
          body.user = {};
        }
      }

      const reel = await require("../models/Reel").findByIdAndUpdate(
        req.params.id,
        body,
        {
          new: true,
          runValidators: true,
        },
      );
      if (!reel)
        return res
          .status(404)
          .json({ success: false, message: "Reel not found" });
      res.json({ success: true, reel });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  },
);

router.delete("/:id", protect, restrictTo("admin"), deleteReel);

module.exports = router;
