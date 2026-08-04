const { db, admin } = require("../firebase/firebaseAdmin");
const { generateEquipmentQrCode } = require("../services/qrService");
const { deleteQrCode, PLACEHOLDER_PATH } = require("../services/fileService");
const { deleteStoredImage } = require("../services/storageService");

const COLLECTION = "equipment";
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

function computeStatus(available, minStock) {
  if (available <= 0) return "Out of Stock";
  if (available <= minStock) return "Low Stock";
  return "Available";
}

function normalizeLookup(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeBorrower(value) {
  return String(value || "").trim().toLowerCase();
}

function getActiveLoans(item) {
  return Array.isArray(item.activeLoans) ? item.activeLoans : [];
}

function getOpenQuantity(loan) {
  return Number(loan.remainingQuantity ?? loan.quantity ?? 0) || 0;
}

function cloneLoan(loan) {
  return {
    borrowerName: loan.borrowerName || "",
    quantity: Number(loan.quantity) || 0,
    remainingQuantity: getOpenQuantity(loan),
    borrowedAt: loan.borrowedAt || null,
  };
}

function isVisibleBorrowEntry(entry) {
  return entry && entry.reportHidden !== true;
}

function getVisibleBorrowEntries(item) {
  return Array.isArray(item.borrowHistory) ? item.borrowHistory.filter(isVisibleBorrowEntry) : [];
}

function getLatestVisibleBorrowEntry(item) {
  const visibleEntries = getVisibleBorrowEntries(item)
    .map((entry) => ({
      ...entry,
      borrowedAtDate: entry.borrowedAt
        ? new Date(entry.borrowedAt._seconds ? entry.borrowedAt._seconds * 1000 : entry.borrowedAt)
        : null,
    }))
    .filter((entry) => entry.borrowedAtDate && !Number.isNaN(entry.borrowedAtDate.getTime()));

  if (visibleEntries.length === 0) return { borrowerName: "", borrowedAt: null };

  visibleEntries.sort((left, right) => right.borrowedAtDate - left.borrowedAtDate);
  return {
    borrowerName: visibleEntries[0].borrowerName || "",
    borrowedAt: visibleEntries[0].borrowedAt || null,
  };
}

function transformBorrowEntries(entries, oldBorrowerName, newBorrowerName, hidden) {
  const target = normalizeBorrower(oldBorrowerName);
  return entries.map((entry) => {
    if (normalizeBorrower(entry.borrowerName) !== target) return entry;
    return {
      ...entry,
      borrowerName: hidden ? entry.borrowerName : newBorrowerName,
      reportHidden: hidden,
    };
  });
}

function allocateReturn(loans, amount, borrowerName) {
  const targetBorrower = normalizeBorrower(borrowerName);
  let remaining = amount;

  const nextLoans = loans.map((loan) => ({ ...loan }));
  const updatedLoans = [];
  const touchedBorrowers = new Map();

  const candidateIndexes = nextLoans
    .map((loan, index) => ({ loan, index }))
    .filter(({ loan }) => getOpenQuantity(loan) > 0 && (!targetBorrower || normalizeBorrower(loan.borrowerName) === targetBorrower));

  for (const { loan, index } of candidateIndexes) {
    if (remaining <= 0) break;

    const openQuantity = getOpenQuantity(loan);
    const returned = Math.min(openQuantity, remaining);
    remaining -= returned;

    const newRemaining = openQuantity - returned;
    nextLoans[index] = { ...loan, remainingQuantity: newRemaining };

    const borrowerKey = normalizeBorrower(loan.borrowerName);
    const currentReturned = touchedBorrowers.get(borrowerKey)?.quantity || 0;
    touchedBorrowers.set(borrowerKey, {
      borrowerName: loan.borrowerName || "",
      quantity: currentReturned + returned,
    });
  }

  for (const loan of nextLoans) {
    if (getOpenQuantity(loan) > 0) {
      updatedLoans.push(cloneLoan(loan));
    }
  }

  return {
    remaining,
    activeLoans: updatedLoans,
    returnedByBorrower: Array.from(touchedBorrowers.values()),
  };
}

async function findByName(equipmentName) {
  const target = normalizeLookup(equipmentName);
  if (!target) return null;

  const items = await getAll();
  return (
    items.find((item) => normalizeLookup(item.equipmentName) === target) ||
    items.find((item) => normalizeLookup(item.equipmentCode) === target) ||
    null
  );
}

async function getAll() {
  const snap = await db.collection(COLLECTION).orderBy("createdAt", "desc").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function findById(id) {
  if (!id) return null;
  const doc = await db.collection(COLLECTION).doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

// Fuzzy / partial name search. Used to suggest "Did you mean …?" when an
// exact name/code match fails. Ranks exact > prefix > contains.
async function searchEquipment(query, limit = 8) {
  const target = normalizeLookup(query);
  if (!target) return [];

  const items = await getAll();
  const scored = [];
  for (const item of items) {
    const name = normalizeLookup(item.equipmentName);
    const code = normalizeLookup(item.equipmentCode);
    let score = 0;
    if (name === target || code === target) score = 100;
    else if (name.startsWith(target) || code.startsWith(target)) score = 80;
    else if (name.includes(target) || code.includes(target)) score = 60;
    else continue;
    scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}

async function createEquipment({ name, quantity, imagePath }) {
  const total = Number(quantity) || 0;
  const docRef = await db.collection(COLLECTION).add({
    equipmentName: name,
    equipmentNameKey: normalizeLookup(name),
    brand: "",
    model: "",
    serialNumber: "",
    storageLocation: "",
    totalQuantity: total,
    availableQuantity: total,
    borrowedQuantity: 0,
    minimumStockLevel: 0,
    imagePath: imagePath || PLACEHOLDER_PATH,
    qrCodePath: null,
    status: computeStatus(total, 0),
    description: "",
    borrowHistory: [],
    activeLoans: [],
    lastBorrowedBy: "",
    lastBorrowedAt: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const qrCodePath = await generateEquipmentQrCode(docRef.id, CLIENT_URL);
  await docRef.update({ qrCodePath });

  const created = await docRef.get();
  return { id: docRef.id, ...created.data() };
}

const EDITABLE_FIELDS = {
  name: "equipmentName",
  brand: "brand",
  model: "model",
  serial: "serialNumber",
  location: "storageLocation",
  quantity: "totalQuantity",
  minstock: "minimumStockLevel",
  description: "description",
};

async function editField(equipmentCode, field, value) {
  const item = await findByName(equipmentCode);
  if (!item) return { error: "not_found" };

  const dbField = EDITABLE_FIELDS[field.toLowerCase()];
  if (!dbField) return { error: "bad_field", validFields: Object.keys(EDITABLE_FIELDS) };

  const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

  if (dbField === "totalQuantity") {
    const newTotal = Number(value);
    const diff = newTotal - item.totalQuantity;
    updates.totalQuantity = newTotal;
    updates.availableQuantity = item.availableQuantity + diff;
    updates.status = computeStatus(updates.availableQuantity, item.minimumStockLevel);
  } else if (dbField === "minimumStockLevel") {
    updates.minimumStockLevel = Number(value);
    updates.status = computeStatus(item.availableQuantity, updates.minimumStockLevel);
  } else {
    updates[dbField] = value;
    if (dbField === "equipmentName") {
      updates.equipmentNameKey = normalizeLookup(value);
    }
  }

  await db.collection(COLLECTION).doc(item.id).update(updates);
  const updated = await db.collection(COLLECTION).doc(item.id).get();
  return { item: { id: item.id, ...updated.data() } };
}

async function borrow(equipmentName, qty, borrowerName) {
  const item = await findByName(equipmentName);
  if (!item) return { error: "not_found" };

  const amount = Number(qty);
  if (!amount || amount <= 0) return { error: "bad_quantity" };
  if (amount > item.availableQuantity) return { error: "insufficient", available: item.availableQuantity };

  const borrower = String(borrowerName || "").trim();
  if (!borrower) return { error: "bad_borrower" };

  const availableQuantity = item.availableQuantity - amount;
  const borrowedQuantity = item.borrowedQuantity + amount;
  const status = computeStatus(availableQuantity, item.minimumStockLevel);
  const borrowedAt = admin.firestore.Timestamp.now();
  const activeLoans = getActiveLoans(item);
  const existingLoanIndex = activeLoans.findIndex(
    (loan) => normalizeBorrower(loan.borrowerName) === normalizeBorrower(borrower)
  );
  if (existingLoanIndex >= 0) {
    const existingLoan = activeLoans[existingLoanIndex];
    activeLoans[existingLoanIndex] = {
      borrowerName: borrower,
      quantity: (Number(existingLoan.quantity) || 0) + amount,
      remainingQuantity: (Number(existingLoan.remainingQuantity ?? existingLoan.quantity) || 0) + amount,
      borrowedAt: existingLoan.borrowedAt || borrowedAt,
    };
  } else {
    activeLoans.push({
      borrowerName: borrower,
      quantity: amount,
      remainingQuantity: amount,
      borrowedAt,
    });
  }

  await db.collection(COLLECTION).doc(item.id).update({
    availableQuantity,
    borrowedQuantity,
    status,
    lastBorrowedBy: borrower,
    lastBorrowedAt: borrowedAt,
    activeLoans,
    borrowHistory: admin.firestore.FieldValue.arrayUnion({
      borrowerName: borrower,
      quantity: amount,
      borrowedAt,
      reportHidden: false,
    }),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { item: { ...item, availableQuantity, borrowedQuantity, status, lastBorrowedBy: borrower, lastBorrowedAt: borrowedAt } };
}

async function returnItem(equipmentName, qty, borrowerName = "") {
  const item = await findByName(equipmentName);
  if (!item) return { error: "not_found" };

  const amount = Number(qty);
  if (!amount || amount <= 0) return { error: "bad_quantity" };
  if (amount > item.borrowedQuantity) return { error: "too_many", borrowed: item.borrowedQuantity };

  const activeLoans = getActiveLoans(item);
  const openLoans = activeLoans.filter((loan) => getOpenQuantity(loan) > 0);
  const borrowerFilter = normalizeBorrower(borrowerName);

  if (borrowerFilter) {
    const borrowerOpen = openLoans.filter((loan) => normalizeBorrower(loan.borrowerName) === borrowerFilter);
    const borrowerTotal = borrowerOpen.reduce((sum, loan) => sum + getOpenQuantity(loan), 0);
    if (borrowerOpen.length === 0) return { error: "borrower_not_found" };
    if (amount > borrowerTotal) return { error: "too_many_borrower", borrowed: borrowerTotal };
  }

  const allocation = allocateReturn(activeLoans, amount, borrowerName);
  if (allocation.remaining > 0) {
    if (borrowerFilter) {
      return { error: "too_many_borrower", borrowed: amount - allocation.remaining };
    }
    return { error: "too_many", borrowed: item.borrowedQuantity };
  }

  const availableQuantity = item.availableQuantity + amount;
  const borrowedQuantity = item.borrowedQuantity - amount;
  const status = computeStatus(availableQuantity, item.minimumStockLevel);

  await db.collection(COLLECTION).doc(item.id).update({
    availableQuantity,
    borrowedQuantity,
    status,
    activeLoans: allocation.activeLoans,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    item: { ...item, availableQuantity, borrowedQuantity, status, activeLoans: allocation.activeLoans },
    returnedByBorrower: allocation.returnedByBorrower,
  };
}

async function renameBorrowerRecord(equipmentName, oldBorrowerName, newBorrowerName) {
  const item = await findByName(equipmentName);
  if (!item) return { error: "not_found" };

  const nextBorrowHistory = transformBorrowEntries(item.borrowHistory || [], oldBorrowerName, newBorrowerName, false);
  const nextActiveLoans = transformBorrowEntries(item.activeLoans || [], oldBorrowerName, newBorrowerName, false);
  const latest = getLatestVisibleBorrowEntry({ borrowHistory: nextBorrowHistory });

  await db.collection(COLLECTION).doc(item.id).update({
    borrowHistory: nextBorrowHistory,
    activeLoans: nextActiveLoans,
    lastBorrowedBy: latest.borrowerName,
    lastBorrowedAt: latest.borrowedAt,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const updated = await db.collection(COLLECTION).doc(item.id).get();
  return { item: { id: item.id, ...updated.data() } };
}

async function hideBorrowerFromReports(equipmentName, borrowerName) {
  const item = await findByName(equipmentName);
  if (!item) return { error: "not_found" };

  const nextBorrowHistory = transformBorrowEntries(item.borrowHistory || [], borrowerName, borrowerName, true);
  const nextActiveLoans = transformBorrowEntries(item.activeLoans || [], borrowerName, borrowerName, true);
  const latest = getLatestVisibleBorrowEntry({ borrowHistory: nextBorrowHistory });

  await db.collection(COLLECTION).doc(item.id).update({
    borrowHistory: nextBorrowHistory,
    activeLoans: nextActiveLoans,
    lastBorrowedBy: latest.borrowerName,
    lastBorrowedAt: latest.borrowedAt,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const updated = await db.collection(COLLECTION).doc(item.id).get();
  return { item: { id: item.id, ...updated.data() } };
}

// Remove every borrow record for one borrower on one equipment item, and reverse
// the inventory impact of their still-open loans. Used to wipe a misinput borrow so
// the borrower report reflects reality.
async function deleteBorrowerRecord(equipmentName, borrowerName) {
  const item = await findByName(equipmentName);
  if (!item) return { error: "not_found" };

  const target = normalizeBorrower(borrowerName);
  if (!target) return { error: "bad_borrower" };

  const history = Array.isArray(item.borrowHistory) ? item.borrowHistory : [];
  const activeLoans = getActiveLoans(item);

  const hasHistory = history.some((entry) => normalizeBorrower(entry.borrowerName) === target);
  const removedLoans = activeLoans.filter((loan) => normalizeBorrower(loan.borrowerName) === target);
  if (!hasHistory && removedLoans.length === 0) {
    return { error: "borrower_not_found" };
  }

  // Only the still-open (remaining) quantities are tied up in borrowedQuantity, so
  // that's what we release back to available.
  const released = removedLoans.reduce((sum, loan) => sum + getOpenQuantity(loan), 0);
  const nextActiveLoans = activeLoans
    .filter((loan) => normalizeBorrower(loan.borrowerName) !== target)
    .map(cloneLoan);
  const nextBorrowHistory = history.filter((entry) => normalizeBorrower(entry.borrowerName) !== target);

  const availableQuantity = (Number(item.availableQuantity) || 0) + released;
  const borrowedQuantity = Math.max(0, (Number(item.borrowedQuantity) || 0) - released);
  const status = computeStatus(availableQuantity, item.minimumStockLevel);
  const latest = getLatestVisibleBorrowEntry({ borrowHistory: nextBorrowHistory });

  await db.collection(COLLECTION).doc(item.id).update({
    borrowHistory: nextBorrowHistory,
    activeLoans: nextActiveLoans,
    availableQuantity,
    borrowedQuantity,
    status,
    lastBorrowedBy: latest.borrowerName,
    lastBorrowedAt: latest.borrowedAt,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const updated = await db.collection(COLLECTION).doc(item.id).get();
  return { item: { id: item.id, ...updated.data() }, released };
}

// Wipe borrow history + open loans for every equipment item and reset counts so the
// borrower report comes back empty. Destructive — cannot be undone.
async function clearAllBorrowHistory() {
  const items = await getAll();
  const batch = db.batch();
  let count = 0;

  for (const item of items) {
    const hasBorrowData =
      (Array.isArray(item.borrowHistory) && item.borrowHistory.length > 0) ||
      (Array.isArray(item.activeLoans) && item.activeLoans.length > 0) ||
      (Number(item.borrowedQuantity) || 0) > 0 ||
      item.lastBorrowedBy;

    if (!hasBorrowData) continue;

    const totalQuantity = Number(item.totalQuantity) || 0;
    const minimumStockLevel = Number(item.minimumStockLevel) || 0;
    batch.update(db.collection(COLLECTION).doc(item.id), {
      borrowHistory: [],
      activeLoans: [],
      borrowedQuantity: 0,
      availableQuantity: totalQuantity,
      lastBorrowedBy: "",
      lastBorrowedAt: null,
      status: computeStatus(totalQuantity, minimumStockLevel),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    count++;
  }

  if (count > 0) await batch.commit();
  return { clearedItems: count };
}

async function deleteEquipmentByName(equipmentName) {
  const item = await findByName(equipmentName);
  if (!item) return { error: "not_found" };

  deleteStoredImage(item.imagePath);
  deleteQrCode(item.qrCodePath);
  await db.collection(COLLECTION).doc(item.id).delete();

  return { item };
}

async function attachImage(equipmentName, imagePath) {
  const item = await findByName(equipmentName);
  if (!item) return { error: "not_found" };

  deleteStoredImage(item.imagePath);
  await db.collection(COLLECTION).doc(item.id).update({
    imagePath,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { item: { ...item, imagePath } };
}

module.exports = {
  findByName,
  findById,
  getAll,
  searchEquipment,
  createEquipment,
  editField,
  borrow,
  returnItem,
  renameBorrowerRecord,
  hideBorrowerFromReports,
  deleteBorrowerRecord,
  clearAllBorrowHistory,
  deleteEquipmentByName,
  attachImage,
  EDITABLE_FIELDS,
};
