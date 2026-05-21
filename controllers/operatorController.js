const { Operator, VALID_STATES } = require('../models/Operator')

// GET /api/operators  (admin only)
exports.getAllOperators = async (req, res) => {
    try {
        const { search, state, page = 1, limit = 20 } = req.query
        const query = {}

        if (search) {
            query['$or'] = [
                { businessName: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
            ]
        }

        if (state && state !== 'all') {
            query.onboardingState = state
        }

        const skip = (Number(page) - 1) * Number(limit)

        const [operators, total] = await Promise.all([
            Operator.find(query).skip(skip).limit(Number(limit)).sort({ createdAt: -1 }),
            Operator.countDocuments(query),
        ])

        res.json({ success: true, total, page: Number(page), operators })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// GET /api/operators/:id  (admin only)
exports.getOperatorById = async (req, res) => {
    try {
        const operator = await Operator.findById(req.params.id)
        if (!operator) {
            return res.status(404).json({ success: false, message: 'Operator not found' })
        }
        res.json({ success: true, operator })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// PATCH /api/operators/:id/state  (admin only)
exports.transitionState = async (req, res) => {
    try {
        const { newState, note } = req.body

        if (!VALID_STATES.includes(newState)) {
            return res.status(400).json({ success: false, message: 'Invalid state' })
        }

        if (!note || note.trim().length === 0) {
            return res.status(400).json({ success: false, message: 'Transition note is required' })
        }

        const operator = await Operator.findById(req.params.id)
        if (!operator) {
            return res.status(404).json({ success: false, message: 'Operator not found' })
        }

        operator.transitionHistory.push({
            fromState: operator.onboardingState,
            toState: newState,
            note: note.trim(),
            performedBy: req.user._id,
            timestamp: new Date(),
        })

        operator.onboardingState = newState

        await operator.save()

        res.json({ success: true, operator })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// POST /api/operators/onboarding  (operator protected)
exports.submitOnboarding = async (req, res) => {
    try {
        const { businessName, registeredAddress, gstin, pan, tan, bankAccountNumber } = req.body

        const operator = await Operator.findById(req.operator._id)
        if (!operator) {
            return res.status(404).json({ success: false, message: 'Operator not found' })
        }

        if (operator.onboardingState !== 'DRAFT') {
            return res.status(400).json({ success: false, message: 'Onboarding form already submitted' })
        }

        // Update business fields
        operator.businessName = businessName
        operator.registeredAddress = registeredAddress
        operator.gstin = gstin
        operator.pan = pan
        operator.tan = tan
        operator.bankAccountNumber = bankAccountNumber

        // Update document paths from uploaded files
        const documentFields = [
            'gstCertificate',
            'pan',
            'incorporationCertificate',
            'bankProof',
            'tan',
            'industryAssociationCertificate',
            'liabilityInsuranceCertificate',
        ]

        if (req.files) {
            for (const fieldName of documentFields) {
                if (req.files[fieldName] && req.files[fieldName][0]) {
                    operator.documents[fieldName] = '/uploads/' + req.files[fieldName][0].filename
                }
            }
        }

        operator.onboardingState = 'DOCUMENTS_SUBMITTED'

        await operator.save()

        res.json({ success: true, operator })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}
