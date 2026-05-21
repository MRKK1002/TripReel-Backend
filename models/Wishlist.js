const mongoose = require('mongoose')

const wishlistSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Wishlist name is required'],
            trim: true,
        },
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        packages: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'Package',
            },
        ],
        location: {
            type: String,
            default: '',
        },
        image: {
            type: String,
            default: '',
        },
    },
    { timestamps: true }
)

module.exports = mongoose.model('Wishlist', wishlistSchema)
