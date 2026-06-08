const Wishlist = require("../models/Wishlist");
const Notification = require("../models/Notification");
const { notifyUser } = require("./notificationController");

/**
 * Notify all users who wishlisted a package.
 * Respects max 2 alerts per user per day.
 */
async function alertWishlistedUsers(packageId, title, body, data = {}) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Find all wishlists containing this package
    const wishlists = await Wishlist.find({ packages: packageId });

    let sent = 0;
    for (const wl of wishlists) {
      const userId = wl.user;

      // Max 2 per day check
      const todayCount = await Notification.countDocuments({
        recipientId: userId,
        type: "offer",
        createdAt: { $gte: today },
      });
      if (todayCount >= 2) continue;

      notifyUser(userId, title, body, {
        type: "offer",
        packageId: packageId.toString(),
        screen: "PackageDetail",
        ...data,
      });
      sent++;
    }
    return sent;
  } catch (err) {
    console.warn("alertWishlistedUsers error:", err.message);
    return 0;
  }
}

module.exports = { alertWishlistedUsers };
