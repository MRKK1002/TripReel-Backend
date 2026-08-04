const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Operator uploads go into /uploads/operators/
const uploadDir = path.join(__dirname, "../uploads/operators");
try {
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
} catch (e) {
  console.error("⚠️ Could not create operator upload dir:", e.message);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Ensure dir exists at request time too (handles ephemeral filesystems)
    try {
      if (!fs.existsSync(uploadDir))
        fs.mkdirSync(uploadDir, { recursive: true });
    } catch {}
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const suffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, suffix + path.extname(file.originalname));
  },
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = (file.mimetype || "").toLowerCase();

  // KYC docs may only be PDF or common image formats. Extension AND mimetype
  // must both match — mimetype alone is client-controlled and spoofable.
  const allowedByExt = [".pdf", ".jpg", ".jpeg", ".png"];
  const allowedByMime = [
    "application/pdf",
    "image/jpeg",
    "image/jpg",
    "image/png",
  ];

  if (allowedByExt.includes(ext) && allowedByMime.includes(mime)) {
    cb(null, true);
  } else {
    cb(new Error("Only PDF, JPG or PNG files are allowed"));
  }
};

const operatorUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

module.exports = operatorUpload;
