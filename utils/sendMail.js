const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
});

// Anti-spam: proper headers
const FROM_NAME = "TripReel";
const FROM_EMAIL = process.env.SMTP_USER;
const REPLY_TO = "support@tripreel.com";

/**
 * Base email wrapper with TripReel branding
 */
function wrapInTemplate(content) {
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <!-- Header -->
  <tr><td style="background:linear-gradient(135deg,#1F8A70,#16a34a);padding:24px 30px;border-radius:12px 12px 0 0;text-align:center;">
    <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;letter-spacing:-0.5px;">TripReel</h1>
    <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:12px;">Your Travel Partner</p>
  </td></tr>
  <!-- Body -->
  <tr><td style="background:#ffffff;padding:30px;border:1px solid #e5e7eb;border-top:none;">
    ${content}
  </td></tr>
  <!-- Footer -->
  <tr><td style="padding:20px 30px;text-align:center;border-radius:0 0 12px 12px;">
    <p style="font-size:11px;color:#9CA3AF;margin:0;">
      TripReel | Your Travel Partner<br/>
      This email was sent to you because you have an account with TripReel.<br/>
      &copy; ${new Date().getFullYear()} TripReel. All rights reserved.
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * Send an email with anti-spam headers
 */
const sendMail = async ({ to, subject, text, html, attachments }) => {
  const mailOptions = {
    from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
    replyTo: REPLY_TO,
    to,
    subject,
    text,
    html,
    attachments: attachments || [],
    headers: {
      "X-Mailer": "TripReel Mailer",
      "List-Unsubscribe": `<mailto:${REPLY_TO}?subject=unsubscribe>`,
    },
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`Email sent to ${to}: ${info.messageId}`);
    return info;
  } catch (err) {
    console.warn(`Email failed to ${to}:`, err.message);
    return null;
  }
};

/**
 * Booking Confirmed — full trip details PDF-style email
 */
const sendBookingConfirmation = async ({ to, userName, bookingDetails }) => {
  const {
    bookingId,
    packageName,
    packageLocation,
    batchDate,
    seats,
    totalAmount,
    paymentId,
    travelers,
    itinerary,
    inclusions,
    operatorName,
    operatorPhone,
  } = bookingDetails;

  const travelersHtml = (travelers || [])
    .map(
      (t, i) =>
        `<tr><td style="padding:4px 8px;font-size:13px;color:#374151;">${i + 1}. ${t.name || "-"}</td><td style="padding:4px 8px;font-size:13px;color:#6B7280;">${t.gender || "-"}</td><td style="padding:4px 8px;font-size:13px;color:#6B7280;">Age ${t.age || "-"}</td></tr>`,
    )
    .join("");

  const itineraryHtml = (itinerary || [])
    .map(
      (day) =>
        `<div style="margin-bottom:10px;"><strong style="color:#1F8A70;">Day ${day.day}:</strong> <span style="color:#374151;">${day.title}</span>${day.points?.length ? '<ul style="margin:4px 0 0 16px;padding:0;color:#4B5563;font-size:13px;">' + day.points.map((p) => `<li>${p}</li>`).join("") + "</ul>" : ""}</div>`,
    )
    .join("");

  const inclusionsHtml = (inclusions || [])
    .map(
      (inc) =>
        `<span style="display:inline-block;background:#ECFDF5;color:#065F46;padding:3px 10px;border-radius:12px;font-size:11px;margin:3px 3px 3px 0;">${inc}</span>`,
    )
    .join("");

  const content = `
    <h2 style="color:#111827;margin:0 0 8px;font-size:20px;">Booking Confirmed</h2>
    <p style="font-size:15px;color:#4B5563;margin:0 0 20px;">Hi <strong>${userName}</strong>, your trip is booked!</p>

    <!-- Booking Summary Card -->
    <div style="background:#F9FAFB;border-radius:10px;padding:20px;margin-bottom:20px;border:1px solid #E5E7EB;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr><td style="padding:6px 0;color:#6B7280;font-size:13px;">Booking ID</td><td style="padding:6px 0;color:#111827;font-size:13px;font-weight:600;text-align:right;">${bookingId || "-"}</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280;font-size:13px;">Package</td><td style="padding:6px 0;color:#111827;font-size:14px;font-weight:700;text-align:right;">${packageName}</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280;font-size:13px;">Location</td><td style="padding:6px 0;color:#111827;font-size:13px;text-align:right;">${packageLocation || "-"}</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280;font-size:13px;">Travel Dates</td><td style="padding:6px 0;color:#111827;font-size:13px;font-weight:600;text-align:right;">${batchDate}</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280;font-size:13px;">Guests</td><td style="padding:6px 0;color:#111827;font-size:13px;text-align:right;">${seats}</td></tr>
        <tr style="border-top:1px solid #E5E7EB;"><td style="padding:12px 0 6px;color:#111827;font-size:15px;font-weight:700;">Total Amount</td><td style="padding:12px 0 6px;color:#1F8A70;font-size:16px;font-weight:700;text-align:right;">Rs.${Number(totalAmount).toLocaleString("en-IN")}</td></tr>
      </table>
      ${paymentId ? `<p style="font-size:11px;color:#9CA3AF;margin:10px 0 0;">Payment ID: ${paymentId}</p>` : ""}
    </div>

    <!-- Travelers -->
    ${
      travelersHtml
        ? `
    <h3 style="color:#111827;font-size:14px;margin:0 0 8px;">Travelers</h3>
    <table width="100%" style="border-collapse:collapse;margin-bottom:20px;background:#F9FAFB;border-radius:8px;overflow:hidden;">
      ${travelersHtml}
    </table>`
        : ""
    }

    <!-- Itinerary -->
    ${
      itineraryHtml
        ? `
    <h3 style="color:#111827;font-size:14px;margin:0 0 8px;">Trip Itinerary</h3>
    <div style="margin-bottom:20px;">${itineraryHtml}</div>`
        : ""
    }

    <!-- Inclusions -->
    ${
      inclusionsHtml
        ? `
    <h3 style="color:#111827;font-size:14px;margin:0 0 8px;">What's Included</h3>
    <div style="margin-bottom:20px;">${inclusionsHtml}</div>`
        : ""
    }

    <!-- Operator Contact -->
    ${
      operatorName
        ? `
    <div style="background:#EFF6FF;border-radius:8px;padding:14px;margin-bottom:20px;">
      <p style="margin:0;font-size:13px;color:#1E40AF;"><strong>Your Operator:</strong> ${operatorName}</p>
      ${operatorPhone ? `<p style="margin:4px 0 0;font-size:12px;color:#3B82F6;">Phone: ${operatorPhone}</p>` : ""}
    </div>`
        : ""
    }

    <p style="font-size:14px;color:#4B5563;">View your complete booking details in the <strong>My Trips</strong> section of the TripReel app.</p>
    <p style="font-size:14px;color:#4B5563;margin-top:16px;">Happy travels!<br/><strong>Team TripReel</strong></p>
  `;

  // Generate PDF attachment
  let attachments = [];
  try {
    const { generateBookingPdf } = require("./generateBookingPdf");
    const pdfBuffer = await generateBookingPdf(bookingDetails);
    attachments = [
      {
        filename: `TripReel_Booking_${bookingId || "confirmation"}.pdf`,
        content: pdfBuffer,
        contentType: "application/pdf",
      },
    ];
  } catch (pdfErr) {
    console.warn("PDF generation failed:", pdfErr.message);
  }

  return sendMail({
    to,
    subject: `Booking Confirmed - ${packageName} | ${batchDate}`,
    html: wrapInTemplate(content),
    text: `Hi ${userName}, your booking for ${packageName} on ${batchDate} (${seats} guests) is confirmed. Total: Rs.${totalAmount}. Booking ID: ${bookingId || "N/A"}`,
    attachments,
  });
};

/**
 * Payment Receipt email
 */
const sendPaymentReceipt = async ({ to, userName, paymentDetails }) => {
  const { amount, paymentId, orderId, packageName, date } = paymentDetails;

  const content = `
    <h2 style="color:#111827;margin:0 0 8px;font-size:20px;">Payment Receipt</h2>
    <p style="font-size:15px;color:#4B5563;">Hi <strong>${userName}</strong>, we have received your payment.</p>

    <div style="background:#F9FAFB;border-radius:10px;padding:20px;margin:20px 0;border:1px solid #E5E7EB;">
      <table width="100%" style="border-collapse:collapse;">
        <tr><td style="padding:8px 0;color:#6B7280;font-size:13px;">Amount Paid</td><td style="padding:8px 0;color:#1F8A70;font-size:16px;font-weight:700;text-align:right;">Rs.${Number(amount).toLocaleString("en-IN")}</td></tr>
        <tr><td style="padding:8px 0;color:#6B7280;font-size:13px;">Payment ID</td><td style="padding:8px 0;color:#111827;font-size:12px;text-align:right;">${paymentId}</td></tr>
        <tr><td style="padding:8px 0;color:#6B7280;font-size:13px;">Order ID</td><td style="padding:8px 0;color:#111827;font-size:12px;text-align:right;">${orderId}</td></tr>
        <tr><td style="padding:8px 0;color:#6B7280;font-size:13px;">Package</td><td style="padding:8px 0;color:#111827;font-size:13px;font-weight:600;text-align:right;">${packageName}</td></tr>
        <tr><td style="padding:8px 0;color:#6B7280;font-size:13px;">Date</td><td style="padding:8px 0;color:#111827;font-size:13px;text-align:right;">${date}</td></tr>
      </table>
    </div>

    <p style="font-size:14px;color:#4B5563;">Thank you for choosing TripReel!<br/><strong>Team TripReel</strong></p>
  `;

  return sendMail({
    to,
    subject: `Payment Receipt - Rs.${Number(amount).toLocaleString("en-IN")} for ${packageName}`,
    html: wrapInTemplate(content),
    text: `Hi ${userName}, payment of Rs.${amount} received. Payment ID: ${paymentId}. Package: ${packageName}.`,
  });
};

/**
 * Trip Reminder email (1 day before)
 */
const sendTripReminder = async ({ to, userName, tripDetails }) => {
  const { packageName, batchDate, pickupPoint, operatorName, operatorPhone } =
    tripDetails;

  const content = `
    <h2 style="color:#111827;margin:0 0 8px;font-size:20px;">Your Trip is Tomorrow!</h2>
    <p style="font-size:15px;color:#4B5563;">Hi <strong>${userName}</strong>, get ready for an amazing trip!</p>

    <div style="background:#ECFDF5;border-radius:10px;padding:20px;margin:20px 0;border:1px solid #A7F3D0;">
      <p style="margin:0 0 8px;font-size:15px;font-weight:700;color:#065F46;">${packageName}</p>
      <p style="margin:0;font-size:13px;color:#047857;">Date: ${batchDate}</p>
      ${pickupPoint ? `<p style="margin:4px 0 0;font-size:13px;color:#047857;">Pickup: ${pickupPoint}</p>` : ""}
    </div>

    ${
      operatorName
        ? `
    <div style="background:#F9FAFB;border-radius:8px;padding:14px;margin-bottom:20px;">
      <p style="margin:0;font-size:13px;color:#374151;"><strong>Operator:</strong> ${operatorName}</p>
      ${operatorPhone ? `<p style="margin:4px 0 0;font-size:12px;color:#6B7280;">Phone: ${operatorPhone}</p>` : ""}
    </div>`
        : ""
    }

    <h3 style="color:#111827;font-size:14px;margin:0 0 8px;">Quick Checklist:</h3>
    <ul style="color:#4B5563;font-size:13px;line-height:1.8;">
      <li>ID proof (Aadhaar/Passport)</li>
      <li>Comfortable clothing and footwear</li>
      <li>Water bottle and snacks</li>
      <li>Sunscreen and sunglasses</li>
      <li>Fully charged phone</li>
    </ul>

    <p style="font-size:14px;color:#4B5563;margin-top:16px;">Have a wonderful trip!<br/><strong>Team TripReel</strong></p>
  `;

  return sendMail({
    to,
    subject: `Trip Tomorrow - ${packageName} | Get Ready!`,
    html: wrapInTemplate(content),
    text: `Hi ${userName}, your trip to ${packageName} is tomorrow (${batchDate}). Don't forget your ID proof and essentials!`,
  });
};

/**
 * Review Request email (after trip)
 */
const sendReviewRequest = async ({ to, userName, tripDetails }) => {
  const { packageName } = tripDetails;

  const content = `
    <h2 style="color:#111827;margin:0 0 8px;font-size:20px;">How was your trip?</h2>
    <p style="font-size:15px;color:#4B5563;">Hi <strong>${userName}</strong>, we hope you had an amazing time at <strong>${packageName}</strong>!</p>

    <p style="font-size:14px;color:#4B5563;margin:16px 0;">Your review helps other travelers make better decisions and helps operators improve their service.</p>

    <div style="text-align:center;margin:24px 0;">
      <p style="font-size:13px;color:#6B7280;margin-bottom:12px;">Rate your experience</p>
      <p style="font-size:32px;margin:0;">&#11088; &#11088; &#11088; &#11088; &#11088;</p>
    </div>

    <p style="font-size:14px;color:#4B5563;">Open the TripReel app and go to <strong>My Trips</strong> to leave your review. It only takes 30 seconds!</p>

    <p style="font-size:14px;color:#4B5563;margin-top:20px;">Thank you!<br/><strong>Team TripReel</strong></p>
  `;

  return sendMail({
    to,
    subject: `How was ${packageName}? Share your experience`,
    html: wrapInTemplate(content),
    text: `Hi ${userName}, how was your trip to ${packageName}? Open the TripReel app to leave a review!`,
  });
};

module.exports = {
  sendMail,
  sendBookingConfirmation,
  sendPaymentReceipt,
  sendTripReminder,
  sendReviewRequest,
};
