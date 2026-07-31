const TripDocTemplate = require("../models/TripDocTemplate");

// GET /api/trip-doc-templates?packageId=X — list operator's templates
exports.getTemplates = async (req, res) => {
  try {
    const query = { operatorId: req.operator._id };
    if (req.query.packageId) query.packageId = req.query.packageId;
    const templates = await TripDocTemplate.find(query).sort({ updatedAt: -1 });
    res.json({ success: true, templates });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/trip-doc-templates — save a new template
exports.createTemplate = async (req, res) => {
  try {
    const {
      packageId,
      label,
      itinerary,
      inclusions,
      exclusions,
      hotel,
      transport,
      policies,
      specialNotes,
    } = req.body;

    if (!packageId) {
      return res
        .status(400)
        .json({ success: false, message: "packageId is required" });
    }

    const template = await TripDocTemplate.create({
      operatorId: req.operator._id,
      packageId,
      label: (label || "Default").trim().slice(0, 80),
      itinerary: itinerary || [],
      inclusions: inclusions || [],
      exclusions: exclusions || [],
      hotel: hotel || {},
      transport: transport || {},
      policies: policies || {},
      specialNotes: (specialNotes || "").trim().slice(0, 1000),
    });

    res.status(201).json({ success: true, template });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        message:
          "A template with this label already exists for this package. Use a different name.",
      });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/trip-doc-templates/:id — update a template
exports.updateTemplate = async (req, res) => {
  try {
    const template = await TripDocTemplate.findOne({
      _id: req.params.id,
      operatorId: req.operator._id,
    });
    if (!template) {
      return res
        .status(404)
        .json({ success: false, message: "Template not found" });
    }

    const allowed = [
      "label",
      "itinerary",
      "inclusions",
      "exclusions",
      "hotel",
      "transport",
      "policies",
      "specialNotes",
    ];
    allowed.forEach((k) => {
      if (req.body[k] !== undefined) template[k] = req.body[k];
    });
    if (template.label)
      template.label = String(template.label).trim().slice(0, 80);
    if (template.specialNotes)
      template.specialNotes = String(template.specialNotes)
        .trim()
        .slice(0, 1000);

    await template.save();
    res.json({ success: true, template });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/trip-doc-templates/:id — delete a template
exports.deleteTemplate = async (req, res) => {
  try {
    const template = await TripDocTemplate.findOneAndDelete({
      _id: req.params.id,
      operatorId: req.operator._id,
    });
    if (!template) {
      return res
        .status(404)
        .json({ success: false, message: "Template not found" });
    }
    res.json({ success: true, message: "Template deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
