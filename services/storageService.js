const { v2: cloudinary } = require("cloudinary");
const { deleteEquipmentImage, PLACEHOLDER_PATH } = require("./fileService");

// Equipment images live in Cloudinary (free, no credit card) so they survive
// Railway's ephemeral filesystem and are shared by both the web app and the
// Telegram bot. Firestore stores the Cloudinary **public_id** (e.g.
// "equipment/<id>") in `imagePath` — NOT a URL. A fetchable HTTPS CDN URL is
// resolved from that public_id at read time via `resolveImageUrl`. Deleting uses
// the public_id directly via `cloudinary.uploader.destroy`.
//
// Required env vars: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

function isCloudinaryPath(imagePath) {
  return typeof imagePath === "string" && imagePath.startsWith("equipment/");
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function isLegacyLocalPath(imagePath) {
  return typeof imagePath === "string" && imagePath.startsWith("/uploads/equipment/");
}

function ensureConfigured() {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw new Error(
      "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET (in server/.env locally, or Railway Variables in production)."
    );
  }
}

// Upload a buffer to Cloudinary under the "equipment" folder. Returns the stored
// public_id (NOT a URL) to persist in Firestore `imagePath`.
async function uploadEquipmentImage(buffer, { contentType } = {}) {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "equipment",
        resource_type: "image",
        ...(contentType ? { format: contentType.split("/")[1] } : {}),
      },
      (err, result) => {
        if (err) return reject(err);
        resolve({ storagePath: result.public_id });
      }
    );
    stream.end(buffer);
  });
}

// Delete an equipment image, routing by path shape:
//   equipment/...           -> cloudinary.uploader.destroy(public_id) (swallow not-found)
//   /uploads/equipment/...  -> delete the local disk file (legacy) via fileService
//   placeholder / missing  -> no-op
async function deleteStoredImage(imagePath) {
  if (!imagePath || imagePath === PLACEHOLDER_PATH) return;

  if (isCloudinaryPath(imagePath)) {
    try {
      ensureConfigured();
      await cloudinary.uploader.destroy(imagePath);
    } catch (err) {
      console.error("[storageService] Failed to delete Cloudinary asset:", imagePath, err && err.message);
    }
    return;
  }

  if (isLegacyLocalPath(imagePath)) {
    deleteEquipmentImage(imagePath);
    return;
  }
}

// Resolve a stored imagePath into a fetchable HTTPS CDN URL at read time.
//   equipment/...  -> Cloudinary secure URL
//   http(s)://...  -> returned as-is
//   /uploads/...  -> returned as-is (caller prepends API_BASE / reads from disk)
//   placeholder / missing -> returned as-is
async function resolveImageUrl(imagePath) {
  if (!imagePath) return imagePath;
  if (isHttpUrl(imagePath)) return imagePath;
  if (!isCloudinaryPath(imagePath)) return imagePath; // legacy local path or placeholder

  ensureConfigured();
  return cloudinary.url(imagePath, { secure: true, fetch_format: "auto" });
}

module.exports = {
  uploadEquipmentImage,
  deleteStoredImage,
  resolveImageUrl,
  isCloudinaryPath,
};