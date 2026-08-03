const express = require("express");
const router = express.Router();

const upload = require("../middleware/upload");
const verifyFirebaseToken = require("../middleware/auth");
const {
  getAllEquipment,
  getEquipmentById,
  createEquipment,
  updateEquipment,
  deleteEquipment,
  deleteEquipmentImageOnly,
} = require("../controllers/equipmentController");

// Reads are open to any logged-in user of the app; writes require auth too
// (single/two-person system, so we keep this simple — no role checks).
router.get("/", verifyFirebaseToken, getAllEquipment);
router.get("/:id", verifyFirebaseToken, getEquipmentById);
router.post("/", verifyFirebaseToken, upload.single("image"), createEquipment);
router.put("/:id", verifyFirebaseToken, upload.single("image"), updateEquipment);
router.delete("/:id", verifyFirebaseToken, deleteEquipment);
router.delete("/:id/image", verifyFirebaseToken, deleteEquipmentImageOnly);

module.exports = router;
