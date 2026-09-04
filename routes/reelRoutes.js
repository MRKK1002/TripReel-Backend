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

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

// Browsers often report a generic MIME type for media files because the value
// comes from the OS, not the file contents. Treat these as unknown rather than
// invalid, otherwise legitimate uploads are rejected with a 400.
const GENERIC_MIMES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/x-octet-stream",
]);

// The extension decides which field a file belongs to. The MIME type is only
// used to reject an obvious contradiction, e.g. an image sent as the video.
const mimeAllowsKind = (mimetype, kind) => {
  const mime = String(mimetype || "").toLowerCase();
  return mime.startsWith(`${kind}/`) || GENERIC_MIMES.has(mime);
};

const rejectFile = (field, message, cb) => {
  const error = new multer.MulterError("LIMIT_UNEXPECTED_FILE", field);
  error.message = message;
  cb(error);
};

const fileFilter = (req, file, cb) => {
  const extension = path.extname(file.originalname).toLowerCase();

  if (file.fieldname === "video") {
    if (
      VIDEO_EXTENSIONS.has(extension) &&
      mimeAllowsKind(file.mimetype, "video")
    ) {
      return cb(null, true);
    }
    return rejectFile(
      file.fieldname,
      "Video must be an MP4, MOV, AVI, MKV, or WebM file.",
      cb,
    );
  }

  if (file.fieldname === "thumbnail") {
    if (
      IMAGE_EXTENSIONS.has(extension) &&
      mimeAllowsKind(file.mimetype, "image")
    ) {
      return cb(null, true);
    }
    return rejectFile(
      file.fieldname,
      "Thumbnail must be a JPG, PNG, or WebP image.",
      cb,
    );
  }

  return rejectFile(file.fieldname, "Unexpected reel upload field.", cb);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
});

// Uploaded files are written to disk before the database write runs, so discard
// them when the save fails. Otherwise each failed save leaves an orphaned file.
const discardUploadedFiles = (files) => {
  Object.values(files || {})
    .flat()
    .forEach((file) => {
      fs.promises.unlink(file.path).catch(() => {
        /* best effort cleanup */
      });
    });
};

// Reject a file field that arrived as a non-file value. Axios serialises
// FormData to JSON when a JSON content type is set, which turns uploads into
// empty objects; fail with a clear message instead of a Mongoose cast error.
const readMediaField = (value) => {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  return null; // present but not a usable value
};

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
      const body = { ...req.body };

      if (req.files?.video?.[0]) {
        body.video = `/uploads/videos/${req.files.video[0].filename}`;
      }
      if (req.files?.thumbnail?.[0]) {
        body.thumbnail = `/uploads/videos/${req.files.thumbnail[0].filename}`;
      }

      for (const field of ["video", "thumbnail"]) {
        if (req.files?.[field]?.[0]) continue;
        const value = readMediaField(body[field]);
        if (value === null) {
          discardUploadedFiles(req.files);
          return res.status(400).json({
            success: false,
            message: `The ${field} was not received as a file. Retry the upload; if it repeats, reload the page.`,
          });
        }
        if (value === undefined) delete body[field];
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
      discardUploadedFiles(req.files);
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
      const body = { ...req.body };

      if (req.files?.video?.[0]) {
        body.video = `/uploads/videos/${req.files.video[0].filename}`;
      }
      if (req.files?.thumbnail?.[0]) {
        body.thumbnail = `/uploads/videos/${req.files.thumbnail[0].filename}`;
      }

      for (const field of ["video", "thumbnail"]) {
        if (req.files?.[field]?.[0]) continue;
        const value = readMediaField(body[field]);
        if (value === null) {
          discardUploadedFiles(req.files);
          return res.status(400).json({
            success: false,
            message: `The ${field} was not received as a file. Retry the upload; if it repeats, reload the page.`,
          });
        }
        if (value === undefined) delete body[field];
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
      if (!reel) {
        discardUploadedFiles(req.files);
        return res
          .status(404)
          .json({ success: false, message: "Reel not found" });
      }
      res.json({ success: true, reel });
    } catch (err) {
      discardUploadedFiles(req.files);
      res.status(400).json({ success: false, message: err.message });
    }
  },
);

router.delete("/:id", protect, restrictTo("admin"), deleteReel);

module.exports = router;
