const Package = require("../models/Package");
const Batch = require("../models/Batch");
const TripBooking = require("../models/TripBooking");
const { getPagination, paginationMeta } = require("../utils/pagination");
const {
  normalizeView,
  packageLifecycle,
  applyLifecycleView,
  isHistory,
} = require("../utils/lifecycle");
const { pendingReferenceQuery } = require("../utils/resourceIntegrity");
const { getISTDateKey, getISTDayRange } = require("../utils/businessDate");
const {
  validateSubmittedItinerary,
} = require("../utils/packageItineraryValidation");

// Count live bookings whose effective trip end is today or later. Batch dates
// remain authoritative; flexible/snapshotted dates cover flexible and legacy
// bookings without a populated batch reference.
function activeBookingEndCutoff(now = new Date()) {
  return getISTDayRange(getISTDateKey(now)).start;
}

async function countFutureOrOngoingLiveBookings(packageId, now = new Date()) {
  const activeEndCutoff = activeBookingEndCutoff(now);
  const result = await TripBooking.aggregate([
    {
      $match: {
        packageId,
        status: { $in: ["CONFIRMED", "PENDING"] },
      },
    },
    {
      $lookup: {
        from: Batch.collection.name,
        localField: "batchId",
        foreignField: "_id",
        as: "effectiveBatch",
      },
    },
    {
      $set: {
        effectiveEndDate: {
          $ifNull: [
            { $arrayElemAt: ["$effectiveBatch.endDate", 0] },
            { $ifNull: ["$flexEndDate", "$snapshot.endDate"] },
          ],
        },
      },
    },
    { $match: { effectiveEndDate: { $gte: activeEndCutoff } } },
    { $count: "count" },
  ]);

  return result[0]?.count || 0;
}
exports.activeBookingEndCutoff = activeBookingEndCutoff;

async function hasInFlightPackageOrder(packageId) {
  const PendingOrder = require("../models/PendingOrder");
  return PendingOrder.exists({
    $or: [
      { ...pendingReferenceQuery("packageId", packageId) },
      {
        packageId,
        status: "pending",
        finalizationState: {
          $in: require("../utils/resourceIntegrity").IN_FLIGHT_STATES,
        },
      },
    ],
  });
}

async function assertBookingModeChangeAllowed(pkg, nextMode) {
  if (!nextMode || nextMode === pkg.bookingMode) return;
  const [bookingHistory, pendingOrder] = await Promise.all([
    TripBooking.exists({ packageId: pkg._id }),
    hasInFlightPackageOrder(pkg._id),
  ]);
  if (bookingHistory || pendingOrder) {
    const error = new Error(
      "Booking mode cannot change after booking history or an in-flight payment order exists.",
    );
    error.statusCode = 409;
    throw error;
  }

  const FlexibleAvailability = require("../models/FlexibleAvailability");
  const Coupon = require("../models/Coupon");
  const incompatible =
    nextMode === "flexible"
      ? await Promise.all([
          Batch.exists({
            packageId: pkg._id,
            isActive: { $ne: false },
            isArchived: { $ne: true },
          }),
          Coupon.exists({
            packageId: pkg._id,
            batchId: { $ne: null },
            isActive: { $ne: false },
            isArchived: { $ne: true },
          }),
        ])
      : await Promise.all([
          FlexibleAvailability.exists({
            packageId: pkg._id,
            isActive: { $ne: false },
            isArchived: { $ne: true },
          }),
          Coupon.exists({
            packageId: pkg._id,
            batchId: null,
            isActive: { $ne: false },
            isArchived: { $ne: true },
          }),
        ]);
  if (incompatible.some(Boolean)) {
    const error = new Error(
      "Deactivate or remove incompatible active inventory and coupons before changing booking mode.",
    );
    error.statusCode = 409;
    throw error;
  }
}

async function deleteOrArchivePackage(
  pkg,
  { actorId = "", actorType = "system", reason = "" } = {},
) {
  const PendingOrder = require("../models/PendingOrder");
  const Review = require("../models/Review");
  const Trip = require("../models/Trip");
  const TripGroup = require("../models/TripGroup");
  const Coupon = require("../models/Coupon");
  const FlexibleAvailability = require("../models/FlexibleAvailability");
  const FlexibleDateInventory = require("../models/FlexibleDateInventory");
  const BookingIntent = require("../models/BookingIntent");

  const [liveBookings, inFlightOrder] = await Promise.all([
    TripBooking.countDocuments({
      packageId: pkg._id,
      status: { $in: ["CONFIRMED", "PENDING"] },
    }),
    hasInFlightPackageOrder(pkg._id),
  ]);
  if (liveBookings > 0 || inFlightOrder) {
    const error = new Error(
      liveBookings > 0
        ? `Cannot delete — ${liveBookings} active booking${liveBookings === 1 ? "" : "s"} reference this package.`
        : "Cannot delete while a payment order for this package is still in flight.",
    );
    error.statusCode = 409;
    throw error;
  }

  const [bookingRef, reviewRef, tripRef, groupRef, usedCouponRef] =
    await Promise.all([
      TripBooking.exists({ packageId: pkg._id }),
      Review.exists({ packageId: pkg._id }),
      Trip.exists({ package: pkg._id }),
      TripGroup.exists({ packageId: pkg._id }),
      Coupon.exists({
        packageId: pkg._id,
        $or: [
          { everUsedCount: { $gt: 0 } },
          { usedCount: { $gt: 0 } },
          { usageClaimKeys: { $exists: true, $ne: [] } },
        ],
      }),
    ]);
  const hasHistory = [
    bookingRef,
    reviewRef,
    tripRef,
    groupRef,
    usedCouponRef,
  ].some(Boolean);
  if (hasHistory) {
    const now = new Date();
    const archive = {
      isActive: false,
      isArchived: true,
      archivedAt: now,
      archivedBy: String(actorId || ""),
      archivedByType: actorType,
      archivedReason: String(reason || "Historical references preserved").slice(
        0,
        500,
      ),
    };
    pkg.isActive = false;
    pkg.status = "ARCHIVED";
    pkg.archivedAt = now;
    pkg.archivedBy = archive.archivedBy;
    pkg.archivedByType = actorType;
    pkg.archivedReason = archive.archivedReason;
    await Promise.all([
      pkg.save(),
      Batch.updateMany(
        { packageId: pkg._id, isArchived: { $ne: true } },
        { $set: archive },
      ),
      FlexibleAvailability.updateMany(
        { packageId: pkg._id, isArchived: { $ne: true } },
        { $set: archive },
      ),
      Coupon.updateMany(
        { packageId: pkg._id, isArchived: { $ne: true } },
        { $set: archive },
      ),
    ]);
    return { archived: true };
  }

  const flexIds = await FlexibleAvailability.find({
    packageId: pkg._id,
  }).distinct("_id");
  await Promise.all([
    Batch.deleteMany({ packageId: pkg._id }),
    Coupon.deleteMany({ packageId: pkg._id }),
    FlexibleAvailability.deleteMany({ packageId: pkg._id }),
    FlexibleDateInventory.deleteMany({
      $or: [{ packageId: pkg._id }, { flexAvailabilityId: { $in: flexIds } }],
    }),
    BookingIntent.deleteMany({ packageId: pkg._id }),
    PendingOrder.deleteMany({
      status: { $in: ["expired"] },
      $or: [
        { packageId: pkg._id },
        { "payload.packageId": { $in: [pkg._id, String(pkg._id)] } },
      ],
    }),
  ]);
  await pkg.deleteOne();
  return { archived: false };
}

// Helper: Attach nearest upcoming batch price to each package
async function enrichWithBatchPrice(packages) {
  if (!packages || packages.length === 0) return packages;

  const now = new Date();
  const dayStart = getISTDayRange(getISTDateKey(now)).start;
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
        endDate: { $gte: dayStart },
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
        flexMaxBookings: { $first: "$maxBookings" },
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
      capacityMode: "per_start_date",
      maxBookingsPerStartDate: f.flexMaxBookings || 0,
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
      obj.capacityMode = flexMap[id].capacityMode;
      obj.maxBookingsPerStartDate = flexMap[id].maxBookingsPerStartDate;
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

      const toISTDayStart = (value) => getISTDayRange(value)?.start;
      const toISTDayEnd = (value) => getISTDayRange(value)?.endExclusive;
      if (
        [date, dateFrom, dateTo].some(
          (value) => value && !getISTDayRange(value),
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "date, dateFrom and dateTo must use valid YYYY-MM-DD business dates",
        });
      }

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
      const escapeRegex = require("../utils/escapeRegex");
      const safe = escapeRegex(String(search));
      query.$or = [
        { title: { $regex: safe, $options: "i" } },
        { location: { $regex: safe, $options: "i" } },
        { city: { $regex: safe, $options: "i" } },
        { state: { $regex: safe, $options: "i" } },
        { country: { $regex: safe, $options: "i" } },
        { departureCity: { $regex: safe, $options: "i" } },
      ];
    }
    if (category) {
      const escapeRegex = require("../utils/escapeRegex");
      const safeCat = escapeRegex(String(category));
      query.$and = [
        ...(query.$and || []),
        {
          $or: [
            { category: { $regex: safeCat, $options: "i" } },
            { categories: { $regex: safeCat, $options: "i" } },
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
        { $project: { pendingRevision: 0 } },
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
      Package.find(query)
        .select("-pendingRevision")
        .skip(skip)
        .limit(Number(limit))
        .sort(sort),
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
    const now = new Date();

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
      // Check if the package has at least one upcoming batch with seats
      {
        $lookup: {
          from: "batches",
          let: { pid: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$packageId", "$$pid"] },
                    { $eq: ["$isActive", true] },
                    { $gt: ["$startDate", now] },
                    { $lt: ["$bookedSeats", "$totalSeats"] },
                  ],
                },
              },
            },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: "_futureBatches",
        },
      },
      // Check if the package has at least one active flexible availability
      {
        $lookup: {
          from: "flexibleavailabilities",
          let: { pid: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$packageId", "$$pid"] },
                    { $eq: ["$isActive", true] },
                    { $gte: ["$endDate", now] },
                  ],
                },
              },
            },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: "_flexAvail",
        },
      },
      {
        $addFields: {
          // true if the package currently has bookable dates
          hasAvailability: {
            $gt: [
              {
                $add: [{ $size: "$_futureBatches" }, { $size: "$_flexAvail" }],
              },
              0,
            ],
          },
          popularityScore: {
            $add: [
              { $multiply: [{ $ifNull: ["$bookingCount", 0] }, 3] },
              { $multiply: [{ $ifNull: ["$avgRating", 0] }, 10] },
              { $multiply: [{ $ifNull: ["$reviewCount", 0] }, 1] },
            ],
          },
        },
      },
      // Packages with no bookable dates at all are excluded — bad UX to show them
      {
        $match: {
          hasAvailability: true,
        },
      },
      // Sort by popularity score, then newest
      { $sort: { popularityScore: -1, createdAt: -1 } },
      { $limit: limit },
      // Clean up lookup fields
      { $project: { _futureBatches: 0, _flexAvail: 0, pendingRevision: 0 } },
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

// GET /api/packages/:id  (public — approved, active canonical content only)
exports.getPackageById = async (req, res) => {
  try {
    const pkg = await Package.findOne({
      _id: req.params.id,
      status: "APPROVED",
      isActive: true,
    }).select("-pendingRevision");
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

// Explicit allowlist used for pending revisions and approval. Unknown request
// keys and platform-managed fields must never be persisted inside Mixed data.
const OPERATOR_EDITABLE_PACKAGE_FIELDS = [
  "title",
  "location",
  "country",
  "state",
  "city",
  "tourType",
  "destination",
  "departureCity",
  "bookingMode",
  "durationDays",
  "durationNights",
  "duration",
  "category",
  "aboutThisTrip",
  "about",
  "price",
  "priceLabel",
  "badge",
  "highlights",
  "itinerary",
  "inclusions",
  "exclusions",
  "addons",
  "outsideCityCharge",
  "videos",
  "hotelDetails",
  "transportDetails",
  "pricing",
  "availability",
  "policies",
  "offer",
  "image_url",
  "images",
];

function pickOperatorEditableFields(source) {
  const picked = {};
  OPERATOR_EDITABLE_PACKAGE_FIELDS.forEach((field) => {
    if (source[field] !== undefined) picked[field] = source[field];
  });
  return picked;
}

function toAdminReviewView(pkg) {
  const live = pkg?.toObject ? pkg.toObject() : { ...pkg };
  const revision = live.pendingRevision;
  if (!revision?.data) return live;

  return {
    ...live,
    ...revision.data,
    _id: live._id,
    operatorId: live.operatorId,
    isActive: live.isActive,
    liveStatus: live.status,
    status: revision.status,
    revisionStatus: revision.status,
    adminNotes: revision.adminNotes || "",
    pendingRevision: revision,
  };
}

// GET /api/packages/admin/all  (admin — all packages and pending revisions)
exports.adminGetAllPackages = async (req, res) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    const clauses = [];

    if (search) {
      const escapeRegex = require("../utils/escapeRegex");
      const safe = escapeRegex(String(search));
      clauses.push({
        $or: [
          { title: { $regex: safe, $options: "i" } },
          { location: { $regex: safe, $options: "i" } },
          { "pendingRevision.data.title": { $regex: safe, $options: "i" } },
          {
            "pendingRevision.data.location": {
              $regex: safe,
              $options: "i",
            },
          },
        ],
      });
    }
    if (status && status !== "all") {
      clauses.push({
        $or: [
          { "pendingRevision.status": status },
          {
            $and: [
              { "pendingRevision.status": { $exists: false } },
              { status },
            ],
          },
        ],
      });
    }

    const query = clauses.length > 0 ? { $and: clauses } : {};
    const skip = (Number(page) - 1) * Number(limit);
    const [packageDocs, total] = await Promise.all([
      Package.find(query)
        .populate("operatorId", "businessName contactName email")
        .skip(skip)
        .limit(Number(limit))
        .sort({ createdAt: -1 }),
      Package.countDocuments(query),
    ]);

    res.json({
      success: true,
      total,
      page: Number(page),
      packages: packageDocs.map(toAdminReviewView),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/packages/admin/:id (admin — canonical data plus review candidate)
exports.adminGetPackageById = async (req, res) => {
  try {
    const pkg = await Package.findById(req.params.id).populate(
      "operatorId",
      "businessName contactName email",
    );
    if (!pkg) {
      return res
        .status(404)
        .json({ success: false, message: "Package not found" });
    }
    res.json({ success: true, package: toAdminReviewView(pkg) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /api/packages/:id/review  (admin — approve, reject, or request revision)
exports.reviewPackage = async (req, res) => {
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
    if (
      (action === "reject" || action === "needs_revision") &&
      !(adminNotes || "").trim()
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Please add a note explaining what needs to change before rejecting or requesting a revision.",
      });
    }

    const pkg = await Package.findById(req.params.id);
    if (!pkg) {
      return res
        .status(404)
        .json({ success: false, message: "Package not found" });
    }
    if (pkg.status === "ARCHIVED") {
      return res.status(409).json({
        success: false,
        message:
          "Archived packages cannot re-enter review without a dedicated restore workflow.",
      });
    }

    const revision = pkg.pendingRevision;
    const isApprovedRevision =
      pkg.status === "APPROVED" && Boolean(revision?.data);
    if (isApprovedRevision && revision.status === "DRAFT") {
      return res.status(400).json({
        success: false,
        message: "This revision is still a draft and has not been submitted.",
      });
    }

    const notificationTitle =
      (isApprovedRevision && revision.data?.title) || pkg.title;

    if (isApprovedRevision) {
      if (action === "approve") {
        const approvedData = pickOperatorEditableFields(revision.data);
        validateSubmittedItinerary(approvedData.itinerary);
        await assertBookingModeChangeAllowed(pkg, approvedData.bookingMode);
        Object.entries(approvedData).forEach(([field, value]) => {
          pkg.set(field, value);
        });
        pkg.pendingRevision = undefined;
        pkg.adminNotes = "";
        // Keep the existing live APPROVED/isActive state and stable package ID.
        await pkg.save();
      } else {
        pkg.pendingRevision.status = statusMap[action];
        pkg.pendingRevision.adminNotes = (adminNotes || "").trim();
        pkg.pendingRevision.updatedAt = new Date();
        pkg.markModified("pendingRevision");
        await pkg.save({ validateModifiedOnly: true });
      }
    } else {
      if (action === "approve") {
        if (pkg.status !== "PENDING") {
          return res.status(409).json({
            success: false,
            message: "Only a submitted package can be approved.",
          });
        }
        validateSubmittedItinerary(pkg.itinerary);
      }
      pkg.status = statusMap[action];
      pkg.adminNotes = (adminNotes || "").trim();
      pkg.isActive = action === "approve";
      await pkg.save();
    }

    // Notify operator about package review result
    if (pkg.operatorId) {
      const { notifyOperator } = require("./notificationController");
      if (action === "approve") {
        notifyOperator(
          pkg.operatorId,
          "Package Approved! ✅",
          `Your package "${notificationTitle}" has been approved and is now live.`,
          { type: "package_approved", packageId: pkg._id.toString() },
        );
      } else if (action === "reject") {
        notifyOperator(
          pkg.operatorId,
          "Package Rejected",
          `Your package "${notificationTitle}" was rejected. ${adminNotes || "Please review and resubmit."}`,
          { type: "package_rejected", packageId: pkg._id.toString() },
        );
      } else {
        notifyOperator(
          pkg.operatorId,
          "Package Needs Revision",
          `Your package "${notificationTitle}" needs changes. ${adminNotes || "Check admin notes."}`,
          { type: "package_revision", packageId: pkg._id.toString() },
        );
      }
    }

    res.json({ success: true, package: toAdminReviewView(pkg) });
  } catch (err) {
    const status =
      err.statusCode || (err.name === "ValidationError" ? 400 : 500);
    res.status(status).json({ success: false, message: err.message });
  }
};

// DELETE /api/packages/:id  (admin)
exports.deletePackage = async (req, res) => {
  try {
    const pkg = await Package.findById(req.params.id);
    if (!pkg) {
      return res
        .status(404)
        .json({ success: false, message: "Package not found" });
    }
    const result = await deleteOrArchivePackage(pkg, {
      actorId: req.user?._id,
      actorType: "admin",
      reason: req.body?.reason || req.body?.archivedReason,
    });
    return res.json({
      success: true,
      archived: result.archived,
      message: result.archived
        ? "Package has durable history and was archived with its active inventory and coupons."
        : "Package and disposable dependents deleted successfully",
    });
  } catch (err) {
    res
      .status(err.statusCode || 500)
      .json({ success: false, message: err.message });
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
    const { page, limit, skip } = getPagination(req.query, 20);
    const view = normalizeView(req.query);
    const query = { operatorId: req.operator._id };
    if (req.query.packageId) {
      const mongoose = require("mongoose");
      if (!mongoose.isValidObjectId(req.query.packageId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid packageId",
        });
      }
      query._id = req.query.packageId;
    }
    if (req.query.search) {
      const escapeRegex = require("../utils/escapeRegex");
      const safe = escapeRegex(String(req.query.search));
      query.$or = [
        { title: { $regex: safe, $options: "i" } },
        { location: { $regex: safe, $options: "i" } },
        { city: { $regex: safe, $options: "i" } },
        { destination: { $regex: safe, $options: "i" } },
        { "pendingRevision.data.title": { $regex: safe, $options: "i" } },
        { "pendingRevision.data.location": { $regex: safe, $options: "i" } },
        { "pendingRevision.data.city": { $regex: safe, $options: "i" } },
        {
          "pendingRevision.data.destination": {
            $regex: safe,
            $options: "i",
          },
        },
      ];
    }
    const all = await Package.find(query).sort({ createdAt: -1, _id: -1 });
    const classified = applyLifecycleView(
      all,
      "package",
      packageLifecycle,
      view,
    );
    const packages = classified.items.slice(skip, skip + limit);
    res.json({
      success: true,
      packages,
      count: packages.length,
      ...paginationMeta(classified.items.length, page, limit),
      currentTotal: classified.currentTotal,
      historyTotal: classified.historyTotal,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/packages/operator  (operator — create package, starts as PENDING)
// ─────────────────────────────────────────────────────────────────────────────
// Fields on Package that only the platform may set. An operator submitting the
// create/update form used to have its whole body spread into Mongo, so it could
// self-promote (isFeatured/isTrending), fake its social proof (bookingCount,
// avgRating, reviewCount, rating), approve itself (status/isActive), or hand the
// package to another account (operatorId).
// ─────────────────────────────────────────────────────────────────────────────
const OPERATOR_FORBIDDEN_PACKAGE_FIELDS = [
  "_id",
  "id",
  "operatorId",
  "status",
  "isActive",
  "isFeatured",
  "isTrending",
  "rating",
  "avgRating",
  "reviewCount",
  "bookingCount",
  "adminNotes",
  "pendingRevision",
  "sampleMedia",
  "approvedCategory",
  "reviews",
  "createdAt",
  "updatedAt",
  "__v",
];

function stripPlatformFields(body) {
  OPERATOR_FORBIDDEN_PACKAGE_FIELDS.forEach((f) => delete body[f]);
  return body;
}

// Client-supplied image paths ("existing_images" / "existing_image_url") are used
// to keep already-uploaded files across an edit. They were trusted verbatim, so
// arbitrary strings or external URLs could be written into image fields. Only
// accept paths that look like our own uploads, and enforce the gallery cap that
// multer applies to fresh uploads.
const MAX_GALLERY_IMAGES = 4;

function sanitizeExistingImagePaths(value) {
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((p) => typeof p === "string")
    .map((p) => p.trim())
    .filter(
      (p) =>
        p.startsWith("/uploads/") &&
        !p.includes("..") &&
        !p.includes("\\") &&
        !/\s/.test(p),
    );
}

// Resolve cover image + gallery from freshly uploaded files plus any retained
// existing paths. Shared by create and update (was duplicated in both).
function applyImageFields(body, files) {
  const cover = files?.["image_url"]?.[0];
  if (cover) {
    body.image_url = "/uploads/" + cover.filename;
  } else if (body.existing_image_url) {
    body.image_url = sanitizeExistingImagePaths(body.existing_image_url)[0];
    if (!body.image_url) delete body.image_url;
  }

  const newUrls = (files?.["images"] || []).map(
    (f) => "/uploads/" + f.filename,
  );
  const keptUrls = body.existing_images
    ? sanitizeExistingImagePaths(body.existing_images)
    : [];

  if (newUrls.length > 0 || keptUrls.length > 0) {
    body.images = [...keptUrls, ...newUrls].slice(0, MAX_GALLERY_IMAGES);
  }

  delete body.existing_image_url;
  delete body.existing_images;
  return body;
}

exports.operatorCreatePackage = async (req, res) => {
  try {
    const body = stripPlatformFields({ ...req.body });

    // Prevent duplicate titles for the same operator
    if (body.title?.trim()) {
      const existingTitle = await Package.findOne({
        operatorId: req.operator._id,
        title: {
          $regex: `^${body.title.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          $options: "i",
        },
      });
      if (existingTitle) {
        return res.status(400).json({
          success: false,
          message: `You already have a package titled "${body.title.trim()}". Please use a different title.`,
        });
      }
    }

    // slot-0 → image_url (cover), slots 1-3 → images (gallery)
    applyImageFields(body, req.files);

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
    if (status !== "DRAFT") validateSubmittedItinerary(body.itinerary);

    // Drafts are partial — skip Mongoose schema validators for them.
    // Submitted packages get full validation.
    let pkg;
    if (status === "DRAFT") {
      pkg = new Package({
        ...body,
        operatorId: req.operator._id,
        status,
        isActive: false,
      });
      await pkg.save({ validateBeforeSave: false });
    } else {
      pkg = await Package.create({
        ...body,
        operatorId: req.operator._id,
        status,
        isActive: false,
      });
    }
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
    const lifecycle = packageLifecycle(pkg);
    if (isHistory("package", lifecycle)) {
      return res.status(409).json({
        success: false,
        message: `This package is in History (${lifecycle}) and is read-only. It cannot be changed.`,
      });
    }

    const body = stripPlatformFields({ ...req.body });
    await assertBookingModeChangeAllowed(pkg, body.bookingMode);

    // slot-0 → image_url (cover), slots 1-3 → images (gallery)
    applyImageFields(body, req.files);

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
    const wasApproved = pkg.status === "APPROVED";

    // Auto-sync the legacy `duration` text field from numeric days/nights
    if (body.durationDays != null) {
      const days = Number(body.durationDays) || 0;
      const nights = Number(body.durationNights) || Math.max(0, days - 1);
      body.duration =
        days === 1
          ? "1 Day"
          : `${days} Days / ${nights} Night${nights !== 1 ? "s" : ""}`;
    }

    let updated;
    let reviewTitle;
    if (wasApproved) {
      // Build a fully cast candidate from the live package, any existing
      // revision, and this request. Nothing is copied back to canonical fields
      // until an administrator approves it.
      const candidate = new Package({
        ...pkg.toObject(),
        ...(pkg.pendingRevision?.data || {}),
        ...pickOperatorEditableFields(body),
        _id: pkg._id,
        operatorId: pkg.operatorId,
        status: "APPROVED",
        isActive: pkg.isActive,
        pendingRevision: undefined,
      });
      if (nextStatus === "PENDING") {
        validateSubmittedItinerary(candidate.itinerary);
        await candidate.validate();
      }

      const candidateData = pickOperatorEditableFields(candidate.toObject());
      pkg.pendingRevision = {
        status: nextStatus,
        data: candidateData,
        adminNotes:
          nextStatus === "PENDING" ? "" : pkg.pendingRevision?.adminNotes || "",
        submittedAt:
          nextStatus === "PENDING"
            ? new Date()
            : pkg.pendingRevision?.submittedAt,
        updatedAt: new Date(),
      };
      pkg.markModified("pendingRevision");
      await pkg.save({ validateModifiedOnly: true });
      updated = pkg;
      reviewTitle = candidateData.title || pkg.title;
    } else {
      if (nextStatus === "PENDING") {
        const candidate = new Package({
          ...pkg.toObject(),
          ...pickOperatorEditableFields(body),
          _id: pkg._id,
          operatorId: pkg.operatorId,
          status: nextStatus,
          isActive: false,
        });
        validateSubmittedItinerary(candidate.itinerary);
        await candidate.validate();
      }
      updated = await Package.findByIdAndUpdate(
        req.params.id,
        {
          ...pickOperatorEditableFields(body),
          // Re-pin ownership and all platform-controlled fields so they can
          // never be moved by the request body.
          operatorId: pkg.operatorId,
          status: nextStatus,
          adminNotes: resetNotes ? "" : pkg.adminNotes,
          isActive: false,
        },
        // Drafts can be partial, so only enforce full validation on submit.
        { new: true, runValidators: nextStatus !== "DRAFT" },
      );
      reviewTitle = updated.title;
    }

    res.json({ success: true, package: updated });

    // Notify admin if package was submitted or re-submitted for review.
    if (nextStatus === "PENDING") {
      const { notifyAdmin } = require("./notificationController");
      const label = wasApproved
        ? "Package Re-submitted for Review"
        : "Package Submitted for Review";
      notifyAdmin(
        label,
        `"${reviewTitle}" ${wasApproved ? "(approved package edit)" : ""} needs admin review.`,
        { type: "general", packageId: updated._id.toString() },
      );
    }
  } catch (err) {
    res
      .status(err.statusCode || 400)
      .json({ success: false, message: err.message });
  }
};

// DELETE /api/packages/operator/:id  (operator — delete their own package)
exports.operatorDeletePackage = async (req, res) => {
  try {
    const pkg = await Package.findOne({
      _id: req.params.id,
      operatorId: req.operator._id,
    });
    if (!pkg) {
      return res
        .status(404)
        .json({ success: false, message: "Package not found or not yours" });
    }
    const lifecycle = packageLifecycle(pkg);
    if (isHistory("package", lifecycle)) {
      return res.status(409).json({
        success: false,
        message: `This package is in History (${lifecycle}) and is read-only. It cannot be deleted.`,
      });
    }
    const result = await deleteOrArchivePackage(pkg, {
      actorId: req.operator._id,
      actorType: "operator",
      reason: req.body?.reason || req.body?.archivedReason,
    });
    res.json({
      success: true,
      archived: result.archived,
      message: result.archived
        ? "This package has durable history and was archived with its active inventory and coupons."
        : "Package and disposable dependents deleted",
    });
  } catch (err) {
    res
      .status(err.statusCode || 500)
      .json({ success: false, message: err.message });
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
    const lifecycle = packageLifecycle(pkg);
    if (isHistory("package", lifecycle)) {
      return res.status(409).json({
        success: false,
        message: `This package is in History (${lifecycle}) and is read-only. Its active state cannot be changed.`,
      });
    }

    // If trying to disable, check for active bookings
    if (pkg.isActive) {
      const activeBookings = await countFutureOrOngoingLiveBookings(pkg._id);

      if (activeBookings > 0) {
        return res.status(400).json({
          success: false,
          message: `Cannot disable — ${activeBookings} active booking${activeBookings > 1 ? "s" : ""} exist for upcoming or ongoing trips. Wait until all trips are completed or cancel them first.`,
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
    if (pkg.status === "ARCHIVED") {
      return res.status(409).json({
        success: false,
        message:
          "Archived packages cannot be activated through suspension controls.",
      });
    }

    if (pkg.isActive) {
      const activeBookings = await countFutureOrOngoingLiveBookings(pkg._id);
      if (activeBookings > 0) {
        return res.status(400).json({
          success: false,
          message: `Cannot suspend — ${activeBookings} active booking${activeBookings > 1 ? "s" : ""} exist for upcoming or ongoing trips. Wait until all trips are completed or cancel them first.`,
        });
      }
    }

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
