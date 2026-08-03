const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const EQUIPMENT_DIR = path.join(__dirname, "..", "uploads", "equipment");

if (!fs.existsSync(EQUIPMENT_DIR)) {
  fs.mkdirSync(EQUIPMENT_DIR, { recursive: true });
}

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
const MAX_FILE_SIZE_MB = 5;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, EQUIPMENT_DIR);
  },
  filename: (req, file, cb) => {
    // Always rename to avoid collisions/duplicates
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${uuidv4()}${ext}`;
    cb(null, uniqueName);
  },
});

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
