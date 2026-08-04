/**
 * One-off, idempotent migration: copy local equipment images in
 * server/uploads/equipment/ into Cloudinary and rewrite each Firestore
 * `imagePath` from "/uploads/equipment/xxx.jpg" to the Cloudinary public_id
 * "equipment/<id>".
 *
 * Run locally (where the original files still exist on disk):
 *   npm run migrate-images
 * or: node server/scripts/migrateImagesToStorage.js
 *
 * Requires Cloudinary env vars: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY,
 * CLOUDINARY_API_SECRET (in server/.env).
 *
 * Safe to run repeatedly: items whose imagePath already starts with "http" or
 * "equipment/" are skipped. Items whose local file is missing are logged and skipped
 * (their Firestore path is left unchanged).
 */
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const { db, admin } = require("../firebase/firebaseAdmin");
const { uploadEquipmentImage } = require("../services/storageService");
const { PLACEHOLDER_PATH } = require("../services/fileService");

const EQUIPMENT_DIR = path.join(__dirname, "..", "uploads", "equipment");

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return { contentType: "image/png", ext: ".png" };
    case ".webp":
      return { contentType: "image/webp", ext: ".webp" };
    case ".jpg":
    case ".jpeg":
    default:
      return { contentType: "image/jpeg", ext: ".jpg" };
  }
}

async function migrate() {
  const snap = await db.collection("equipment").get();

  let migrated = 0;
  let skippedAlready = 0;
  let skippedPlaceholder = 0;
  let missing = 0;
  const missingNames = [];

  for (const doc of snap.docs) {
    const data = doc.data();
    const imagePath = data.imagePath;

    if (!imagePath || imagePath === PLACEHOLDER_PATH) {
      skippedPlaceholder++;
      continue;
    }
    if (imagePath.startsWith("http://") || imagePath.startsWith("https://") || imagePath.startsWith("equipment/")) {
      skippedAlready++;
      continue;
    }
    if (!imagePath.startsWith("/uploads/equipment/")) {
      skippedAlready++;
      continue;
    }

    const localFile = path.join(EQUIPMENT_DIR, path.basename(imagePath));
    if (!fs.existsSync(localFile)) {
      missing++;
      missingNames.push(imagePath);
      continue;
    }

    const buffer = fs.readFileSync(localFile);
    const { ext, contentType } = contentTypeFor(localFile);
    const { storagePath } = await uploadEquipmentImage(buffer, { ext, contentType });
    await doc.ref.update({
      imagePath: storagePath,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`migrated: ${imagePath} -> ${storagePath}`);
    migrated++;
  }

  console.log("\n--- migration summary ---");
  console.log(`migrated:           ${migrated}`);
  console.log(`already migrated:   ${skippedAlready}`);
  console.log(`placeholder/no img:  ${skippedPlaceholder}`);
  console.log(`local file missing: ${missing}`);
  if (missingNames.length) console.log("missing files:\n  " + missingNames.join("\n  "));
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });