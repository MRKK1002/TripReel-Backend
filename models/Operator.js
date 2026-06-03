const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')

const VALID_STATES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SUSPENDED']

const transitionHistorySchema = new mongoose.Schema(
    {
        fromState: { type: String, required: true },
        toState: { type: String, required: true },
        note: { type: String, default: '' },
        performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        timestamp: { type: Date, default: Date.now },
    },
    { _id: false }
)

const operatorSchema = new mongoose.Schema(
    {
        // ── Step 1: Basic Information ─────────────────────────────────────────
        contactName: { type: String, required: true, trim: true },
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        phone: { type: String, trim: true },
        password: { type: String, required: true, minlength: 8, select: false },

        // ── Step 2: Business Information ──────────────────────────────────────
        businessName: { type: String, trim: true },
        businessType: {
            type: String,
            enum: ['INDIVIDUAL_GUIDE', 'TOUR_OPERATOR', 'TRAVEL_AGENCY', 'EXPERIENCE_HOST', ''],
            default: '',
        },

        // ── Step 3: Location ──────────────────────────────────────────────────
        country: { type: String, trim: true },
        state: { type: String, trim: true },
        city: { type: String, trim: true },
        mainOperatingDestinations: [{ type: String, trim: true }], // e.g. ["Dubai","Goa","Bali"]

        // ── Step 4: Identity Verification ────────────────────────────────────
        profilePhoto: { type: String }, // file path
        governmentId: { type: String }, // file path
        selfieVerification: { type: String }, // file path (optional)

        // ── Step 5: Bank Details ──────────────────────────────────────────────
        accountHolderName: { type: String, trim: true },
        bankName: { type: String, trim: true },
        accountNumber: { type: String, trim: true },
        ifscCode: { type: String, trim: true },
        upiId: { type: String, trim: true }, // optional

        // ── Step 6: Business Documents ────────────────────────────────────────
        // company docs
        gstNumber: { type: String, trim: true }, // optional
        tradeLicensePath: { type: String }, // file path, optional
        panCardPath: { type: String }, // file path, required for both
        // individual also just needs panCardPath

        // ── Step 7: Terms ─────────────────────────────────────────────────────
        agreedToPolicies: { type: Boolean, default: false },
        confirmedAccuracy: { type: Boolean, default: false },

        // ── Document status (per-doc review by admin) ─────────────────────────
        documentStatus: {
            governmentId:       { status: { type: String, enum: ['PENDING','APPROVED','REJECTED','REUPLOAD_REQUIRED'], default: 'PENDING' }, remark: { type: String, default: '' }, updatedAt: { type: Date } },
            selfieVerification: { status: { type: String, enum: ['PENDING','APPROVED','REJECTED','REUPLOAD_REQUIRED'], default: 'PENDING' }, remark: { type: String, default: '' }, updatedAt: { type: Date } },
            tradeLicense:       { status: { type: String, enum: ['PENDING','APPROVED','REJECTED','REUPLOAD_REQUIRED'], default: 'PENDING' }, remark: { type: String, default: '' }, updatedAt: { type: Date } },
            panCard:            { status: { type: String, enum: ['PENDING','APPROVED','REJECTED','REUPLOAD_REQUIRED'], default: 'PENDING' }, remark: { type: String, default: '' }, updatedAt: { type: Date } },
        },

        // ── Approval state ────────────────────────────────────────────────────
        onboardingState: { type: String, enum: VALID_STATES, default: 'DRAFT' },
        rejectionReason: { type: String, trim: true },
        transitionHistory: [transitionHistorySchema],
    },
    { timestamps: true }
)

// Hash password before saving
operatorSchema.pre('save', async function (next) {
    if (!this.isModified('password')) return next()
    this.password = await bcrypt.hash(this.password, 12)
    next()
})

// Compare password
operatorSchema.methods.comparePassword = async function (candidate) {
    return bcrypt.compare(candidate, this.password)
}

module.exports = { Operator: mongoose.model('Operator', operatorSchema), VALID_STATES }
