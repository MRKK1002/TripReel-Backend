const mongoose = require("mongoose");

const reportSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "TripBooking" },
    packageId: { type: mongoose.Schema.Types.ObjectId, ref: "Package" },
    operatorId: { type: mongoose.Schema.Types.ObjectId, ref: "Operator" },
    type: {
      type: String,
      enum: ["booking", "operator", "package", "other"],
      default: "other",
    },
    subject: { type: String, trim: true, required: true },
    description: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["open", "in_progress", "resolved", "closed"],
      default: "open",
    },
    adminNote: { type: String, default: "" },
  },
  { timestamps: true },
);

const Report = mongoose.models.Report || mongoose.model("Report", reportSchema);

// POST /api/reports — user submits a report
exports.createReport = async (req, res) => {
  try {
    const report = await Report.create({ ...req.body, userId: req.user._id });
    res.status(201).json({ success: true, report });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// GET /api/reports/my — user's own reports
exports.getMyReports = async (req, res) => {
  try {
    const reports = await Report.find({ userId: req.user._id }).sort({
      createdAt: -1,
    });
    res.json({ success: true, reports });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/reports — admin gets all reports
exports.getAllReports = async (req, res) => {
  try {
    const { status, type } = req.query;
    const query = {};
    if (status) query.status = status;
    if (type) query.type = type;
    const reports = await Report.find(query)
      .populate("userId", "name phone email")
      .populate("bookingId", "bookingId")
      .populate("packageId", "title")
      .populate("operatorId", "businessName")
      .sort({ createdAt: -1 });
    res.json({ success: true, total: reports.length, reports });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /api/reports/:id — admin updates report status
exports.updateReport = async (req, res) => {
  try {
    const report = await Report.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!report)
      return res
        .status(404)
        .json({ success: false, message: "Report not found" });
    res.json({ success: true, report });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};
