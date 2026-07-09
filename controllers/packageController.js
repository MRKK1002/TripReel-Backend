const Package = require("../models/Package");
const Batch = require("../models/Batch");

// Helper: Attach nearest upcoming batch price to each package
async function enrichWithBatchPrice(packages) {
  if (!packages || packages.length === 0) return packages;

  const now = new Date();
  const packageIds = packages.map((p) => p._id || p);

  // Find the nearest upcoming active batch for each package
  const nearestBatches = await Batch.aggregate([
    {
      $match: {
        packageId: { $in: packageIds },
        isActive: true,
        startDate: { $gt: now },
      },
    },
    { $sort: { startDate: 1 } },
    {
      $group: {
        _id: "$packageId",
        adultPrice: { $first: "$adultPrice" },
        childPrice: { $first: "$childPrice" },
        startDate: { $first: "$startDate" },
      },
    },
  ]);

  const priceMap = {};
  nearestBatches.forEach((b) => {
    priceMap[b._id.toString()] = {
      batchPrice: b.adultPrice,
      childPrice: b.childPrice || 0,
      nextBatchDate: b.startDate,
    };
  });

  // Find cheapest active flexible availability for each package
  const FlexibleAvailability = require("../models/FlexibleAvailability");
  const flexData = await FlexibleAvailability.aggregate([
    {
      $match: {
        packageId: { $in: packageIds },
        isActive: true,
        endDate: { $gte: now },
      },
    },
    { $sort: { adultPrice: 1 } },
    {
      $group: {
        _id: "$packageId",
        flexAdultPrice: { $first: "$adultPrice" },
        flexChildPrice: { $first: "$childPrice" },
        flexStartDate: { $first: "$startDate" },
        flexEndDate: { $last: "$endDate" },
      },
    },
  ]);

  const flexMap = {};
  flexData.forEach((f) => {
    flexMap[f._id.toString()] = {
      flexAdultPrice: f.flexAdultPrice,
      flexChildPrice: f.flexChildPrice || 0,
      flexStartDate: f.flexStartDate,
      flexEndDate: f.flexEndDate,
      hasFlexibility: true,
    };
  });

  // Attach batch price + flex info to each package
  return packages.map((pkg) => {
    const obj = pkg.toJSON ? pkg.toJSON() : { ...pkg };
    const id = (obj._id || "").toString();
    if (priceMap[id]) {
      obj.batchPrice = priceMap[id].batchPrice;
      obj.batchChildPrice = priceMap[id].childPrice;
      obj.nextBatchDate = priceMap[id].nextBatchDate;
    }
    if (flexMap[id]) {
      obj.flexAdultPrice = flexMap[id].flexAdultPrice;
      obj.flexChildPrice = flexMap[id].flexChildPrice;
      obj.flexStartDate = flexMap[id].flexStartDate;
      obj.flexEndDate = flexMap[id].flexEndDate;
      obj.hasFlexibility = true;
    }
    return obj;
  });
}

// ── Public / shared ───────────────────────────────────────────────────────────

// GET /api/packages  (public — only approved packages)
// Supports ?userCountry=India&userState=Goa for nearby-first Curated sort
// Supports ?date=2026-06-11 to filter packages that have batches on that date
// Supports ?guests=3 to filter packages with batches that have enough seats
exports.getAllPackages = async (req, res) => {
  try {
    const {
      search,
      category,
      badge,
      sortBy,
      userCountry,
      userState,
      date,
      dateFrom,
      dateTo,
      guests,
      page = 1,
      limit = 20,
    } = req.query;
    const query = { isActive: true, status: { $in: ["APPROVED"] } };

    // Date range filter: dateFrom/dateTo or single date
    // Check BOTH batches and flexible availability for matching dates
    const hasRange = dateFrom || dateTo;
    if (date || hasRange) {
      const Batch = require("../models/Batch");
      const FlexibleAvailability = require("../models/FlexibleAvailability");

      const istOffset = 5.5 * 60 * 60 * 1000;
      const toISTDayStart = (str) => {
        const [y, m, d] = str.split("-").map(Number);
        return new Date(Date.UTC(y, m - 1, d) - istOffset);
      };
      const toISTDayEnd = (str) => {
        const [y, m, d] = str.split("-").map(Number);
        return new Date(
          Date.UTC(y, m - 1, d) - istOffset + 24 * 60 * 60 * 1000,
        );
      };

      let startFilter;
      if (hasRange) {
        startFilter = {};
        if (dateFrom) startFilter.$gte = toISTDayStart(dateFrom);
        if (dateTo) startFilter.$lt = toISTDayEnd(dateTo);
      } else {
        startFilter = {
          $gte: toISTDayStart(date),
          $lt: toISTDayEnd(date),
        };
      }

      // Find packages with matching batches
      const batchQuery = { isActive: true, startDate: startFilter };
      if (guests && Number(guests) > 0) {
        batchQuery.$expr = {
          $gte: [
            { $subtract: ["$totalSeats", "$bookedSeats"] },
            Number(guests),
          ],
        };
      }
      const matchingBatches = await Batch.find(batchQuery).select("packageId");
      const batchPkgIds = matchingBatches.map((b) => b.packageId.toString());

      // Find packages with flexible availability covering the searched date(s)
      const flexQuery = { isActive: true };
      if (hasRange) {
        // Flex range overlaps with search range
        flexQuery.startDate = {
          $lte: dateTo ? toISTDayEnd(dateTo) : new Date(),
        };
        flexQuery.endDate = {
          $gte: dateFrom ? toISTDayStart(dateFrom) : new Date(),
        };
      } else {
        // Flex range covers the single date
        flexQuery.startDate = { $lte: toISTDayEnd(date) };
        flexQuery.endDate = { $gte: toISTDayStart(date) };
      }
      const matchingFlex =
        await FlexibleAvailability.find(flexQuery).select("packageId");
      const flexPkgIds = matchingFlex.map((f) => f.packageId.toString());

      // Union of both
      const allPkgIds = [...new Set([...batchPkgIds, ...flexPkgIds])];
      if (allPkgIds.length === 0) {
        return res.json({ success: true, total: 0, page: 1, packages: [] });
      }
      query._id = { $in: allPkgIds };
    }

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { location: { $regex: search, $options: "i" } },
        { city: { $regex: search, $options: "i" } },
        { state: { $regex: search, $options: "i" } },
        { country: { $regex: search, $options: "i" } },
        { departureCity: { $regex: search, $options: "i" } },
      ];
    }
    if (category) {
      query.$and = [
        ...(query.$and || []),
        {
          $or: [
            { category: { $regex: category, $options: "i" } },
            { categories: { $regex: category, $options: "i" } },
          ],
        },
      ];
    }
    if (badge) query.badge = badge;

    const skip = (Number(page) - 1) * Number(limit);

    // Nearby-first sort for Curated Packages:
    // Priority 3 = same state (closest), 2 = same country (rest of India), 1 = abroad
    if (userState || userCountry) {
      const uc = (userCountry || "India").trim();
      const us = (userState || "").trim();

      const packages = await Package.aggregate([
        { $match: query },
        {
          $addFields: {
            nearbyScore: {
              $cond: [
                // Same country AND same state → closest
                {
                  $and: [
                    { $eq: [{ $toLower: "$country" }, uc.toLowerCase()] },
                    us
                      ? { $eq: [{ $toLower: "$state" }, us.toLowerCase()] }
                      : { $literal: false },
                  ],
                },
                3,
                {
                  $cond: [
                    // Same country only
                    { $eq: [{ $toLower: "$country" }, uc.toLowerCase()] },
                    2,
                    1, // abroad
                  ],
                },
              ],
            },
            popularityScore: {
              $add: [
                { $multiply: [{ $ifNull: ["$bookingCount", 0] }, 2] },
                { $multiply: [{ $ifNull: ["$avgRating", 0] }, 10] },
                { $multiply: [{ $ifNull: ["$reviewCount", 0] }, 0.5] },
              ],
            },
          },
        },
        { $sort: { nearbyScore: -1, popularityScore: -1, createdAt: -1 } },
        { $skip: skip },
        { $limit: Number(limit) },
      ]);

      const total = await Package.countDocuments(query);
      const enriched = await enrichWithBatchPrice(packages);
      return res.json({
        success: true,
        total,
        page: Number(page),
        packages: enriched,
      });
    }

    // Default sort without location context
    const sortMap = {
      popular_score: { bookingCount: -1, avgRating: -1, reviewCount: -1 },
      rating_desc: { avgRating: -1, reviewCount: -1, bookingCount: -1 },
      newest: { createdAt: -1 },
    };
    const sort = sortMap[sortBy] || { createdAt: -1 };

    const [packages, total] = await Promise.all([
      Package.find(query).skip(skip).limit(Number(limit)).sort(sort),
      Package.countDocuments(query),
    ]);

    // Enrich packages with nearest upcoming batch price
    const enriched = await enrichWithBatchPrice(packages);
    res.json({ success: true, total, page: Number(page), packages: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/packages/popular  (public — ranked by booking count + rating)
// Logic: Popular = packages that have traction (bookings or good ratings).
// Qualifies if: bookingCount >= 1 OR (avgRating >= 4.0 AND reviewCount >= 1)
// Ranked by combined score. Max 10 results.
exports.getPopularPackages = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 10);

    const packages = await Package.aggregate([
      {
        $match: {
          isActive: true,
          status: "APPROVED",
          $or: [
            { bookingCount: { $gte: 1 } },
            { avgRating: { $gte: 4.0 }, reviewCount: { $gte: 1 } },
          ],
        },
      },
      {
        $addFields: {
          popularityScore: {
            $add: [
              { $multiply: [{ $ifNull: ["$bookingCount", 0] }, 3] },
              { $multiply: [{ $ifNull: ["$avgRating", 0] }, 10] },
              { $multiply: [{ $ifNull: ["$reviewCount", 0] }, 1] },
            ],
          },
        },
      },
      { $sort: { popularityScore: -1, createdAt: -1 } },
      { $limit: limit },
    ]);

    res.json({
      success: true,
      total: packages.length,
      packages: await enrichWithBatchPrice(packages),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/packages/:id  (public)
exports.getPackageById = async (req, res) => {
  try {
    const pkg = await Package.findById(req.params.id);
    if (!pkg)
      return res
        .status(404)
        .json({ success: false, message: "Package not found" });
    res.json({ success: true, package: pkg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Admin ─────────────────────────────────────────────────────────────────────

// GET /api/packages/admin/all  (admin — all packages regardless of status)
exports.adminGetAllPackages = async (req, res) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    const query = {};

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { location: { $regex: search, $options: "i" } },
      ];
    }
    if (status && status !== "all") query.status = status;

    const skip = (Number(page) - 1) * Number(limit);
    const [packages, total] = await Promise.all([
      Package.find(query)
        .populate("operatorId", "businessName contactName email")
        .skip(skip)
        .limit(Number(limit))
        .sort({ createdAt: -1 }),
      Package.countDocuments(query),
    ]);

    res.json({ success: true, total, page: Number(page), packages });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /api/packages/:id/review  (admin — approve, reject, or request revision)
exports.reviewPackage = async (req, res) => {
  try {
    const { action, adminNotes } = req.body;
    // action: 'approve' | 'reject' | 'needs_revision'

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

    const pkg = await Package.findByIdAndUpdate(req.params.id, update, {
      new: true,
    });
    if (!pkg)
      return res
        .status(404)
        .json({ success: false, message: "Package not found" });

    // Notify operator about package review result
    if (pkg.operatorId) {
      const { notifyOperator } = require("./notificationController");
      if (action === "approve") {
        notifyOperator(
          pkg.operatorId,
          "Package Approved! ✅",
          `Your package "${pkg.title}" has been approved and is now live.`,
          { type: "package_approved", packageId: pkg._id.toString() },
        );
      } else if (action === "reject") {
        notifyOperator(
          pkg.operatorId,
          "Package Rejected",
          `Your package "${pkg.title}" was rejected. ${adminNotes || "Please review and resubmit."}`,
          { type: "package_rejected", packageId: pkg._id.toString() },
        );
      } else if (action === "needs_revision") {
        notifyOperator(
          pkg.operatorId,
          "Package Needs Revision",
          `Your package "${pkg.title}" needs changes. ${adminNotes || "Check admin notes."}`,
          { type: "package_revision", packageId: pkg._id.toString() },
        );
      }
    }

    res.json({ success: true, package: pkg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/packages/:id  (admin)
exports.deletePackage = async (req, res) => {
  try {
    const pkg = await Package.findByIdAndDelete(req.params.id);
    if (!pkg)
      return res
        .status(404)
        .json({ success: false, message: "Package not found" });
    res.json({ success: true, message: "Package deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Operator ──────────────────────────────────────────────────────────────────

// Shared helper — normalizes and validates batch dates for both create and update
function normalizeBatches(batches) {
  if (!Array.isArray(batches)) return [];
  return batches
    .filter((b) => b.startDate && b.endDate)
    .map((b) => {
      const toDate = (v) => {
        if (!v) return undefined;
        const d = new Date(v);
        return isNaN(d) ? undefined : d;
      };
      const start = toDate(b.startDate);
      const end = toDate(b.endDate);
      let deadline = toDate(b.bookingDeadline);
      // Enforce: booking deadline must not be after start date
      if (deadline && start && deadline > start) deadline = start;
      return {
        ...(b._id ? { _id: b._id } : {}),
        startDate: start,
        endDate: end,
        availableSeats: Math.max(0, Number(b.availableSeats) || 0),
        bookedSeats: Math.max(0, Number(b.bookedSeats) || 0),
        bookingDeadline: deadline,
        label: (b.label || "").trim(),
      };
    });
}

// GET /api/packages/operator/mine  (operator — their own packages)
exports.operatorGetMyPackages = async (req, res) => {
  try {
    const packages = await Package.find({ operatorId: req.operator._id }).sort({
      createdAt: -1,
    });
    res.json({ success: true, packages });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/packages/operator  (operator — create package, starts as PENDING)
exports.operatorCreatePackage = async (req, res) => {
  try {
    const body = { ...req.body };

    // slot-0 → image_url (cover), slots 1-3 → images (gallery)
    if (req.files) {
      if (req.files["image_url"]?.[0]) {
        body.image_url = "/uploads/" + req.files["image_url"][0].filename;
      } else if (body.existing_image_url) {
        body.image_url = body.existing_image_url;
      }
      if (req.files["images"]?.length) {
        const newUrls = req.files["images"].map(
          (f) => "/uploads/" + f.filename,
        );
        const existingUrls = body.existing_images
          ? (Array.isArray(body.existing_images)
              ? body.existing_images
              : [body.existing_images]
            ).filter(Boolean)
          : [];
        body.images = [...existingUrls, ...newUrls];
      } else if (body.existing_images) {
        body.images = Array.isArray(body.existing_images)
          ? body.existing_images.filter(Boolean)
          : [body.existing_images].filter(Boolean);
      }
    }
    delete body.existing_image_url;
    delete body.existing_images;

    const parseJSON = (val, fallback) => {
      if (typeof val !== "string") return val;
      try {
        return JSON.parse(val);
      } catch {
        return fallback;
      }
    };

    [
      "highlights",
      "inclusions",
      "exclusions",
      "itinerary",
      "addons",
      "categories",
      "videos",
    ].forEach((key) => {
      if (typeof body[key] === "string") body[key] = parseJSON(body[key], []);
    });
    [
      "hotelDetails",
      "transportDetails",
      "pricing",
      "availability",
      "policies",
      "offer",
    ].forEach((key) => {
      if (typeof body[key] === "string") body[key] = parseJSON(body[key], {});
    });

    const normalizeDate = (val) => {
      if (!val) return undefined;
      const d = new Date(val);
      return Number.isNaN(d.getTime()) ? undefined : d;
    };
    if (body.availability) {
      body.availability.startDate = normalizeDate(body.availability.startDate);
      body.availability.endDate = normalizeDate(body.availability.endDate);
      body.availability.bookingDeadline = normalizeDate(
        body.availability.bookingDeadline,
      );
    }

    // Normalize batches array
    if (typeof body.batches === "string") {
      try {
        body.batches = JSON.parse(body.batches);
      } catch {
        body.batches = [];
      }
    }
    body.batches = normalizeBatches(body.batches);

    const submissionMode = (body.submissionMode || "SUBMIT")
      .toString()
      .toUpperCase();
    delete body.submissionMode;

    const status = submissionMode === "DRAFT" ? "DRAFT" : "PENDING";

    const pkg = await Package.create({
      ...body,
      operatorId: req.operator._id,
      status,
      isActive: false,
    });
    res.status(201).json({ success: true, package: pkg });

    // Notify admin: new package for review
    const { notifyAdmin } = require("./notificationController");
    notifyAdmin(
      "Package Submitted for Review",
      `Operator submitted "${pkg.title}" for approval.`,
      { type: "general", packageId: pkg._id.toString() },
    );
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// PUT /api/packages/operator/:id  (operator — edit their own package, resets to PENDING)
exports.operatorUpdatePackage = async (req, res) => {
  try {
    const pkg = await Package.findOne({
      _id: req.params.id,
      operatorId: req.operator._id,
    });
    if (!pkg)
      return res
        .status(404)
        .json({ success: false, message: "Package not found or not yours" });

    if (pkg.status === "APPROVED") {
      // Allow editing approved packages — content updates immediately,
      // status resets to PENDING for admin re-review.
      // Package stays isActive=true so it remains visible in the app during review.
      // If admin rejects, they'll request revision and operator can fix.
    }

    const body = { ...req.body };

    // slot-0 → image_url (cover), slots 1-3 → images (gallery)
    if (req.files) {
      if (req.files["image_url"]?.[0]) {
        body.image_url = "/uploads/" + req.files["image_url"][0].filename;
      } else if (body.existing_image_url) {
        body.image_url = body.existing_image_url;
      }
      if (req.files["images"]?.length) {
        const newUrls = req.files["images"].map(
          (f) => "/uploads/" + f.filename,
        );
        const existingUrls = body.existing_images
          ? (Array.isArray(body.existing_images)
              ? body.existing_images
              : [body.existing_images]
            ).filter(Boolean)
          : [];
        body.images = [...existingUrls, ...newUrls];
      } else if (body.existing_images) {
        body.images = Array.isArray(body.existing_images)
          ? body.existing_images.filter(Boolean)
          : [body.existing_images].filter(Boolean);
      }
    }
    delete body.existing_image_url;
    delete body.existing_images;

    const parseJSON = (val, fallback) => {
      if (typeof val !== "string") return val;
      try {
        return JSON.parse(val);
      } catch {
        return fallback;
      }
    };

    [
      "highlights",
      "inclusions",
      "exclusions",
      "itinerary",
      "addons",
      "categories",
      "videos",
    ].forEach((key) => {
      if (typeof body[key] === "string") body[key] = parseJSON(body[key], []);
    });
    [
      "hotelDetails",
      "transportDetails",
      "pricing",
      "availability",
      "policies",
      "offer",
    ].forEach((key) => {
      if (typeof body[key] === "string") body[key] = parseJSON(body[key], {});
    });

    const normalizeDate = (val) => {
      if (!val) return undefined;
      const d = new Date(val);
      return Number.isNaN(d.getTime()) ? undefined : d;
    };
    if (body.availability) {
      body.availability.startDate = normalizeDate(body.availability.startDate);
      body.availability.endDate = normalizeDate(body.availability.endDate);
      body.availability.bookingDeadline = normalizeDate(
        body.availability.bookingDeadline,
      );
    }

    // Normalize batches array
    if (typeof body.batches === "string") {
      try {
        body.batches = JSON.parse(body.batches);
      } catch {
        body.batches = [];
      }
    }
    body.batches = normalizeBatches(body.batches);

    const submissionMode = (body.submissionMode || "SUBMIT")
      .toString()
      .toUpperCase();
    delete body.submissionMode;

    const nextStatus = submissionMode === "DRAFT" ? "DRAFT" : "PENDING";
    const resetNotes = nextStatus === "PENDING";

    // If package was previously APPROVED, keep its current isActive state
    // (respect operator's disable choice). Otherwise hide it until approved.
    const wasApproved = pkg.status === "APPROVED";

    const updated = await Package.findByIdAndUpdate(
      req.params.id,
      {
        ...body,
        status: nextStatus,
        adminNotes: resetNotes ? "" : pkg.adminNotes,
        isActive: wasApproved ? pkg.isActive : false,
      },
      { new: true, runValidators: true },
    );
    res.json({ success: true, package: updated });

    // Notify admin if package was re-submitted for review
    if (nextStatus === "PENDING") {
      const { notifyAdmin } = require("./notificationController");
      const label = wasApproved
        ? "Package Re-submitted for Review"
        : "Package Submitted for Review";
      notifyAdmin(
        label,
        `"${updated.title}" ${wasApproved ? "(was approved, edited)" : ""} needs admin review.`,
        { type: "general", packageId: updated._id.toString() },
      );
    }
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// DELETE /api/packages/operator/:id  (operator — delete their own package)
exports.operatorDeletePackage = async (req, res) => {
  try {
    const pkg = await Package.findOneAndDelete({
      _id: req.params.id,
      operatorId: req.operator._id,
    });
    if (!pkg)
      return res
        .status(404)
        .json({ success: false, message: "Package not found or not yours" });
    res.json({ success: true, message: "Package deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /api/packages/operator/:id/toggle-active — operator disable/enable their package
// Cannot disable if there are active bookings on upcoming batches or active flex ranges
exports.operatorToggleActive = async (req, res) => {
  try {
    const pkg = await Package.findOne({
      _id: req.params.id,
      operatorId: req.operator._id,
    });
    if (!pkg)
      return res
        .status(404)
        .json({ success: false, message: "Package not found or not yours" });

    // If trying to disable, check for active bookings
    if (pkg.isActive) {
      const now = new Date();
      const TripBooking = require("../models/TripBooking");

      // Check for confirmed bookings on upcoming/ongoing batches or flex dates
      const activeBookings = await TripBooking.countDocuments({
        packageId: pkg._id,
        status: { $in: ["CONFIRMED", "PENDING"] },
        tripEndDate: { $gte: now },
      });

      if (activeBookings > 0) {
        return res.status(400).json({
          success: false,
          message: `Cannot disable — ${activeBookings} active booking${activeBookings > 1 ? "s" : ""} exist for upcoming trips. Wait until all trips are completed or cancel them first.`,
        });
      }
    }

    pkg.isActive = !pkg.isActive;
    await pkg.save();
    res.json({
      success: true,
      message: pkg.isActive
        ? "Package is now active and visible to users"
        : "Package disabled — hidden from users",
      package: pkg,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /api/packages/admin/:id/suspend — toggle isActive
exports.adminTogglePackageSuspend = async (req, res) => {
  try {
    const pkg = await Package.findById(req.params.id);
    if (!pkg)
      return res
        .status(404)
        .json({ success: false, message: "Package not found" });
    pkg.isActive = !pkg.isActive;
    await pkg.save();
    res.json({
      success: true,
      message: pkg.isActive ? "Package activated" : "Package suspended",
      package: pkg,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/packages/operator/:id/reviews — get all reviews for an operator's packages
exports.operatorGetReviews = async (req, res) => {
  try {
    const Review = require("../models/Review");
    const operatorPackages = await Package.find({
      operatorId: req.operator._id,
    }).select("_id title");
    const packageIds = operatorPackages.map((p) => p._id);
    const reviews = await Review.find({ packageId: { $in: packageIds } })
      .populate("userId", "name avatar")
      .populate("packageId", "title")
      .sort({ createdAt: -1 });
    res.json({ success: true, total: reviews.length, reviews });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
