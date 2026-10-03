const TripBooking = require("../models/TripBooking");
const Package = require("../models/Package");
const { Operator } = require("../models/Operator");
const User = require("../models/User");

// GET /api/admin/revenue/dashboard
exports.getRevenueDashboard = async (req, res) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

    // All confirmed/completed bookings
    const allBookings = await TripBooking.find({
      status: { $in: ["CONFIRMED", "COMPLETED"] },
    }).lean();

    const cancelledBookings = await TripBooking.find({
      status: "CANCELLED",
    }).lean();

    // Total revenue
    const totalRevenue = allBookings.reduce(
      (s, b) => s + (b.pricing?.totalAmount || 0),
      0,
    );
    const totalPlatformEarnings = allBookings.reduce(
      (s, b) => s + (b.pricing?.platformFeeAmount || 0),
      0,
    );
    const totalOperatorPayouts = allBookings.reduce(
      (s, b) => s + (b.pricing?.operatorAmount || 0),
      0,
    );
    const totalRefunds = cancelledBookings.reduce(
      (s, b) => s + (b.refundAmount || 0),
      0,
    );

    // GST collected (platform collects, remits to govt)
    const totalGstCollected = allBookings.reduce(
      (s, b) => s + (b.pricing?.gstAmount || 0),
      0,
    );
    // Snapja add-on payouts (base portion = addonAmount - addonSurcharge)
    const totalSnapjaPayouts = allBookings.reduce(
      (s, b) =>
        s +
        Math.max(0, (b.pricing?.addonAmount || 0) - (b.addonSurcharge || 0)),
      0,
    );
    // Net platform profit = platform fee only (GST is remitted, Snapja is paid out)
    const netPlatformProfit = totalPlatformEarnings;

    // This month
    const thisMonthBookings = allBookings.filter(
      (b) => new Date(b.createdAt) >= monthStart,
    );
    const thisMonthRevenue = thisMonthBookings.reduce(
      (s, b) => s + (b.pricing?.totalAmount || 0),
      0,
    );
    const thisMonthPlatformFee = thisMonthBookings.reduce(
      (s, b) => s + (b.pricing?.platformFeeAmount || 0),
      0,
    );

    // Last month
    const lastMonthBookingsArr = allBookings.filter((b) => {
      const d = new Date(b.createdAt);
      return d >= lastMonthStart && d <= lastMonthEnd;
    });
    const lastMonthRevenue = lastMonthBookingsArr.reduce(
      (s, b) => s + (b.pricing?.totalAmount || 0),
      0,
    );

    // Monthly revenue for chart (last 6 months)
    const monthlyRevenue = [];
    for (let i = 5; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      const monthBookings = allBookings.filter((b) => {
        const d = new Date(b.createdAt);
        return d >= start && d <= end;
      });
      monthlyRevenue.push({
        month: start.toLocaleDateString("en-IN", {
          month: "short",
          year: "2-digit",
        }),
        revenue: monthBookings.reduce(
          (s, b) => s + (b.pricing?.totalAmount || 0),
          0,
        ),
        platformFee: monthBookings.reduce(
          (s, b) => s + (b.pricing?.platformFeeAmount || 0),
          0,
        ),
        bookings: monthBookings.length,
      });
    }

    // Counts
    const totalUsers = await User.countDocuments();
    const totalOperators = await Operator.countDocuments({
      onboardingState: "APPROVED",
    });
    const totalPackages = await Package.countDocuments({
      isActive: true,
      status: "APPROVED",
    });
    const totalBookings = await TripBooking.countDocuments();
    const totalCancellations = cancelledBookings.length;

    // Escrow / Held Funds (confirmed bookings awaiting trip completion)
    const activeConfirmedBookings = allBookings.filter(
      (b) => b.status === "CONFIRMED",
    );
    const escrowHeldAmount = activeConfirmedBookings.reduce(
      (s, b) => s + (b.pricing?.operatorAmount || 0),
      0,
    );

    // Operator Onboarding & Withdrawal Pipeline
    let pendingOperatorsCount = 0;
    try {
      pendingOperatorsCount = await Operator.countDocuments({
        onboardingState: "PENDING_APPROVAL",
      });
    } catch {}

    let pendingWithdrawalsCount = 0;
    let pendingWithdrawalsAmount = 0;
    try {
      const Withdrawal = require("../models/Withdrawal");
      const pendingWithdrawalsDocs = await Withdrawal.find({
        status: { $in: ["PENDING", "PROCESSING"] },
      }).lean();
      pendingWithdrawalsCount = pendingWithdrawalsDocs.length;
      pendingWithdrawalsAmount = pendingWithdrawalsDocs.reduce(
        (s, w) => s + (w.amount || 0),
        0,
      );
    } catch {}

    // Support reports count
    let openReportsCount = 0;
    try {
      const mongoose = require("mongoose");
      const Report = mongoose.models.Report;
      if (Report) {
        openReportsCount = await Report.countDocuments({
          status: { $in: ["open", "in_progress"] },
        });
      }
    } catch {}

    // Platform performance metrics
    const platformMarginPercent =
      totalRevenue > 0
        ? Number(((totalPlatformEarnings / totalRevenue) * 100).toFixed(1))
        : 0;
    const averageOrderValue =
      allBookings.length > 0
        ? Math.round(totalRevenue / allBookings.length)
        : 0;

    // Repeat traveler rate
    const userBookingCounts = {};
    allBookings.forEach((b) => {
      const uid = b.userId?.toString();
      if (uid) userBookingCounts[uid] = (userBookingCounts[uid] || 0) + 1;
    });
    const repeatTravelersCount = Object.values(userBookingCounts).filter(
      (c) => c >= 2,
    ).length;

    // Funnel views & wishlists
    let totalPackageViews = 0;
    try {
      const PackageView = require("../models/PackageView");
      totalPackageViews = await PackageView.countDocuments();
    } catch {}
    let totalWishlists = 0;
    try {
      const Wishlist = require("../models/Wishlist");
      totalWishlists = await Wishlist.countDocuments();
    } catch {}

    // Top operators by revenue
    const operatorRevenue = {};
    allBookings.forEach((b) => {
      const opId = b.operatorId?.toString();
      if (opId) {
        operatorRevenue[opId] =
          (operatorRevenue[opId] || 0) + (b.pricing?.totalAmount || 0);
      }
    });
    const topOperatorIds = Object.entries(operatorRevenue)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id]) => id);
    const topOperators = await Operator.find({ _id: { $in: topOperatorIds } })
      .select("businessName contactName email")
      .lean();
    const topOperatorsWithRevenue = topOperators
      .map((op) => ({
        ...op,
        revenue: operatorRevenue[op._id.toString()] || 0,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    res.json({
      success: true,
      data: {
        totalRevenue,
        totalPlatformEarnings,
        totalOperatorPayouts,
        totalRefunds,
        totalGstCollected,
        totalSnapjaPayouts,
        netPlatformProfit,
        escrowHeldAmount,
        pendingOperatorsCount,
        pendingWithdrawalsCount,
        pendingWithdrawalsAmount,
        openReportsCount,
        platformMarginPercent,
        averageOrderValue,
        repeatTravelersCount,
        totalPackageViews,
        totalWishlists,
        thisMonthRevenue,
        thisMonthPlatformFee,
        lastMonthRevenue,
        revenueGrowth:
          lastMonthRevenue > 0
            ? Math.round(
                ((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue) *
                  100,
              )
            : 0,
        monthlyRevenue,
        totalUsers,
        totalOperators,
        totalPackages,
        totalBookings,
        totalCancellations,
        topOperators: topOperatorsWithRevenue,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/revenue/cancellations
exports.getCancellationReport = async (req, res) => {
  try {
    const cancellations = await TripBooking.find({ status: "CANCELLED" })
      .populate("userId", "name phone email")
      .populate("packageId", "title location")
      .sort({ cancelledAt: -1, updatedAt: -1 })
      .limit(100)
      .lean();

    const totalRefunded = cancellations.reduce(
      (s, b) => s + (b.refundAmount || 0),
      0,
    );
    const reasons = {};
    cancellations.forEach((b) => {
      const r = b.cancelReason || "Unknown";
      reasons[r] = (reasons[r] || 0) + 1;
    });

    res.json({
      success: true,
      total: cancellations.length,
      totalRefunded,
      reasonBreakdown: reasons,
      cancellations,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
