const mongoose = require("mongoose");

// Atomic sequence counter — used to mint collision-free sequential IDs
// (e.g. bookingId). Using $inc on a single document is atomic in MongoDB,
// so concurrent inserts can never receive the same number, and deletions
// never cause a re-used value (unlike countDocuments()+1).
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // sequence name, e.g. "tripBookingId"
  seq: { type: Number, default: 0 },
});

module.exports = mongoose.model("Counter", counterSchema);
