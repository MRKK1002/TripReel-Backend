const Coupon = require("../models/Coupon");
const Batch = require("../models/Batch");
const Package = require("../models/Package");
const TripBooking = require("../models/TripBooking");
const PendingOrder = require("../models/PendingOrder");
const { getPagination, paginationMeta } = require("../utils/pagination");
const {
  getISTDateKey,
  getISTDayRange,
  storedDateKey,
  parseDateKey,
  dateKeyToISTStart,
  isDateKeyPastInclusiveEnd,
} = require("../utils/businessDate");
const {
  normalizeView,
  couponLifecycle,
  applyLifecycleView,
  isHistory,
} = require("../utils/lifecycle");
const {
  parseBoolean,
  IN_FLIGHT_STATES,
} = require("../utils/resourceIntegrity");

function parseCouponDate(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = String(value).trim();
  if (parseDateKey(raw)) return dateKeyToISTStart(raw);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function validateCouponWindow({ validFrom, validUntil, requireFuture = true }) {
  const untilKey = storedDateKey(validUntil);
  if (!untilKey) return "Please provide a valid expiry date.";
  if (validFrom) {
    const fromKey = storedDateKey(validFrom);
    if (!fromKey) return "Please provide a valid start date.";
    if (untilKey < fromKey)
      return "The expiry date must be on or after the coupon's start date.";
  }
  if (requireFuture && isDateKeyPastInclusiveEnd(untilKey))
    return "The expiry date must be today or later.";
  return "";
}

function validateCouponLimits({
  maxDiscount,
  minGuests,
  minOrderAmount,
  usageLimit,
}) {
  const fields = {
    "Maximum discount": { value: maxDiscount, integer: false },
    "Minimum guests": { value: minGuests, integer: true },
    "Minimum order amount": { value: minOrderAmount, integer: false },
    "Usage limit": { value: usageLimit, integer: true },
  };
  for (const [label, config] of Object.entries(fields)) {
    if (
      config.value === undefined ||
      config.value === null ||
      config.value === ""
    )
      continue;
    const number = Number(config.value);
    if (!Number.isFinite(number) || number < 0)
      return `${label} cannot be negative.`;
    if (config.integer && !Number.isInteger(number))
      return `${label} must be a whole number.`;
  }
  if (minGuests !== undefined && Number(minGuests) > 100)
    return "Minimum guests cannot exceed 100.";
  return "";
}

function validateDiscount(type, value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0)
    return "Discount value must be greater than 0.";
  if (type === "percentage" && amount > 100)
    return "Percentage discount must be greater than 0 and no more than 100.";
  if (!["percentage", "flat"].includes(type)) return "Coupon type is invalid.";
  return "";
}

async function resolveScope({ batchId, packageId, operatorId }) {
  if (Boolean(batchId) === Boolean(packageId)) {
    const error = new Error(
      "Provide exactly one coupon scope: batchId or packageId.",
    );
    error.statusCode = 400;
    throw error;
  }
  if (batchId) {
    const batch = await Batch.findOne({
      _id: batchId,
      operatorId,
      isArchived: { $ne: true },
    });
    if (!batch) {
      const error = new Error("Batch not found or not yours");
      error.statusCode = 404;
      throw error;
    }
    const pkg = await Package.findOne({ _id: batch.packageId, operatorId });
    if (!pkg || pkg.bookingMode !== "batch") {
      const error = new Error(
        "Batch coupons require an owned batch-mode package.",
      );
      error.statusCode = 400;
      throw error;
    }
    return {
      scope: "batch",
      batchId: batch._id,
      packageId: batch.packageId,
      batch,
    };
  }
  const pkg = await Package.findOne({ _id: packageId, operatorId });
  if (!pkg) {
    const error = new Error("Package not found or not yours");
    error.statusCode = 404;
    throw error;
  }
  if (pkg.bookingMode !== "flexible") {
    const error = new Error(
      "Package-scoped coupons require a flexible package.",
    );
    error.statusCode = 400;
    throw error;
  }
  return { scope: "package", batchId: null, packageId: pkg._id, batch: null };
}

function inFlightCouponQuery(coupon) {
  return {
    status: "pending",
    $and: [
      {
        $or: [
          { finalizationState: { $in: IN_FLIGHT_STATES } },
          { finalizationState: { $exists: false } },
        ],
      },
      {
        $or: [
          { packageId: coupon.packageId },
          {
            "payload.packageId": {
              $in: [coupon.packageId, String(coupon.packageId)],
            },
          },
        ],
      },
      {
        $or: [
          { "payload.couponCode": coupon.code },
          { "chargedPricingSnapshot.pricing.couponCode": coupon.code },
        ],
      },
    ],
  };
}

function serializeCoupon(coupon) {
  const raw = coupon?.toObject ? coupon.toObject() : { ...coupon };
  return { ...raw, lifecycle: couponLifecycle(raw) };
}

exports.validateCouponWindow = validateCouponWindow;
exports.validateCouponLimits = validateCouponLimits;
exports.parseCouponDate = parseCouponDate;
exports.inFlightCouponQuery = inFlightCouponQuery;

exports.getCouponsForBatch = async (req, res) => {
  try {
    const { batchId, packageId } = req.query;
    if (Boolean(batchId) === Boolean(packageId)) {
      return res.status(400).json({
        success: false,
        message: "Provide exactly one of batchId or packageId",
      });
    }
    const dayStart = getISTDayRange(getISTDateKey()).start;
    const query = {
      isActive: true,
      isArchived: { $ne: true },
      validFrom: { $lte: new Date() },
      validUntil: { $gte: dayStart },
      $or: [
        { usageLimit: 0 },
        { $expr: { $lt: ["$usedCount", "$usageLimit"] } },
      ],
      ...(batchId ? { batchId } : { packageId, batchId: null }),
    };
    const coupons = (
      await Coupon.find(query).select(
        "code type value maxDiscount minGuests minOrderAmount description validUntil usageLimit usedCount",
      )
    ).map(serializeCoupon);
    res.json({ success: true, count: coupons.length, coupons });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.validateCoupon = async (req, res) => {
  try {
    const { batchId, packageId, code, guests = 1, subtotal = 0 } = req.body;
    if (!code || Boolean(batchId) === Boolean(packageId)) {
      return res.status(400).json({
        success: false,
        message: "code and exactly one of batchId or packageId are required",
      });
    }
    const coupon = await Coupon.findOne({
      code: String(code).trim().toUpperCase(),
      isActive: true,
      isArchived: { $ne: true },
      ...(batchId ? { batchId } : { packageId, batchId: null }),
    });
    if (!coupon)
      return res
        .status(400)
        .json({ success: false, message: "Invalid coupon code" });
    const now = new Date();
    if (coupon.validFrom > now)
      return res
        .status(400)
        .json({ success: false, message: "This coupon is not yet active" });
    if (isDateKeyPastInclusiveEnd(coupon.validUntil, now))
      return res
        .status(400)
        .json({ success: false, message: "This coupon has expired" });
    if (coupon.usageLimit > 0 && coupon.usedCount >= coupon.usageLimit)
      return res.status(400).json({
        success: false,
        message: "This coupon has reached its usage limit",
      });
    if (coupon.minGuests > 0 && Number(guests) < coupon.minGuests)
      return res.status(400).json({
        success: false,
        message: `Minimum ${coupon.minGuests} guests required to use this coupon`,
      });
    if (coupon.minOrderAmount > 0 && Number(subtotal) < coupon.minOrderAmount)
      return res.status(400).json({
        success: false,
        message: `Minimum order of ₹${coupon.minOrderAmount.toLocaleString("en-IN")} required`,
      });
    let discountAmount =
      coupon.type === "percentage"
        ? Math.round((Number(subtotal) * coupon.value) / 100)
        : coupon.value;
    if (coupon.type === "percentage" && coupon.maxDiscount > 0)
      discountAmount = Math.min(discountAmount, coupon.maxDiscount);
    discountAmount = Math.min(
      discountAmount,
      Math.max(0, Number(subtotal) || 0),
    );
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
      isActive,
    } = req.body;
    if (!code || !type || value === undefined || !validUntil)
      return res.status(400).json({
        success: false,
        message: "code, type, value, and validUntil are required",
      });
    const discountError = validateDiscount(type, value);
    const windowError = validateCouponWindow({ validFrom, validUntil });
    const limitsError = validateCouponLimits({
      maxDiscount,
      minGuests,
      minOrderAmount,
      usageLimit,
    });
    if (discountError || windowError || limitsError)
      return res.status(400).json({
        success: false,
        message: discountError || windowError || limitsError,
      });
    const resolved = await resolveScope({
      batchId,
      packageId,
      operatorId: req.operator._id,
    });
    if (
      resolved.batch &&
      storedDateKey(validUntil) > storedDateKey(resolved.batch.bookingDeadline)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Batch coupon expiry cannot be later than the booking deadline.",
      });
    }
    const coupon = await Coupon.create({
      batchId: resolved.batchId,
      packageId: resolved.packageId,
      scope: resolved.scope,
      operatorId: req.operator._id,
      code: String(code).trim().toUpperCase(),
      type,
      value: Number(value),
      maxDiscount: Number(maxDiscount) || 0,
      minGuests: Number(minGuests) || 0,
      minOrderAmount: Number(minOrderAmount) || 0,
      usageLimit: Number(usageLimit) || 0,
      validFrom: parseCouponDate(validFrom, new Date()),
      validUntil: parseCouponDate(validUntil),
      isActive: parseBoolean(isActive, true),
      description: String(description || "").trim(),
    });
    const { alertWishlistedUsers } = require("./wishlistAlertController");
    alertWishlistedUsers(
      resolved.packageId,
      `New coupon: ${coupon.code}`,
      `Use code ${coupon.code} for ${type === "percentage" ? `${value}% off` : `Rs.${value} off`}! Limited time offer.`,
    );
    res.status(201).json({ success: true, coupon: serializeCoupon(coupon) });
  } catch (err) {
    if (err.code === 11000)
      return res.status(400).json({
        success: false,
        message: "A coupon with this code already exists for this package",
      });
    res
      .status(err.statusCode || 400)
      .json({ success: false, message: err.message });
  }
};

exports.operatorGetMyCoupons = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query, 20);
    const view = normalizeView(req.query);
    const query = { operatorId: req.operator._id };
    if (req.query.batchId) query.batchId = req.query.batchId;
    if (req.query.packageId) query.packageId = req.query.packageId;
    if (req.query.search) {
      const escapeRegex = require("../utils/escapeRegex");
      const safe = escapeRegex(String(req.query.search).trim());
      query.$or = [
        { code: { $regex: safe, $options: "i" } },
        { description: { $regex: safe, $options: "i" } },
      ];
    }
    const docs = await Coupon.find(query)
      .populate("batchId", "startDate endDate bookingDeadline label")
      .populate("packageId", "title bookingMode")
      .sort({ createdAt: -1, _id: -1 });
    const classified = applyLifecycleView(
      docs,
      "coupon",
      couponLifecycle,
      view,
    );
    const coupons = classified.items.slice(skip, skip + limit);
    res.json({
      success: true,
      count: coupons.length,
      coupons,
      ...paginationMeta(classified.items.length, page, limit),
      currentTotal: classified.currentTotal,
      historyTotal: classified.historyTotal,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.updateCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.findOne({
      _id: req.params.id,
      operatorId: req.operator._id,
    }).select("+usageClaimKeys +releaseClaimKeys");
    if (!coupon)
      return res
        .status(404)
        .json({ success: false, message: "Coupon not found or not yours" });
    const lifecycle = couponLifecycle(coupon);
    if (isHistory("coupon", lifecycle)) {
      return res.status(409).json({
        success: false,
        message: `This coupon is in History (${lifecycle}) and is read-only. It cannot be changed.`,
      });
    }
    const everUsed =
      Number(coupon.everUsedCount) > 0 ||
      Number(coupon.usedCount) > 0 ||
      coupon.usageClaimKeys.length > 0;
    const scopeRequested =
      req.body.batchId !== undefined || req.body.packageId !== undefined;
    const locked = [
      "batchId",
      "packageId",
      "code",
      "type",
      "value",
      "maxDiscount",
      "minGuests",
      "minOrderAmount",
      "usageLimit",
      "validFrom",
    ];
    if (everUsed) {
      const attempted = locked.filter(
        (key) =>
          req.body[key] !== undefined &&
          String(req.body[key] ?? "") !== String(coupon[key] ?? ""),
      );
      if (attempted.length > 0) {
        return res.status(409).json({
          success: false,
          message: `Used coupon history is immutable (${attempted.join(", ")}). Only validity, description, pause, or archive metadata may change.`,
        });
      }
    }
    const inFlight = await PendingOrder.exists(inFlightCouponQuery(coupon));
    const inFlightSensitive = [...locked, "validUntil", "isActive"];
    if (
      inFlight &&
      inFlightSensitive.some((key) => req.body[key] !== undefined)
    ) {
      return res.status(409).json({
        success: false,
        message:
          "Coupon pricing, limits, validity, activity, or scope cannot change while a charged order is being finalized.",
      });
    }
    let resolved = {
      scope: coupon.scope || (coupon.batchId ? "batch" : "package"),
      batchId: coupon.batchId,
      packageId: coupon.packageId,
    };
    if (scopeRequested) {
      resolved = await resolveScope({
        batchId: req.body.batchId,
        packageId: req.body.packageId,
        operatorId: req.operator._id,
      });
    }
    const next = {
      code:
        req.body.code === undefined
          ? coupon.code
          : String(req.body.code).trim().toUpperCase(),
      type: req.body.type === undefined ? coupon.type : String(req.body.type),
      value:
        req.body.value === undefined ? coupon.value : Number(req.body.value),
      maxDiscount:
        req.body.maxDiscount === undefined
          ? coupon.maxDiscount
          : Number(req.body.maxDiscount),
      minGuests:
        req.body.minGuests === undefined
          ? coupon.minGuests
          : Number(req.body.minGuests),
      minOrderAmount:
        req.body.minOrderAmount === undefined
          ? coupon.minOrderAmount
          : Number(req.body.minOrderAmount),
      usageLimit:
        req.body.usageLimit === undefined
          ? coupon.usageLimit
          : Number(req.body.usageLimit),
      validFrom:
        req.body.validFrom === undefined
          ? coupon.validFrom
          : parseCouponDate(req.body.validFrom),
      validUntil:
        req.body.validUntil === undefined
          ? coupon.validUntil
          : parseCouponDate(req.body.validUntil),
    };
    const error =
      validateDiscount(next.type, next.value) ||
      validateCouponWindow({
        validFrom: next.validFrom,
        validUntil: next.validUntil,
        requireFuture: req.body.validUntil !== undefined,
      }) ||
      validateCouponLimits(next);
    if (error) return res.status(400).json({ success: false, message: error });
    if (resolved.batchId) {
      const batch = resolved.batch || (await Batch.findById(resolved.batchId));
      if (
        !batch ||
        storedDateKey(next.validUntil) > storedDateKey(batch.bookingDeadline)
      )
        return res.status(400).json({
          success: false,
          message:
            "Batch coupon expiry cannot be later than the booking deadline.",
        });
    }
    if (next.usageLimit > 0 && next.usageLimit < Number(coupon.usedCount))
      return res.status(409).json({
        success: false,
        message: `Usage limit cannot be lower than ${coupon.usedCount} active redemption(s).`,
      });
    Object.assign(coupon, next, {
      batchId: resolved.batchId || null,
      packageId: resolved.packageId,
      scope: resolved.scope,
    });
    if (req.body.description !== undefined)
      coupon.description = String(req.body.description || "").trim();
    if (req.body.isActive !== undefined)
      coupon.isActive = parseBoolean(req.body.isActive, coupon.isActive);
    await coupon.save();
    res.json({ success: true, coupon: serializeCoupon(coupon) });
  } catch (err) {
    res
      .status(err.statusCode || 400)
      .json({ success: false, message: err.message });
  }
};

exports.deleteCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.findOne({
      _id: req.params.id,
      operatorId: req.operator._id,
    }).select("+usageClaimKeys +releaseClaimKeys");
    if (!coupon)
      return res
        .status(404)
        .json({ success: false, message: "Coupon not found or not yours" });
    const lifecycle = couponLifecycle(coupon);
    if (isHistory("coupon", lifecycle)) {
      return res.status(409).json({
        success: false,
        message: `This coupon is in History (${lifecycle}) and is read-only. It cannot be deleted.`,
      });
    }
    const [bookingRef, inFlight] = await Promise.all([
      TripBooking.exists({
        $or: [
          { operatorCouponId: coupon._id },
          { packageId: coupon.packageId, "pricing.couponCode": coupon.code },
        ],
      }),
      PendingOrder.exists(inFlightCouponQuery(coupon)),
    ]);
    if (inFlight) {
      return res.status(409).json({
        success: false,
        message:
          "Cannot delete or archive this coupon while a paid booking order is still being finalized.",
      });
    }
    const used =
      Number(coupon.everUsedCount) > 0 ||
      Number(coupon.usedCount) > 0 ||
      coupon.usageClaimKeys.length > 0 ||
      coupon.releaseClaimKeys.length > 0;
    if (used || bookingRef) {
      coupon.isActive = false;
      coupon.isArchived = true;
      coupon.archivedAt = new Date();
      coupon.archivedBy = String(req.operator._id);
      coupon.archivedByType = "operator";
      coupon.archivedReason = String(
        req.body?.reason || "Usage or payment history preserved",
      ).slice(0, 500);
      await coupon.save();
      return res.json({
        success: true,
        archived: true,
        message: "Coupon has durable history and was archived.",
      });
    }
    await coupon.deleteOne();
    res.json({ success: true, archived: false, message: "Coupon deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
