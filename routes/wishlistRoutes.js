const express = require('express')
const router = express.Router()
const {
    getAllWishlists,
    getMyWishlists,
    createWishlist,
    addPackageToWishlist,
    removePackageFromWishlist,
    deleteWishlist,
} = require('../controllers/wishlistController')
const { protect, restrictTo } = require('../middleware/authMiddleware')

// All wishlist routes require authentication
router.use(protect)

router.get('/my', getMyWishlists)                        // user's own wishlists
router.get('/', restrictTo('admin'), getAllWishlists)     // admin: all wishlists
router.post('/', createWishlist)
router.post('/:id/packages', addPackageToWishlist)
router.delete('/:id/packages/:packageId', removePackageFromWishlist)
router.delete('/:id', deleteWishlist)

module.exports = router
