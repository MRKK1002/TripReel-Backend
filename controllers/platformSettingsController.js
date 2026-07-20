const PlatformSettings = require("../models/PlatformSettings");

// Default settings — seeded on first GET if missing
const DEFAULTS = [
  { key: "platform_fee_percent", value: 10, label: "Platform Fee (%)" },
  { key: "gst_percent", value: 5, label: "GST on Bookings (%)" },
  {
    key: "default_cancellation_policy",
    value:
      "Free cancellation up to 7 days before departure. 50% refund for cancellations 3-7 days prior. No refund within 3 days of departure.",
    label: "Default Cancellation Policy",
  },
  {
    key: "default_refund_policy",
    value:
      "Refunds are processed within 7-10 business days to the original payment method.",
    label: "Default Refund Policy",
  },
  {
    key: "default_terms",
    value:
      "Bookings are subject to availability. Valid ID required at check-in. The operator reserves the right to modify itinerary due to weather or safety concerns.",
    label: "Default Terms & Conditions",
  },
];

// Ensure defaults exist in DB
async function seedDefaults() {
  for (const d of DEFAULTS) {
    await PlatformSettings.findOneAndUpdate(
      { key: d.key },
      { $setOnInsert: { key: d.key, value: d.value, label: d.label } },
      { upsert: true, new: false },
    );
  }
}

// Helper — get a single setting value (used by other controllers)
exports.getSetting = async (key) => {
  await seedDefaults();
  const doc = await PlatformSettings.findOne({ key });
  return doc ? doc.value : null;
};

// GET /api/settings  (admin — all settings)
exports.getAllSettings = async (req, res) => {
  try {
    await seedDefaults();
    const settings = await PlatformSettings.find().sort({ key: 1 });
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/settings/public  (public — gst + default policies for form auto-fill)
exports.getPublicSettings = async (req, res) => {
  try {
    await seedDefaults();
    const keys = [
      "gst_percent",
      "default_cancellation_policy",
      "default_refund_policy",
      "default_terms",
      "splash_image_url",
      "splash_images",
      "sample_demo_media",
    ];
    const docs = await PlatformSettings.find({ key: { $in: keys } });
    const result = {};
    docs.forEach((d) => {
      result[d.key] = d.value;
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/settings/sample-media/view  (public)
// Body: { url } — increments the real view count for a sample work media item
exports.incrementSampleMediaView = async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url)
      return res.status(400).json({ success: false, message: "url required" });

    const doc = await PlatformSettings.findOne({ key: "sample_demo_media" });
    if (!doc || !Array.isArray(doc.value))
      return res
        .status(404)
        .json({ success: false, message: "Sample media not found" });

    const item = doc.value.find((m) => m && m.url === url);
    if (!item)
      return res
        .status(404)
        .json({ success: false, message: "Media not found" });

    item.views = (Number(item.views) || 0) + 1;
    doc.markModified("value");
    await doc.save();

    res.json({ success: true, views: item.views });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /api/settings/:key  (admin — update any setting)
// Build a human-readable cancellation policy sentence from refund slabs
function generatePolicyText(slabs) {
  if (!Array.isArray(slabs) || slabs.length === 0) {
    return "Cancellation refunds are processed as per platform policy.";
  }
  const sorted = [...slabs].sort((a, b) => b.daysBeforeTrip - a.daysBeforeTrip);
  const parts = sorted.map((slab, i) => {
    const days = Number(slab.daysBeforeTrip) || 0;
    const pct = Number(slab.refundPercent) || 0;
    const upper = sorted[i - 1];
    let range;
    if (i === 0) {
      range = `${days}+ days before departure`;
    } else if (days === 0) {
      range = `less than ${upper.daysBeforeTrip} days before departure or no-show`;
    } else {
      range = `${days}-${upper.daysBeforeTrip - 1} days before departure`;
    }
    const refundText = pct === 0 ? "no refund" : `${pct}% refund`;
    // Capitalize first letter for the opening sentence
    const sentence =
      i === 0
        ? `Cancel ${range}: ${refundText}.`
        : `Cancel ${range}: ${refundText}.`;
    return sentence;
  });
  return parts.join(" ");
}

exports.updateSetting = async (req, res) => {
  try {
    const { value } = req.body;
    if (value === undefined || value === null) {
      return res
        .status(400)
        .json({ success: false, message: "value is required" });
    }

    const numVal = Number(value);
    const numericKeys = ["platform_fee_percent", "gst_percent"];
    const arrayKeys = [
      "cancellation_refund_slabs",
      "sample_demo_media",
      "splash_images",
    ];

    let finalValue = value;

    if (numericKeys.includes(req.params.key)) {
      if (isNaN(numVal) || numVal < 0) {
        return res.status(400).json({
          success: false,
          message: "value must be a non-negative number",
        });
      }
      if (numVal > 100) {
        return res.status(400).json({
          success: false,
          message: "Percentage value cannot exceed 100%",
        });
      }
      finalValue = numVal;
    } else if (arrayKeys.includes(req.params.key)) {
      // Array settings (refund slabs) — store as-is
      if (!Array.isArray(value)) {
        return res
          .status(400)
          .json({ success: false, message: "value must be an array" });
      }
      finalValue = value;
    } else {
      // String settings (policies, terms) — just store as-is
      finalValue = String(value).trim();
    }

    const setting = await PlatformSettings.findOneAndUpdate(
      { key: req.params.key },
      { value: finalValue, updatedBy: req.user._id },
      { new: true, upsert: true },
    );

    // Auto-generate the user-facing cancellation policy text from the slabs
    if (req.params.key === "cancellation_refund_slabs") {
      const policyText = generatePolicyText(finalValue);
      await PlatformSettings.findOneAndUpdate(
        { key: "default_cancellation_policy" },
        { value: policyText, updatedBy: req.user._id },
        { upsert: true },
      );
    }

    res.json({ success: true, setting });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
