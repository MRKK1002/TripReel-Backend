const Coupon = require("../models/Coupon");
const Batch = require("../models/Batch");

// ── Public / User ─────────────────────────────────────────────────────────────

// GET /api/coupons?batchId=X — available coupons for a batch (app shows these)
exports.getCouponsForBatch = async (req, res) => {
  try {
    const { batchId } = req.query;
    if (!batchId) {
      return res
        .status(400)
        .json({ success: false, message: "batchId is required" });
    }

    const now = new Date();
    const coupons = await Coupon.find({
      batchId,
      isActive: true,
      validFrom: { $lte: now },
      validUntil: { $gte: now },
      $or: [
        { usageLimit: 0 }, // unlimited
        { $expr: { $lt: ["$usedCount", "$usageLimit"] } },
      ],
    }).select(
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
    const { batchId, code, guests = 1, subtotal = 0 } = req.body;

    if (!batchId || !code) {
      return res
        .status(400)
        .json({ success: false, message: "batchId and code are required" });
    }

    const now = new Date();
    const coupon = await Coupon.findOne({
      batchId,
      code: code.trim().toUpperCase(),
      isActive: true,
    });

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

// POST /api/coupons — operator creates a coupon for their batch
exports.createCoupon = async (req, res) => {
  try {
    const {
      batchId,
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

    if (!batchId || !code || !type || value === undefined || !validUntil) {
      return res.status(400).json({
        success: false,
        message: "batchId, code, type, value, and validUntil are required",
      });
    }

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

    const coupon = await Coupon.create({
      batchId,
      operatorId: req.operator._id,
      packageId: batch.packageId,
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
      batch.packageId,
      `New coupon: ${code.trim().toUpperCase()}`,
      `Use code ${code.trim().toUpperCase()} for ${discountText}! Limited time offer.`,
    );

    res.status(201).json({ success: true, coupon });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "A coupon with this code already exists for this batch",
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
