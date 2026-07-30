const Batch = require("../models/Batch");
const Package = require("../models/Package");

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDate(val) {
  if (!val) return undefined;
  const d = new Date(val);
  return isNaN(d.getTime()) ? undefined : d;
}

const MAX_BATCH_PRICE = 10000000; // ₹1 crore sanity ceiling
const MAX_BATCH_SEATS = 1000;

// Price/seat rules. These lived only in the React form, so a direct API call
// could create a ₹0 batch (free trips) or a batch with absurd seat counts.
function validateBatchPricing({ adultPrice, childPrice, totalSeats }) {
  const adult = Number(adultPrice);
  if (!Number.isFinite(adult) || adult <= 0) {
    return "Adult price must be greater than ₹0.";
  }
  if (adult > MAX_BATCH_PRICE) {
    return `Adult price cannot exceed ₹${MAX_BATCH_PRICE.toLocaleString("en-IN")}.`;
  }

  if (childPrice !== undefined && childPrice !== null && childPrice !== "") {
    const child = Number(childPrice);
    if (!Number.isFinite(child) || child < 0) {
      return "Child price cannot be negative.";
    }
    if (child > adult) {
      return "Child price cannot be higher than the adult price.";
    }
  }

  const seats = Number(totalSeats);
  if (!Number.isFinite(seats) || !Number.isInteger(seats) || seats < 1) {
    return "Total seats must be a whole number of at least 1.";
  }
  if (seats > MAX_BATCH_SEATS) {
    return `Total seats cannot exceed ${MAX_BATCH_SEATS}.`;
  }
  return "";
}

// Two batches on the same package must not cover overlapping dates
async function findOverlappingBatch({ packageId, start, end, excludeId }) {
  const query = {
    packageId,
    startDate: { $lt: end },
    endDate: { $gt: start },
  };
  if (excludeId) query._id = { $ne: excludeId };
  return Batch.findOne(query);
}

const fmtRange = (a, b) =>
  `${new Date(a).toLocaleDateString("en-IN")} – ${new Date(b).toLocaleDateString("en-IN")}`;

// Exported for tests
exports.validateBatchPricing = validateBatchPricing;
exports.MAX_BATCH_PRICE = MAX_BATCH_PRICE;
exports.MAX_BATCH_SEATS = MAX_BATCH_SEATS;

// ── Public ────────────────────────────────────────────────────────────────────

// GET /api/batches?packageId=X
// Returns all active upcoming + ongoing batches for a package, sorted by startDate
exports.getBatchesForPackage = async (req, res) => {
  try {
    const { packageId } = req.query;
    if (!packageId) {
      return res
        .status(400)
        .json({ success: false, message: "packageId is required" });
    }

    const now = new Date();
    const batches = await Batch.find({
      packageId,
      isActive: true,
      bookingDeadline: { $gte: now }, // only show batches still open for booking
      endDate: { $gte: now }, // exclude fully completed ones
    }).sort({ startDate: 1 });

    res.json({ success: true, count: batches.length, batches });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/batches/:id
exports.getBatchById = async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.id).populate(
      "packageId",
      "title location image_url",
    );
    if (!batch) {
      return res
        .status(404)
        .json({ success: false, message: "Batch not found" });
    }
    res.json({ success: true, batch });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Operator ──────────────────────────────────────────────────────────────────

// POST /api/batches  — operator creates a new batch for their approved package
exports.createBatch = async (req, res) => {
  try {
    const {
      packageId,
      startDate,
      endDate,
      bookingDeadline,
      adultPrice,
      childPrice,
      totalSeats,
      label,
    } = req.body;

    if (!packageId) {
      return res
        .status(400)
        .json({ success: false, message: "packageId is required" });
    }

    // Verify package belongs to this operator and is approved
    const pkg = await Package.findOne({
      _id: packageId,
      operatorId: req.operator._id,
      status: "APPROVED",
      isActive: true,
    });
    if (!pkg) {
      return res.status(404).json({
        success: false,
        message: "Package not found, not yours, or not yet approved",
      });
    }
    // Fixed batches only apply to batch-mode packages (flexible packages use
    // date-availability ranges instead) — prevents batch/flex date collisions.
    if (pkg.bookingMode === "flexible") {
      return res.status(400).json({
        success: false,
        message:
          "This package uses flexible dates, not fixed batches. Use Date Availability instead.",
      });
    }

    const start = toDate(startDate);
    const end = toDate(endDate);
    let deadline = toDate(bookingDeadline);

    if (!start || !end) {
      return res.status(400).json({
        success: false,
        message: "startDate and endDate are required",
      });
    }

    const now = new Date();
    if (start <= now) {
      return res
        .status(400)
        .json({ success: false, message: "startDate must be in the future" });
    }
    if (end <= start) {
      return res
        .status(400)
        .json({ success: false, message: "endDate must be after startDate" });
    }
    if (!deadline || deadline > start) {
      // Default: booking deadline = start date
      deadline = start;
    }

    // ── Price / seat validation (was frontend-only, so ₹0 batches got through) ──
    const priceError = validateBatchPricing({
      adultPrice,
      childPrice,
      totalSeats,
    });
    if (priceError) {
      return res.status(400).json({ success: false, message: priceError });
    }

    // Reject duplicate/overlapping batches on the same package
    const overlap = await findOverlappingBatch({
      packageId,
      start,
      end,
    });
    if (overlap) {
      return res.status(400).json({
        success: false,
        message: `These dates overlap an existing batch (${fmtRange(overlap.startDate, overlap.endDate)}). Edit that batch or pick different dates.`,
      });
    }

    const batch = await Batch.create({
      packageId,
      operatorId: req.operator._id,
      startDate: start,
      endDate: end,
      bookingDeadline: deadline,
      adultPrice: Math.round(Number(adultPrice)),
      childPrice: Math.round(Number(childPrice) || 0),
      totalSeats: Math.floor(Number(totalSeats)),
      label: (label || "").trim().slice(0, 80),
    });

    // Alert wishlisted users about new batch
    const { alertWishlistedUsers } = require("./wishlistAlertController");
    const fmtDate = (d) =>
      new Date(d).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
      });
    alertWishlistedUsers(
      packageId,
      "New dates available!",
      `${pkg.title} has new dates: ${fmtDate(start)} - ${fmtDate(end)}. Book now!`,
    );

    res.status(201).json({ success: true, batch });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// POST /api/batches/:id/clone  — clone an existing batch, operator updates dates
exports.cloneBatch = async (req, res) => {
  try {
    const source = await Batch.findOne({
      _id: req.params.id,
      operatorId: req.operator._id,
    });
    if (!source) {
      return res
        .status(404)
        .json({ success: false, message: "Batch not found or not yours" });
    }

    const { startDate, endDate, bookingDeadline, label } = req.body;

    const start = toDate(startDate);
    const end = toDate(endDate);
    let deadline = toDate(bookingDeadline);

    if (!start || !end) {
      return res.status(400).json({
        success: false,
        message: "New startDate and endDate are required for clone",
      });
    }

    const now = new Date();
    if (start <= now) {
      return res
        .status(400)
        .json({ success: false, message: "startDate must be in the future" });
    }
    if (end <= start) {
      return res
        .status(400)
        .json({ success: false, message: "endDate must be after startDate" });
    }
    if (!deadline || deadline > start) deadline = start;

    // The source batch may predate price validation — re-check before cloning
    const cloneError = validateBatchPricing({
      adultPrice: source.adultPrice,
      childPrice: source.childPrice,
      totalSeats: source.totalSeats,
    });
    if (cloneError) {
      return res.status(400).json({
        success: false,
        message: `Cannot clone — the original batch has invalid pricing (${cloneError}) Fix it first.`,
      });
    }

    const cloneOverlap = await findOverlappingBatch({
      packageId: source.packageId,
      start,
      end,
    });
    if (cloneOverlap) {
      return res.status(400).json({
        success: false,
        message: `These dates overlap an existing batch (${fmtRange(cloneOverlap.startDate, cloneOverlap.endDate)}). Pick different dates.`,
      });
    }

    const cloned = await Batch.create({
      packageId: source.packageId,
      operatorId: source.operatorId,
      startDate: start,
      endDate: end,
      bookingDeadline: deadline,
      adultPrice: source.adultPrice,
      childPrice: source.childPrice,
      totalSeats: source.totalSeats,
      label: (label || source.label || "").trim(),
    });

    res.status(201).json({ success: true, batch: cloned });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// PUT /api/batches/:id  — operator edits own batch (only if no confirmed bookings)
exports.updateBatch = async (req, res) => {
  try {
    const TripBooking = require("../models/TripBooking");

    const batch = await Batch.findOne({
      _id: req.params.id,
      operatorId: req.operator._id,
    });
    if (!batch) {
      return res
        .status(404)
        .json({ success: false, message: "Batch not found or not yours" });
    }

    // Block edit if any live booking exists. This used to check CONFIRMED only,
    // while delete checked CONFIRMED *and* PENDING — so a batch with a pending
    // booking could have its price and dates rewritten under the traveller.
    const liveCount = await TripBooking.countDocuments({
      batchId: batch._id,
      status: { $in: ["CONFIRMED", "PENDING"] },
    });
    if (liveCount > 0) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot edit a batch that already has bookings. Contact admin.",
      });
    }

    const {
      startDate,
      endDate,
      bookingDeadline,
      adultPrice,
      childPrice,
      totalSeats,
      label,
    } = req.body;

    const oldPrice = batch.adultPrice;
    const datesChanged = Boolean(startDate || endDate);

    if (startDate) batch.startDate = toDate(startDate) || batch.startDate;
    if (endDate) batch.endDate = toDate(endDate) || batch.endDate;

    if (batch.endDate <= batch.startDate) {
      return res
        .status(400)
        .json({ success: false, message: "endDate must be after startDate" });
    }

    // Moved dates must still be in the future — create enforced this, update
    // did not, so a batch could be edited into the past.
    if (datesChanged && batch.startDate <= new Date()) {
      return res
        .status(400)
        .json({ success: false, message: "startDate must be in the future" });
    }

    // Re-clamp the deadline whenever either the deadline or the start date moves
    if (bookingDeadline) {
      const d = toDate(bookingDeadline);
      batch.bookingDeadline = d && d <= batch.startDate ? d : batch.startDate;
    } else if (datesChanged && batch.bookingDeadline > batch.startDate) {
      batch.bookingDeadline = batch.startDate;
    }

    if (adultPrice !== undefined)
      batch.adultPrice = Math.round(Number(adultPrice));
    if (childPrice !== undefined)
      batch.childPrice = Math.round(Number(childPrice) || 0);
    if (totalSeats !== undefined)
      batch.totalSeats = Math.max(
        batch.bookedSeats,
        Math.floor(Number(totalSeats)),
      );
    if (label !== undefined) batch.label = (label || "").trim().slice(0, 80);

    const priceError = validateBatchPricing({
      adultPrice: batch.adultPrice,
      childPrice: batch.childPrice,
      totalSeats: batch.totalSeats,
    });
    if (priceError) {
      return res.status(400).json({ success: false, message: priceError });
    }

    if (datesChanged) {
      const overlap = await findOverlappingBatch({
        packageId: batch.packageId,
        start: batch.startDate,
        end: batch.endDate,
        excludeId: batch._id,
      });
      if (overlap) {
        return res.status(400).json({
          success: false,
          message: `These dates overlap another batch (${fmtRange(overlap.startDate, overlap.endDate)}). Pick different dates.`,
        });
      }
    }

    await batch.save();

    // If price changed, alert wishlisted users
    if (adultPrice !== undefined && Number(adultPrice) !== oldPrice) {
      const { alertWishlistedUsers } = require("./wishlistAlertController");
      const Package = require("../models/Package");
      const pkg = await Package.findById(batch.packageId).select("title");
      if (Number(adultPrice) < oldPrice) {
        alertWishlistedUsers(
          batch.packageId,
          "Price dropped!",
          `${pkg?.title || "A trip you saved"} is now Rs.${Number(adultPrice).toLocaleString("en-IN")}/person (was Rs.${oldPrice.toLocaleString("en-IN")}). Book now!`,
        );
      }
    }

    res.json({ success: true, batch });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// DELETE /api/batches/:id  — operator deletes own batch (only if no confirmed bookings)
exports.deleteBatch = async (req, res) => {
  try {
    const TripBooking = require("../models/TripBooking");

    const batch = await Batch.findOne({
      _id: req.params.id,
      operatorId: req.operator._id,
    });
    if (!batch) {
      return res
        .status(404)
        .json({ success: false, message: "Batch not found or not yours" });
    }

    const confirmedCount = await TripBooking.countDocuments({
      batchId: batch._id,
      status: { $in: ["CONFIRMED", "PENDING"] },
    });
    if (confirmedCount > 0) {
      return res.status(400).json({
        success: false,
        message: "Cannot delete a batch that has active bookings.",
      });
    }

    await batch.deleteOne();
    res.json({ success: true, message: "Batch deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/batches/operator/mine  — all batches for operator's packages
exports.operatorGetMyBatches = async (req, res) => {
  try {
    const { packageId } = req.query;
    const query = { operatorId: req.operator._id };
    if (packageId) query.packageId = packageId;

    const batches = await Batch.find(query)
      .populate("packageId", "title location")
      .sort({ startDate: 1 });

    res.json({ success: true, count: batches.length, batches });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Admin ─────────────────────────────────────────────────────────────────────

// PATCH /api/batches/:id/active  — admin suspend/unsuspend
exports.adminToggleActive = async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.id);
    if (!batch) {
      return res
        .status(404)
        .json({ success: false, message: "Batch not found" });
    }
    batch.isActive = !batch.isActive;
    await batch.save();
    res.json({ success: true, batch });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/batches/admin/all  — admin sees all batches
exports.adminGetAllBatches = async (req, res) => {
  try {
    const { packageId, operatorId, page = 1, limit = 20 } = req.query;
    const query = {};
    if (packageId) query.packageId = packageId;
    if (operatorId) query.operatorId = operatorId;

    const skip = (Number(page) - 1) * Number(limit);
    const [batches, total] = await Promise.all([
      Batch.find(query)
        .populate("packageId", "title location")
        .populate("operatorId", "businessName contactName email")
        .sort({ startDate: 1 })
        .skip(skip)
        .limit(Number(limit)),
      Batch.countDocuments(query),
    ]);

    res.json({ success: true, total, page: Number(page), batches });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
