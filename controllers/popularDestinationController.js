const PopularDestination = require('../models/PopularDestination')

// GET /api/popular-destinations
exports.getAllDestinations = async (req, res) => {
    try {
        const { search, isPopular } = req.query
        const query = { isActive: true }

        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { location: { $regex: search, $options: 'i' } },
            ]
        }
        if (isPopular !== undefined) query.isPopular = isPopular === 'true'

        const destinations = await PopularDestination.find(query).sort({ createdAt: -1 })
        res.json({ success: true, count: destinations.length, destinations })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// GET /api/popular-destinations/:id
exports.getDestinationById = async (req, res) => {
    try {
        const destination = await PopularDestination.findById(req.params.id)
        if (!destination) return res.status(404).json({ success: false, message: 'Destination not found' })
        res.json({ success: true, destination })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// POST /api/popular-destinations
exports.createDestination = async (req, res) => {
    try {
        const destination = await PopularDestination.create(req.body)
        res.status(201).json({ success: true, destination })
    } catch (err) {
        res.status(400).json({ success: false, message: err.message })
    }
}

// PUT /api/popular-destinations/:id
exports.updateDestination = async (req, res) => {
    try {
        const destination = await PopularDestination.findByIdAndUpdate(req.params.id, req.body, {
            new: true,
            runValidators: true,
        })
        if (!destination) return res.status(404).json({ success: false, message: 'Destination not found' })
        res.json({ success: true, destination })
    } catch (err) {
        res.status(400).json({ success: false, message: err.message })
    }
}

// DELETE /api/popular-destinations/:id
exports.deleteDestination = async (req, res) => {
    try {
        const destination = await PopularDestination.findByIdAndDelete(req.params.id)
        if (!destination) return res.status(404).json({ success: false, message: 'Destination not found' })
        res.json({ success: true, message: 'Destination deleted successfully' })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}
