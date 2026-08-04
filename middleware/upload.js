const multer = require("multer");

// Equipment images are uploaded to Firebase Storage (not the local disk), so we keep
// the uploaded file in memory as a buffer and hand it to storageService. This avoids
// touching the ephemeral filesystem on Railway at all.
const storage = multer.memoryStorage();

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
const MAX_FILE_SIZE_MB = 5;

function fileFilter(req, file, cb) {
  if (!ALLOWED_TYPES.includes(file.mimetype)) {
    return cb(
      new Error("Invalid file type. Only JPG, PNG, and WEBP images are allowed."),
      false
    );
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
});

module.exports = upload;
