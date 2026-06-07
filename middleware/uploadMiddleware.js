const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Base uploads directory
const baseUploadDir = path.join(__dirname, "../uploads");

// Ensure all subdirectories exist
const subdirs = [
  "banners",
  "packages",
  "reels",
  "profiles",
  "chat",
  "broadcast",
  "general",
];
subdirs.forEach((dir) => {
  const fullPath = path.join(baseUploadDir, dir);
  if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
});

// Determine folder based on request path or a custom header
function getSubfolder(req) {
  const routePath = req.baseUrl || req.originalUrl || "";
  if (routePath.includes("/banners")) return "banners";
  if (routePath.includes("/packages")) return "packages";
  if (routePath.includes("/reels")) return "reels";
  if (routePath.includes("/profile") || routePath.includes("/avatar"))
    return "profiles";
  if (routePath.includes("/chat")) return "chat";
  if (routePath.includes("/broadcast") || routePath.includes("/notifications"))
    return "broadcast";
  return "general";
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const subfolder = getSubfolder(req);
    const destDir = path.join(baseUploadDir, subfolder);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    cb(null, destDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = /jpeg|jpg|png|gif|webp|mp4|mov/;
  const extname = allowed.test(path.extname(file.originalname).toLowerCase());
  const mimetype =
    allowed.test(file.mimetype) || file.mimetype.startsWith("video/");

  if (extname || mimetype) {
    cb(null, true);
  } else {
    cb(new Error("Only image/video files are allowed"));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB (for videos)
});

module.exports = upload;
