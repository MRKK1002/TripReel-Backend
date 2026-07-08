const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const { protect, restrictTo } = require("../middleware/authMiddleware");
const upload = require("../middleware/uploadMiddleware");

// Helper: get base URL
function getBaseUrl() {
  return process.env.BASE_URL || `http://localhost:${process.env.PORT || 5001}`;
}

// POST /api/upload — accepts base64 data URI, saves to disk, returns URL (admin only)
router.post("/", protect, restrictTo("admin"), (req, res) => {
  try {
    const { data, filename, folder } = req.body;

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

    // Use subfolder if specified, otherwise "general"
    const subfolder = folder || "general";
    const uploadDir = path.join(__dirname, "../uploads", subfolder);
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    const safeName = `${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`;
    fs.writeFileSync(path.join(uploadDir, safeName), buffer);

    const url = `${getBaseUrl()}/uploads/${subfolder}/${safeName}`;
    res.json({ success: true, url });
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
  (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, message: "File required" });
      }
      const relativePath = path.relative(
        path.join(__dirname, "../uploads"),
        req.file.path,
      );
      const url = `${getBaseUrl()}/uploads/${relativePath.replace(/\\/g, "/")}`;
      res.json({ success: true, url });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// POST /api/upload/chat — multipart image upload for chat (any logged-in user)
router.post("/chat", protect, upload.single("image"), (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "Image file required" });
    }
    // file is already in /uploads/chat/ subfolder thanks to middleware
    const relativePath = path.relative(
      path.join(__dirname, "../uploads"),
      req.file.path,
    );
    const url = `${getBaseUrl()}/uploads/${relativePath.replace(/\\/g, "/")}`;
    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
