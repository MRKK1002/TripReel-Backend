const mongoose = require('mongoose')

const popularDestinationSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Destination name is required'],
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

module.exports = mongoose.model('PopularDestination', popularDestinationSchema)
