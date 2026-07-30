const mongoose = require("mongoose");

const dayExtraChargeSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      trim: true,
      default: "",
      maxlength: [60, "Charge label cannot exceed 60 characters"],
    },
    amount: { type: Number, default: 0, min: 0, max: 5000 },
  },
  { _id: false },
);

// Per-day extra charges flow straight into the operator's payout WITHOUT the
// platform fee applied (see calcPricing in tripBookingController). The per-item
// cap was the only guard, and the array was unbounded — so N x ₹5000 could be
// stacked on a single day. Cap the count and the per-day total too.
const MAX_EXTRA_CHARGES_PER_DAY = 5;
const MAX_EXTRA_CHARGE_TOTAL_PER_DAY = 10000;

const itineraryDaySchema = new mongoose.Schema(
  {
    day: { type: Number, required: true },
    title: { type: String, required: true, trim: true, maxlength: 80 },
    points: [{ type: String, maxlength: 200 }],
    pickupPoint: { type: String, default: "" },
    pickupTime: { type: String, default: "" },
    pickupLat: { type: Number, default: null },
    pickupLng: { type: Number, default: null },
    isOutsideCity: { type: Boolean, default: false },
    // Per-day outside-city surcharge for the creator (varies by place).
    // Falls back to package.outsideCityCharge if 0/unset (backward compatible).
    outsideCityCharge: { type: Number, default: 0, min: 0, max: 10000 },
    // Optional extra charges for the creator on this day (entry fee, parking, etc.)
    extraCharges: {
      type: [dayExtraChargeSchema],
      default: [],
      validate: [
        {
          validator: (arr) =>
            !Array.isArray(arr) || arr.length <= MAX_EXTRA_CHARGES_PER_DAY,
          message: `A day can have at most ${MAX_EXTRA_CHARGES_PER_DAY} extra charges`,
        },
        {
          validator: (arr) =>
            !Array.isArray(arr) ||
            arr.reduce((sum, c) => sum + (Number(c?.amount) || 0), 0) <=
              MAX_EXTRA_CHARGE_TOTAL_PER_DAY,
          message: `Extra charges for a day cannot total more than ₹${MAX_EXTRA_CHARGE_TOTAL_PER_DAY}`,
        },
      ],
    },
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
      maxlength: [60, "Package title cannot exceed 60 characters"],
    },
    // Location & price are only mandatory once the package is actually submitted
    // for review. A DRAFT can be saved with just a title, so these must not be
    // hard-required or draft-save would 400 with "Location is required".
    location: {
      type: String,
      required: [
        function () {
          return this.status !== "DRAFT";
        },
        "Location is required",
      ],
      trim: true,
      default: "",
      maxlength: [50, "Location cannot exceed 50 characters"],
    },
    // Structured location fields for proximity-based filtering
    country: {
      type: String,
      trim: true,
      default: "India",
      maxlength: 56,
    },
    state: {
      type: String,
      trim: true,
      default: "",
      maxlength: 40,
    },
    city: {
      type: String,
      trim: true,
      default: "",
      maxlength: 40,
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
      maxlength: 50,
    },
    departureCity: {
      type: String,
      trim: true,
      default: "",
      maxlength: 40,
    },
    // How this package accepts bookings: "batch" (fixed group departures) or "flexible" (date availability ranges)
    bookingMode: {
      type: String,
      enum: ["batch", "flexible"],
      default: "batch",
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
      required: [
        function () {
          return this.status !== "DRAFT";
        },
        "Price is required",
      ],
      min: [50, "Price must be at least ₹50"],
      max: [5000000, "Price cannot exceed ₹50,00,000"],
      default: 0,
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
        // Operator "deleted" a package that has booking history — kept for
        // audit/reporting, hidden from travellers.
        "ARCHIVED",
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
