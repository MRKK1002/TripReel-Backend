const express = require('express')
const router = express.Router()
const {
    getAllCategories,
    createCategory,
    updateCategory,
    deleteCategory,
} = require('../controllers/categoryController')
const { protect, restrictTo } = require('../middleware/authMiddleware')

// Public
router.get('/', getAllCategories)

// Admin only
router.post('/', protect, restrictTo('admin'), createCategory)
router.put('/:id', protect, restrictTo('admin'), updateCategory)
router.delete('/:id', protect, restrictTo('admin'), deleteCategory)

module.exports = router
