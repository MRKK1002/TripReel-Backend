const mongoose = require('mongoose')

const itineraryDaySchema = new mongoose.Schema(
    {
        day: { type: Number, required: true },
        title: { type: String, required: true },
        points: [{ type: String }],
    },
    { _id: false }
)

const addonSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        price: { type: Number, default: 0 },
        details: [{ type: String }],
    },
    { _id: false }
)

const packageSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: [true, 'Package title is required'],
            trim: true,
        },
        location: {
            type: String,
            required: [true, 'Location is required'],
            trim: true,
        },
        category: {
            type: String,
            trim: true,
            default: '',
        },
        description: {
            type: String,
            trim: true,
            default: '',
        },
        about: {
            type: String,
            default: '',
        },
        rating: {
            type: Number,
            min: 0,
            max: 5,
            default: 4.5,
        },
        reviews: {
            type: String,
            default: '',
        },
        price: {
            type: Number,
            required: [true, 'Price is required'],
            min: 0,
        },
        priceLabel: {
            type: String,
            default: '',
        },
        badge: {
            type: String,
            enum: ['Popular', 'Trending', 'New', ''],
            default: 'Popular',
        },
        duration: {
            type: String,
            default: '',
        },
        highlights: [{ type: String }],
        itinerary: [itineraryDaySchema],
        inclusions: [{ type: String }],
        exclusions: [{ type: String }],
        addons: [addonSchema],
        image_url: {
            type: String,
            default: '',
        },
        images: [{ type: String }],
        isActive: {
            type: Boolean,
            default: true,
        },
        // Operator ownership & review workflow
        operatorId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Operator',
            default: null,
        },
        status: {
            type: String,
            enum: ['PENDING', 'NEEDS_REVISION', 'APPROVED', 'REJECTED'],
            default: 'PENDING',
        },
        adminNotes: {
            type: String,
            default: '',
        },
        approvedCategory: {
            type: String,
            default: '',
        },
    },
    { timestamps: true }
)

module.exports = mongoose.model('Package', packageSchema)
