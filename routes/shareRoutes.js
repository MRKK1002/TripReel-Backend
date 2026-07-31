const express = require("express");
const router = express.Router();
const Package = require("../models/Package");

// Store links (override via env once the apps are published)
const ANDROID_STORE_URL =
  process.env.ANDROID_STORE_URL ||
  "https://play.google.com/store/apps/details?id=com.tripreel.app";
const IOS_STORE_URL =
  process.env.IOS_STORE_URL || "https://apps.apple.com/app/id000000000";

const esc = (s = "") =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// GET /share/package/:id — smart link. Opens the app to the package if
// installed, otherwise sends the user to the correct app store.
router.get("/package/:id", async (req, res) => {
  const id = req.params.id;
  let pkg = null;
  try {
    pkg = await Package.findById(id).select("title location image_url pricing");
  } catch {
    // fall through with nulls
  }

  const title = esc(pkg?.title || "Trip Reel");
  const location = esc(pkg?.location || "");
  const price = pkg?.pricing?.adultPrice
    ? `From ₹${Number(pkg.pricing.adultPrice).toLocaleString("en-IN")}`
    : "";
  const image = esc(pkg?.image_url || "");
  const appDeepLink = `tripreel://package/${esc(id)}`;

  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — Trip Reel</title>
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${location}${
    location && price ? " · " : ""
  }${esc(price)}" />
  ${image ? `<meta property="og:image" content="${image}" />` : ""}
  <meta name="apple-itunes-app" content="app-id=000000000" />
  <style>
    body{font-family:-apple-system,Roboto,Segoe UI,sans-serif;margin:0;background:#fff;color:#222;
      display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px}
    .card{max-width:360px}
    h1{font-size:20px;margin:16px 0 4px}
    p{color:#717171;font-size:14px;margin:0 0 20px}
    a.btn{display:inline-block;background:#458347;color:#fff;text-decoration:none;
      padding:14px 22px;border-radius:10px;font-weight:600;font-size:15px}
    img.hero{width:100%;max-height:200px;object-fit:cover;border-radius:12px}
  </style>
</head>
<body>
  <div class="card">
    ${image ? `<img class="hero" src="${image}" alt="" />` : ""}
    <h1>${title}</h1>
    <p>${location}${location && price ? " · " : ""}${esc(price)}</p>
    <a class="btn" id="openBtn" href="${appDeepLink}">Open in Trip Reel</a>
  </div>
  <script>
    (function () {
      var deepLink = ${JSON.stringify(appDeepLink)};
      var android = ${JSON.stringify(ANDROID_STORE_URL)};
      var ios = ${JSON.stringify(IOS_STORE_URL)};
      var ua = navigator.userAgent || navigator.vendor || "";
      var isIOS = /iphone|ipad|ipod/i.test(ua);
      var isAndroid = /android/i.test(ua);
      var store = isIOS ? ios : android;

      if (isIOS || isAndroid) {
        var start = Date.now();
        // Try to open the app
        window.location = deepLink;
        // If still here after a moment, the app isn't installed → go to store
        setTimeout(function () {
          if (Date.now() - start < 2000) {
            window.location = store;
          }
        }, 1200);
      }
      // Desktop: leave the page with the "Open in Trip Reel" button + preview
      document.getElementById("openBtn").addEventListener("click", function (e) {
        if (!isIOS && !isAndroid) {
          e.preventDefault();
          window.location = android;
        }
      });
    })();
  </script>
</body>
</html>`);
});

module.exports = router;
