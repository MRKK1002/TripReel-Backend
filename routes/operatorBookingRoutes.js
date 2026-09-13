const express = require("express");
const router = express.Router();
const {
  operatorGetMyBookings,
  operatorGetBookingById,
  operatorBookingSummary,
  operatorCancelBooking,
  operatorCancelBatch,
} = require("../controllers/tripBookingController");
const {
  operatorProtect,
  requireApprovedOperator,
} = require("../middleware/operatorAuthMiddleware");

router.get("/summary", operatorProtect, operatorBookingSummary);
router.get("/", operatorProtect, operatorGetMyBookings);
// Keep named/static GET routes above this owned detail route.
router.get("/:id", operatorProtect, operatorGetBookingById);
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
