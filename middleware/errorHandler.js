const multer = require("multer");

// Central error handler. Also translates Multer errors into clean JSON.
function errorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "Image is too large. Max size is 5MB." });
    }
    return res.status(400).json({ error: err.message });
  }

  if (err) {
    console.error("[Error]", err.message);
    return res.status(err.status || 500).json({
      error: err.message || "Internal server error",
    });
  }

  next();
}

module.exports = errorHandler;
