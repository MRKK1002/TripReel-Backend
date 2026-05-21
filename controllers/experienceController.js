const Experience = require('../models/Experience')

// GET /api/experiences
exports.getAllExperiences = async (req, res) => {
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

        const experiences = await Experience.find(query).sort({ createdAt: -1 })
        res.json({ success: true, count: experiences.length, experiences })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// GET /api/experiences/:id
exports.getExperienceById = async (req, res) => {
    try {
        const experience = await Experience.findById(req.params.id)
        if (!experience) return res.status(404).json({ success: false, message: 'Experience not found' })
        res.json({ success: true, experience })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// POST /api/experiences
exports.createExperience = async (req, res) => {
    try {
        const experience = await Experience.create(req.body)
        res.status(201).json({ success: true, experience })
    } catch (err) {
        res.status(400).json({ success: false, message: err.message })
    }
}

// PUT /api/experiences/:id
exports.updateExperience = async (req, res) => {
    try {
        const experience = await Experience.findByIdAndUpdate(req.params.id, req.body, {
            new: true,
            runValidators: true,
        })
        if (!experience) return res.status(404).json({ success: false, message: 'Experience not found' })
        res.json({ success: true, experience })
    } catch (err) {
        res.status(400).json({ success: false, message: err.message })
    }
}

// DELETE /api/experiences/:id
exports.deleteExperience = async (req, res) => {
    try {
        const experience = await Experience.findByIdAndDelete(req.params.id)
        if (!experience) return res.status(404).json({ success: false, message: 'Experience not found' })
        res.json({ success: true, message: 'Experience deleted successfully' })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}
