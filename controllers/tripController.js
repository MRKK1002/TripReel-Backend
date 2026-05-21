const Trip = require('../models/Trip')
const User = require('../models/User')

// GET /api/trips  (admin: all trips)
exports.getAllTrips = async (req, res) => {
    try {
        const { search, status, tripType, page = 1, limit = 20 } = req.query
        const query = {}

        if (status && status !== 'all') {
            query.status = { $regex: new RegExp(`^${status}$`, 'i') }
        }
        if (tripType) query.tripType = tripType

        const skip = (Number(page) - 1) * Number(limit)
        let tripsQuery = Trip.find(query)
            .populate('user', 'name email')
            .populate('package', 'title')
            .skip(skip)
            .limit(Number(limit))
            .sort({ createdAt: -1 })

        const [trips, total] = await Promise.all([
            tripsQuery,
            Trip.countDocuments(query),
        ])

        // Apply search after populate (on name/bookingId)
        const filtered = search
            ? trips.filter(
                (t) =>
                    t.tripName.toLowerCase().includes(search.toLowerCase()) ||
                    (t.user?.name || '').toLowerCase().includes(search.toLowerCase()) ||
                    t.bookingId.toLowerCase().includes(search.toLowerCase())
            )
            : trips

        res.json({ success: true, total, page: Number(page), trips: filtered })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// GET /api/trips/my  (logged-in user's trips)
exports.getMyTrips = async (req, res) => {
    try {
        const trips = await Trip.find({ user: req.user.id })
            .populate('package', 'title image_url')
            .sort({ createdAt: -1 })
        res.json({ success: true, count: trips.length, trips })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// GET /api/trips/:id
exports.getTripById = async (req, res) => {
    try {
        const trip = await Trip.findById(req.params.id)
            .populate('user', 'name email phone')
            .populate('package', 'title image_url')
        if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' })
        res.json({ success: true, trip })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// POST /api/trips
exports.createTrip = async (req, res) => {
    try {
        const trip = await Trip.create({ ...req.body, user: req.user.id })

        // Increment user's trip count
        await User.findByIdAndUpdate(req.user.id, { $inc: { tripsCount: 1 } })

        res.status(201).json({ success: true, trip })
    } catch (err) {
        res.status(400).json({ success: false, message: err.message })
    }
}

// PATCH /api/trips/:id/status
exports.updateTripStatus = async (req, res) => {
    try {
        const { status } = req.body
        const allowed = ['Confirmed', 'Pending', 'Cancelled', 'Completed']
        if (!allowed.includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status value' })
        }

        const trip = await Trip.findByIdAndUpdate(
            req.params.id,
            { status },
            { new: true, runValidators: true }
        )
        if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' })
        res.json({ success: true, trip })
    } catch (err) {
        res.status(400).json({ success: false, message: err.message })
    }
}

// DELETE /api/trips/:id
exports.deleteTrip = async (req, res) => {
    try {
        const trip = await Trip.findByIdAndDelete(req.params.id)
        if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' })
        res.json({ success: true, message: 'Trip deleted successfully' })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}
