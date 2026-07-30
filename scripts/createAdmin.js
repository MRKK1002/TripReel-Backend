require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");

// Create or promote an admin account.
//
// Credentials are NEVER hardcoded here. An earlier version of this script
// created a fixed admin address with a short, well-known default password — if
// it was ever run against a real environment, that account should be found and
// its password rotated (or the account removed).
//
// Usage:
//   node scripts/createAdmin.js <email> <password>
// or set ADMIN_EMAIL / ADMIN_PASSWORD in the environment.

const email = (process.argv[2] || process.env.ADMIN_EMAIL || "")
  .trim()
  .toLowerCase();
const password = process.argv[3] || process.env.ADMIN_PASSWORD || "";

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
  console.error(
    "❌ Provide a valid email: node scripts/createAdmin.js <email> <password>",
  );
  process.exit(1);
}

mongoose
  .connect(process.env.mongodburl)
  .then(async () => {
    const existing = await User.findOne({ email });
    if (existing) {
      existing.role = "admin";
      if (password) existing.password = password; // re-hashed by the model hook
      await existing.save();
      console.log(`✅ Promoted existing user to admin: ${existing.email}`);
      process.exit(0);
    }

    if (!password || password.length < 12) {
      console.error(
        "❌ A password of at least 12 characters is required to create a new admin.",
      );
      process.exit(1);
    }

    const user = await User.create({
      name: "Admin",
      email,
      password,
      role: "admin",
    });
    console.log(`✅ Created admin user: ${user.email}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
