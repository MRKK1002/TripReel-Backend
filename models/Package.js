const mongoose = require("mongoose");

const itineraryDaySchema = new mongoose.Schema(
  {
    day: { type: Number, required: true },
    title: { type: String, required: true },
    points: [{ type: String }],
    pickupPoint: { type: String, default: "" },
    pickupTime: { type: String, default: "" },
    pickupLat: { type: Number, default: null },
    pickupLng: { type: Number, default: null },
    isOutsideCity: { type: Boolean, default: false },
  },
  { _id: false },
);

const addonSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    price: { type: Number, default: 0 },
    details: [{ type: String }],
  },
  { _id: false },
);

const packagePricingSchema = new mongoose.Schema(
  {
    adultPrice: { type: Number, default: 0, min: 0 },
    childPrice: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const packageHotelSchema = new mongoose.Schema(
  {
    hotelName: { type: String, trim: true, default: "" },
    hotelCategory: { type: String, trim: true, default: "" },
    roomType: { type: String, trim: true, default: "" },
    mealPlan: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const packageTransportSchema = new mongoose.Schema(
  {
    flightIncluded: { type: Boolean, default: false },
    busIncluded: { type: Boolean, default: false },
    cabIncluded: { type: Boolean, default: false },
    pickupDrop: { type: String, trim: true, default: "" },
    vehicleType: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const packageAvailabilitySchema = new mongoose.Schema(
  {
    startDate: { type: Date },
    endDate: { type: Date },
    availableSeats: { type: Number, default: 0, min: 0 },
    bookingDeadline: { type: Date },
  },
  { _id: false },
);

const packagePoliciesSchema = new mongoose.Schema(
  {
    cancellationPolicy: { type: String, trim: true, default: "" },
    refundPolicy: { type: String, trim: true, default: "" },
    terms: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const packageOfferSchema = new mongoose.Schema(
  {
    couponCode: { type: String, trim: true, default: "" },
    earlyBirdOffer: { type: String, trim: true, default: "" },
    festivalOffer: { type: String, trim: true, default: "" },
    groupDiscount: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const packageSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Package title is required"],
      trim: true,
    },
    location: {
      type: String,
      required: [true, "Location is required"],
      trim: true,
    },
    // Structured location fields for proximity-based filtering
    country: {
      type: String,
      trim: true,
      default: "India",
    },
    state: {
      type: String,
      trim: true,
      default: "",
    },
    city: {
      type: String,
      trim: true,
      default: "",
    },
    tourType: {
      type: String,
      trim: true,
      default: "",
    },
    destination: {
      type: String,
      trim: true,
      default: "",
    },
    departureCity: {
      type: String,
      trim: true,
      default: "",
    },
    durationDays: {
      type: Number,
      min: 0,
      default: 0,
    },
    durationNights: {
      type: Number,
      min: 0,
      default: 0,
    },
    category: {
      type: String,
      trim: true,
      default: "",
    },
    aboutThisTrip: {
      type: String,
      trim: true,
      default: "",
    },
    about: {
      type: String,
      default: "",
    },
    rating: {
      type: Number,
      min: 0,
      max: 5,
      default: 0,
    },
    avgRating: {
      type: Number,
      min: 0,
      max: 5,
      default: 0,
    },
    reviewCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    reviews: {
      type: String,
      default: "",
    },
    price: {
      type: Number,
      required: [true, "Price is required"],
      min: 0,
    },
    priceLabel: {
      type: String,
      default: "",
    },
    badge: {
      type: String,
      enum: ["Popular", "Trending", "New", ""],
      default: "",
    },
    isFeatured: { type: Boolean, default: false },
    isTrending: { type: Boolean, default: false },
    duration: {
      type: String,
      default: "",
    },
    highlights: [{ type: String }],
    itinerary: [itineraryDaySchema],
    inclusions: [{ type: String }],
    exclusions: [{ type: String }],
    addons: [addonSchema],
    // Per-person surcharge for outside-city addon days (photographer/reel maker)
    outsideCityCharge: {
      type: Number,
      default: 0,
      min: 0,
    },
    videos: [{ type: String }],
    // Sample work from photographer / reelmaker — managed by admin
    sampleMedia: [
      {
        url: { type: String, required: true },
        type: { type: String, enum: ["photo", "video"], default: "video" },
        category: {
          type: String,
          enum: ["photographer", "reelmaker"],
          default: "reelmaker",
        },
        thumbnail: { type: String },
      },
    ],
    hotelDetails: packageHotelSchema,
    transportDetails: packageTransportSchema,
    pricing: packagePricingSchema,
    availability: packageAvailabilitySchema,
    // batches moved to separate Batch collection — see models/Batch.js
    policies: packagePoliciesSchema,
    offer: packageOfferSchema,
    image_url: {
      type: String,
      default: "",
    },
    images: [{ type: String }],
    isActive: {
      type: Boolean,
      default: true,
    },
    // Operator ownership & review workflow
    operatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Operator",
      default: null,
    },
    status: {
      type: String,
      enum: [
        "DRAFT",
        "PENDING",
        "NEEDS_REVISION",
        "APPROVED",
        "REJECTED",
        "EXPIRED",
      ],
      default: "PENDING",
    },
    adminNotes: {
      type: String,
      default: "",
    },
    approvedCategory: {
      type: String,
      default: "",
    },
    // Number of confirmed bookings — used as a popularity signal alongside avgRating
    bookingCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Package", packageSchema);
