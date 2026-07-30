const jwt = require("jsonwebtoken");
const { Operator } = require("../models/Operator");
const {
  collapseSpaces,
  validatePersonName,
  validateEmail,
  validatePhoneIN,
  validatePassword,
  validateUpi,
  validateBounded,
  validatePlaceName,
  validateDestinations,
  firstError,
  LIMITS,
} = require("../utils/validators");

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

// POST /api/operators/auth/register
exports.register = async (req, res) => {
  try {
    let { contactName, email, phone, password } = req.body;

    // Normalize
    contactName = collapseSpaces(contactName);
    email = (email || "").trim().toLowerCase();
    phone = (phone || "").trim().replace(/\D/g, "");

    // ── Validate every field server-side (client rules can be bypassed) ────
    const bad = firstError({
      contactName: validatePersonName(contactName, "Full name"),
      email: validateEmail(email),
      phone: validatePhoneIN(phone),
      password: validatePassword(password),
    });
    if (bad) {
      return res
        .status(400)
        .json({ success: false, field: bad.field, message: bad.message });
    }

    // Reject if email OR phone already belongs to another operator
    const orConditions = [{ email }];
    if (phone) orConditions.push({ phone });
    const existing = await Operator.findOne({ $or: orConditions });
    if (existing) {
      const reason = existing.email === email ? "email" : "phone number";
      return res.status(400).json({
        success: false,
        message: `An operator account with this ${reason} already exists. Please log in instead.`,
      });
    }

    const operator = await Operator.create({
      contactName,
      email,
      phone,
      password,
    });
    const token = signToken(operator._id);

    res.status(201).json({
      success: true,
      token,
      operator: {
        _id: operator._id,
        contactName: operator.contactName,
        email: operator.email,
        phone: operator.phone,
        onboardingState: operator.onboardingState,
      },
    });
  } catch (err) {
    // Race-safe: duplicate key (unique email index) hit between check and create
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "An operator account with this email or phone already exists.",
      });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/operators/auth/login
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "Email and password are required" });
    }

    const operator = await Operator.findOne({ email }).select("+password");
    if (!operator || !(await operator.comparePassword(password))) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password" });
    }

    const token = signToken(operator._id);

    // Return full operator data (exclude password + payout identifiers, which
    // the client never needs and which used to be persisted to localStorage)
    const fullOperator = await Operator.findById(operator._id).select(
      "-razorpayContactId -razorpayFundAccountId -razorpayFundFingerprint",
    );

    res.json({
      success: true,
      token,
      operator: fullOperator,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/operators/auth/me  (protected by operatorProtect)
exports.getMe = async (req, res) => {
  try {
    const operator = await Operator.findById(req.operator._id);
    res.json({ success: true, operator });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /api/operators/auth/profile — operator updates their own profile
exports.updateProfile = async (req, res) => {
  try {
    const allowedFields = [
      "contactName",
      "phone",
      "businessName",
      "businessType",
      "city",
      "state",
      "country",
      "mainOperatingDestinations",
      "upiId",
    ];

    const updates = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    // Handle mainOperatingDestinations as comma-separated string → array
    if (typeof updates.mainOperatingDestinations === "string") {
      updates.mainOperatingDestinations = updates.mainOperatingDestinations
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    // ── Validate only the fields actually being changed ────────────────────
    const checks = {};
    if (updates.contactName !== undefined) {
      updates.contactName = collapseSpaces(updates.contactName);
      checks.contactName = validatePersonName(updates.contactName, "Full name");
    }
    if (updates.phone !== undefined) {
      updates.phone = String(updates.phone).replace(/\D/g, "");
      checks.phone = validatePhoneIN(updates.phone);
    }
    if (updates.businessName !== undefined) {
      updates.businessName = collapseSpaces(updates.businessName);
      checks.businessName = validateBounded(
        updates.businessName,
        "Business name",
        2,
        LIMITS.BUSINESS_NAME_MAX,
        { required: false },
      );
    }
    if (updates.businessType !== undefined) {
      const allowedTypes = [
        "INDIVIDUAL_GUIDE",
        "TOUR_OPERATOR",
        "TRAVEL_AGENCY",
        "EXPERIENCE_HOST",
        "",
      ];
      checks.businessType = allowedTypes.includes(updates.businessType)
        ? ""
        : "Please select a valid business type.";
    }
    if (updates.city !== undefined)
      checks.city = validatePlaceName(updates.city, "City");
    if (updates.state !== undefined)
      checks.state = validatePlaceName(updates.state, "State");
    if (updates.country !== undefined)
      checks.country = validatePlaceName(updates.country, "Country");
    if (updates.mainOperatingDestinations !== undefined)
      checks.mainOperatingDestinations = validateDestinations(
        updates.mainOperatingDestinations,
      );
    if (updates.upiId !== undefined) {
      updates.upiId = String(updates.upiId).trim();
      checks.upiId = validateUpi(updates.upiId, { required: false });
    }

    const bad = firstError(checks);
    if (bad) {
      return res
        .status(400)
        .json({ success: false, field: bad.field, message: bad.message });
    }

    // Changing the UPI ID changes where money goes — stamp it so the wallet can
    // apply its cooling-off window, and drop the cached RazorpayX fund account.
    if (updates.upiId !== undefined) {
      const current = await Operator.findById(req.operator._id).select("upiId");
      if ((current?.upiId || "") !== updates.upiId) {
        updates.payoutDetailsChangedAt = new Date();
        updates.razorpayFundAccountId = "";
        updates.razorpayFundFingerprint = "";
      }
    }

    const operator = await Operator.findByIdAndUpdate(
      req.operator._id,
      updates,
      { new: true, runValidators: true },
    );

    if (!operator) {
      return res
        .status(404)
        .json({ success: false, message: "Operator not found" });
    }

    res.json({ success: true, operator });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};
