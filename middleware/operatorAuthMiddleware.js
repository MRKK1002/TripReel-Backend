const jwt = require("jsonwebtoken");
const { Operator } = require("../models/Operator");

// Verify JWT and attach operator to request
exports.operatorProtect = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization?.startsWith("Bearer ")) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (!token) {
      return res
        .status(401)
        .json({ success: false, message: "Not authorized, no token" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const operator = await Operator.findById(decoded.id);

    if (!operator) {
      return res
        .status(401)
        .json({ success: false, message: "Operator no longer exists" });
    }

    if (operator.onboardingState === "SUSPENDED") {
      // Suspended operators can only read (GET) — block all write operations
      if (req.method !== "GET") {
        return res.status(403).json({
          success: false,
          message: "Your account is suspended. You cannot perform this action.",
        });
      }
    }

    req.operator = operator;
    next();
  } catch (err) {
    res
      .status(401)
      .json({ success: false, message: "Not authorized, invalid token" });
  }
};
