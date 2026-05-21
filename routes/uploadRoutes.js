const express = require('express')
const router = express.Router()
const path = require('path')
const fs = require('fs')
const { protect, restrictTo } = require('../middleware/authMiddleware')

// POST /api/upload  — accepts base64 data URI, saves to disk, returns URL
router.post('/', protect, restrictTo('admin'), (req, res) => {
    try {
        const { data, filename } = req.body

        if (!data || !data.startsWith('data:image/')) {
            return res.status(400).json({ success: false, message: 'Invalid image data' })
        }

        // Strip the data URI prefix  e.g. "data:image/jpeg;base64,"
        const matches = data.match(/^data:image\/(\w+);base64,(.+)$/)
        if (!matches) {
            return res.status(400).json({ success: false, message: 'Malformed data URI' })
        }

        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1]
        const buffer = Buffer.from(matches[2], 'base64')

        // Guard: 8 MB max per image
        if (buffer.length > 8 * 1024 * 1024) {
            return res.status(413).json({ success: false, message: 'Image too large (max 8 MB)' })
        }

        const uploadDir = path.join(__dirname, '../uploads')
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })

        const safeName = `${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`
        fs.writeFileSync(path.join(uploadDir, safeName), buffer)

        // Return full absolute URL so the frontend can display it regardless of port
        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`
        const url = `${baseUrl}/uploads/${safeName}`
        res.json({ success: true, url })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
})

module.exports = router
