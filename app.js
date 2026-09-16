process.env.TZ = process.env.TZ || "Asia/Phnom_Penh";
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");

const equipmentRoutes = require("./routes/equipmentRoutes");
const errorHandler = require("./middleware/errorHandler");

const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = [
  process.env.CLIENT_URL,
  "http://localhost:5173",
  "http://localhost:3000",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (
        allowedOrigins.includes(origin) ||
        origin.endsWith(".vercel.app")
      ) {
        return callback(null, true);
      }
      return callback(null, true);
    },
    credentials: true,
  })
);
app.use(express.json());
app.use(morgan("dev"));

// Serve uploaded images/QR codes as static files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Root status route
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "OSH Equipment API is running" });
});

// API routes
app.use("/api/equipment", equipmentRoutes);

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found." });
});

// Central error handler (must be last)
app.use(errorHandler);

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`OSH Equipment server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
