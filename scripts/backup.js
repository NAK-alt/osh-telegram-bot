/**
 * Simple backup script.
 * Run with: npm run backup
 *
 * Produces a timestamped .zip in /server/backups containing:
 *   - firestore-export.json  (full export of the "equipment" collection)
 *   - uploads/               (equipment images + qr codes)
 *   - .env.example           (config reference; the real .env is never committed/backed up as-is on purpose)
 *
 * For larger/production setups, prefer `gcloud firestore export` to a
 * Cloud Storage bucket instead of this JSON dump.
 */
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const { db } = require("../firebase/firebaseAdmin");

const BACKUP_DIR = path.join(__dirname, "..", "backups");
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");

async function exportFirestore() {
  const snapshot = await db.collection("equipment").get();
  const data = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  return JSON.stringify(data, null, 2);
}

async function runBackup() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const zipPath = path.join(BACKUP_DIR, `backup-${timestamp}.zip`);
  const exportJsonPath = path.join(BACKUP_DIR, `firestore-export-${timestamp}.json`);

  const firestoreJson = await exportFirestore();
  fs.writeFileSync(exportJsonPath, firestoreJson);

  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 9 } });

  output.on("close", () => {
    console.log(`Backup complete: ${zipPath} (${archive.pointer()} bytes)`);
    fs.unlinkSync(exportJsonPath); // cleanup loose json, it's inside the zip
    process.exit(0);
  });

  archive.on("error", (err) => {
    throw err;
  });

  archive.pipe(output);
  archive.file(exportJsonPath, { name: "firestore-export.json" });
  archive.directory(UPLOADS_DIR, "uploads");
  archive.file(path.join(__dirname, "..", ".env.example"), { name: ".env.example" });
  archive.finalize();
}

runBackup().catch((err) => {
  console.error("Backup failed:", err);
  process.exit(1);
});
