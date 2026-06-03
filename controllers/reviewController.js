const Review = require("../models/Review");
const Package = require("../models/Package");
const Trip = require("../models/Trip");

// Threshold: avg rating >= 4.0 AND at least 3 reviews → "Popular" badge
const POPULAR_MIN_RATING = 4.0;
const POPULAR_MIN_REVIEWS = 3;

// Recalculate package's avgRating, reviewCount, and auto-set badge
async function recalcPackageRating(packageId) {
  const agg = await Review.aggregate([
    { $match: { packageId, isVisible: true } },
    {
      $group: {
        _id: null,
        avg: { $avg: "$rating" },
        count: { $sum: 1 },
      },
    },
  ]);

  const avg = agg[0]?.avg || 0;
  const count = agg[0]?.count || 0;
  const rounded = Math.round(avg * 10) / 10; // round to 1 decimal

  const update = {
    avgRating: rounded,
    reviewCount: count,
    rating: rounded, // keep legacy `rating` field in sync
  };

  // Auto-badge: Popular if threshold met
  if (rounded >= POPULAR_MIN_RATING && count >= POPULAR_MIN_REVIEWS) {
    update.badge = "Popular";
  }

  await Package.findByIdAndUpdate(packageId, update);
  return update;
}

// ── Public ─────────────────────────────────────────────────────────────────────

// GET /api/reviews/:packageId
exports.getPackageReviews = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const [reviews, total] = await Promise.all([
      Review.find({ packageId: req.params.packageId, isVisible: true })
        .populate("userId", "name avatar")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Review.countDocuments({
        packageId: req.params.packageId,
        isVisible: true,
      }),
    ]);

    res.json({ success: true, reviews, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── User (requires auth) ───────────────────────────────────────────────────────

// POST /api/reviews
// Body: { packageId, tripId (optional), rating, comment }
exports.createReview = async (req, res) => {
  try {
    const { packageId, tripId, rating, comment } = req.body;

    if (!packageId) {
      return res
        .status(400)
        .json({ success: false, message: "packageId is required" });
    }

    const r = Number(rating);
    if (!r || r < 1 || r > 5) {
      return res
        .status(400)
        .json({ success: false, message: "Rating must be between 1 and 5" });
    }

    // If tripId provided, verify the trip belongs to this user and is Completed
    if (tripId) {
      const trip = await Trip.findOne({ _id: tripId, user: req.user.id });
      if (!trip) {
        return res
          .status(404)
          .json({ success: false, message: "Trip not found" });
      }
      if (trip.status !== "Completed") {
        return res
          .status(400)
          .json({
            success: false,
            message: "You can only review a completed trip",
          });
      }
    }

    // Check if package exists
    const pkg = await Package.findById(packageId);
    if (!pkg) {
      return res
        .status(404)
        .json({ success: false, message: "Package not found" });
    }

    // Upsert: one review per user per package
    const review = await Review.findOneAndUpdate(
      { packageId, userId: req.user.id },
      {
        packageId,
        userId: req.user.id,
        tripId: tripId || null,
        rating: r,
        comment: (comment || "").trim(),
      },
      { upsert: true, new: true, runValidators: true },
    );

    // Recalculate package rating
    const stats = await recalcPackageRating(pkg._id);

    res.status(201).json({
      success: true,
      review,
      packageStats: stats,
    });
  } catch (err) {
    if (err.code === 11000) {
      return res
        .status(400)
        .json({
          success: false,
          message: "You have already reviewed this package",
        });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/reviews/my/:packageId — check if current user already reviewed
exports.getMyReview = async (req, res) => {
  try {
    const review = await Review.findOne({
      packageId: req.params.packageId,
      userId: req.user.id,
    });
    res.json({ success: true, review: review || null });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/reviews/:id — user deletes their own review
exports.deleteReview = async (req, res) => {
  try {
    const review = await Review.findOneAndDelete({
      _id: req.params.id,
      userId: req.user.id,
    });
    if (!review) {
      return res
        .status(404)
        .json({ success: false, message: "Review not found" });
    }
    await recalcPackageRating(review.packageId);
    res.json({ success: true, message: "Review deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Admin ──────────────────────────────────────────────────────────────────────

// GET /api/reviews/admin/all
exports.adminGetAllReviews = async (req, res) => {
  try {
    const { packageId, page = 1, limit = 20 } = req.query;
    const query = {};
    if (packageId) query.packageId = packageId;

    const skip = (Number(page) - 1) * Number(limit);
    const [reviews, total] = await Promise.all([
      Review.find(query)
        .populate("userId", "name email")
        .populate("packageId", "title location")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Review.countDocuments(query),
    ]);

    res.json({ success: true, reviews, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /api/reviews/:id/visibility — admin hide/show a review
exports.toggleVisibility = async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) {
      return res
        .status(404)
        .json({ success: false, message: "Review not found" });
    }
    review.isVisible = !review.isVisible;
    await review.save();
    await recalcPackageRating(review.packageId);
    res.json({ success: true, review });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
