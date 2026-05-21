const jwt = require('jsonwebtoken')
const User = require('../models/User')

// Verify JWT and attach user to request
exports.protect = async (req, res, next) => {
    try {
        let token

        if (req.headers.authorization?.startsWith('Bearer ')) {
            token = req.headers.authorization.split(' ')[1]
        }

        if (!token) {
            return res.status(401).json({ success: false, message: 'Not authorized, no token' })
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET)
        const user = await User.findById(decoded.id)

        if (!user) {
            return res.status(401).json({ success: false, message: 'User no longer exists' })
        }

        if (user.status === 'Suspended') {
            return res.status(403).json({ success: false, message: 'Your account has been suspended' })
        }

        req.user = user
        next()
    } catch (err) {
        res.status(401).json({ success: false, message: 'Not authorized, invalid token' })
    }
}

// Restrict to specific roles
exports.restrictTo = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to perform this action',
            })
        }
        next()
    }
}
