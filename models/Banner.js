const mongoose = require('mongoose')

const bannerSchema = new mongoose.Schema(
    {
        image: {
            type: String,
            required: [true, 'Banner image is required'],
        },
        title: {
            type: String,
            required: [true, 'Banner title is required'],
            trim: true,
        },
        subtitle: {
            type: String,
            trim: true,
            default: '',
        },
        accent: {
            type: String,
            default: '#0d9488',
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        order: {
            type: Number,
            default: 0,
        },
    },
    { timestamps: true }
)

module.exports = mongoose.model('Banner', bannerSchema)
