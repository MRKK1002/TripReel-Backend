const Package = require('../models/Package')

// ── Public / shared ───────────────────────────────────────────────────────────

// GET /api/packages  (public — only approved packages)
exports.getAllPackages = async (req, res) => {
    try {
        const { search, category, badge, page = 1, limit = 20 } = req.query
        const query = { isActive: true, status: { $in: ['APPROVED'] } }

        if (search) {
            query.$or = [
                { title: { $regex: search, $options: 'i' } },
                { location: { $regex: search, $options: 'i' } },
            ]
        }
        if (category) {
            query.$and = [
                ...(query.$and || []),
                { $or: [{ category: { $regex: category, $options: 'i' } }, { categories: { $regex: category, $options: 'i' } }] },
            ]
        }
        if (badge) query.badge = badge

        const skip = (Number(page) - 1) * Number(limit)
        const [packages, total] = await Promise.all([
            Package.find(query).skip(skip).limit(Number(limit)).sort({ createdAt: -1 }),
            Package.countDocuments(query),
        ])

        res.json({ success: true, total, page: Number(page), packages })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// GET /api/packages/:id  (public)
exports.getPackageById = async (req, res) => {
    try {
        const pkg = await Package.findById(req.params.id)
        if (!pkg) return res.status(404).json({ success: false, message: 'Package not found' })
        res.json({ success: true, package: pkg })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// ── Admin ─────────────────────────────────────────────────────────────────────

// GET /api/packages/admin/all  (admin — all packages regardless of status)
exports.adminGetAllPackages = async (req, res) => {
    try {
        const { search, status, page = 1, limit = 20 } = req.query
        const query = {}

        if (search) {
            query.$or = [
                { title: { $regex: search, $options: 'i' } },
                { location: { $regex: search, $options: 'i' } },
            ]
        }
        if (status && status !== 'all') query.status = status

        const skip = (Number(page) - 1) * Number(limit)
        const [packages, total] = await Promise.all([
            Package.find(query)
                .populate('operatorId', 'businessName contactName email')
                .skip(skip)
                .limit(Number(limit))
                .sort({ createdAt: -1 }),
            Package.countDocuments(query),
        ])

        res.json({ success: true, total, page: Number(page), packages })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// PATCH /api/packages/:id/review  (admin — approve, reject, or request revision)
exports.reviewPackage = async (req, res) => {
    try {
        const { action, adminNotes } = req.body
        // action: 'approve' | 'reject' | 'needs_revision'

        const statusMap = {
            approve: 'APPROVED',
            reject: 'REJECTED',
            needs_revision: 'NEEDS_REVISION',
        }

        if (!statusMap[action]) {
            return res.status(400).json({ success: false, message: 'Invalid action. Use approve, reject, or needs_revision.' })
        }

        const update = {
            status: statusMap[action],
            adminNotes: adminNotes || '',
            isActive: action === 'approve',
        }

        const pkg = await Package.findByIdAndUpdate(req.params.id, update, { new: true })
        if (!pkg) return res.status(404).json({ success: false, message: 'Package not found' })

        res.json({ success: true, package: pkg })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// DELETE /api/packages/:id  (admin)
exports.deletePackage = async (req, res) => {
    try {
        const pkg = await Package.findByIdAndDelete(req.params.id)
        if (!pkg) return res.status(404).json({ success: false, message: 'Package not found' })
        res.json({ success: true, message: 'Package deleted successfully' })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// ── Operator ──────────────────────────────────────────────────────────────────

// GET /api/packages/operator/mine  (operator — their own packages)
exports.operatorGetMyPackages = async (req, res) => {
    try {
        const packages = await Package.find({ operatorId: req.operator._id }).sort({ createdAt: -1 })
        res.json({ success: true, packages })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// POST /api/packages/operator  (operator — create package, starts as PENDING)
exports.operatorCreatePackage = async (req, res) => {
    try {
        const body = { ...req.body }

        // slot-0 → image_url (cover), slots 1-3 → images (gallery)
        if (req.files) {
            if (req.files['image_url']?.[0]) {
                body.image_url = '/uploads/' + req.files['image_url'][0].filename
            } else if (body.existing_image_url) {
                body.image_url = body.existing_image_url
            }
            if (req.files['images']?.length) {
                const newUrls = req.files['images'].map(f => '/uploads/' + f.filename)
                const existingUrls = body.existing_images
                    ? (Array.isArray(body.existing_images) ? body.existing_images : [body.existing_images]).filter(Boolean)
                    : []
                body.images = [...existingUrls, ...newUrls]
            } else if (body.existing_images) {
                body.images = Array.isArray(body.existing_images)
                    ? body.existing_images.filter(Boolean)
                    : [body.existing_images].filter(Boolean)
            }
        }
        delete body.existing_image_url
        delete body.existing_images

        const parseJSON = (val, fallback) => {
            if (typeof val !== 'string') return val
            try { return JSON.parse(val) } catch { return fallback }
        }

        ;['highlights', 'inclusions', 'exclusions', 'itinerary', 'addons', 'categories', 'videos'].forEach(key => {
            if (typeof body[key] === 'string') body[key] = parseJSON(body[key], [])
        })
        ;['hotelDetails', 'transportDetails', 'pricing', 'availability', 'policies', 'offer'].forEach(key => {
            if (typeof body[key] === 'string') body[key] = parseJSON(body[key], {})
        })

        const normalizeDate = (val) => {
            if (!val) return undefined
            const d = new Date(val)
            return Number.isNaN(d.getTime()) ? undefined : d
        }
        if (body.availability) {
            body.availability.startDate = normalizeDate(body.availability.startDate)
            body.availability.endDate = normalizeDate(body.availability.endDate)
            body.availability.bookingDeadline = normalizeDate(body.availability.bookingDeadline)
        }

        const submissionMode = (body.submissionMode || 'SUBMIT').toString().toUpperCase()
        delete body.submissionMode

        const status = submissionMode === 'DRAFT' ? 'DRAFT' : 'PENDING'

        const pkg = await Package.create({
            ...body,
            operatorId: req.operator._id,
            status,
            isActive: false,
        })
        res.status(201).json({ success: true, package: pkg })
    } catch (err) {
        res.status(400).json({ success: false, message: err.message })
    }
}

// PUT /api/packages/operator/:id  (operator — edit their own package, resets to PENDING)
exports.operatorUpdatePackage = async (req, res) => {
    try {
        const pkg = await Package.findOne({ _id: req.params.id, operatorId: req.operator._id })
        if (!pkg) return res.status(404).json({ success: false, message: 'Package not found or not yours' })

        if (pkg.status === 'APPROVED') {
            return res.status(400).json({ success: false, message: 'Approved packages cannot be edited. Contact admin.' })
        }

        const body = { ...req.body }

        // slot-0 → image_url (cover), slots 1-3 → images (gallery)
        if (req.files) {
            if (req.files['image_url']?.[0]) {
                body.image_url = '/uploads/' + req.files['image_url'][0].filename
            } else if (body.existing_image_url) {
                body.image_url = body.existing_image_url
            }
            if (req.files['images']?.length) {
                const newUrls = req.files['images'].map(f => '/uploads/' + f.filename)
                const existingUrls = body.existing_images
                    ? (Array.isArray(body.existing_images) ? body.existing_images : [body.existing_images]).filter(Boolean)
                    : []
                body.images = [...existingUrls, ...newUrls]
            } else if (body.existing_images) {
                body.images = Array.isArray(body.existing_images)
                    ? body.existing_images.filter(Boolean)
                    : [body.existing_images].filter(Boolean)
            }
        }
        delete body.existing_image_url
        delete body.existing_images

        const parseJSON = (val, fallback) => {
            if (typeof val !== 'string') return val
            try { return JSON.parse(val) } catch { return fallback }
        }

        ;['highlights', 'inclusions', 'exclusions', 'itinerary', 'addons', 'categories', 'videos'].forEach(key => {
            if (typeof body[key] === 'string') body[key] = parseJSON(body[key], [])
        })
        ;['hotelDetails', 'transportDetails', 'pricing', 'availability', 'policies', 'offer'].forEach(key => {
            if (typeof body[key] === 'string') body[key] = parseJSON(body[key], {})
        })

        const normalizeDate = (val) => {
            if (!val) return undefined
            const d = new Date(val)
            return Number.isNaN(d.getTime()) ? undefined : d
        }
        if (body.availability) {
            body.availability.startDate = normalizeDate(body.availability.startDate)
            body.availability.endDate = normalizeDate(body.availability.endDate)
            body.availability.bookingDeadline = normalizeDate(body.availability.bookingDeadline)
        }

        const submissionMode = (body.submissionMode || 'SUBMIT').toString().toUpperCase()
        delete body.submissionMode

        const nextStatus = submissionMode === 'DRAFT' ? 'DRAFT' : 'PENDING'
        const resetNotes = nextStatus === 'PENDING'

        const updated = await Package.findByIdAndUpdate(
            req.params.id,
            { ...body, status: nextStatus, adminNotes: resetNotes ? '' : pkg.adminNotes, isActive: false },
            { new: true, runValidators: true }
        )
        res.json({ success: true, package: updated })
    } catch (err) {
        res.status(400).json({ success: false, message: err.message })
    }
}

// DELETE /api/packages/operator/:id  (operator — delete their own package)
exports.operatorDeletePackage = async (req, res) => {
    try {
        const pkg = await Package.findOneAndDelete({ _id: req.params.id, operatorId: req.operator._id })
        if (!pkg) return res.status(404).json({ success: false, message: 'Package not found or not yours' })
        res.json({ success: true, message: 'Package deleted' })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}
