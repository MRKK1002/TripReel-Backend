const Wishlist = require('../models/Wishlist')

// GET /api/wishlists  (admin: all wishlists)
exports.getAllWishlists = async (req, res) => {
    try {
        const { search } = req.query
        let query = {}

        const wishlists = await Wishlist.find(query)
            .populate('user', 'name email')
            .populate('packages', 'title image_url')
            .sort({ createdAt: -1 })

        const filtered = search
            ? wishlists.filter(
                (w) =>
                    w.name.toLowerCase().includes(search.toLowerCase()) ||
                    (w.user?.name || '').toLowerCase().includes(search.toLowerCase()) ||
                    (w.user?.email || '').toLowerCase().includes(search.toLowerCase())
            )
            : wishlists

        res.json({ success: true, count: filtered.length, wishlists: filtered })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// GET /api/wishlists/my  (logged-in user's wishlists)
exports.getMyWishlists = async (req, res) => {
    try {
        const wishlists = await Wishlist.find({ user: req.user.id })
            .populate('packages', 'title image_url images price location')
            .sort({ createdAt: -1 })
        res.json({ success: true, count: wishlists.length, wishlists })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// POST /api/wishlists
exports.createWishlist = async (req, res) => {
    try {
        const wishlist = await Wishlist.create({ ...req.body, user: req.user.id })
        res.status(201).json({ success: true, wishlist })
    } catch (err) {
        res.status(400).json({ success: false, message: err.message })
    }
}

// POST /api/wishlists/:id/packages  — add a package to wishlist
exports.addPackageToWishlist = async (req, res) => {
    try {
        const { packageId } = req.body
        const wishlist = await Wishlist.findOneAndUpdate(
            { _id: req.params.id, user: req.user.id },
            { $addToSet: { packages: packageId } },
            { new: true }
        ).populate('packages', 'title image_url images price location')

        if (!wishlist) return res.status(404).json({ success: false, message: 'Wishlist not found' })
        res.json({ success: true, wishlist })
    } catch (err) {
        res.status(400).json({ success: false, message: err.message })
    }
}

// DELETE /api/wishlists/:id/packages/:packageId  — remove a package
exports.removePackageFromWishlist = async (req, res) => {
    try {
        const wishlist = await Wishlist.findOneAndUpdate(
            { _id: req.params.id, user: req.user.id },
            { $pull: { packages: req.params.packageId } },
            { new: true }
        ).populate('packages', 'title image_url images price location')

        if (!wishlist) return res.status(404).json({ success: false, message: 'Wishlist not found' })
        res.json({ success: true, wishlist })
    } catch (err) {
        res.status(400).json({ success: false, message: err.message })
    }
}

// DELETE /api/wishlists/:id
exports.deleteWishlist = async (req, res) => {
    try {
        const wishlist = await Wishlist.findByIdAndDelete(req.params.id)
        if (!wishlist) return res.status(404).json({ success: false, message: 'Wishlist not found' })
        res.json({ success: true, message: 'Wishlist deleted successfully' })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}
