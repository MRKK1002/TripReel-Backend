const express = require("express");
const router = express.Router();
const {
  operatorProtect,
  requireApprovedOperator,
} = require("../middleware/operatorAuthMiddleware");
const {
  getTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} = require("../controllers/tripDocTemplateController");

router.get("/", operatorProtect, getTemplates);
router.post("/", operatorProtect, requireApprovedOperator, createTemplate);
router.put("/:id", operatorProtect, requireApprovedOperator, updateTemplate);
router.delete("/:id", operatorProtect, requireApprovedOperator, deleteTemplate);

module.exports = router;
