const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");

const QR_DIR = path.join(__dirname, "..", "uploads", "qr-codes");

if (!fs.existsSync(QR_DIR)) {
  fs.mkdirSync(QR_DIR, { recursive: true });
}

/**
 * Generates a QR code PNG for a given equipment ID that, when scanned,
 * opens that equipment's detail page on the frontend.
 * Returns the local path to store in Firestore, e.g. "/uploads/qr-codes/eq_123.png".
 */
async function generateEquipmentQrCode(equipmentId, clientBaseUrl) {
  const filename = `${equipmentId}.png`;
  const fullPath = path.join(QR_DIR, filename);
  const detailUrl = `${clientBaseUrl}/equipment/${equipmentId}`;

  await QRCode.toFile(fullPath, detailUrl, {
    width: 400,
    margin: 2,
  });

  return `/uploads/qr-codes/${filename}`;
}

module.exports = { generateEquipmentQrCode };
