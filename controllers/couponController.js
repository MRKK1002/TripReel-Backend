const Coupon = require("../models/Coupon");
const Batch = require("../models/Batch");

// ── Public / User ─────────────────────────────────────────────────────────────

// GET /api/coupons?batchId=X or ?packageId=X — available coupons (app shows these)
exports.getCouponsForBatch = async (req, res) => {
  try {
    const { batchId, packageId } = req.query;
    if (!batchId && !packageId) {
      return res
        .status(400)
        .json({ success: false, message: "batchId or packageId is required" });
    }

    const now = new Date();
    const query = {
      isActive: true,
      validFrom: { $lte: now },
      validUntil: { $gte: now },
      $or: [
        { usageLimit: 0 }, // unlimited
        { $expr: { $lt: ["$usedCount", "$usageLimit"] } },
      ],
    };

    if (batchId) {
      query.batchId = batchId;
    } else {
      // For flex packages — get package-level coupons (batchId is null)
      query.packageId = packageId;
      query.batchId = null;
    }

    const coupons = await Coupon.find(query).select(
      "code type value maxDiscount minGuests minOrderAmount description validUntil",
    );

    res.json({ success: true, count: coupons.length, coupons });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/coupons/validate — validate a coupon code for a booking
exports.validateCoupon = async (req, res) => {
  try {
    const { batchId, packageId, code, guests = 1, subtotal = 0 } = req.body;

    if (!code || (!batchId && !packageId)) {
      return res.status(400).json({
        success: false,
        message: "code and (batchId or packageId) are required",
      });
    }

    const now = new Date();
    const query = {
      code: code.trim().toUpperCase(),
      isActive: true,
    };

    if (batchId) {
      query.batchId = batchId;
    } else {
      query.packageId = packageId;
      query.batchId = null;
    }

    const coupon = await Coupon.findOne(query);

    if (!coupon) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid coupon code" });
    }

    // Check expiry
    if (coupon.validFrom > now) {
      return res
        .status(400)
        .json({ success: false, message: "This coupon is not yet active" });
    }
    if (coupon.validUntil < now) {
      return res
        .status(400)
        .json({ success: false, message: "This coupon has expired" });
    }

    // Check usage limit
    if (coupon.usageLimit > 0 && coupon.usedCount >= coupon.usageLimit) {
      return res.status(400).json({
        success: false,
        message: "This coupon has reached its usage limit",
      });
    }

    // Check minimum guests
    if (coupon.minGuests > 0 && guests < coupon.minGuests) {
      return res.status(400).json({
        success: false,
        message: `Minimum ${coupon.minGuests} guests required to use this coupon`,
      });
    }

    // Check minimum order amount
    if (coupon.minOrderAmount > 0 && subtotal < coupon.minOrderAmount) {
      return res.status(400).json({
        success: false,
        message: `Minimum order of ₹${coupon.minOrderAmount.toLocaleString("en-IN")} required`,
      });
    }

    // Calculate discount
    let discountAmount = 0;
    if (coupon.type === "percentage") {
      discountAmount = Math.round((subtotal * coupon.value) / 100);
      // Apply cap
      if (coupon.maxDiscount > 0 && discountAmount > coupon.maxDiscount) {
        discountAmount = coupon.maxDiscount;
      }
    } else {
      // flat
      discountAmount = coupon.value;
      // Can't exceed subtotal
      if (discountAmount > subtotal) discountAmount = subtotal;
    }

    res.json({
      success: true,
      coupon: {
        code: coupon.code,
        type: coupon.type,
        value: coupon.value,
        maxDiscount: coupon.maxDiscount,
        description: coupon.description,
      },
      discountAmount,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Operator ──────────────────────────────────────────────────────────────────

// POST /api/coupons — operator creates a coupon for their batch or package
exports.createCoupon = async (req, res) => {
  try {
    const {
      batchId,
      packageId,
      code,
      type,
      value,
      maxDiscount,
      minGuests,
      minOrderAmount,
      usageLimit,
      validFrom,
      validUntil,
      description,
    } = req.body;

    if (!code || !type || value === undefined || !validUntil) {
      return res.status(400).json({
        success: false,
        message: "code, type, value, and validUntil are required",
      });
    }

    if (!batchId && !packageId) {
      return res.status(400).json({
        success: false,
        message: "Either batchId or packageId is required",
      });
    }

    // Percentage coupons capped at 100%
    if (type === "percentage" && (Number(value) <= 0 || Number(value) > 100)) {
      return res.status(400).json({
        success: false,
        message: "Percentage discount must be between 1 and 100.",
      });
    }
    if (type === "flat" && Number(value) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Discount value must be greater than 0.",
      });
    }

    let resolvedPackageId = packageId;

    if (batchId) {
      // Verify batch belongs to this operator
      const batch = await Batch.findOne({
        _id: batchId,
        operatorId: req.operator._id,
      });
      if (!batch) {
        return res
          .status(404)
          .json({ success: false, message: "Batch not found or not yours" });
      }
      resolvedPackageId = batch.packageId;
    } else {
      // Verify package belongs to this operator
      const Package = require("../models/Package");
      const pkg = await Package.findOne({
        _id: packageId,
        operatorId: req.operator._id,
      });
      if (!pkg) {
        return res
          .status(404)
          .json({ success: false, message: "Package not found or not yours" });
      }
    }

    const coupon = await Coupon.create({
      batchId: batchId || null,
      operatorId: req.operator._id,
      packageId: resolvedPackageId,
      code: code.trim().toUpperCase(),
      type,
      value: Number(value),
      maxDiscount: Number(maxDiscount) || 0,
      minGuests: Number(minGuests) || 0,
      minOrderAmount: Number(minOrderAmount) || 0,
      usageLimit: Number(usageLimit) || 0,
      validFrom: validFrom ? new Date(validFrom) : new Date(),
      validUntil: new Date(validUntil),
      description: (description || "").trim(),
    });

    // Alert wishlisted users about new coupon
    const { alertWishlistedUsers } = require("./wishlistAlertController");
    const discountText =
      type === "percentage" ? `${value}% off` : `Rs.${value} off`;
    alertWishlistedUsers(
      resolvedPackageId,
      `New coupon: ${code.trim().toUpperCase()}`,
      `Use code ${code.trim().toUpperCase()} for ${discountText}! Limited time offer.`,
    );

    res.status(201).json({ success: true, coupon });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "A coupon with this code already exists for this package",
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
};

// GET /api/coupons/operator/mine — operator's all coupons with usage stats
exports.operatorGetMyCoupons = async (req, res) => {
  try {
    const { batchId, packageId } = req.query;
    const query = { operatorId: req.operator._id };
    if (batchId) query.batchId = batchId;
    if (packageId) query.packageId = packageId;

    const coupons = await Coupon.find(query)
      .populate("batchId", "startDate endDate label")
      .populate("packageId", "title")
      .sort({ createdAt: -1 });

    res.json({ success: true, count: coupons.length, coupons });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/coupons/:id — operator edits their coupon
exports.updateCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.findOne({
      _id: req.params.id,
      operatorId: req.operator._id,
    });
    if (!coupon) {
      return res
        .status(404)
        .json({ success: false, message: "Coupon not found or not yours" });
    }

    const allowed = [
      "code",
      "type",
      "value",
      "maxDiscount",
      "minGuests",
      "minOrderAmount",
      "usageLimit",
      "validFrom",
      "validUntil",
      "description",
      "isActive",
    ];
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) {
        if (key === "code")
          coupon[key] = String(req.body[key]).trim().toUpperCase();
        else if (key === "validFrom" || key === "validUntil")
          coupon[key] = new Date(req.body[key]);
        else if (key === "isActive") coupon[key] = Boolean(req.body[key]);
        else coupon[key] = Number(req.body[key]) || req.body[key];
      }
    });

    await coupon.save();
    res.json({ success: true, coupon });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// DELETE /api/coupons/:id — operator deletes their coupon
exports.deleteCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.findOneAndDelete({
      _id: req.params.id,
      operatorId: req.operator._id,
    });
    if (!coupon) {
      return res
        .status(404)
        .json({ success: false, message: "Coupon not found or not yours" });
    }
    res.json({ success: true, message: "Coupon deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
