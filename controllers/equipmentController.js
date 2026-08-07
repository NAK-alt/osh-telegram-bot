const { db, admin } = require("../firebase/firebaseAdmin");
const { deleteQrCode, PLACEHOLDER_PATH } = require("../services/fileService");
const { generateEquipmentQrCode } = require("../services/qrService");
const {
  uploadEquipmentImage,
  deleteStoredImage,
  resolveImageUrl,
} = require("../services/storageService");

const COLLECTION = "equipment";
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

// Map an uploaded file's mimetype to a file extension for Storage.
function extFromMimetype(mimetype) {
  switch ((mimetype || "").toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/jpeg":
    case "image/jpg":
    default:
      return ".jpg";
  }
}

// Resolve an item's imagePath to a fetchable URL before sending it to the client.
// Legacy /uploads/... and placeholder paths pass through unchanged (the client
// prepends the API base). Storage paths become signed HTTPS URLs.
async function withResolvedImage(item) {
  if (!item) return item;
  return { ...item, imagePath: await resolveImageUrl(item.imagePath) };
}

// GET /api/equipment
async function getAllEquipment(req, res, next) {
  try {
    const snapshot = await db.collection(COLLECTION).orderBy("createdAt", "desc").get();
    const equipment = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const resolved = await Promise.all(equipment.map(withResolvedImage));
    res.json(resolved);
  } catch (err) {
    next(err);
  }
}

// GET /api/equipment/:id
async function getEquipmentById(req, res, next) {
  try {
    const doc = await db.collection(COLLECTION).doc(req.params.id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: "Equipment not found." });
    }
    const item = { id: doc.id, ...doc.data() };
    res.json(await withResolvedImage(item));
  } catch (err) {
    next(err);
  }
}

// POST /api/equipment
async function createEquipment(req, res, next) {
  try {
    const {
      equipmentName,
      brand,
      model,
      serialNumber,
      storageLocation,
      totalQuantity,
      minimumStockLevel,
      description,
    } = req.body;

    if (!equipmentName) {
      return res.status(400).json({ error: "equipmentName is required." });
    }

    const total = Number(totalQuantity) || 0;
    let imagePath = PLACEHOLDER_PATH;
    if (req.file) {
      const { storagePath } = await uploadEquipmentImage(req.file.buffer, {
        ext: extFromMimetype(req.file.mimetype),
        contentType: req.file.mimetype,
      });
      imagePath = storagePath;
    }

    const docRef = await db.collection(COLLECTION).add({
      equipmentName,
      equipmentNameKey: normalizeName(equipmentName),
      brand: brand || "",
      model: model || "",
      serialNumber: serialNumber || "",
      storageLocation: storageLocation || "",
      totalQuantity: total,
      availableQuantity: total,
      borrowedQuantity: 0,
      minimumStockLevel: Number(minimumStockLevel) || 0,
      imagePath,
      qrCodePath: null,
      status: total > 0 ? "Available" : "Out of Stock",
      description: description || "",
      borrowHistory: [],
      activeLoans: [],
      lastBorrowedBy: "",
      lastBorrowedAt: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Generate QR code now that we have the document ID
    const qrCodePath = await generateEquipmentQrCode(docRef.id, CLIENT_URL);
    await docRef.update({ qrCodePath });

    const created = await docRef.get();
    res.status(201).json(await withResolvedImage({ id: docRef.id, ...created.data() }));
  } catch (err) {
    next(err);
  }
}

// PUT /api/equipment/:id
async function updateEquipment(req, res, next) {
  try {
    const docRef = db.collection(COLLECTION).doc(req.params.id);
    const existing = await docRef.get();

    if (!existing.exists) {
      return res.status(404).json({ error: "Equipment not found." });
    }

    const existingData = existing.data();
    const updates = { ...req.body, updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    if (updates.equipmentName !== undefined) {
      updates.equipmentNameKey = normalizeName(updates.equipmentName);
    }

    // Normalize numeric fields if present
    ["totalQuantity", "availableQuantity", "borrowedQuantity", "minimumStockLevel"].forEach((f) => {
      if (updates[f] !== undefined && updates[f] !== "") updates[f] = Number(updates[f]);
    });

    const effectiveTotal = updates.totalQuantity !== undefined ? updates.totalQuantity : existingData.totalQuantity;
    const effectiveBorrowed = updates.borrowedQuantity !== undefined ? updates.borrowedQuantity : (existingData.borrowedQuantity || 0);

    if (updates.availableQuantity === undefined && (updates.totalQuantity !== undefined || updates.borrowedQuantity !== undefined)) {
      updates.availableQuantity = Math.max(0, effectiveTotal - effectiveBorrowed);
    }

    const effectiveAvailable = updates.availableQuantity !== undefined ? updates.availableQuantity : (existingData.availableQuantity || 0);

    // If a new image was uploaded, replace the old one (Storage or legacy disk).
    if (req.file) {
      await deleteStoredImage(existingData.imagePath);
      const { storagePath } = await uploadEquipmentImage(req.file.buffer, {
        ext: extFromMimetype(req.file.mimetype),
        contentType: req.file.mimetype,
      });
      updates.imagePath = storagePath;
    }

    if (effectiveAvailable <= 0) updates.status = "Out of Stock";
    else updates.status = "Available";

    await docRef.update(updates);
    const updated = await docRef.get();
    res.json(await withResolvedImage({ id: docRef.id, ...updated.data() }));
  } catch (err) {
    next(err);
  }
}

// DELETE /api/equipment/:id
async function deleteEquipment(req, res, next) {
  try {
    const docRef = db.collection(COLLECTION).doc(req.params.id);
    const existing = await docRef.get();

    if (!existing.exists) {
      return res.status(404).json({ error: "Equipment not found." });
    }

    const data = existing.data();
    await deleteStoredImage(data.imagePath);
    deleteQrCode(data.qrCodePath);

    await docRef.delete();
    res.json({ message: "Equipment deleted successfully." });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/equipment/:id/image  -> revert to placeholder
async function deleteEquipmentImageOnly(req, res, next) {
  try {
    const docRef = db.collection(COLLECTION).doc(req.params.id);
    const existing = await docRef.get();

    if (!existing.exists) {
      return res.status(404).json({ error: "Equipment not found." });
    }

    await deleteStoredImage(existing.data().imagePath);
    await docRef.update({ imagePath: PLACEHOLDER_PATH, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    res.json({ message: "Image removed, reverted to placeholder.", imagePath: PLACEHOLDER_PATH });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getAllEquipment,
  getEquipmentById,
  createEquipment,
  updateEquipment,
  deleteEquipment,
  deleteEquipmentImageOnly,
};