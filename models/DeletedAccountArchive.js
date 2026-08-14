const mongoose = require("mongoose");

// Admin-only retention record captured when a user deletes their account.
// Kept for legal / accounting / dispute-resolution purposes (a lawful basis
// permitted under DPDP). Access is restricted to admins. This must NOT be used
// to re-contact or market to the deleted user.
const deletedAccountArchiveSchema = new mongoose.Schema(
  {
    // Original user id (the User doc itself is anonymized, not dropped)
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    phone: { type: String, default: "" },
    state: { type: String, default: "" },
    country: { type: String, default: "" },
    memberSince: { type: Date },
    tripsCount: { type: Number, default: 0 },

    // Snapshot of the user's bookings at deletion time (for reference/audit)
    bookings: [
      {
        bookingId: String,
        packageTitle: String,
        startDate: Date,
        endDate: Date,
        seats: Number,
        status: String,
        totalAmount: Number,
      },
    ],

    deletedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model(
  "DeletedAccountArchive",
  deletedAccountArchiveSchema,
);
