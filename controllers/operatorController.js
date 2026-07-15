const { Operator, VALID_STATES } = require("../models/Operator");

// ── GET /api/operators  (admin only) ─────────────────────────────────────────
exports.getAllOperators = async (req, res) => {
  try {
    const { search, state, page = 1, limit = 20 } = req.query;
    const query = {};
    if (search) {
      query["$or"] = [
        { businessName: { $regex: search, $options: "i" } },
        { contactName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ];
    }
    if (state && state !== "all") query.onboardingState = state;
    const skip = (Number(page) - 1) * Number(limit);
    const [operators, total] = await Promise.all([
      Operator.find(query)
        .select("-password")
        .skip(skip)
        .limit(Number(limit))
        .sort({ createdAt: -1 }),
      Operator.countDocuments(query),
    ]);

    // Enrich with package + booking counts
    const Package = require("../models/Package");
    const TripBooking = require("../models/TripBooking");
    const opIds = operators.map((o) => o._id);

    const [pkgCounts, bkgCounts] = await Promise.all([
      Package.aggregate([
        { $match: { operatorId: { $in: opIds } } },
        { $group: { _id: "$operatorId", count: { $sum: 1 } } },
      ]),
      TripBooking.aggregate([
        { $match: { operatorId: { $in: opIds } } },
        { $group: { _id: "$operatorId", count: { $sum: 1 } } },
      ]),
    ]);

    const pkgMap = {};
    pkgCounts.forEach((p) => {
      pkgMap[p._id.toString()] = p.count;
    });
    const bkgMap = {};
    bkgCounts.forEach((b) => {
      bkgMap[b._id.toString()] = b.count;
    });

    const enriched = operators.map((op) => {
      const obj = op.toJSON();
      obj.packageCount = pkgMap[op._id.toString()] || 0;
      obj.bookingCount = bkgMap[op._id.toString()] || 0;
      return obj;
    });

    res.json({ success: true, total, page: Number(page), operators: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/operators/:id  (admin only) ─────────────────────────────────────
exports.getOperatorById = async (req, res) => {
  try {
    const operator = await Operator.findById(req.params.id).select("-password");
    if (!operator)
      return res
        .status(404)
        .json({ success: false, message: "Operator not found" });
    res.json({ success: true, operator });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PATCH /api/operators/:id/state  (admin only) ─────────────────────────────
exports.transitionState = async (req, res) => {
  try {
    const { newState, note } = req.body;
    if (!VALID_STATES.includes(newState)) {
      return res.status(400).json({ success: false, message: "Invalid state" });
    }
    const operator = await Operator.findById(req.params.id);
    if (!operator)
      return res
        .status(404)
        .json({ success: false, message: "Operator not found" });

    const previousState = operator.onboardingState;

    operator.transitionHistory.push({
      fromState: previousState,
      toState: newState,
      note: (note || "").trim(),
      performedBy: req.user._id,
      timestamp: new Date(),
    });
    operator.onboardingState = newState;
    if (newState === "REJECTED") operator.rejectionReason = (note || "").trim();

    await operator.save();

    // ── Side effects on state transitions ────────────────────────────────
    const Package = require("../models/Package");
    const Notification = require("../models/Notification");

    if (newState === "SUSPENDED") {
      // Deactivate all operator's packages so they don't show in app
      await Package.updateMany(
        { operatorId: operator._id, isActive: true },
        { isActive: false, adminNotes: "SUSPENDED_BY_ADMIN" },
      );
      // Send notification to operator
      await Notification.create({
        recipientId: operator._id,
        recipientType: "operator",
        title: "Account Suspended",
        body:
          (note || "").trim() ||
          "Your account has been suspended by admin. Please contact admin for details.",
        type: "account_suspended",
      });
    }

    if (
      newState === "APPROVED" &&
      (previousState === "SUSPENDED" || previousState === "ACTIVE_FULL")
    ) {
      // Reactivate packages that were suspended by admin
      await Package.updateMany(
        { operatorId: operator._id, adminNotes: "SUSPENDED_BY_ADMIN" },
        { isActive: true, adminNotes: "" },
      );
      // Send notification to operator
      await Notification.create({
        recipientId: operator._id,
        recipientType: "operator",
        title: "Account Reinstated",
        body: "Your account has been reactivated. You can now access all features and your packages are live again.",
        type: "account_reinstated",
      });
    }

    if (newState === "APPROVED" && previousState === "PENDING_APPROVAL") {
      // Notify operator of approval
      await Notification.create({
        recipientId: operator._id,
        recipientType: "operator",
        title: "Application Approved!",
        body: "Congratulations! Your operator application has been approved. You can now start creating packages.",
        type: "account_approved",
      });
    }

    if (newState === "REJECTED") {
      // Notify operator of rejection
      await Notification.create({
        recipientId: operator._id,
        recipientType: "operator",
        title: "Application Update",
        body:
          (note || "").trim() ||
          "Your application has been reviewed. Please check your status page for details.",
        type: "general",
      });
    }

    res.json({ success: true, operator });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PATCH /api/operators/:id/document-status  (admin only) ───────────────────
exports.updateDocumentStatus = async (req, res) => {
  try {
    const { key, status, remark } = req.body;
    const allowedKeys = [
      "governmentId",
      "selfieVerification",
      "tradeLicense",
      "panCard",
    ];
    const allowedStatuses = [
      "PENDING",
      "APPROVED",
      "REJECTED",
      "REUPLOAD_REQUIRED",
    ];

    if (!allowedKeys.includes(key)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid document key" });
    }
    if (!allowedStatuses.includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid status" });
    }

    const operator = await Operator.findById(req.params.id);
    if (!operator)
      return res
        .status(404)
        .json({ success: false, message: "Operator not found" });

    if (!operator.documentStatus) operator.documentStatus = {};
    operator.documentStatus[key] = {
      status,
      remark: (remark || "").trim(),
      updatedAt: new Date(),
    };
    operator.markModified("documentStatus");

    await operator.save();
    res.json({ success: true, operator });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/operators/:id/stats  (admin only) ──────────────────────────────
exports.getOperatorStats = async (req, res) => {
  try {
    const operatorId = req.params.id;
    const operator = await Operator.findById(operatorId).select("-password");
    if (!operator)
      return res
        .status(404)
        .json({ success: false, message: "Operator not found" });

    // Packages (full list with key details)
    const Package = require("../models/Package");
    const packages = await Package.find({ operatorId: operatorId }).select(
      "title location price status isActive durationDays durationNights category avgRating reviewCount bookingCount createdAt image_url",
    );
    const packageCount = packages.length;
    const packageIds = packages.map((p) => p._id);

    // Batches (with package title and booking count)
    let batchCount = 0;
    let batches = [];
    try {
      const Batch = require("../models/Batch");
      batches = await Batch.find({ operatorId: operatorId })
        .populate("packageId", "title")
        .sort({ startDate: -1 });
      batchCount = batches.length;

      // Get booking counts per batch
      const TripBooking = require("../models/TripBooking");
      const batchIds = batches.map((b) => b._id);
      const batchBookingCounts = await TripBooking.aggregate([
        { $match: { batchId: { $in: batchIds } } },
        { $group: { _id: "$batchId", count: { $sum: 1 } } },
      ]);
      const batchBookingMap = {};
      batchBookingCounts.forEach((item) => {
        batchBookingMap[item._id.toString()] = item.count;
      });

      // Enrich batches with booking count
      batches = batches.map((b) => {
        const bObj = b.toJSON();
        bObj.bookingCount = batchBookingMap[b._id.toString()] || 0;
        bObj.packageTitle = b.packageId?.title || "Unknown";
        return bObj;
      });
    } catch {}

    // Bookings + Revenue
    let bookingCount = 0,
      totalRevenue = 0,
      completedBookings = 0;
    let recentBookings = [];
    try {
      const TripBooking = require("../models/TripBooking");
      const bookings = await TripBooking.find({ operatorId: operatorId }).sort({
        createdAt: -1,
      });
      bookingCount = bookings.length;
      completedBookings = bookings.filter(
        (b) => b.status === "COMPLETED",
      ).length;
      totalRevenue = bookings
        .filter((b) => b.status === "COMPLETED" || b.status === "CONFIRMED")
        .reduce(
          (sum, b) =>
            sum + (b.pricing?.operatorAmount || b.pricing?.totalAmount || 0),
          0,
        );
      recentBookings = bookings.map((b) => ({
        _id: b._id,
        status: b.status,
        totalAmount: b.pricing?.totalAmount || 0,
        operatorAmount: b.pricing?.operatorAmount || 0,
        seats: b.pricing?.seats || b.travelers?.length || 1,
        travelers: b.travelers,
        snapshot: b.snapshot,
        batchId: b.batchId,
        createdAt: b.createdAt,
      }));
    } catch {}

    // Coupons
    let couponCount = 0;
    let coupons = [];
    try {
      const Coupon = require("../models/Coupon");
      coupons = await Coupon.find({ operatorId: operatorId })
        .select(
          "code type value minOrderAmount maxDiscount isActive usedCount validUntil description",
        )
        .sort({ createdAt: -1 });
      couponCount = coupons.length;
    } catch {}

    // Flexible Availability
    let flexRanges = [];
    try {
      const FlexibleAvailability = require("../models/FlexibleAvailability");
      flexRanges = await FlexibleAvailability.find({ operatorId: operatorId })
        .populate("packageId", "title")
        .sort({ startDate: -1 });
    } catch {}

    // Reviews
    let reviewCount = 0,
      avgRating = 0;
    let recentReviews = [];
    try {
      const Review = require("../models/Review");
      const reviews = await Review.find({ packageId: { $in: packageIds } })
        .populate("userId", "name profileImage")
        .populate("packageId", "title")
        .sort({ createdAt: -1 });
      reviewCount = reviews.length;
      if (reviewCount > 0) {
        avgRating =
          reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / reviewCount;
      }
      recentReviews = reviews.slice(0, 10).map((r) => ({
        _id: r._id,
        rating: r.rating,
        comment: r.comment,
        userName: r.userId?.name || "Anonymous",
        packageTitle: r.packageId?.title || "Unknown",
        createdAt: r.createdAt,
      }));
    } catch {}

    res.json({
      success: true,
      stats: {
        packageCount,
        batchCount,
        bookingCount,
        completedBookings,
        totalRevenue,
        couponCount,
        reviewCount,
        avgRating: Math.round(avgRating * 10) / 10,
      },
      packages,
      batches,
      recentBookings,
      coupons,
      flexRanges,
      recentReviews,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/operators/onboarding  (operator protected) ─────────────────────
exports.submitOnboarding = async (req, res) => {
  try {
    const operator = await Operator.findById(req.operator._id);
    if (!operator)
      return res
        .status(404)
        .json({ success: false, message: "Operator not found" });
    if (operator.onboardingState !== "DRAFT") {
      return res
        .status(400)
        .json({ success: false, message: "Onboarding already submitted" });
    }

    const {
      contactName,
      phone,
      businessName,
      businessType,
      country,
      state,
      city,
      mainOperatingDestinations,
      accountHolderName,
      bankName,
      accountNumber,
      ifscCode,
      upiId,
      gstNumber,
      agreedToPolicies,
      confirmedAccuracy,
    } = req.body;

    if (contactName) operator.contactName = contactName.trim();
    if (phone) operator.phone = phone.trim();
    if (businessName) operator.businessName = businessName.trim();
    if (businessType) operator.businessType = businessType;
    if (country) operator.country = country.trim();
    if (state) operator.state = state.trim();
    if (city) operator.city = city.trim();

    const parseList = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) return val.filter(Boolean);
      if (typeof val === "string") {
        try {
          const p = JSON.parse(val);
          return Array.isArray(p) ? p.filter(Boolean) : [];
        } catch {
          return val
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
      }
      return [];
    };
    if (mainOperatingDestinations)
      operator.mainOperatingDestinations = parseList(mainOperatingDestinations);

    // Files
    if (req.files) {
      if (req.files["governmentId"]?.[0]) {
        operator.governmentId =
          "/uploads/operators/" + req.files["governmentId"][0].filename;
        if (!operator.documentStatus) operator.documentStatus = {};
        operator.documentStatus.governmentId = {
          status: "PENDING",
          remark: "",
          updatedAt: new Date(),
        };
      }
      if (req.files["selfieVerification"]?.[0]) {
        operator.selfieVerification =
          "/uploads/operators/" + req.files["selfieVerification"][0].filename;
        if (!operator.documentStatus) operator.documentStatus = {};
        operator.documentStatus.selfieVerification = {
          status: "PENDING",
          remark: "",
          updatedAt: new Date(),
        };
      }
      if (req.files["tradeLicense"]?.[0]) {
        operator.tradeLicensePath =
          "/uploads/operators/" + req.files["tradeLicense"][0].filename;
        if (!operator.documentStatus) operator.documentStatus = {};
        operator.documentStatus.tradeLicense = {
          status: "PENDING",
          remark: "",
          updatedAt: new Date(),
        };
      }
      if (req.files["panCard"]?.[0]) {
        operator.panCardPath =
          "/uploads/operators/" + req.files["panCard"][0].filename;
        if (!operator.documentStatus) operator.documentStatus = {};
        operator.documentStatus.panCard = {
          status: "PENDING",
          remark: "",
          updatedAt: new Date(),
        };
      }
    }

    if (accountHolderName)
      operator.accountHolderName = accountHolderName.trim();
    if (bankName) operator.bankName = bankName.trim();
    if (accountNumber) operator.accountNumber = accountNumber.trim();
    if (ifscCode) operator.ifscCode = ifscCode.trim();
    if (upiId) operator.upiId = upiId.trim();
    if (gstNumber) operator.gstNumber = gstNumber.trim();

    operator.agreedToPolicies =
      agreedToPolicies === "true" || agreedToPolicies === true;
    operator.confirmedAccuracy =
      confirmedAccuracy === "true" || confirmedAccuracy === true;

    operator.transitionHistory.push({
      fromState: "DRAFT",
      toState: "PENDING_APPROVAL",
      note: "Operator submitted onboarding form",
      timestamp: new Date(),
    });
    operator.onboardingState = "PENDING_APPROVAL";
    operator.markModified("documentStatus");

    await operator.save();
    res.json({ success: true, operator });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PATCH /api/operators/documents/reupload  (operator protected) ─────────────
exports.reuploadDocument = async (req, res) => {
  try {
    const { key } = req.body;
    const allowedKeys = [
      "governmentId",
      "selfieVerification",
      "tradeLicense",
      "panCard",
    ];

    if (!allowedKeys.includes(key)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid document key" });
    }
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "File is required" });
    }

    const operator = await Operator.findById(req.operator._id);
    if (!operator)
      return res
        .status(404)
        .json({ success: false, message: "Operator not found" });

    const currentStatus = operator.documentStatus?.[key]?.status;
    if (currentStatus !== "REUPLOAD_REQUIRED" && currentStatus !== "REJECTED") {
      return res.status(400).json({
        success: false,
        message: "Re-upload not allowed for this document",
      });
    }

    // Map key to field name
    const fieldMap = {
      governmentId: "governmentId",
      selfieVerification: "selfieVerification",
      tradeLicense: "tradeLicensePath",
      panCard: "panCardPath",
    };
    operator[fieldMap[key]] = "/uploads/operators/" + req.file.filename;
    operator.documentStatus[key] = {
      status: "PENDING",
      remark: "",
      updatedAt: new Date(),
    };
    operator.markModified("documentStatus");

    await operator.save();
    res.json({ success: true, operator });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
