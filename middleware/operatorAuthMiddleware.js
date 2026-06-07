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
      // Allow access to auth/me, notifications, and profile but block other operations
      // The frontend will show the suspended status page
      // Only block write operations at route level, not here
    }

    req.operator = operator;
    next();
  } catch (err) {
    res
      .status(401)
      .json({ success: false, message: "Not authorized, invalid token" });
  }
};
