const jwt = require('jsonwebtoken')
const User = require('../models/User')

const signToken = (id) =>
    jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    })

// POST /api/auth/register
exports.register = async (req, res) => {
    try {
        const { name, email, phone, password } = req.body

        const existing = await User.findOne({ email })
        if (existing) {
            return res.status(400).json({ success: false, message: 'Email already in use' })
        }

        const user = await User.create({ name, email, phone, password })
        const token = signToken(user._id)

        res.status(201).json({
            success: true,
            token,
            user: {
                _id: user._id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                role: user.role,
                status: user.status,
            },
        })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// POST /api/auth/login
exports.login = async (req, res) => {
    try {
        const { email, password } = req.body

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password are required' })
        }

        const user = await User.findOne({ email }).select('+password')
        if (!user || !(await user.comparePassword(password))) {
            return res.status(401).json({ success: false, message: 'Invalid email or password' })
        }

        if (user.status === 'Suspended') {
            return res.status(403).json({ success: false, message: 'Your account has been suspended' })
        }

        const token = signToken(user._id)

        res.json({
            success: true,
            token,
            user: {
                _id: user._id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                role: user.role,
                status: user.status,
            },
        })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// GET /api/auth/me
exports.getMe = async (req, res) => {
    try {
        const user = await User.findById(req.user.id)
        res.json({ success: true, user })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}
