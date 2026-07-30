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
    // Only accept the fields a reporter is allowed to set — `status` and
    // `adminNote` are staff-controlled.
    const { bookingId, packageId, operatorId, type, subject, description } =
      req.body;

    const cleanSubject = String(subject || "").trim();
    if (!cleanSubject) {
      return res
        .status(400)
        .json({ success: false, message: "Subject is required" });
    }

    const report = await Report.create({
      userId: req.user._id,
      bookingId: bookingId || undefined,
      packageId: packageId || undefined,
      operatorId: operatorId || undefined,
      type: ["booking", "operator", "package", "other"].includes(type)
        ? type
        : "other",
      subject: cleanSubject.slice(0, 200),
      description: String(description || "")
        .trim()
        .slice(0, 2000),
      status: "open",
    });
    res.status(201).json({ success: true, report });

    // Notify admin about new report
    const { notifyAdmin } = require("./notificationController");
    notifyAdmin(
      "New User Report",
      `${req.user.name || "User"} reported: "${report.subject}"`,
      { type: "general" },
    );
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
    // Whitelist — the whole body used to be written straight through, so an
    // admin request could rewrite userId, subject, or the linked booking.
    const updates = {};
    if (req.body.status !== undefined) {
      const allowedStatuses = ["open", "in_progress", "resolved", "closed"];
      if (!allowedStatuses.includes(req.body.status)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid report status" });
      }
      updates.status = req.body.status;
    }
    if (req.body.adminNote !== undefined) {
      updates.adminNote = String(req.body.adminNote).trim().slice(0, 1000);
    }
    if (Object.keys(updates).length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Nothing to update" });
    }

    const report = await Report.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });
    if (!report)
      return res
        .status(404)
        .json({ success: false, message: "Report not found" });

    // Notify user when report status changes to resolved
    if (req.body.status === "resolved" && report.userId) {
      const { notifyUser } = require("./notificationController");
      notifyUser(
        report.userId,
        "Issue Resolved ✅",
        `Your reported issue "${report.subject}" has been resolved.${req.body.adminNote ? " Note: " + req.body.adminNote : ""}`,
        { type: "report_resolved", reportId: report._id.toString() },
      );
    }

    res.json({ success: true, report });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};
