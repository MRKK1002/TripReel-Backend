/**
 * Fetch a Snapja booking by ID to see what data they return (assigned creator, status, etc.)
 *   node scripts/checkSnapjaBooking.js SNJ0383
 */
require("dotenv").config();

const SNAPJA_API = "https://api.snapja.com/api/tripreel/bookings";
const SNAPJA_API_KEY = process.env.SNAPJA_API_KEY;

async function main() {
  const bookingId = process.argv[2] || "SNJ0383";

  // Try GET with booking ID
  const urls = [
    `${SNAPJA_API}/${bookingId}`,
    `${SNAPJA_API}?booking_id=${bookingId}`,
  ];

  for (const url of urls) {
    console.log(`\nTrying: GET ${url}`);
    try {
      const res = await fetch(url, {
        headers: {
          "X-API-Key": SNAPJA_API_KEY,
          "Content-Type": "application/json",
        },
      });
      const text = await res.text();
      console.log("Status:", res.status);
      try {
        const json = JSON.parse(text);
        console.log("Response:", JSON.stringify(json, null, 2));
      } catch {
        console.log("Response (not JSON):", text.slice(0, 500));
      }
    } catch (e) {
      console.log("Error:", e.message);
    }
  }
}

main();
