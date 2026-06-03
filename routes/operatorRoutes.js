const express = require('express')
const router = express.Router()
const { protect, restrictTo } = require('../middleware/authMiddleware')
const { operatorProtect } = require('../middleware/operatorAuthMiddleware')
const operatorUpload = require('../middleware/operatorUploadMiddleware')
const {
    getAllOperators, getOperatorById, transitionState,
    submitOnboarding, reuploadDocument, updateDocumentStatus,
} = require('../controllers/operatorController')

// ── Operator: submit onboarding ───────────────────────────────────────────────
router.post('/onboarding', operatorProtect,
    operatorUpload.fields([
        { name: 'governmentId',       maxCount: 1 },
        { name: 'selfieVerification', maxCount: 1 },
        { name: 'tradeLicense',       maxCount: 1 },
        { name: 'panCard',            maxCount: 1 },
    ]),
    submitOnboarding
)

// ── Operator: re-upload a rejected document ───────────────────────────────────
router.patch('/documents/reupload', operatorProtect,
    operatorUpload.single('file'),
    reuploadDocument
)

// ── Admin: list all operators ─────────────────────────────────────────────────
router.get('/', protect, restrictTo('admin'), getAllOperators)

// ── Admin: get single operator ────────────────────────────────────────────────
router.get('/:id', protect, restrictTo('admin'), getOperatorById)

// ── Admin: approve / reject / suspend ────────────────────────────────────────
router.patch('/:id/state', protect, restrictTo('admin'), transitionState)

// ── Admin: approve / reject / reupload a document ────────────────────────────
router.patch('/:id/document-status', protect, restrictTo('admin'), updateDocumentStatus)

module.exports = router
