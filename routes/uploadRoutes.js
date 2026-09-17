const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const { protect, restrictTo } = require("../middleware/authMiddleware");
const upload = require("../middleware/uploadMiddleware");
const {
  isCloudStorageEnabled,
  keyForUpload,
  uploadBufferToS3,
  syncUploadedFile,
} = require("../utils/s3Storage");

// Only these characters may reach a filesystem path or an S3 key. A body value
// like "../../src" previously escaped the uploads directory.
function sanitizeFolder(folder) {
  const value = String(folder || "general");
  return /^[a-zA-Z0-9_-]+$/.test(value) ? value : "general";
}

// POST /api/upload — accepts base64 data URI, stores it, returns URL (admin only)
router.post("/", protect, restrictTo("admin"), async (req, res) => {
  try {
    const { data, folder } = req.body;

    if (!data || !data.startsWith("data:image/")) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid image data" });
    }

    const matches = data.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) {
      return res
        .status(400)
        .json({ success: false, message: "Malformed data URI" });
    }

    const ext = matches[1] === "jpeg" ? "jpg" : matches[1];
    const buffer = Buffer.from(matches[2], "base64");

    if (buffer.length > 8 * 1024 * 1024) {
      return res
        .status(413)
        .json({ success: false, message: "Image too large (max 8 MB)" });
    }

    const subfolder = sanitizeFolder(folder);
    const safeName = `${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`;
    const key = keyForUpload(subfolder, safeName);

    // Keep a local copy as well, so the static route still works when no CDN is
    // configured and so the migration script can re-sync if needed.
    const uploadDir = path.join(__dirname, "../uploads", subfolder);
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, safeName), buffer);

    // A failed upload must fail the request: with a CDN configured, clients
    // never read media from this server, so "succeeded locally" would hand back
    // a URL that can never resolve.
    if (isCloudStorageEnabled()) {
      await uploadBufferToS3({
        buffer,
        key,
        contentType: `image/${ext === "jpg" ? "jpeg" : ext}`,
      });
    }

    // Relative path is the canonical stored form; clients resolve it against
    // the CDN (or the API host when no CDN is configured).
    res.json({ success: true, url: `/${key}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/upload/demo-media — upload image/video for demo media (admin only)
router.post(
  "/demo-media",
  protect,
  restrictTo("admin"),
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, message: "File required" });
      }
      // uploadMiddleware stores flat in /uploads, so there is no sub-directory.
      const url = await syncUploadedFile(req.file, "");
      res.json({ success: true, url });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// POST /api/upload/chat — multipart image upload for chat (any logged-in user)
router.post("/chat", protect, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "Image file required" });
    }
    const url = await syncUploadedFile(req.file, "");
    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
