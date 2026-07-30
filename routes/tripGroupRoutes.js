const express = require("express");
const router = express.Router();
const {
  operatorProtect,
  requireApprovedOperator,
} = require("../middleware/operatorAuthMiddleware");
const {
  getMyGroups,
  createGroup,
} = require("../controllers/tripGroupController");
const {
  updateGroup,
  deleteGroup,
} = require("../controllers/tripGroupController2");

router.get("/", operatorProtect, getMyGroups);
router.post("/", operatorProtect, requireApprovedOperator, createGroup);
router.patch("/:id", operatorProtect, requireApprovedOperator, updateGroup);
router.delete("/:id", operatorProtect, requireApprovedOperator, deleteGroup);

module.exports = router;
