const express = require("express");
const router = express.Router();
const {
  operatorGetMyBookings,
  operatorBookingSummary,
  operatorCancelBooking,
  operatorCancelBatch,
} = require("../controllers/tripBookingController");
const {
  operatorProtect,
  requireApprovedOperator,
} = require("../middleware/operatorAuthMiddleware");

router.get("/", operatorProtect, operatorGetMyBookings);
router.get("/summary", operatorProtect, operatorBookingSummary);
router.post(
  "/:id/cancel",
  operatorProtect,
  requireApprovedOperator,
  operatorCancelBooking,
);
router.post(
  "/batch/:batchId/cancel",
  operatorProtect,
  requireApprovedOperator,
  operatorCancelBatch,
);

module.exports = router;
