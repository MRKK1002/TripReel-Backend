const Banner = require('../models/Banner')

// GET /api/banners
exports.getAllBanners = async (req, res) => {
    try {
        const banners = await Banner.find().sort({ order: 1, createdAt: -1 })
        res.json({ success: true, count: banners.length, banners })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// POST /api/banners
exports.createBanner = async (req, res) => {
    try {
        const banner = await Banner.create(req.body)
        res.status(201).json({ success: true, banner })
    } catch (err) {
        res.status(400).json({ success: false, message: err.message })
    }
}

// PUT /api/banners/:id
exports.updateBanner = async (req, res) => {
    try {
        const banner = await Banner.findByIdAndUpdate(req.params.id, req.body, {
            new: true,
            runValidators: true,
        })
        if (!banner) return res.status(404).json({ success: false, message: 'Banner not found' })
        res.json({ success: true, banner })
    } catch (err) {
        res.status(400).json({ success: false, message: err.message })
    }
}

// DELETE /api/banners/:id
exports.deleteBanner = async (req, res) => {
    try {
        const banner = await Banner.findByIdAndDelete(req.params.id)
        if (!banner) return res.status(404).json({ success: false, message: 'Banner not found' })
        res.json({ success: true, message: 'Banner deleted successfully' })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}
