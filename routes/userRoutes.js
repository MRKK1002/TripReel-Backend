const express = require("express");
const router = express.Router();
const {
  getAllUsers,
  getUserById,
  updateUserStatus,
  deleteUser,
  getDeletedArchive,
} = require("../controllers/userController");
const { protect, restrictTo } = require("../middleware/authMiddleware");

// Admin only
router.use(protect, restrictTo("admin"));

// Must come before '/:id' so it isn't captured as an id
router.get("/deleted-archive", getDeletedArchive);

router.get("/", getAllUsers);
router.get("/:id", getUserById);
router.patch("/:id/status", updateUserStatus);
router.delete("/:id", deleteUser);

module.exports = router;
