const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");

// Prefer the FIREBASE_SERVICE_ACCOUNT env var (base64-encoded JSON service account
// key) so the secret never lives in the repo — this is what cloud hosts (Railway,
// Render, etc.) use. Fall back to the local file for dev.
const envKey = process.env.FIREBASE_SERVICE_ACCOUNT;
const serviceAccountPath = path.join(__dirname, "serviceAccountKey.json");

let serviceAccount = null;
if (envKey) {
  try {
    serviceAccount = JSON.parse(Buffer.from(envKey, "base64").toString("utf8"));
  } catch (err) {
    console.error("[Firebase] Could not parse FIREBASE_SERVICE_ACCOUNT env var:", err.message);
    process.exit(1);
  }
} else if (fs.existsSync(serviceAccountPath)) {
  serviceAccount = require(serviceAccountPath);
} else {
  console.error(
    "\n[Firebase] No service account found.\n" +
    "Either set FIREBASE_SERVICE_ACCOUNT (base64 of the key JSON) or place\n" +
    "serviceAccountKey.json in /server/firebase/ (download from Firebase Console >\n" +
    "Project Settings > Service Accounts > Generate new private key).\n"
  );
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

module.exports = { admin, db };
