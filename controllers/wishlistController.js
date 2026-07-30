const Wishlist = require("../models/Wishlist");

// GET /api/wishlists  (admin: all wishlists)
exports.getAllWishlists = async (req, res) => {
  try {
    const { search } = req.query;
    let query = {};

    const wishlists = await Wishlist.find(query)
      .populate("user", "name email")
      .populate("packages", "title image_url")
      .sort({ createdAt: -1 });

    const filtered = search
      ? wishlists.filter(
          (w) =>
            w.name.toLowerCase().includes(search.toLowerCase()) ||
            (w.user?.name || "").toLowerCase().includes(search.toLowerCase()) ||
            (w.user?.email || "").toLowerCase().includes(search.toLowerCase()),
        )
      : wishlists;

    res.json({ success: true, count: filtered.length, wishlists: filtered });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/wishlists/my  (logged-in user's wishlists)
exports.getMyWishlists = async (req, res) => {
  try {
    const wishlists = await Wishlist.find({ user: req.user.id })
      .populate({
        path: "packages",
        select: "title image_url images price location isActive",
        match: { isActive: true },
      })
      .sort({ createdAt: -1 });
    res.json({ success: true, count: wishlists.length, wishlists });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/wishlists
exports.createWishlist = async (req, res) => {
  try {
    // Whitelist instead of spreading the raw body
    const name = String(req.body.name || "").trim();
    if (!name) {
      return res
        .status(400)
        .json({ success: false, message: "Wishlist name is required" });
    }

    const wishlist = await Wishlist.create({
      user: req.user.id,
      name: name.slice(0, 100),
      location: String(req.body.location || "")
        .trim()
        .slice(0, 100),
      image: String(req.body.image || "").trim(),
      packages: [],
    });
    res.status(201).json({ success: true, wishlist });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// POST /api/wishlists/:id/packages  — add a package to wishlist
exports.addPackageToWishlist = async (req, res) => {
  try {
    const { packageId } = req.body;
    const wishlist = await Wishlist.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { $addToSet: { packages: packageId } },
      { new: true },
    ).populate("packages", "title image_url images price location");

    if (!wishlist)
      return res
        .status(404)
        .json({ success: false, message: "Wishlist not found" });
    res.json({ success: true, wishlist });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// DELETE /api/wishlists/:id/packages/:packageId  — remove a package
exports.removePackageFromWishlist = async (req, res) => {
  try {
    const wishlist = await Wishlist.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { $pull: { packages: req.params.packageId } },
      { new: true },
    ).populate("packages", "title image_url images price location");

    if (!wishlist)
      return res
        .status(404)
        .json({ success: false, message: "Wishlist not found" });
    res.json({ success: true, wishlist });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// DELETE /api/wishlists/:id
exports.deleteWishlist = async (req, res) => {
  try {
    // Ownership check — this was a bare findByIdAndDelete, so any authenticated
    // user could delete any other user's wishlist. Admins may delete any.
    const filter =
      req.user?.role === "admin"
        ? { _id: req.params.id }
        : { _id: req.params.id, user: req.user.id };

    const wishlist = await Wishlist.findOneAndDelete(filter);
    if (!wishlist)
      return res
        .status(404)
        .json({ success: false, message: "Wishlist not found" });
    res.json({ success: true, message: "Wishlist deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/wishlists/operator/stats — operator sees how many users wishlisted their packages
exports.operatorWishlistStats = async (req, res) => {
  try {
    const Package = require("../models/Package");
    // Get operator's package IDs
    const myPackages = await Package.find({
      operatorId: req.operator._id,
    }).select("_id title");
    const packageIds = myPackages.map((p) => p._id);

    if (packageIds.length === 0) {
      return res.json({ success: true, total: 0, packages: [] });
    }

    // Find all wishlists that contain any of the operator's packages.
    // Counts only — the response used to include the name/avatar of users who
    // wishlisted, which the operator UI never shows and doesn't need.
    const wishlists = await Wishlist.find({ packages: { $in: packageIds } })
      .select("packages")
      .lean();

    // Count per package
    const packageCounts = {};
    packageIds.forEach((id) => {
      packageCounts[id.toString()] = { count: 0 };
    });

    wishlists.forEach((wl) => {
      (wl.packages || []).forEach((pkgId) => {
        const key = pkgId.toString();
        if (packageCounts[key]) packageCounts[key].count++;
      });
    });

    const result = myPackages
      .map((p) => ({
        packageId: p._id,
        title: p.title,
        wishlistCount: packageCounts[p._id.toString()]?.count || 0,
      }))
      .filter((p) => p.wishlistCount > 0)
      .sort((a, b) => b.wishlistCount - a.wishlistCount);

    const totalWishlists = result.reduce((s, p) => s + p.wishlistCount, 0);

    res.json({ success: true, total: totalWishlists, packages: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
