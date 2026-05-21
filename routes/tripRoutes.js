const express = require('express')
const router = express.Router()
const {
    getAllTrips,
    getMyTrips,
    getTripById,
    createTrip,
    updateTripStatus,
    deleteTrip,
} = require('../controllers/tripController')
const { protect, restrictTo } = require('../middleware/authMiddleware')

// All trip routes require authentication
router.use(protect)

router.get('/my', getMyTrips)                          // user's own trips
router.get('/', restrictTo('admin'), getAllTrips)       // admin: all trips
router.get('/:id', getTripById)
router.post('/', createTrip)
router.patch('/:id/status', restrictTo('admin'), updateTripStatus)
router.delete('/:id', restrictTo('admin'), deleteTrip)

module.exports = router
