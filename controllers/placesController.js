// Server-side proxy for Google Places (legacy) Autocomplete + Details.
// Keeps the API key on the server (never ships in the app) and sidesteps
// Android application-restriction issues that block direct calls from the app.

const KEY = () => process.env.GOOGLE_PLACES_API_KEY || "";

// GET /api/places/autocomplete?input=...&lat=...&lng=...&radius=...
exports.autocomplete = async (req, res) => {
  try {
    const key = KEY();
    if (!key) {
      return res
        .status(503)
        .json({ success: false, message: "Place search not configured" });
    }

    const input = (req.query.input || "").toString().trim();
    if (input.length < 3) {
      return res.json({ success: true, predictions: [] });
    }

    let url =
      "https://maps.googleapis.com/maps/api/place/autocomplete/json" +
      `?input=${encodeURIComponent(input)}` +
      `&key=${key}` +
      "&language=en&components=country:in";

    // Optional radius restriction around a center point
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radius = Number(req.query.radius); // meters
    if (!isNaN(lat) && !isNaN(lng) && !isNaN(radius) && radius > 0) {
      url += `&location=${lat},${lng}&radius=${Math.round(radius)}&strictbounds=true`;
    }

    const r = await fetch(url);
    const data = await r.json();

    if (data.status && data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      console.error(
        "[places.autocomplete] Google:",
        data.status,
        data.error_message,
      );
      return res.status(502).json({
        success: false,
        message: data.error_message || "Place search failed",
        status: data.status,
      });
    }

    const predictions = (data.predictions || []).map((p) => ({
      placeId: p.place_id,
      mainText: p.structured_formatting?.main_text || p.description || "",
      secondaryText: p.structured_formatting?.secondary_text || "",
    }));

    res.json({ success: true, predictions });
  } catch (err) {
    console.error("[places.autocomplete] error:", err.message);
    res.status(500).json({ success: false, message: "Place search failed" });
  }
};

// GET /api/places/details?placeId=...
exports.details = async (req, res) => {
  try {
    const key = KEY();
    if (!key) {
      return res
        .status(503)
        .json({ success: false, message: "Place search not configured" });
    }

    const placeId = (req.query.placeId || "").toString().trim();
    if (!placeId) {
      return res
        .status(400)
        .json({ success: false, message: "placeId is required" });
    }

    const url =
      "https://maps.googleapis.com/maps/api/place/details/json" +
      `?place_id=${encodeURIComponent(placeId)}` +
      `&key=${key}` +
      "&fields=geometry,formatted_address,name";

    const r = await fetch(url);
    const data = await r.json();

    if (data.status && data.status !== "OK") {
      console.error(
        "[places.details] Google:",
        data.status,
        data.error_message,
      );
      return res.status(502).json({
        success: false,
        message: data.error_message || "Place details failed",
        status: data.status,
      });
    }

    const place = data.result || {};
    res.json({
      success: true,
      place: {
        name: place.name || "",
        address: place.formatted_address || "",
        lat: place.geometry?.location?.lat ?? null,
        lng: place.geometry?.location?.lng ?? null,
      },
    });
  } catch (err) {
    console.error("[places.details] error:", err.message);
    res.status(500).json({ success: false, message: "Place details failed" });
  }
};
