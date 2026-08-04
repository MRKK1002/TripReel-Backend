const {
  Operator,
  VALID_STATES,
  EDITABLE_STATES,
  ALLOWED_TRANSITIONS,
  CORRECTABLE_FIELDS,
} = require("../models/Operator");
const {
  collapseSpaces,
  validatePersonName,
  validatePhoneIN,
  validateAccountNumber,
  validateIfsc,
  validateUpi,
  validateGstin,
  validateBounded,
  validatePlaceName,
  validateDestinations,
  firstError,
  LIMITS,
} = require("../utils/validators");

// Maps a UI "status" filter to the underlying onboardingState(s).
// `needs_action` and `active` are virtual buckets spanning multiple states.
const STATUS_GROUPS = {
  needs_action: ["PENDING_APPROVAL", "CHANGES_REQUESTED"],
  active: ["APPROVED", "ACTIVE_FULL"],
};

function buildOperatorQuery({ search, status, businessType, from, to }) {
  const escapeRegex = require("../utils/escapeRegex");
  const query = {};

  if (search) {
    const rx = { $regex: escapeRegex(String(search)), $options: "i" };
    query.$or = [
      { businessName: rx },
      { contactName: rx },
      { email: rx },
      { phone: rx },
    ];
  }

  if (status && status !== "all") {
    if (STATUS_GROUPS[status])
      query.onboardingState = { $in: STATUS_GROUPS[status] };
    else query.onboardingState = status;
  }

  if (businessType && businessType !== "all") query.businessType = businessType;

  if (from || to) {
    query.createdAt = {};
    if (from) {
      const d = new Date(from);
      if (!isNaN(d)) query.createdAt.$gte = d;
    }
    if (to) {
      const d = new Date(to);
      if (!isNaN(d)) {
        d.setHours(23, 59, 59, 999);
        query.createdAt.$lte = d;
      }
    }
    if (Object.keys(query.createdAt).length === 0) delete query.createdAt;
  }

  return query;
}

// ── GET /api/operators/counts  (admin only) — tab badge counts ────────────────
exports.getOperatorCounts = async (req, res) => {
  try {
    const rows = await Operator.aggregate([
      { $group: { _id: "$onboardingState", count: { $sum: 1 } } },
    ]);
    const byState = {};
    let total = 0;
    rows.forEach((r) => {
      byState[r._id] = r.count;
      total += r.count;
    });
    const sum = (states) => states.reduce((n, s) => n + (byState[s] || 0), 0);

    res.json({
      success: true,
      counts: {
        all: total,
        needs_action: sum(STATUS_GROUPS.needs_action),
        active: sum(STATUS_GROUPS.active),
        DRAFT: byState.DRAFT || 0,
        PENDING_APPROVAL: byState.PENDING_APPROVAL || 0,
        CHANGES_REQUESTED: byState.CHANGES_REQUESTED || 0,
        APPROVED: byState.APPROVED || 0,
        ACTIVE_FULL: byState.ACTIVE_FULL || 0,
        REJECTED: byState.REJECTED || 0,
        SUSPENDED: byState.SUSPENDED || 0,
        EXPIRED: byState.EXPIRED || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/operators  (admin only) ─────────────────────────────────────────
exports.getAllOperators = async (req, res) => {
  try {
    const {
      search,
      status,
      state, // legacy alias for status
      businessType,
      from,
      to,
      sort = "recent",
      page = 1,
      limit = 20,
    } = req.query;

    const query = buildOperatorQuery({
      search,
      status: status || state,
      businessType,
      from,
      to,
    });

    // Sort options. "submitted" = FIFO on the review queue (oldest waiting first).
    const sortMap = {
      recent: { createdAt: -1 },
      oldest: { createdAt: 1 },
      submitted: { lastSubmittedAt: 1, createdAt: 1 },
      name: { businessName: 1, contactName: 1 },
    };
    const sortBy = sortMap[sort] || sortMap.recent;

    const skip = (Number(page) - 1) * Number(limit);
    const [operators, total] = await Promise.all([
      Operator.find(query)
        .select("-password")
        .skip(skip)
        .limit(Number(limit))
        .sort(sortBy),
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

    // Replace private KYC doc paths with short-lived signed URLs so admins can
    // view them without the files being publicly downloadable.
    const { toSignedUrl } = require("../utils/signedDocUrl");
    const op = operator.toObject();
    for (const field of [
      "governmentId",
      "selfieVerification",
      "panCardPath",
      "tradeLicensePath",
      "profilePhoto",
    ]) {
      if (op[field]) op[field] = toSignedUrl(op[field]);
    }

    res.json({ success: true, operator: op });
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

    // ── Enforce the state machine ──────────────────────────────────────────
    if (newState === previousState) {
      return res.status(400).json({
        success: false,
        message: `Operator is already ${previousState.replace(/_/g, " ").toLowerCase()}.`,
      });
    }
    const allowed = ALLOWED_TRANSITIONS[previousState] || [];
    if (!allowed.includes(newState)) {
      return res.status(400).json({
        success: false,
        message: `Cannot move an operator from ${previousState} to ${newState}.`,
      });
    }

    // A rejection / correction request must always carry a reason so the
    // operator knows what to fix.
    if (
      (newState === "REJECTED" || newState === "SUSPENDED") &&
      !(note || "").trim()
    ) {
      return res.status(400).json({
        success: false,
        message: `A reason is required when marking an operator ${newState.toLowerCase()}.`,
      });
    }

    // Don't approve while a document is still flagged as bad — otherwise the
    // operator goes live with a rejected ID on file.
    if (newState === "APPROVED") {
      const badDocs = Object.entries(
        operator.documentStatus?.toObject?.() || operator.documentStatus || {},
      )
        .filter(
          ([, v]) =>
            v?.status === "REJECTED" || v?.status === "REUPLOAD_REQUIRED",
        )
        .map(([k]) => k);
      if (badDocs.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Cannot approve — these documents are still marked as rejected / re-upload required: ${badDocs.join(", ")}. Resolve them first.`,
        });
      }
    }

    operator.transitionHistory.push({
      fromState: previousState,
      toState: newState,
      note: (note || "").trim(),
      performedBy: req.user._id,
      timestamp: new Date(),
    });
    operator.onboardingState = newState;
    if (newState === "REJECTED") operator.rejectionReason = (note || "").trim();

    // Approving clears any open correction request and the old rejection note
    if (newState === "APPROVED" || newState === "ACTIVE_FULL") {
      operator.rejectionReason = "";
      operator.correctionRequest = undefined;
    }

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

// ── PATCH /api/operators/:id/request-changes  (admin only) ───────────────────
// Real-world flow: admin reviews the application, spots wrong details (e.g. a
// bad account number), and sends it back listing exactly which fields to fix.
// Operator lands in CHANGES_REQUESTED, corrects those fields, and resubmits.
exports.requestChanges = async (req, res) => {
  try {
    const { fields, note } = req.body;

    const requestedFields = Array.isArray(fields)
      ? fields.filter((f) => CORRECTABLE_FIELDS.includes(f))
      : [];

    if (requestedFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Select at least one field the operator needs to correct.",
      });
    }
    if (!(note || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "Please explain what is wrong so the operator can fix it.",
      });
    }

    const operator = await Operator.findById(req.params.id);
    if (!operator)
      return res
        .status(404)
        .json({ success: false, message: "Operator not found" });

    const previousState = operator.onboardingState;
    const allowed = ALLOWED_TRANSITIONS[previousState] || [];
    if (!allowed.includes("CHANGES_REQUESTED")) {
      return res.status(400).json({
        success: false,
        message: `Cannot request changes while the operator is ${previousState.replace(/_/g, " ").toLowerCase()}.`,
      });
    }

    operator.correctionRequest = {
      fields: requestedFields,
      note: note.trim(),
      requestedAt: new Date(),
      requestedBy: req.user._id,
    };
    operator.onboardingState = "CHANGES_REQUESTED";
    operator.transitionHistory.push({
      fromState: previousState,
      toState: "CHANGES_REQUESTED",
      note: note.trim(),
      performedBy: req.user._id,
      timestamp: new Date(),
    });

    // Any flagged document also gets marked REUPLOAD_REQUIRED so the operator
    // sees the request on the document itself.
    const docFieldMap = {
      governmentId: "governmentId",
      selfieVerification: "selfieVerification",
      panCard: "panCard",
      tradeLicense: "tradeLicense",
    };
    if (!operator.documentStatus) operator.documentStatus = {};
    requestedFields.forEach((f) => {
      const docKey = docFieldMap[f];
      if (docKey) {
        operator.documentStatus[docKey] = {
          status: "REUPLOAD_REQUIRED",
          remark: note.trim(),
          updatedAt: new Date(),
        };
      }
    });
    operator.markModified("documentStatus");

    await operator.save();

    const Notification = require("../models/Notification");
    await Notification.create({
      recipientId: operator._id,
      recipientType: "operator",
      title: "Corrections Required",
      body: `Please correct the following before we can approve your account: ${requestedFields.join(", ")}. ${note.trim()}`,
      type: "general",
    });

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
    // First submission (DRAFT) or a resubmission after the admin asked for
    // corrections / rejected the application.
    if (!EDITABLE_STATES.includes(operator.onboardingState)) {
      const msg =
        operator.onboardingState === "PENDING_APPROVAL"
          ? "Your application is already under review. You'll be notified once an admin reviews it."
          : "Your application can no longer be edited.";
      return res.status(400).json({ success: false, message: msg });
    }
    const isResubmission = operator.onboardingState !== "DRAFT";

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

    const destinations = parseList(mainOperatingDestinations);
    const isCompany = ["TOUR_OPERATOR", "TRAVEL_AGENCY"].includes(businessType);
    const truthy = (v) => v === true || v === "true";

    // On a resubmission, any document the admin flagged must be replaced with a
    // fresh file — re-sending the same rejected file is not a correction.
    const docFieldMap = {
      governmentId: "governmentId",
      selfieVerification: "selfieVerification",
      panCard: "panCard",
      tradeLicense: "tradeLicense",
    };
    const docLabels = {
      governmentId: "Government ID",
      selfieVerification: "Selfie verification",
      panCard: "PAN card",
      tradeLicense: "Trade license",
    };
    const staleDocError = (key) => {
      if (!isResubmission) return "";
      const st = operator.documentStatus?.[docFieldMap[key]]?.status;
      if (st !== "REUPLOAD_REQUIRED" && st !== "REJECTED") return "";
      return req.files?.[key]?.[0]
        ? ""
        : `${docLabels[key]} was rejected by the reviewer — please upload a new file.`;
    };

    // ── Full server-side validation of the 7-step form ─────────────────────
    const bad = firstError({
      contactName: validatePersonName(contactName, "Full name"),
      phone: validatePhoneIN(phone),
      businessName: isCompany
        ? validateBounded(
            businessName,
            "Company / agency name",
            2,
            LIMITS.BUSINESS_NAME_MAX,
          )
        : validateBounded(
            businessName,
            "Company / agency name",
            2,
            LIMITS.BUSINESS_NAME_MAX,
            { required: false },
          ),
      businessType: [
        "INDIVIDUAL_GUIDE",
        "TOUR_OPERATOR",
        "TRAVEL_AGENCY",
        "EXPERIENCE_HOST",
      ].includes(businessType)
        ? ""
        : "Please select a valid business type.",
      country: validatePlaceName(country, "Country"),
      state: validatePlaceName(state, "State"),
      city: validatePlaceName(city, "City"),
      mainOperatingDestinations: validateDestinations(destinations),
      governmentId:
        req.files?.["governmentId"]?.[0] || operator.governmentId
          ? staleDocError("governmentId")
          : "Government ID is required.",
      selfieVerification: staleDocError("selfieVerification"),
      tradeLicense: staleDocError("tradeLicense"),
      accountHolderName: validatePersonName(
        accountHolderName,
        "Account holder name",
      ),
      bankName: validateBounded(
        bankName,
        "Bank name",
        LIMITS.BANK_NAME_MIN,
        LIMITS.BANK_NAME_MAX,
      ),
      accountNumber: validateAccountNumber(accountNumber),
      ifscCode: validateIfsc(ifscCode),
      upiId: validateUpi(upiId, { required: false }),
      gstNumber: validateGstin(gstNumber, { required: false }),
      panCard:
        req.files?.["panCard"]?.[0] || operator.panCardPath
          ? staleDocError("panCard")
          : "PAN card is required.",
      agreedToPolicies: truthy(agreedToPolicies)
        ? ""
        : "You must agree to the platform policies.",
      confirmedAccuracy: truthy(confirmedAccuracy)
        ? ""
        : "You must confirm accuracy of information.",
    });
    if (bad) {
      return res
        .status(400)
        .json({ success: false, field: bad.field, message: bad.message });
    }

    operator.contactName = collapseSpaces(contactName);
    operator.phone = String(phone).replace(/\D/g, "");
    operator.businessName = collapseSpaces(businessName);
    operator.businessType = businessType;
    operator.country = collapseSpaces(country);
    operator.state = collapseSpaces(state);
    operator.city = collapseSpaces(city);
    operator.mainOperatingDestinations = destinations.map((d) =>
      collapseSpaces(d),
    );

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

    operator.accountHolderName = collapseSpaces(accountHolderName);
    operator.bankName = collapseSpaces(bankName);
    operator.accountNumber = String(accountNumber).trim();
    operator.ifscCode = String(ifscCode).trim().toUpperCase();
    operator.upiId = (upiId || "").trim();
    operator.gstNumber = (gstNumber || "").trim().toUpperCase();

    operator.agreedToPolicies = true;
    operator.confirmedAccuracy = true;

    const fromState = operator.onboardingState;

    // Close out the open correction request (keep it in history for audit)
    if (operator.correctionRequest?.requestedAt) {
      operator.correctionHistory.push({
        fields: operator.correctionRequest.fields || [],
        note: operator.correctionRequest.note || "",
        requestedAt: operator.correctionRequest.requestedAt,
        resolvedAt: new Date(),
      });
      operator.correctionRequest = undefined;
    }
    operator.rejectionReason = "";

    operator.transitionHistory.push({
      fromState,
      toState: "PENDING_APPROVAL",
      note: isResubmission
        ? "Operator corrected details and resubmitted for approval"
        : "Operator submitted onboarding form",
      timestamp: new Date(),
    });
    operator.onboardingState = "PENDING_APPROVAL";
    operator.submissionCount = (operator.submissionCount || 0) + 1;
    operator.lastSubmittedAt = new Date();
    operator.markModified("documentStatus");

    await operator.save();

    // Tell admins there's something to review again
    if (isResubmission) {
      try {
        const Notification = require("../models/Notification");
        await Notification.create({
          recipientId: operator._id,
          recipientType: "operator",
          title: "Application Resubmitted",
          body: "Thanks — your corrected details are back with our team for review.",
          type: "general",
        });
      } catch {}
    }

    res.json({ success: true, operator, resubmitted: isResubmission });
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
    // operatorUploadMiddleware stores files under /uploads/operators/
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
