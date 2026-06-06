const jwt = require("jsonwebtoken");
const { Operator } = require("../models/Operator");

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

// POST /api/operators/auth/register
exports.register = async (req, res) => {
  try {
    const { contactName, email, phone, password } = req.body;

    if (!password || password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters",
      });
    }

    const existing = await Operator.findOne({ email });
    if (existing) {
      return res
        .status(400)
        .json({ success: false, message: "Email already in use" });
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

    if (operator.onboardingState === "SUSPENDED") {
      return res
        .status(403)
        .json({ success: false, message: "Your account has been suspended" });
    }

    if (operator.onboardingState === "REJECTED") {
      return res.status(403).json({
        success: false,
        message: "Your application was rejected. Please contact support.",
      });
    }

    const token = signToken(operator._id);

    // Return full operator data (exclude password)
    const fullOperator = await Operator.findById(operator._id);

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
