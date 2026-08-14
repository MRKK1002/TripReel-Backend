const PackageView = require("../models/PackageView");

// POST /api/package-views — record that the user opened a package's detail page.
// Upserts per user+package, increments the view count, resets the reminder flag
// so a fresh visit can re-remind. Fire-and-forget; never blocks the screen.
exports.recordView = async (req, res) => {
  try {
    const { packageId, packageTitle } = req.body;
    if (!packageId) {
      return res
        .status(400)
        .json({ success: false, message: "packageId is required" });
    }

    await PackageView.findOneAndUpdate(
      { userId: req.user._id, packageId },
      {
        $set: {
          packageTitle: packageTitle || "",
          lastViewedAt: new Date(),
          notified: false,
          converted: false,
        },
        $inc: { viewCount: 1 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.json({ success: true });
  } catch (err) {
    // Non-critical — never block the detail screen on this
    res.status(200).json({ success: false, message: err.message });
  }
};

// Mark a user's view for a package as converted (called after a booking).
exports.markViewConverted = async (userId, packageId) => {
  try {
    await PackageView.updateOne(
      { userId, packageId },
      { $set: { converted: true } },
    );
  } catch {
    // best-effort
  }
};
