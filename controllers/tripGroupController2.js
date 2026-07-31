// Continuation — additional trip group actions (split file for size)
const TripGroup = require("../models/TripGroup");

// PATCH /api/trip-groups/:id — update label/notes or add/remove bookings
exports.updateGroup = async (req, res) => {
  try {
    const group = await TripGroup.findOne({
      _id: req.params.id,
      operatorId: req.operator._id,
    });
    if (!group) {
      return res
        .status(404)
        .json({ success: false, message: "Group not found" });
    }

    const { label, notes, addBookingIds, removeBookingIds } = req.body;
    if (label !== undefined) group.label = String(label).trim().slice(0, 80);
    if (notes !== undefined) group.notes = String(notes).trim().slice(0, 500);

    if (Array.isArray(addBookingIds) && addBookingIds.length > 0) {
      // Check they're not in another group
      const conflict = await TripGroup.findOne({
        _id: { $ne: group._id },
        bookingIds: { $in: addBookingIds },
        operatorId: req.operator._id,
      });
      if (conflict) {
        return res.status(400).json({
          success: false,
          message: `Some bookings are already in group "${conflict.label || "Untitled"}".`,
        });
      }
      group.bookingIds = [
        ...new Set([
          ...group.bookingIds.map(String),
          ...addBookingIds.map(String),
        ]),
      ];
    }

    if (Array.isArray(removeBookingIds) && removeBookingIds.length > 0) {
      const removeSet = new Set(removeBookingIds.map(String));
      group.bookingIds = group.bookingIds.filter(
        (id) => !removeSet.has(String(id)),
      );
    }

    if (group.bookingIds.length > 50) {
      return res.status(400).json({
        success: false,
        message: "A group can have at most 50 bookings.",
      });
    }

    await group.save();
    res.json({ success: true, group });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/trip-groups/:id — dissolve a group (bookings return to ungrouped)
exports.deleteGroup = async (req, res) => {
  try {
    const group = await TripGroup.findOneAndDelete({
      _id: req.params.id,
      operatorId: req.operator._id,
    });
    if (!group) {
      return res
        .status(404)
        .json({ success: false, message: "Group not found" });
    }
    res.json({ success: true, message: "Group dissolved" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
