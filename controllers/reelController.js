const Reel = require("../models/Reel");

// GET /api/reels
exports.getAllReels = async (req, res) => {
  try {
    const { search, badge, page = 1, limit = 20 } = req.query;
    const query = { isActive: true };

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { location: { $regex: search, $options: "i" } },
      ];
    }
    if (badge) query.badge = badge;

    const skip = (Number(page) - 1) * Number(limit);
    const [reels, total] = await Promise.all([
      Reel.find(query)
        .skip(skip)
        .limit(Number(limit))
        .sort({ order: 1, createdAt: -1 }),
      Reel.countDocuments(query),
    ]);

    res.json({ success: true, total, page: Number(page), reels });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/reels/:id
exports.getReelById = async (req, res) => {
  try {
    const reel = await Reel.findById(req.params.id);
    if (!reel)
      return res
        .status(404)
        .json({ success: false, message: "Reel not founds" });
    res.json({ success: true, reel });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/reels
exports.createReel = async (req, res) => {
  try {
    const reel = await Reel.create(req.body);
    res.status(201).json({ success: true, reel });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// PUT /api/reels/:id
exports.updateReel = async (req, res) => {
  try {
    const reel = await Reel.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!reel)
      return res
        .status(404)
        .json({ success: false, message: "Reel not found" });
    res.json({ success: true, reel });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// DELETE /api/reels/:id
exports.deleteReel = async (req, res) => {
  try {
    const reel = await Reel.findByIdAndDelete(req.params.id);
    if (!reel)
      return res
        .status(404)
        .json({ success: false, message: "Reel not found" });
    res.json({ success: true, message: "Reel deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
