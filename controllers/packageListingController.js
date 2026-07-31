const PackageListing = require("../models/PackageListing");

function parseArrayField(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean);
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch {
      return val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
}

// GET /api/listings  (public)
exports.getAllListings = async (req, res) => {
  try {
    const {
      templateId,
      operatorId,
      status,
      isActive,
      minPrice,
      maxPrice,
      sort = "price_asc",
      page = 1,
      limit = 20,
    } = req.query;

    // Public endpoint: only ever expose live listings. The `status` query param
    // used to be honoured here, which let anyone enumerate a competitor's
    // PENDING/REJECTED listings and their prices via ?operatorId=&status=.
    const query = { status: "APPROVED", isActive: true };
    if (templateId) query.templateId = templateId;
    if (operatorId) query.operatorId = operatorId;

    if (minPrice || maxPrice) {
      query.basePrice = {};
      if (minPrice) query.basePrice.$gte = Number(minPrice);
      if (maxPrice) query.basePrice.$lte = Number(maxPrice);
    }

    const sortMap = {
      price_asc: { basePrice: 1 },
      price_desc: { basePrice: -1 },
      newest: { createdAt: -1 },
    };

    const skip = (Number(page) - 1) * Number(limit);
    const [listings, total] = await Promise.all([
      PackageListing.find(query)
        .populate("operatorId", "businessName contactName")
        .populate(
          "templateId",
          "destinationName theme nights days durationLabel slug seoPath",
        )
        .sort(sortMap[sort] || sortMap.price_asc)
        .skip(skip)
        .limit(Number(limit)),
      PackageListing.countDocuments(query),
    ]);

    res.json({ success: true, listings, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/listings/:id  (public)
exports.getListingById = async (req, res) => {
  try {
    // Public: never expose the operator's email, and never serve a listing that
    // isn't live.
    const listing = await PackageListing.findOne({
      _id: req.params.id,
      status: "APPROVED",
      isActive: true,
    })
      .populate("operatorId", "businessName contactName")
      .populate("templateId");
    if (!listing)
      return res
        .status(404)
        .json({ success: false, message: "Listing not found" });
    res.json({ success: true, listing });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Admin ─────────────────────────────────────────────────────────────────────

// GET /api/listings/admin/all
exports.adminGetAllListings = async (req, res) => {
  try {
    const { status, page = 1, limit = 20, search } = req.query;

    const query = {};
    if (status && status !== "all") query.status = status;

    if (search) {
      // Escape user input — an unanchored raw regex here is a ReDoS vector
      const escapeRegex = require("../utils/escapeRegex");
      const regex = new RegExp(escapeRegex(String(search)), "i");
      query.$or = [{ "hotel.name": regex }, { "hotel.category": regex }];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [listings, total] = await Promise.all([
      PackageListing.find(query)
        .populate("operatorId", "businessName contactName email")
        .populate(
          "templateId",
          "destinationName theme nights days durationLabel slug seoPath",
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      PackageListing.countDocuments(query),
    ]);

    res.json({ success: true, listings, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /api/listings/:id/review
exports.reviewListing = async (req, res) => {
  try {
    const { action, adminNotes } = req.body;
    const statusMap = {
      approve: "APPROVED",
      reject: "REJECTED",
      needs_revision: "NEEDS_REVISION",
    };

    if (!statusMap[action]) {
      return res.status(400).json({
        success: false,
        message: "Invalid action. Use approve, reject, or needs_revision.",
      });
    }

    const update = {
      status: statusMap[action],
      adminNotes: adminNotes || "",
      isActive: action === "approve",
    };

    const listing = await PackageListing.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true },
    );
    if (!listing)
      return res
        .status(404)
        .json({ success: false, message: "Listing not found" });

    res.json({ success: true, listing });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Operator ──────────────────────────────────────────────────────────────────

// GET /api/listings/operator/mine
exports.operatorGetMyListings = async (req, res) => {
  try {
    const listings = await PackageListing.find({ operatorId: req.operator._id })
      .populate(
        "templateId",
        "destinationName theme nights days durationLabel slug seoPath",
      )
      .sort({ createdAt: -1 });
    res.json({ success: true, listings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Platform-controlled listing fields — never settable from an operator request
const OPERATOR_FORBIDDEN_LISTING_FIELDS = [
  "_id",
  "id",
  "operatorId",
  "status",
  "isActive",
  "adminNotes",
  "reviewedBy",
  "reviewedAt",
  "createdAt",
  "updatedAt",
  "__v",
];

function stripPlatformListingFields(body) {
  OPERATOR_FORBIDDEN_LISTING_FIELDS.forEach((f) => delete body[f]);
  return body;
}

// POST /api/listings/operator
exports.operatorCreateListing = async (req, res) => {
  try {
    const body = stripPlatformListingFields({ ...req.body });

    body.meals = parseArrayField(body.meals);
    body.inclusions = parseArrayField(body.inclusions);
    body.exclusions = parseArrayField(body.exclusions);
    body.seasonalPricing =
      typeof body.seasonalPricing === "string"
        ? (() => {
            try {
              return JSON.parse(body.seasonalPricing);
            } catch {
              return [];
            }
          })()
        : Array.isArray(body.seasonalPricing)
          ? body.seasonalPricing
          : [];

    const listing = await PackageListing.create({
      ...body,
      operatorId: req.operator._id,
      status: "PENDING",
      adminNotes: "",
      isActive: false,
    });

    res.status(201).json({ success: true, listing });
  } catch (err) {
    const msg =
      err.code === 11000
        ? "Listing already exists for this template and operator"
        : err.message;
    res.status(400).json({ success: false, message: msg });
  }
};

// PUT /api/listings/operator/:id
exports.operatorUpdateListing = async (req, res) => {
  try {
    const listing = await PackageListing.findOne({
      _id: req.params.id,
      operatorId: req.operator._id,
    });
    if (!listing)
      return res
        .status(404)
        .json({ success: false, message: "Listing not found or not yours" });

    if (listing.status === "APPROVED") {
      return res.status(400).json({
        success: false,
        message: "Approved listings cannot be edited. Contact admin.",
      });
    }

    const body = stripPlatformListingFields({ ...req.body });
    if (typeof body.meals !== "undefined")
      body.meals = parseArrayField(body.meals);
    if (typeof body.inclusions !== "undefined")
      body.inclusions = parseArrayField(body.inclusions);
    if (typeof body.exclusions !== "undefined")
      body.exclusions = parseArrayField(body.exclusions);
    if (typeof body.seasonalPricing === "string") {
      try {
        body.seasonalPricing = JSON.parse(body.seasonalPricing);
      } catch {
        body.seasonalPricing = [];
      }
    }

    const updated = await PackageListing.findByIdAndUpdate(
      req.params.id,
      {
        ...body,
        // Re-pin ownership so it can't be moved via the request body
        operatorId: listing.operatorId,
        status: "PENDING",
        adminNotes: "",
        isActive: false,
      },
      { new: true, runValidators: true },
    );

    res.json({ success: true, listing: updated });
  } catch (err) {
    const msg =
      err.code === 11000
        ? "Listing already exists for this template and operator"
        : err.message;
    res.status(400).json({ success: false, message: msg });
  }
};

// DELETE /api/listings/operator/:id
exports.operatorDeleteListing = async (req, res) => {
  try {
    const listing = await PackageListing.findOneAndDelete({
      _id: req.params.id,
      operatorId: req.operator._id,
    });
    if (!listing)
      return res
        .status(404)
        .json({ success: false, message: "Listing not found or not yours" });
    res.json({ success: true, message: "Listing deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
