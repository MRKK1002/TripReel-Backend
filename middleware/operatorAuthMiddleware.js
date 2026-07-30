const jwt = require("jsonwebtoken");
const { Operator, ACTIVE_STATES } = require("../models/Operator");

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
      // Suspended: block all writes, and allow only the handful of reads needed
      // to render the suspension notice. Previously every GET stayed open, so a
      // suspended operator kept reading bookings, customer PII and wallet data.
      if (req.method !== "GET") {
        return res.status(403).json({
          success: false,
          code: "OPERATOR_SUSPENDED",
          message: "Your account is suspended. You cannot perform this action.",
        });
      }
      const path = req.baseUrl + req.path;
      const suspendedReadAllowlist = [
        "/api/operators/auth/me",
        "/api/notifications/operator/my",
      ];
      if (!suspendedReadAllowlist.some((p) => path.startsWith(p))) {
        return res.status(403).json({
          success: false,
          code: "OPERATOR_SUSPENDED",
          message:
            "Your account is suspended. Contact admin to restore access.",
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

// ─────────────────────────────────────────────────────────────────────────────
// Gate every business action (packages, batches, coupons, listings, payouts…)
// behind admin approval. Must run AFTER operatorProtect.
//
// Without this the APPROVED check lived only in the React router, so any
// unapproved operator holding a valid JWT could create data by calling the API
// directly.
// ─────────────────────────────────────────────────────────────────────────────
const STATE_MESSAGES = {
  DRAFT:
    "Please complete your onboarding application before using this feature.",
  PENDING_APPROVAL:
    "Your application is still under review. You can start once an admin approves your account.",
  CHANGES_REQUESTED:
    "An admin has requested corrections to your application. Please update the requested details and resubmit for approval.",
  REJECTED:
    "Your application was not approved. Please correct the requested details and re-apply.",
  SUSPENDED: "Your account is suspended. You cannot perform this action.",
};

exports.requireApprovedOperator = (req, res, next) => {
  const state = req.operator?.onboardingState;

  if (ACTIVE_STATES.includes(state)) return next();

  return res.status(403).json({
    success: false,
    code: "OPERATOR_NOT_APPROVED",
    onboardingState: state,
    message:
      STATE_MESSAGES[state] ||
      "Your account is not approved yet. You cannot perform this action.",
  });
};

// Read-only variant: unapproved operators may look at their own (empty) data
// but never mutate it. Use where GET should stay open.
exports.requireApprovedOperatorForWrites = (req, res, next) => {
  if (req.method === "GET") return next();
  return exports.requireApprovedOperator(req, res, next);
};
