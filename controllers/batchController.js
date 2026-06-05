const Batch = require("../models/Batch");
const Package = require("../models/Package");

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDate(val) {
  if (!val) return undefined;
  const d = new Date(val);
  return isNaN(d.getTime()) ? undefined : d;
}

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

    const batch = await Batch.create({
      packageId,
      operatorId: req.operator._id,
      startDate: start,
      endDate: end,
      bookingDeadline: deadline,
      adultPrice: Number(adultPrice) || 0,
      childPrice: Number(childPrice) || 0,
      totalSeats: Math.max(1, Number(totalSeats) || 1),
      label: (label || "").trim(),
    });

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

    // Block edit if any confirmed bookings exist
    const confirmedCount = await TripBooking.countDocuments({
      batchId: batch._id,
      status: "CONFIRMED",
    });
    if (confirmedCount > 0) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot edit a batch that has confirmed bookings. Contact admin.",
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

    if (startDate) batch.startDate = toDate(startDate) || batch.startDate;
    if (endDate) batch.endDate = toDate(endDate) || batch.endDate;
    if (bookingDeadline) {
      const d = toDate(bookingDeadline);
      batch.bookingDeadline = d && d <= batch.startDate ? d : batch.startDate;
    }
    if (adultPrice !== undefined) batch.adultPrice = Number(adultPrice) || 0;
    if (childPrice !== undefined) batch.childPrice = Number(childPrice) || 0;
    if (totalSeats !== undefined)
      batch.totalSeats = Math.max(batch.bookedSeats, Number(totalSeats) || 1);
    if (label !== undefined) batch.label = (label || "").trim();

    if (batch.endDate <= batch.startDate) {
      return res
        .status(400)
        .json({ success: false, message: "endDate must be after startDate" });
    }

    await batch.save();
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
