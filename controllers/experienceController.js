const Experience = require("../models/Experience");
const escapeRegex = require("../utils/escapeRegex");

// GET /api/experiences
// Supports ?country=India&state=Goa for "Experiences Near You"
// Supports ?search=keyword for general search
exports.getAllExperiences = async (req, res) => {
  try {
    const { search, country, state, isPopular, limit = 20 } = req.query;
    const query = { isActive: true };

    // Structured location filter — country + state for "Experiences Near You"
    if (state) {
      query.state = { $regex: escapeRegex(state.trim()), $options: "i" };
      if (country) {
        query.country = { $regex: escapeRegex(country.trim()), $options: "i" };
      }
    } else if (country && !state) {
      // Country-only filter (e.g. show all India experiences)
      query.country = { $regex: escapeRegex(country.trim()), $options: "i" };
    } else if (search) {
      const safe = escapeRegex(String(search));
      query.$or = [
        { name: { $regex: safe, $options: "i" } },
        { location: { $regex: safe, $options: "i" } },
        { city: { $regex: safe, $options: "i" } },
        { state: { $regex: safe, $options: "i" } },
      ];
    }

    if (isPopular !== undefined) query.isPopular = isPopular === "true";

    const experiences = await Experience.find(query)
      .sort({ rating: -1, createdAt: -1 })
      .limit(Number(limit));

    res.json({ success: true, count: experiences.length, experiences });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/experiences/:id
exports.getExperienceById = async (req, res) => {
  try {
    const experience = await Experience.findById(req.params.id);
    if (!experience)
      return res
        .status(404)
        .json({ success: false, message: "Experience not found" });
    res.json({ success: true, experience });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/experiences
exports.createExperience = async (req, res) => {
  try {
    const experience = await Experience.create(req.body);
    res.status(201).json({ success: true, experience });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// PUT /api/experiences/:id
exports.updateExperience = async (req, res) => {
  try {
    const experience = await Experience.findByIdAndUpdate(
      req.params.id,
      req.body,
      {
        new: true,
        runValidators: true,
      },
    );
    if (!experience)
      return res
        .status(404)
        .json({ success: false, message: "Experience not found" });
    res.json({ success: true, experience });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// DELETE /api/experiences/:id
exports.deleteExperience = async (req, res) => {
  try {
    const experience = await Experience.findByIdAndDelete(req.params.id);
    if (!experience)
      return res
        .status(404)
        .json({ success: false, message: "Experience not found" });
    res.json({ success: true, message: "Experience deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
