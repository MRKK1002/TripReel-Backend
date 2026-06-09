const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false, // true for 465, false for 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
});

/**
 * Send an email
 * @param {Object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.text - Plain text body (optional)
 * @param {string} options.html - HTML body (optional)
 * @returns {Promise}
 */
const sendMail = async ({ to, subject, text, html }) => {
  const mailOptions = {
    from: `"TripReel" <${process.env.SMTP_USER}>`,
    to,
    subject,
    text,
    html,
  };

  const info = await transporter.sendMail(mailOptions);
  console.log(`✉️ Email sent to ${to}: ${info.messageId}`);
  return info;
};

/**
 * Send booking confirmation email
 */
const sendBookingConfirmation = async ({ to, userName, bookingDetails }) => {
  const { packageName, batchDate, seats, totalAmount, paymentId } =
    bookingDetails;

  const html = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #1F8A70, #16a34a); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: #fff; margin: 0; font-size: 24px;">Booking Confirmed! ✓</h1>
      </div>
      <div style="background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <p style="font-size: 16px; color: #374151;">Hi <strong>${userName}</strong>,</p>
        <p style="font-size: 15px; color: #4B5563;">Your trip booking has been confirmed. Here are the details:</p>
        
        <div style="background: #F9FAFB; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #6B7280; font-size: 14px;">Package</td>
              <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 600; text-align: right;">${packageName}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6B7280; font-size: 14px;">Travel Date</td>
              <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 600; text-align: right;">${batchDate}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6B7280; font-size: 14px;">Guests</td>
              <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 600; text-align: right;">${seats}</td>
            </tr>
            <tr style="border-top: 1px solid #E5E7EB;">
              <td style="padding: 12px 0 8px; color: #111827; font-size: 15px; font-weight: 700;">Total Paid</td>
              <td style="padding: 12px 0 8px; color: #1F8A70; font-size: 15px; font-weight: 700; text-align: right;">₹${totalAmount.toLocaleString("en-IN")}</td>
            </tr>
          </table>
        </div>

        ${paymentId ? `<p style="font-size: 12px; color: #9CA3AF;">Payment ID: ${paymentId}</p>` : ""}
        
        <p style="font-size: 14px; color: #4B5563; margin-top: 20px;">
          You can view your booking details in the <strong>"My Trips"</strong> section of the app.
        </p>
        
        <p style="font-size: 14px; color: #4B5563; margin-top: 20px;">
          Happy travels! 🌍<br/>
          <strong>Team TripReel</strong>
        </p>
      </div>
      <p style="text-align: center; font-size: 11px; color: #9CA3AF; margin-top: 16px;">
        © ${new Date().getFullYear()} TripReel. All rights reserved.
      </p>
    </div>
  `;

  return sendMail({
    to,
    subject: `✅ Booking Confirmed — ${packageName}`,
    html,
    text: `Hi ${userName}, your booking for ${packageName} on ${batchDate} (${seats} guests) is confirmed. Total: ₹${totalAmount}. Payment ID: ${paymentId || "N/A"}`,
  });
};

/**
 * Send payment receipt email
 */
const sendPaymentReceipt = async ({ to, userName, paymentDetails }) => {
  const { amount, paymentId, orderId, packageName, date } = paymentDetails;

  const html = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #111827; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: #fff; margin: 0; font-size: 22px;">Payment Receipt</h1>
      </div>
      <div style="background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <p style="font-size: 16px; color: #374151;">Hi <strong>${userName}</strong>,</p>
        <p style="font-size: 15px; color: #4B5563;">We've received your payment. Here's your receipt:</p>
        
        <div style="background: #F9FAFB; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #6B7280; font-size: 14px;">Amount</td>
              <td style="padding: 8px 0; color: #1F8A70; font-size: 16px; font-weight: 700; text-align: right;">₹${amount.toLocaleString("en-IN")}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6B7280; font-size: 14px;">Payment ID</td>
              <td style="padding: 8px 0; color: #111827; font-size: 13px; text-align: right;">${paymentId}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6B7280; font-size: 14px;">Order ID</td>
              <td style="padding: 8px 0; color: #111827; font-size: 13px; text-align: right;">${orderId}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6B7280; font-size: 14px;">For</td>
              <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 600; text-align: right;">${packageName}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6B7280; font-size: 14px;">Date</td>
              <td style="padding: 8px 0; color: #111827; font-size: 14px; text-align: right;">${date}</td>
            </tr>
          </table>
        </div>
        
        <p style="font-size: 14px; color: #4B5563; margin-top: 20px;">
          Thank you for choosing TripReel! 🎉<br/>
          <strong>Team TripReel</strong>
        </p>
      </div>
    </div>
  `;

  return sendMail({
    to,
    subject: `🧾 Payment Receipt — ₹${amount.toLocaleString("en-IN")} for ${packageName}`,
    html,
    text: `Hi ${userName}, payment of ₹${amount} received. Payment ID: ${paymentId}. Order: ${orderId}. Package: ${packageName}.`,
  });
};

module.exports = { sendMail, sendBookingConfirmation, sendPaymentReceipt };
