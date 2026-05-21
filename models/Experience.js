const mongoose = require('mongoose')

const experienceSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Experience name is required'],
            trim: true,
        },
        location: {
            type: String,
            required: [true, 'Location is required'],
            trim: true,
        },
        rating: {
            type: Number,
            min: 0,
            max: 5,
            default: 4.5,
        },
        duration: {
            type: String,
            default: '',
        },
        price: {
            type: Number,
            required: [true, 'Price is required'],
            min: 0,
        },
        reviews: {
            type: String,
            default: '',
        },
        image: {
            type: String,
            default: '',
        },
        isPopular: {
            type: Boolean,
            default: false,
        },
        isActive: {
            type: Boolean,
            default: true,
        },
    },
    { timestamps: true }
)

module.exports = mongoose.model('Experience', experienceSchema)
