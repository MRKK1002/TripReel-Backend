const express = require('express')
const router = express.Router()
const {
    getAllBanners,
    createBanner,
    updateBanner,
    deleteBanner,
} = require('../controllers/bannerController')
const { protect, restrictTo } = require('../middleware/authMiddleware')
const upload = require('../middleware/uploadMiddleware')

// Public — mobile app reads banners
router.get('/', getAllBanners)

// Admin only
router.post('/', protect, restrictTo('admin'), upload.single('image'), createBanner)
router.put('/:id', protect, restrictTo('admin'), upload.single('image'), updateBanner)
router.delete('/:id', protect, restrictTo('admin'), deleteBanner)

module.exports = router
