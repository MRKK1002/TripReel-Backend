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

// PATCH /api/settings/:key  (admin — update any setting)
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

    let finalValue = value;

    if (numericKeys.includes(req.params.key)) {
      if (isNaN(numVal) || numVal < 0) {
        return res.status(400).json({
          success: false,
          message: "value must be a non-negative number",
        });
      }
      if (req.params.key === "platform_fee_percent" && numVal > 100) {
        return res
          .status(400)
          .json({ success: false, message: "Platform fee cannot exceed 100%" });
      }
      finalValue = numVal;
    } else {
      // String settings (policies, terms) — just store as-is
      finalValue = String(value).trim();
    }

    const setting = await PlatformSettings.findOneAndUpdate(
      { key: req.params.key },
      { value: finalValue, updatedBy: req.user._id },
      { new: true, upsert: true },
    );

    res.json({ success: true, setting });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
