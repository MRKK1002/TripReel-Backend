const { Operator, VALID_STATES } = require('../models/Operator')

// ── GET /api/operators  (admin only) ─────────────────────────────────────────
exports.getAllOperators = async (req, res) => {
    try {
        const { search, state, page = 1, limit = 20 } = req.query
        const query = {}
        if (search) {
            query['$or'] = [
                { businessName: { $regex: search, $options: 'i' } },
                { contactName: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
            ]
        }
        if (state && state !== 'all') query.onboardingState = state
        const skip = (Number(page) - 1) * Number(limit)
        const [operators, total] = await Promise.all([
            Operator.find(query).select('-password').skip(skip).limit(Number(limit)).sort({ createdAt: -1 }),
            Operator.countDocuments(query),
        ])
        res.json({ success: true, total, page: Number(page), operators })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// ── GET /api/operators/:id  (admin only) ─────────────────────────────────────
exports.getOperatorById = async (req, res) => {
    try {
        const operator = await Operator.findById(req.params.id).select('-password')
        if (!operator) return res.status(404).json({ success: false, message: 'Operator not found' })
        res.json({ success: true, operator })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// ── PATCH /api/operators/:id/state  (admin only) ─────────────────────────────
exports.transitionState = async (req, res) => {
    try {
        const { newState, note } = req.body
        if (!VALID_STATES.includes(newState)) {
            return res.status(400).json({ success: false, message: 'Invalid state' })
        }
        const operator = await Operator.findById(req.params.id)
        if (!operator) return res.status(404).json({ success: false, message: 'Operator not found' })

        operator.transitionHistory.push({
            fromState: operator.onboardingState,
            toState: newState,
            note: (note || '').trim(),
            performedBy: req.user._id,
            timestamp: new Date(),
        })
        operator.onboardingState = newState
        if (newState === 'REJECTED') operator.rejectionReason = (note || '').trim()

        await operator.save()
        res.json({ success: true, operator })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// ── PATCH /api/operators/:id/document-status  (admin only) ───────────────────
exports.updateDocumentStatus = async (req, res) => {
    try {
        const { key, status, remark } = req.body
        const allowedKeys = ['governmentId', 'selfieVerification', 'tradeLicense', 'panCard']
        const allowedStatuses = ['PENDING', 'APPROVED', 'REJECTED', 'REUPLOAD_REQUIRED']

        if (!allowedKeys.includes(key)) {
            return res.status(400).json({ success: false, message: 'Invalid document key' })
        }
        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' })
        }

        const operator = await Operator.findById(req.params.id)
        if (!operator) return res.status(404).json({ success: false, message: 'Operator not found' })

        if (!operator.documentStatus) operator.documentStatus = {}
        operator.documentStatus[key] = { status, remark: (remark || '').trim(), updatedAt: new Date() }
        operator.markModified('documentStatus')

        await operator.save()
        res.json({ success: true, operator })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// ── POST /api/operators/onboarding  (operator protected) ─────────────────────
exports.submitOnboarding = async (req, res) => {
    try {
        const operator = await Operator.findById(req.operator._id)
        if (!operator) return res.status(404).json({ success: false, message: 'Operator not found' })
        if (operator.onboardingState !== 'DRAFT') {
            return res.status(400).json({ success: false, message: 'Onboarding already submitted' })
        }

        const {
            contactName, phone, businessName, businessType,
            country, state, city, mainOperatingDestinations,
            accountHolderName, bankName, accountNumber, ifscCode, upiId,
            gstNumber, agreedToPolicies, confirmedAccuracy,
        } = req.body

        if (contactName) operator.contactName = contactName.trim()
        if (phone) operator.phone = phone.trim()
        if (businessName) operator.businessName = businessName.trim()
        if (businessType) operator.businessType = businessType
        if (country) operator.country = country.trim()
        if (state) operator.state = state.trim()
        if (city) operator.city = city.trim()

        const parseList = (val) => {
            if (!val) return []
            if (Array.isArray(val)) return val.filter(Boolean)
            if (typeof val === 'string') {
                try { const p = JSON.parse(val); return Array.isArray(p) ? p.filter(Boolean) : [] }
                catch { return val.split(',').map(s => s.trim()).filter(Boolean) }
            }
            return []
        }
        if (mainOperatingDestinations) operator.mainOperatingDestinations = parseList(mainOperatingDestinations)

        // Files
        if (req.files) {
            if (req.files['governmentId']?.[0]) {
                operator.governmentId = '/uploads/' + req.files['governmentId'][0].filename
                if (!operator.documentStatus) operator.documentStatus = {}
                operator.documentStatus.governmentId = { status: 'PENDING', remark: '', updatedAt: new Date() }
            }
            if (req.files['selfieVerification']?.[0]) {
                operator.selfieVerification = '/uploads/' + req.files['selfieVerification'][0].filename
                if (!operator.documentStatus) operator.documentStatus = {}
                operator.documentStatus.selfieVerification = { status: 'PENDING', remark: '', updatedAt: new Date() }
            }
            if (req.files['tradeLicense']?.[0]) {
                operator.tradeLicensePath = '/uploads/' + req.files['tradeLicense'][0].filename
                if (!operator.documentStatus) operator.documentStatus = {}
                operator.documentStatus.tradeLicense = { status: 'PENDING', remark: '', updatedAt: new Date() }
            }
            if (req.files['panCard']?.[0]) {
                operator.panCardPath = '/uploads/' + req.files['panCard'][0].filename
                if (!operator.documentStatus) operator.documentStatus = {}
                operator.documentStatus.panCard = { status: 'PENDING', remark: '', updatedAt: new Date() }
            }
        }

        if (accountHolderName) operator.accountHolderName = accountHolderName.trim()
        if (bankName) operator.bankName = bankName.trim()
        if (accountNumber) operator.accountNumber = accountNumber.trim()
        if (ifscCode) operator.ifscCode = ifscCode.trim()
        if (upiId) operator.upiId = upiId.trim()
        if (gstNumber) operator.gstNumber = gstNumber.trim()

        operator.agreedToPolicies = agreedToPolicies === 'true' || agreedToPolicies === true
        operator.confirmedAccuracy = confirmedAccuracy === 'true' || confirmedAccuracy === true

        operator.transitionHistory.push({
            fromState: 'DRAFT',
            toState: 'PENDING_APPROVAL',
            note: 'Operator submitted onboarding form',
            timestamp: new Date(),
        })
        operator.onboardingState = 'PENDING_APPROVAL'
        operator.markModified('documentStatus')

        await operator.save()
        res.json({ success: true, operator })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// ── PATCH /api/operators/documents/reupload  (operator protected) ─────────────
exports.reuploadDocument = async (req, res) => {
    try {
        const { key } = req.body
        const allowedKeys = ['governmentId', 'selfieVerification', 'tradeLicense', 'panCard']

        if (!allowedKeys.includes(key)) {
            return res.status(400).json({ success: false, message: 'Invalid document key' })
        }
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'File is required' })
        }

        const operator = await Operator.findById(req.operator._id)
        if (!operator) return res.status(404).json({ success: false, message: 'Operator not found' })

        const currentStatus = operator.documentStatus?.[key]?.status
        if (currentStatus !== 'REUPLOAD_REQUIRED' && currentStatus !== 'REJECTED') {
            return res.status(400).json({ success: false, message: 'Re-upload not allowed for this document' })
        }

        // Map key to field name
        const fieldMap = {
            governmentId: 'governmentId',
            selfieVerification: 'selfieVerification',
            tradeLicense: 'tradeLicensePath',
            panCard: 'panCardPath',
        }
        operator[fieldMap[key]] = '/uploads/' + req.file.filename
        operator.documentStatus[key] = { status: 'PENDING', remark: '', updatedAt: new Date() }
        operator.markModified('documentStatus')

        await operator.save()
        res.json({ success: true, operator })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}
