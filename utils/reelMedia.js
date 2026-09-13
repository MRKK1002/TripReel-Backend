const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const DEFAULT_UPLOAD_ROOT = path.resolve(__dirname, "..", "uploads");
const REEL_UPLOAD_ROOT = path.resolve(
  process.env.REEL_UPLOAD_ROOT || DEFAULT_UPLOAD_ROOT,
);
const REEL_VIDEO_DIR = path.join(REEL_UPLOAD_ROOT, "videos");
const REEL_THUMBNAIL_DIR = path.join(REEL_UPLOAD_ROOT, "reel-thumbnails");
const PUBLIC_UPLOAD_ROOTS = [...new Set([REEL_UPLOAD_ROOT, DEFAULT_UPLOAD_ROOT])];

const isInside = (candidate, parent) => {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const ensureReelMediaDirectories = async () => {
  await Promise.all([
    fs.promises.mkdir(REEL_VIDEO_DIR, { recursive: true }),
    fs.promises.mkdir(REEL_THUMBNAIL_DIR, { recursive: true }),
  ]);
};

const mediaPathname = (value) => {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).pathname;
    } catch {
      return "";
    }
  }

  return trimmed.split(/[?#]/, 1)[0];
};

const ownedMediaCandidates = (value) => {
  const pathname = mediaPathname(value).replace(/\\/g, "/");
  const match = /^\/uploads\/(videos|reel-thumbnails)\/([^/]+)$/.exec(pathname);
  if (!match) return [];

  const [, directory, filename] = match;
  if (!filename || filename !== path.basename(filename) || filename.includes("..")) {
    return [];
  }

  return PUBLIC_UPLOAD_ROOTS.map((root) => {
    const parent = path.resolve(root, directory);
    const candidate = path.resolve(parent, filename);
    return isInside(candidate, parent) ? candidate : null;
  }).filter(Boolean);
};

const resolveOwnedReelMediaPath = (value) => {
  const candidates = ownedMediaCandidates(value);
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0] || null;
};

const removeOwnedReelMedia = async (...values) => {
  const paths = [...new Set(values.flatMap(ownedMediaCandidates))];
  await Promise.all(
    paths.map((filePath) =>
      fs.promises.unlink(filePath).catch((error) => {
        if (error.code !== "ENOENT") {
          console.warn(`[reels] Could not remove ${filePath}: ${error.message}`);
        }
      }),
    ),
  );
};

const runFfmpeg = (inputPath, outputPath, seekSeconds) =>
  new Promise((resolve, reject) => {
    // Require lazily so serving existing media still works if a deployment has
    // not installed the optional platform binary correctly.
    const ffmpegPath = require("ffmpeg-static");
    if (!ffmpegPath) {
      reject(new Error("No FFmpeg binary is available for this platform."));
      return;
    }

    const args = [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(seekSeconds),
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=720:-2:force_original_aspect_ratio=decrease",
      "-q:v",
      "3",
      "-y",
      outputPath,
    ];
    const child = spawn(ffmpegPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 20000);

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("Thumbnail extraction timed out."));
      } else if (code !== 0) {
        reject(new Error(stderr.trim() || `FFmpeg exited with code ${code}.`));
      } else {
        resolve();
      }
    });
  });

const generateReelThumbnail = async (inputPath) => {
  await ensureReelMediaDirectories();

  const resolvedInput = path.resolve(inputPath);
  const allowedVideoDirs = PUBLIC_UPLOAD_ROOTS.map((root) =>
    path.resolve(root, "videos"),
  );
  if (!allowedVideoDirs.some((directory) => isInside(resolvedInput, directory))) {
    throw new Error("Reel thumbnail input must be an owned video upload.");
  }

  const filename = `${Date.now()}-${crypto.randomUUID()}.jpg`;
  const finalPath = path.join(REEL_THUMBNAIL_DIR, filename);
  const temporaryPath = path.join(
    REEL_THUMBNAIL_DIR,
    `${filename.slice(0, -4)}.part.jpg`,
  );

  let lastError;
  for (const seekSeconds of [1, 0]) {
    try {
      await fs.promises.unlink(temporaryPath).catch(() => {});
      await runFfmpeg(resolvedInput, temporaryPath, seekSeconds);
      const stats = await fs.promises.stat(temporaryPath);
      if (!stats.isFile() || stats.size === 0) {
        throw new Error("FFmpeg produced an empty thumbnail.");
      }
      await fs.promises.rename(temporaryPath, finalPath);
      return {
        absolutePath: finalPath,
        publicPath: `/uploads/reel-thumbnails/${filename}`,
      };
    } catch (error) {
      lastError = error;
    }
  }

  await fs.promises.unlink(temporaryPath).catch(() => {});
  throw lastError || new Error("Could not generate reel thumbnail.");
};

module.exports = {
  DEFAULT_UPLOAD_ROOT,
  REEL_UPLOAD_ROOT,
  REEL_VIDEO_DIR,
  PUBLIC_UPLOAD_ROOTS,
  ensureReelMediaDirectories,
  generateReelThumbnail,
  resolveOwnedReelMediaPath,
  removeOwnedReelMedia,
};
