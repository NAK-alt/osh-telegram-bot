const fs = require("fs");
const path = require("path");

const EQUIPMENT_DIR = path.join(__dirname, "..", "uploads", "equipment");
const QR_DIR = path.join(__dirname, "..", "uploads", "qr-codes");
const PLACEHOLDER_PATH = "/uploads/placeholder.png";

// Make sure the upload dirs exist on startup (cloud hosts start with an empty fs).
for (const dir of [EQUIPMENT_DIR, QR_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Deletes a previously uploaded equipment image given its stored path
 * (e.g. "/uploads/equipment/xxxx.jpg"). Silently ignores the placeholder
 * and missing files so callers never need to check existence first.
 */
function deleteEquipmentImage(imagePath) {
  if (!imagePath || imagePath === PLACEHOLDER_PATH) return;

  const filename = path.basename(imagePath);
  const fullPath = path.join(EQUIPMENT_DIR, filename);

  fs.unlink(fullPath, (err) => {
    if (err && err.code !== "ENOENT") {
      console.error("[fileService] Failed to delete image:", fullPath, err.message);
    }
  });
}

function deleteQrCode(qrPath) {
  if (!qrPath) return;
  const filename = path.basename(qrPath);
  const fullPath = path.join(QR_DIR, filename);

  fs.unlink(fullPath, (err) => {
    if (err && err.code !== "ENOENT") {
      console.error("[fileService] Failed to delete QR code:", fullPath, err.message);
    }
  });
}

module.exports = { deleteEquipmentImage, deleteQrCode, PLACEHOLDER_PATH };
