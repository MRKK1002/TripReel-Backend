const express = require('express')
const router = express.Router()
const {
    getAllDestinations,
    getDestinationById,
    createDestination,
    updateDestination,
    deleteDestination,
} = require('../controllers/popularDestinationController')
const { protect, restrictTo } = require('../middleware/authMiddleware')
const upload = require('../middleware/uploadMiddleware')

// Public
router.get('/', getAllDestinations)
router.get('/:id', getDestinationById)

// Admin only
router.post('/', protect, restrictTo('admin'), upload.single('image'), createDestination)
router.put('/:id', protect, restrictTo('admin'), upload.single('image'), updateDestination)
router.delete('/:id', protect, restrictTo('admin'), deleteDestination)

module.exports = router
