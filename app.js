require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");

const equipmentRoutes = require("./routes/equipmentRoutes");
const errorHandler = require("./middleware/errorHandler");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:5173" }));
app.use(express.json());
app.use(morgan("dev"));

// Serve uploaded images/QR codes as static files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

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

app.listen(PORT, () => {
  console.log(`OSH Equipment server running on http://localhost:${PORT}`);
});
