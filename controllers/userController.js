const User = require('../models/User')

// GET /api/users
exports.getAllUsers = async (req, res) => {
    try {
        const { search, status, page = 1, limit = 20 } = req.query
        const query = {}

        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
            ]
        }
        if (status && status !== 'all') {
            query.status = { $regex: new RegExp(`^${status}$`, 'i') }
        }

        const skip = (Number(page) - 1) * Number(limit)
        const [users, total] = await Promise.all([
            User.find(query).skip(skip).limit(Number(limit)).sort({ createdAt: -1 }),
            User.countDocuments(query),
        ])

        res.json({ success: true, total, page: Number(page), users })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// GET /api/users/:id
exports.getUserById = async (req, res) => {
    try {
        const user = await User.findById(req.params.id)
        if (!user) return res.status(404).json({ success: false, message: 'User not found' })
        res.json({ success: true, user })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// PATCH /api/users/:id/status
exports.updateUserStatus = async (req, res) => {
    try {
        const { status } = req.body
        const allowed = ['Active', 'Inactive', 'Suspended']
        if (!allowed.includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status value' })
        }

        const user = await User.findByIdAndUpdate(
            req.params.id,
            { status },
            { new: true, runValidators: true }
        )
        if (!user) return res.status(404).json({ success: false, message: 'User not found' })

        res.json({ success: true, user })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// DELETE /api/users/:id
exports.deleteUser = async (req, res) => {
    try {
        const user = await User.findByIdAndDelete(req.params.id)
        if (!user) return res.status(404).json({ success: false, message: 'User not found' })
        res.json({ success: true, message: 'User deleted successfully' })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}
