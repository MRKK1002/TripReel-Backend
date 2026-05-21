const mongoose = require('mongoose')

const tripSchema = new mongoose.Schema(
    {
        bookingId: {
            type: String,
            unique: true,
        },
        tripName: {
            type: String,
            required: [true, 'Trip name is required'],
            trim: true,
        },
        location: {
            type: String,
            required: [true, 'Location is required'],
            trim: true,
        },
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        startDate: {
            type: Date,
            required: [true, 'Start date is required'],
        },
        endDate: {
            type: Date,
            required: [true, 'End date is required'],
        },
        tripType: {
            type: String,
            enum: ['Package', 'Adventure', 'Experience', 'Custom'],
            default: 'Package',
        },
        status: {
            type: String,
            enum: ['Confirmed', 'Pending', 'Cancelled', 'Completed'],
            default: 'Pending',
        },
        nights: {
            type: Number,
            default: 1,
        },
        guests: {
            type: Number,
            default: 1,
        },
        amount: {
            type: Number,
            required: [true, 'Amount is required'],
        },
        image: {
            type: String,
            default: '',
        },
        highlights: [{ type: String }],
        package: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Package',
            default: null,
        },
    },
    { timestamps: true }
)

// Auto-generate bookingId before saving
tripSchema.pre('save', async function (next) {
    if (!this.bookingId) {
        const count = await mongoose.model('Trip').countDocuments()
        this.bookingId = `EZH-TRP-${String(count + 1).padStart(5, '0')}`
    }
    next()
})

module.exports = mongoose.model('Trip', tripSchema)
