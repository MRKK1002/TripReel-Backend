const PDFDocument = require("pdfkit");

function generateBookingPdf(bookingDetails) {
  return new Promise((resolve, reject) => {
    const {
      bookingId,
      userName,
      packageName,
      packageLocation,
      batchDate,
      seats,
      totalAmount,
      travelers,
      itinerary,
      inclusions,
      operatorName,
      operatorPhone,
      paymentId,
    } = bookingDetails;

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = 595;
    const leftM = 40;
    const rightM = pageW - 40;
    const contentW = rightM - leftM;

    // ═══════ HEADER ═══════
    doc.rect(0, 0, pageW, 90).fill("#1F8A70");
    doc
      .fontSize(24)
      .fillColor("#FFFFFF")
      .font("Helvetica-Bold")
      .text("TripReel", leftM, 25);
    doc
      .fontSize(11)
      .fillColor("rgba(255,255,255,0.8)")
      .font("Helvetica")
      .text("Booking Confirmation", leftM, 55);
    doc.fontSize(9).text("Your Travel Partner", leftM, 70);

    // Right side - booking ID
    if (bookingId) {
      doc
        .fontSize(9)
        .fillColor("rgba(255,255,255,0.9)")
        .text(bookingId, rightM - 150, 35, { width: 150, align: "right" });
    }

    let y = 110;

    // ═══════ BOOKING SUMMARY BOX ═══════
    doc
      .roundedRect(leftM, y, contentW, 130, 8)
      .fill("#F9FAFB")
      .stroke("#E5E7EB");
    y += 15;

    const col1 = leftM + 15;
    const col2 = leftM + contentW / 2 + 10;

    // Row 1
    doc
      .fontSize(8)
      .fillColor("#6B7280")
      .font("Helvetica")
      .text("PACKAGE", col1, y);
    doc.fontSize(8).text("LOCATION", col2, y);
    y += 12;
    doc
      .fontSize(11)
      .fillColor("#111827")
      .font("Helvetica-Bold")
      .text(packageName || "-", col1, y, { width: contentW / 2 - 20 });
    doc
      .fontSize(11)
      .fillColor("#111827")
      .font("Helvetica-Bold")
      .text(packageLocation || "-", col2, y, { width: contentW / 2 - 20 });
    y += 25;

    // Row 2
    doc
      .fontSize(8)
      .fillColor("#6B7280")
      .font("Helvetica")
      .text("TRAVEL DATES", col1, y);
    doc.fontSize(8).text("GUESTS", col2, y);
    y += 12;
    doc
      .fontSize(11)
      .fillColor("#111827")
      .font("Helvetica-Bold")
      .text(batchDate || "-", col1, y);
    doc
      .fontSize(11)
      .fillColor("#111827")
      .font("Helvetica-Bold")
      .text(String(seats || 1), col2, y);
    y += 25;

    // Row 3 - Amount
    doc
      .fontSize(8)
      .fillColor("#6B7280")
      .font("Helvetica")
      .text("TOTAL AMOUNT", col1, y);
    if (paymentId) doc.fontSize(8).text("PAYMENT ID", col2, y);
    y += 12;
    doc
      .fontSize(14)
      .fillColor("#1F8A70")
      .font("Helvetica-Bold")
      .text("Rs. " + Number(totalAmount || 0).toLocaleString("en-IN"), col1, y);
    if (paymentId)
      doc
        .fontSize(9)
        .fillColor("#374151")
        .font("Helvetica")
        .text(paymentId, col2, y);

    y = 260;

    // ═══════ TRAVELERS ═══════
    if (travelers && travelers.length > 0) {
      doc.moveTo(leftM, y).lineTo(rightM, y).lineWidth(0.5).stroke("#E5E7EB");
      y += 12;
      doc
        .fontSize(11)
        .fillColor("#111827")
        .font("Helvetica-Bold")
        .text("Travelers", leftM, y);
      y += 20;

      doc.fontSize(8).fillColor("#6B7280").font("Helvetica");
      doc.text("#", leftM, y, { width: 20 });
      doc.text("NAME", leftM + 25, y, { width: 200 });
      doc.text("GENDER", leftM + 230, y, { width: 80 });
      doc.text("AGE", leftM + 320, y, { width: 50 });
      y += 15;

      travelers.forEach((t, i) => {
        if (y > 720) {
          doc.addPage();
          y = 50;
        }
        doc.fontSize(9).fillColor("#374151").font("Helvetica");
        doc.text(String(i + 1), leftM, y, { width: 20 });
        doc.text(t.name || "-", leftM + 25, y, { width: 200 });
        doc.text(t.gender || "-", leftM + 230, y, { width: 80 });
        doc.text(String(t.age || "-"), leftM + 320, y, { width: 50 });
        y += 18;
      });
      y += 10;
    }

    // ═══════ ITINERARY ═══════
    if (itinerary && itinerary.length > 0) {
      if (y > 650) {
        doc.addPage();
        y = 50;
      }
      doc.moveTo(leftM, y).lineTo(rightM, y).lineWidth(0.5).stroke("#E5E7EB");
      y += 12;
      doc
        .fontSize(11)
        .fillColor("#111827")
        .font("Helvetica-Bold")
        .text("Trip Itinerary", leftM, y);
      y += 22;

      itinerary.forEach((day) => {
        if (y > 700) {
          doc.addPage();
          y = 50;
        }
        doc
          .fontSize(9)
          .fillColor("#1F8A70")
          .font("Helvetica-Bold")
          .text("Day " + day.day + ": " + (day.title || ""), leftM + 10, y);
        y += 15;
        (day.points || []).forEach((p) => {
          if (y > 720) {
            doc.addPage();
            y = 50;
          }
          doc
            .fontSize(8)
            .fillColor("#4B5563")
            .font("Helvetica")
            .text("  - " + p, leftM + 20, y);
          y += 13;
        });
        y += 6;
      });
      y += 5;
    }

    // ═══════ INCLUSIONS ═══════
    if (inclusions && inclusions.length > 0) {
      if (y > 680) {
        doc.addPage();
        y = 50;
      }
      doc.moveTo(leftM, y).lineTo(rightM, y).lineWidth(0.5).stroke("#E5E7EB");
      y += 12;
      doc
        .fontSize(11)
        .fillColor("#111827")
        .font("Helvetica-Bold")
        .text("Inclusions", leftM, y);
      y += 20;
      inclusions.forEach((inc) => {
        if (y > 720) {
          doc.addPage();
          y = 50;
        }
        doc
          .fontSize(8)
          .fillColor("#065F46")
          .font("Helvetica")
          .text("+ " + inc, leftM + 10, y);
        y += 14;
      });
      y += 10;
    }

    // ═══════ OPERATOR ═══════
    if (operatorName) {
      if (y > 700) {
        doc.addPage();
        y = 50;
      }
      doc.moveTo(leftM, y).lineTo(rightM, y).lineWidth(0.5).stroke("#E5E7EB");
      y += 12;
      doc
        .fontSize(9)
        .fillColor("#6B7280")
        .font("Helvetica")
        .text("Tour Operator:", leftM, y);
      doc
        .fontSize(9)
        .fillColor("#111827")
        .font("Helvetica-Bold")
        .text(
          operatorName + (operatorPhone ? "  |  " + operatorPhone : ""),
          leftM + 85,
          y,
        );
      y += 25;
    }

    // ═══════ FOOTER ═══════
    const footerY = 780;
    doc
      .moveTo(leftM, footerY)
      .lineTo(rightM, footerY)
      .lineWidth(0.5)
      .stroke("#E5E7EB");
    doc
      .fontSize(7)
      .fillColor("#9CA3AF")
      .font("Helvetica")
      .text(
        "TripReel | Your Travel Partner | support@tripreel.com",
        leftM,
        footerY + 8,
        { width: contentW, align: "center" },
      );
    doc
      .fontSize(7)
      .text(
        "This is a system-generated document. No signature required.",
        leftM,
        footerY + 20,
        { width: contentW, align: "center" },
      );

    doc.end();
  });
}

module.exports = { generateBookingPdf };
