/**
 * Test what Snapja API actually returns for a sample booking dispatch.
 *   node scripts/testSnapja.js
 */
require("dotenv").config();
process.env.TZ = process.env.TZ || "Asia/Kolkata"; // IST for all date math

const SNAPJA_API = "https://api.snapja.com/api/tripreel/bookings";
const SNAPJA_API_KEY = process.env.SNAPJA_API_KEY;

async function test() {
  console.log("Snapja API:", SNAPJA_API);
  console.log("API Key:", SNAPJA_API_KEY);
  console.log("─────────────────────────────────────");

  const today = new Date();
  today.setDate(today.getDate() + 15); // 15 days from now
  const testDate = today.toISOString().split("T")[0];

  const payload = {
    service_type: "photographer",
    location: "Goa, India",
    price: 2000,
    duration: 1,
    date: testDate,
    time: "10:00",
    booking_type: "scheduled",
    customer_name: "Test User",
    customer_phone: "9876543210",
    customer_email: "test@tripreel.com",
    notes:
      "TripReel: Test Package — Photographer — Day 1 — Booking TR-TEST-001",
    timezone: "Asia/Kolkata",
    auto_confirm_payment: true,
  };

  console.log("Payload:", JSON.stringify(payload, null, 2));
  console.log("─────────────────────────────────────");

  const res = await fetch(SNAPJA_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": SNAPJA_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log("Status:", res.status, res.statusText);
  console.log("Headers:", Object.fromEntries(res.headers.entries()));
  console.log("Response body:", text);

  try {
    const json = JSON.parse(text);
    console.log("Parsed JSON:", JSON.stringify(json, null, 2));
  } catch {
    console.log("(not JSON)");
  }
}

test().catch((e) => console.error("Error:", e.message));
