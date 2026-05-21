const express = require('express')
const router = express.Router()
const { register, login, getMe } = require('../controllers/operatorAuthController')
const { operatorProtect } = require('../middleware/operatorAuthMiddleware')

// Public routes
router.post('/register', register)
router.post('/login', login)

// Protected routes
router.get('/me', operatorProtect, getMe)

module.exports = router
