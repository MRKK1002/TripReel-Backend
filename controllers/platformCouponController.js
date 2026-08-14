const PlatformCoupon = require("../models/PlatformCoupon");
const Package = require("../models/Package");
const escapeRegex = require("../utils/escapeRegex");
const { resolvePlatformCoupon } = require("../utils/platformCoupon");

// ── Validation helper (mirrors the schema constraints) ───────────────────────
function validateCouponInput(body, { partial = false } = {}) {
  const errors = [];
  const has = (k) => body[k] !== undefined && body[k] !== null;

  if (!partial || has("code")) {
    const code = String(body.code || "").trim();
    if (!code) errors.push("Coupon code is required.");
    else if (!/^[A-Z0-9]{3,20}$/i.test(code))
      errors.push("Code must be 3–20 letters/numbers (no spaces).");
  }
  if (!partial || has("type")) {
    if (!["percentage", "flat"].includes(body.type))
      errors.push("Type must be 'percentage' or 'flat'.");
  }
  if (!partial || has("value")) {
    const v = Number(body.value);
    if (!Number.isFinite(v) || v <= 0)
      errors.push("Value must be greater than 0.");
    if (body.type === "percentage" && v > 100)
      errors.push("Percentage cannot exceed 100.");
  }
  if (has("maxDiscount") && Number(body.maxDiscount) < 0)
    errors.push("Max discount cannot be negative.");
  if (has("minOrderAmount") && Number(body.minOrderAmount) < 0)
    errors.push("Minimum order cannot be negative.");
  if (!partial || has("validUntil")) {
    const until = new Date(body.validUntil);
    if (isNaN(until.getTime())) errors.push("Valid until date is required.");
  }
  if (has("validFrom") && has("validUntil")) {
    if (new Date(body.validUntil) <= new Date(body.validFrom))
      errors.push("Expiry must be after the start date.");
  }
  if (has("appliesTo")) {
    const allowed = ["all", "category", "destination", "package", "operator"];
    if (!allowed.includes(body.appliesTo))
      errors.push("Invalid targeting scope.");
    if (body.appliesTo === "category" && !(body.categories || []).length)
      errors.push("Select at least one category.");
    if (
      body.appliesTo === "destination" &&
      !(body.states || []).length &&
      !(body.cities || []).length
    )
      errors.push("Select at least one state or city.");
    if (body.appliesTo === "package" && !(body.packageIds || []).length)
      errors.push("Select at least one package.");
    if (body.appliesTo === "operator" && !(body.operatorIds || []).length)
      errors.push("Select at least one operator.");
  }
  return errors;
}

// ── Admin: list all platform coupons ──────────────────────────────────────────
exports.adminGetAll = async (req, res) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    const query = {};
    if (search) {
      query.code = { $regex: escapeRegex(String(search)), $options: "i" };
    }
    if (status === "active") query.isActive = true;
    else if (status === "inactive") query.isActive = false;
    else if (status === "expired") query.validUntil = { $lt: new Date() };

    const skip = (Number(page) - 1) * Number(limit);
    const [coupons, total] = await Promise.all([
      PlatformCoupon.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      PlatformCoupon.countDocuments(query),
    ]);
    res.json({ success: true, total, page: Number(page), coupons });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Admin: create ──────────────────────────────────────────────────────────────
exports.adminCreate = async (req, res) => {
  try {
    const errors = validateCouponInput(req.body);
    if (errors.length)
      return res
        .status(400)
        .json({ success: false, message: errors[0], errors });

    const code = String(req.body.code).trim().toUpperCase();
    const existing = await PlatformCoupon.findOne({ code });
    if (existing)
      return res.status(400).json({
        success: false,
        message: "A coupon with this code already exists.",
      });

    const coupon = await PlatformCoupon.create({
      code,
      type: req.body.type,
      value: Number(req.body.value),
      maxDiscount: Number(req.body.maxDiscount) || 0,
      minOrderAmount: Number(req.body.minOrderAmount) || 0,
      minGuests: Number(req.body.minGuests) || 0,
      firstBookingOnly: !!req.body.firstBookingOnly,
      appliesTo: req.body.appliesTo || "all",
      categories: req.body.categories || [],
      states: req.body.states || [],
      cities: req.body.cities || [],
      packageIds: req.body.packageIds || [],
      operatorIds: req.body.operatorIds || [],
      usageLimit: Number(req.body.usageLimit) || 0,
      perUserLimit: Number(req.body.perUserLimit) || 1,
      validFrom: req.body.validFrom ? new Date(req.body.validFrom) : new Date(),
      validUntil: new Date(req.body.validUntil),
      isActive: req.body.isActive !== undefined ? !!req.body.isActive : true,
      description: String(req.body.description || "").trim(),
      featured: !!req.body.featured,
    });
    res.status(201).json({ success: true, coupon });
  } catch (err) {
    if (err.code === 11000)
      return res.status(400).json({
        success: false,
        message: "A coupon with this code already exists.",
      });
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Admin: update ──────────────────────────────────────────────────────────────
exports.adminUpdate = async (req, res) => {
  try {
    const errors = validateCouponInput(req.body, { partial: true });
    if (errors.length)
      return res
        .status(400)
        .json({ success: false, message: errors[0], errors });

    const allowed = [
      "type",
      "value",
      "maxDiscount",
      "minOrderAmount",
      "minGuests",
      "firstBookingOnly",
      "appliesTo",
      "categories",
      "states",
      "cities",
      "packageIds",
      "operatorIds",
      "usageLimit",
      "perUserLimit",
      "validFrom",
      "validUntil",
      "isActive",
      "description",
      "featured",
    ];
    const updates = {};
    allowed.forEach((k) => {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    });
    if (updates.validFrom) updates.validFrom = new Date(updates.validFrom);
    if (updates.validUntil) updates.validUntil = new Date(updates.validUntil);

    const coupon = await PlatformCoupon.findByIdAndUpdate(
      req.params.id,
      updates,
      {
        new: true,
        runValidators: true,
      },
    );
    if (!coupon)
      return res
        .status(404)
        .json({ success: false, message: "Coupon not found" });
    res.json({ success: true, coupon });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Admin: delete ──────────────────────────────────────────────────────────────
exports.adminDelete = async (req, res) => {
  try {
    const coupon = await PlatformCoupon.findByIdAndDelete(req.params.id);
    if (!coupon)
      return res
        .status(404)
        .json({ success: false, message: "Coupon not found" });
    res.json({ success: true, message: "Coupon deleted." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── App: list featured/available platform coupons for a package ───────────────
// GET /api/platform-coupons/available?packageId=...&fareSubtotal=...&seats=...
exports.getAvailableForPackage = async (req, res) => {
  try {
    const { packageId } = req.query;
    if (!packageId)
      return res
        .status(400)
        .json({ success: false, message: "packageId required" });

    const now = new Date();
    const coupons = await PlatformCoupon.find({
      isActive: true,
      featured: true,
      validFrom: { $lte: now },
      validUntil: { $gte: now },
    })
      .select(
        "code type value maxDiscount minOrderAmount minGuests appliesTo categories states cities packageIds operatorIds description",
      )
      .lean();

    // Only surface coupons whose scope could match this package (cheap filter;
    // final eligibility is re-checked at validate/payment time).
    const pkg = await Package.findById(packageId).select(
      "category categories state city operatorId",
    );
    const matches = coupons.filter((c) => {
      if (c.appliesTo === "all") return true;
      if (c.appliesTo === "package")
        return (c.packageIds || []).map(String).includes(String(packageId));
      if (c.appliesTo === "operator")
        return (c.operatorIds || [])
          .map(String)
          .includes(String(pkg?.operatorId));
      if (c.appliesTo === "category") {
        const pkgCats = [pkg?.category, ...(pkg?.categories || [])]
          .filter(Boolean)
          .map((x) => String(x).toLowerCase());
        return (c.categories || [])
          .map((x) => x.toLowerCase())
          .some((x) => pkgCats.includes(x));
      }
      if (c.appliesTo === "destination") {
        const st = String(pkg?.state || "").toLowerCase();
        const ci = String(pkg?.city || "").toLowerCase();
        return (
          (c.states || []).map((x) => x.toLowerCase()).includes(st) ||
          (c.cities || []).map((x) => x.toLowerCase()).includes(ci)
        );
      }
      return false;
    });

    res.json({ success: true, coupons: matches });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── App: validate a coupon code against a package (preview discount) ──────────
// POST /api/platform-coupons/validate
// Body: { code, packageId, fareSubtotal, seats }
exports.validateForUser = async (req, res) => {
  try {
    const { code, packageId, fareSubtotal, seats } = req.body;
    if (!code || !packageId)
      return res
        .status(400)
        .json({ success: false, message: "code and packageId are required" });

    const pkg = await Package.findById(packageId).select(
      "category categories state city operatorId",
    );
    if (!pkg)
      return res
        .status(404)
        .json({ success: false, message: "Package not found" });

    const result = await resolvePlatformCoupon({
      code,
      userId: req.user._id,
      pkg,
      fareSubtotal: Math.max(0, Number(fareSubtotal) || 0),
      numSeats: Math.max(1, Number(seats) || 1),
    });

    if (!result.ok) {
      return res.json({ success: false, valid: false, message: result.reason });
    }
    const c = result.coupon;
    res.json({
      success: true,
      valid: true,
      discountAmount: result.discount,
      coupon: {
        code: c.code,
        type: c.type,
        value: c.value,
        maxDiscount: c.maxDiscount || 0,
        minOrderAmount: c.minOrderAmount || 0,
        minGuests: c.minGuests || 0,
        description: c.description || "",
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
