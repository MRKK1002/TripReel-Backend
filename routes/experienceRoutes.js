const express = require('express')
const router = express.Router()
const {
    getAllExperiences,
    getExperienceById,
    createExperience,
    updateExperience,
    deleteExperience,
} = require('../controllers/experienceController')
const { protect, restrictTo } = require('../middleware/authMiddleware')
const upload = require('../middleware/uploadMiddleware')

// Public
router.get('/', getAllExperiences)
router.get('/:id', getExperienceById)

// Admin only
router.post('/', protect, restrictTo('admin'), upload.single('image'), createExperience)
router.put('/:id', protect, restrictTo('admin'), upload.single('image'), updateExperience)
router.delete('/:id', protect, restrictTo('admin'), deleteExperience)

module.exports = router
