const mongoose = require('mongoose')

const reelSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: [true, 'Title is required'],
            trim: true,
        },
        location: {
            type: String,
            trim: true,
            default: '',
        },
        badge: {
            type: String,
            enum: ['Popular', 'Trending', 'New', 'Featured', ''],
            default: 'Popular',
        },
        video: {
            type: String,
            required: [true, 'Video URL is required'],
        },
        thumbnail: {
            type: String,
            default: '',
        },
        user: {
            name: { type: String, default: '' },
            avatar: { type: String, default: '' },
            role: { type: String, default: '' },
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        views: {
            type: Number,
            default: 0,
        },
        order: {
            type: Number,
            default: 0,
        },
    },
    { timestamps: true }
)

module.exports = mongoose.model('Reel', reelSchema)
