const {
  parseStrictTime,
  validCoordinates,
} = require("./canonicalAddonServices");

function validateSubmittedItinerary(itinerary) {
  if (!Array.isArray(itinerary) || itinerary.length === 0) {
    const error = new Error("Itinerary must contain at least one day before submission.");
    error.statusCode = 400;
    throw error;
  }
  itinerary.forEach((day, index) => {
    const dayNumber = Number(day?.day) || index + 1;
    const pickupPoint = String(day?.pickupPoint || "").trim();
    if (!pickupPoint) {
      const error = new Error(`Day ${dayNumber}: pickup address is required.`);
      error.statusCode = 400;
      throw error;
    }
    if (!parseStrictTime(day?.pickupTime)) {
      const error = new Error(`Day ${dayNumber}: pickup time must use HH:mm (24-hour) format.`);
      error.statusCode = 400;
      throw error;
    }
    if (!validCoordinates(day?.pickupLat, day?.pickupLng)) {
      const error = new Error(`Day ${dayNumber}: valid non-zero pickup coordinates are required.`);
      error.statusCode = 400;
      throw error;
    }
  });
  return true;
}

module.exports = { validateSubmittedItinerary };
