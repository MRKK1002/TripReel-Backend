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
    // Store everything directly in /uploads. Controllers build URLs as
    // "/uploads/<filename>" (and path.relative(base, file.path) => filename),
    // so a flat folder keeps every stored URL correct. (Subfolders previously
    // caused profile photos & package images to 404 because the saved path
    // included a subfolder the URL didn't.)
    if (!fs.existsSync(baseUploadDir))
      fs.mkdirSync(baseUploadDir, { recursive: true });
    cb(null, baseUploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

// Explicitly dangerous types that must NEVER be accepted even if the extension
// or mimetype looks benign — SVG/HTML can carry executable scripts (stored XSS).
const BLOCKED_EXTENSIONS = [
  ".svg",
  ".html",
  ".htm",
  ".xml",
  ".js",
  ".php",
  ".phtml",
  ".exe",
  ".sh",
];
const BLOCKED_MIMES = [
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
  "application/javascript",
  "text/javascript",
];

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = (file.mimetype || "").toLowerCase();

  // Hard block dangerous types first
  if (BLOCKED_EXTENSIONS.includes(ext) || BLOCKED_MIMES.includes(mime)) {
    return cb(new Error("This file type is not allowed."));
  }

  // Allowed image + video types — extension AND mimetype must BOTH match
  const allowedExt = /\.(jpe?g|png|gif|webp|mp4|mov)$/i;
  const extOk = allowedExt.test(ext);
  const mimeOk = mime.startsWith("image/") || mime.startsWith("video/");

  if (extOk && mimeOk) {
    cb(null, true);
  } else {
    cb(new Error("Only JPG, PNG, GIF, WEBP, MP4 or MOV files are allowed"));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB (for videos)
});

module.exports = upload;
