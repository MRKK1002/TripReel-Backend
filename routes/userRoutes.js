const express = require('express')
const router = express.Router()
const {
    getAllUsers,
    getUserById,
    updateUserStatus,
    deleteUser,
} = require('../controllers/userController')
const { protect, restrictTo } = require('../middleware/authMiddleware')

// Admin only
router.use(protect, restrictTo('admin'))

router.get('/', getAllUsers)
router.get('/:id', getUserById)
router.patch('/:id/status', updateUserStatus)
router.delete('/:id', deleteUser)

module.exports = router
