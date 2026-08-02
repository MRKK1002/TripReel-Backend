/**
 * Send an SMS via RapidSMS (DLT transactional route).
 *
 * Expects env vars:
 *   RAPIDSMS_API_KEY  — your RapidSMS API key
 *   RAPIDSMS_SENDER   — approved sender ID (default: TRPREL)
 *
 * The OTP message template must match your DLT-approved template exactly,
 * including the hash tag for auto-read on Android.
 */

const RAPIDSMS_BASE = "https://1.rapidsms.co.in/api/push.json";

async function sendOtpSms(phone, otp) {
  const apiKey = process.env.RAPIDSMS_API_KEY;
  if (!apiKey) {
    console.warn("[SMS] RAPIDSMS_API_KEY not set — OTP not sent via SMS");
    return { success: false, reason: "no_api_key" };
  }

  const sender = process.env.RAPIDSMS_SENDER || "TRPREL";

  // Normalize phone: RapidSMS expects 10-digit Indian number (no country code)
  // or 91XXXXXXXXXX format depending on account. Try with 91 prefix.
  let mobile = String(phone).replace(/\D/g, "");
  if (mobile.length === 10) mobile = "91" + mobile;
  else if (mobile.startsWith("+")) mobile = mobile.slice(1);

  // DLT-approved template — must match exactly what's registered.
  const APP_HASH = process.env.RAPIDSMS_APP_HASH || "9fsKEw5KRlX";
  const message = `<#> ${otp} is your Trip Reel login code. Valid for 10 minutes. Never share this code. ${APP_HASH}`;

  const params = new URLSearchParams({
    apikey: apiKey,
    route: "trans",
    sender,
    mobileno: mobile,
    text: message,
  });

  const url = `${RAPIDSMS_BASE}?${params.toString()}`;

  try {
    const res = await fetch(url);
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }

    console.log(`[SMS] Response for ${mobile}:`, JSON.stringify(data));

    if (
      res.ok &&
      (data.status === "success" ||
        data.status === 200 ||
        data.status === "200")
    ) {
      console.log(`[SMS] OTP sent to ${mobile}`);
      return { success: true, data };
    }

    console.error(
      `[SMS] Failed for ${mobile}:`,
      data.message || data.status || data.error || raw,
    );
    return {
      success: false,
      reason: data.message || data.error || "api_error",
      data,
    };
  } catch (err) {
    console.error(`[SMS] Network error for ${mobile}:`, err.message);
    return { success: false, reason: err.message };
  }
}

module.exports = { sendOtpSms };
