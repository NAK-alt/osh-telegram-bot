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
    reportedBy: loan.reportedBy || "",
    reportedById: loan.reportedById || "",
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

function sanitizeEquipment(d) {
  if (!d) return null;
  const data = typeof d.data === "function" ? d.data() : d;
  if (!data) return null;
  const id = d.id || data.id;

  const totalQuantity = Math.max(0, Number(data.totalQuantity) || 0);
  const activeLoans = Array.isArray(data.activeLoans) ? data.activeLoans : [];

  let borrowedQuantity = Number(data.borrowedQuantity);
  if (Number.isNaN(borrowedQuantity) || borrowedQuantity < 0) {
    borrowedQuantity = activeLoans.reduce((sum, loan) => {
      const openQty = Number(loan.remainingQuantity ?? loan.quantity ?? 0) || 0;
      return sum + openQty;
    }, 0);
  }

  let availableQuantity = Number(data.availableQuantity);
  if (Number.isNaN(availableQuantity) || availableQuantity < 0 || availableQuantity > totalQuantity) {
    availableQuantity = Math.max(0, totalQuantity - borrowedQuantity);
  }

  const status = computeStatus(availableQuantity, data.minimumStockLevel || 0);

  // Self-heal corrupted numeric values in Firestore
  if (
    Number.isNaN(Number(data.availableQuantity)) ||
    Number.isNaN(Number(data.borrowedQuantity)) ||
    Number.isNaN(Number(data.totalQuantity)) ||
    data.availableQuantity === null ||
    data.availableQuantity === undefined
  ) {
    if (id && db) {
      db.collection(COLLECTION).doc(id).update({
        totalQuantity,
        availableQuantity,
        borrowedQuantity,
        status,
      }).catch((err) => console.error(`[sanitizeEquipment] Self-heal doc ${id} failed:`, err.message));
    }
  }

  return {
    id,
    ...data,
    totalQuantity,
    availableQuantity,
    borrowedQuantity,
    status,
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
  return snap.docs.map((d) => sanitizeEquipment(d));
}

async function findById(id) {
  if (!id) return null;
  const doc = await db.collection(COLLECTION).doc(id).get();
  if (!doc.exists) return null;
  return sanitizeEquipment(doc);
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

async function createEquipment({ nameKhmer, nameEnglish, name, model, quantity, imagePath }) {
  const total = Number(quantity) || 0;
  const nameKhmerClean = String(nameKhmer || "").trim();
  const nameEnglishClean = String(nameEnglish || "").trim();
  const rawName = String(name || "").trim();

  let displayName = rawName;
  if (!displayName) {
    if (nameKhmerClean && nameEnglishClean) {
      displayName = `${nameKhmerClean} (${nameEnglishClean})`;
    } else {
      displayName = nameKhmerClean || nameEnglishClean || "Equipment";
    }
  }

  const docRef = await db.collection(COLLECTION).add({
    equipmentName: displayName,
    equipmentNameKhmer: nameKhmerClean || (rawName ? rawName : ""),
    equipmentNameEnglish: nameEnglishClean,
    equipmentNameKey: normalizeLookup(`${displayName} ${nameKhmerClean} ${nameEnglishClean}`),
    brand: "",
    model: String(model || "").trim(),
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
    returnHistory: [],
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
  name_km: "equipmentNameKhmer",
  name_en: "equipmentNameEnglish",
  name: "equipmentName",
  model: "model",
  quantity: "totalQuantity",
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
    updates.availableQuantity = Math.max(0, item.availableQuantity + diff);
    updates.status = computeStatus(updates.availableQuantity, item.minimumStockLevel);
  } else {
    updates[dbField] = value;
    if (dbField === "equipmentNameKhmer" || dbField === "equipmentNameEnglish" || dbField === "equipmentName") {
      const nameKhmer = dbField === "equipmentNameKhmer" ? value : (item.equipmentNameKhmer || "");
      const nameEnglish = dbField === "equipmentNameEnglish" ? value : (item.equipmentNameEnglish || "");
      let displayName = item.equipmentName;
      if (nameKhmer && nameEnglish) {
        displayName = `${nameKhmer} (${nameEnglish})`;
      } else if (nameKhmer || nameEnglish) {
        displayName = nameKhmer || nameEnglish;
      }
      updates.equipmentName = displayName;
      updates.equipmentNameKey = normalizeLookup(`${displayName} ${nameKhmer} ${nameEnglish}`);
    }
  }

  await db.collection(COLLECTION).doc(item.id).update(updates);
  const updated = await db.collection(COLLECTION).doc(item.id).get();
  return { item: { id: item.id, ...updated.data() } };
}

async function borrow(equipmentName, qty, borrowerName, reporter) {
  const item = await findByName(equipmentName);
  if (!item) return { error: "not_found" };

  const amount = Number(qty);
  if (!amount || amount <= 0) return { error: "bad_quantity" };
  if (amount > item.availableQuantity) return { error: "insufficient", available: item.availableQuantity };

  const borrower = String(borrowerName || "").trim();
  if (!borrower) return { error: "bad_borrower" };

  // The Telegram user who actually input this borrow (may differ from the borrower).
  const reportedBy = String((reporter && reporter.name) || "").trim();
  const reportedById = String((reporter && reporter.id) || "").trim();

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
      reportedBy: existingLoan.reportedBy || reportedBy,
      reportedById: existingLoan.reportedById || reportedById,
    };
  } else {
    activeLoans.push({
      borrowerName: borrower,
      quantity: amount,
      remainingQuantity: amount,
      borrowedAt,
      reportedBy,
      reportedById,
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
      reportedBy,
      reportedById,
      reportHidden: false,
    }),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { item: { ...item, availableQuantity, borrowedQuantity, status, lastBorrowedBy: borrower, lastBorrowedAt: borrowedAt }, reportedBy };
}

async function returnItem(equipmentName, qty, borrowerName = "", reporter) {
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

  // Persist a return-history entry per borrower who returned units, tagged with the
  // Telegram user who input the return. arrayUnion accepts multiple args.
  const returnedAt = admin.firestore.Timestamp.now();
  const reportedBy = String((reporter && reporter.name) || "").trim();
  const reportedById = String((reporter && reporter.id) || "").trim();
  const update = {
    availableQuantity,
    borrowedQuantity,
    status,
    activeLoans: allocation.activeLoans,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (allocation.returnedByBorrower.length > 0) {
    update.returnHistory = admin.firestore.FieldValue.arrayUnion(
      ...allocation.returnedByBorrower.map((entry) => ({
        borrowerName: entry.borrowerName || "",
        quantity: Number(entry.quantity) || 0,
        returnedAt,
        reportedBy,
        reportedById,
        reportHidden: false,
      }))
    );
  }

  await db.collection(COLLECTION).doc(item.id).update(update);

  return {
    item: { ...item, availableQuantity, borrowedQuantity, status, activeLoans: allocation.activeLoans },
    returnedByBorrower: allocation.returnedByBorrower,
    reportedBy,
  };
}

async function renameBorrowerRecord(equipmentName, oldBorrowerName, newBorrowerName) {
  const item = await findByName(equipmentName);
  if (!item) return { error: "not_found" };

  const nextBorrowHistory = transformBorrowEntries(item.borrowHistory || [], oldBorrowerName, newBorrowerName, false);
  const nextReturnHistory = transformBorrowEntries(item.returnHistory || [], oldBorrowerName, newBorrowerName, false);
  const nextActiveLoans = transformBorrowEntries(item.activeLoans || [], oldBorrowerName, newBorrowerName, false);
  const latest = getLatestVisibleBorrowEntry({ borrowHistory: nextBorrowHistory });

  await db.collection(COLLECTION).doc(item.id).update({
    borrowHistory: nextBorrowHistory,
    returnHistory: nextReturnHistory,
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
  const nextReturnHistory = transformBorrowEntries(item.returnHistory || [], borrowerName, borrowerName, true);
  const nextActiveLoans = transformBorrowEntries(item.activeLoans || [], borrowerName, borrowerName, true);
  const latest = getLatestVisibleBorrowEntry({ borrowHistory: nextBorrowHistory });

  await db.collection(COLLECTION).doc(item.id).update({
    borrowHistory: nextBorrowHistory,
    returnHistory: nextReturnHistory,
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
  const returnHistory = Array.isArray(item.returnHistory) ? item.returnHistory : [];
  const activeLoans = getActiveLoans(item);

  const hasHistory = history.some((entry) => normalizeBorrower(entry.borrowerName) === target);
  const hasReturnHistory = returnHistory.some((entry) => normalizeBorrower(entry.borrowerName) === target);
  const removedLoans = activeLoans.filter((loan) => normalizeBorrower(loan.borrowerName) === target);
  if (!hasHistory && !hasReturnHistory && removedLoans.length === 0) {
    return { error: "borrower_not_found" };
  }

  // Only the still-open (remaining) quantities are tied up in borrowedQuantity, so
  // that's what we release back to available.
  const released = removedLoans.reduce((sum, loan) => sum + getOpenQuantity(loan), 0);
  const nextActiveLoans = activeLoans
    .filter((loan) => normalizeBorrower(loan.borrowerName) !== target)
    .map(cloneLoan);
  const nextBorrowHistory = history.filter((entry) => normalizeBorrower(entry.borrowerName) !== target);
  const nextReturnHistory = returnHistory.filter((entry) => normalizeBorrower(entry.borrowerName) !== target);

  const availableQuantity = (Number(item.availableQuantity) || 0) + released;
  const borrowedQuantity = Math.max(0, (Number(item.borrowedQuantity) || 0) - released);
  const status = computeStatus(availableQuantity, item.minimumStockLevel);
  const latest = getLatestVisibleBorrowEntry({ borrowHistory: nextBorrowHistory });

  await db.collection(COLLECTION).doc(item.id).update({
    borrowHistory: nextBorrowHistory,
    returnHistory: nextReturnHistory,
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
  return clearTransactionHistory(false);
}

/**
 * Wipe borrow history, return history, active loans, and stock-in history for all equipment items.
 * Destructive — cannot be undone.
 */
async function clearTransactionHistory(clearStockIn = true) {
  const items = await getAll();
  const batch = db.batch();
  let count = 0;

  for (const item of items) {
    const totalQuantity = Number(item.totalQuantity) || 0;
    const minimumStockLevel = Number(item.minimumStockLevel) || 0;
    const updateData = {
      borrowHistory: [],
      returnHistory: [],
      activeLoans: [],
      borrowedQuantity: 0,
      availableQuantity: totalQuantity,
      lastBorrowedBy: "",
      lastBorrowedAt: null,
      status: computeStatus(totalQuantity, minimumStockLevel),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (clearStockIn) {
      updateData.stockInHistory = [];
    }
    batch.update(db.collection(COLLECTION).doc(item.id), updateData);
    count++;
  }

  if (count > 0) {
    await batch.commit();
  }
  return { count };
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

/**
 * Borrow multiple equipment items at once.
 * @param {Array<{equipmentName?: string, id?: string, quantity: number}>} items 
 * @param {string} borrowerName 
 * @param {object} reporter 
 */
async function borrowMultiple(items, borrowerName, reporter) {
  const borrower = String(borrowerName || "").trim();
  if (!borrower) return { error: "bad_borrower" };
  if (!Array.isArray(items) || items.length === 0) return { error: "no_items" };

  // 1. Validate & fetch all items first before mutating any records
  const resolvedItems = [];
  const errors = [];

  for (let i = 0; i < items.length; i++) {
    const entry = items[i];
    const qty = Number(entry.quantity ?? entry.qty);
    if (!qty || qty <= 0) {
      errors.push({ index: i, item: entry.equipmentName || entry.id, error: "bad_quantity" });
      continue;
    }

    const item = entry.id
      ? await findById(entry.id)
      : await findByName(entry.equipmentName);

    if (!item) {
      errors.push({ index: i, item: entry.equipmentName || entry.id, error: "not_found" });
      continue;
    }

    if (qty > item.availableQuantity) {
      errors.push({
        index: i,
        item: item.equipmentName,
        error: "insufficient",
        available: item.availableQuantity,
        requested: qty,
      });
      continue;
    }

    resolvedItems.push({ item, qty });
  }

  if (errors.length > 0) {
    return { error: "validation_failed", errors, processedCount: 0 };
  }

  // 2. Perform borrow for each resolved item
  const results = [];
  for (const { item, qty } of resolvedItems) {
    const res = await borrow(item.equipmentName, qty, borrower, reporter);
    results.push(res);
  }

  return { success: true, results, borrowerName: borrower };
}

/**
 * Return multiple equipment items at once.
 * @param {Array<{equipmentName?: string, id?: string, quantity: number}>} items 
 * @param {string} borrowerName 
 * @param {object} reporter 
 */
async function returnMultiple(items, borrowerName = "", reporter) {
  if (!Array.isArray(items) || items.length === 0) return { error: "no_items" };

  // 1. Validate & fetch all items first
  const resolvedItems = [];
  const errors = [];

  for (let i = 0; i < items.length; i++) {
    const entry = items[i];
    const qty = Number(entry.quantity ?? entry.qty);
    if (!qty || qty <= 0) {
      errors.push({ index: i, item: entry.equipmentName || entry.id, error: "bad_quantity" });
      continue;
    }

    const item = entry.id
      ? await findById(entry.id)
      : await findByName(entry.equipmentName);

    if (!item) {
      errors.push({ index: i, item: entry.equipmentName || entry.id, error: "not_found" });
      continue;
    }

    if (qty > item.borrowedQuantity) {
      errors.push({
        index: i,
        item: item.equipmentName,
        error: "too_many",
        borrowed: item.borrowedQuantity,
        requested: qty,
      });
      continue;
    }

    const borrowerFilter = normalizeBorrower(borrowerName);
    if (borrowerFilter) {
      const activeLoans = getActiveLoans(item);
      const openLoans = activeLoans.filter((loan) => getOpenQuantity(loan) > 0);
      const borrowerOpen = openLoans.filter((loan) => normalizeBorrower(loan.borrowerName) === borrowerFilter);
      const borrowerTotal = borrowerOpen.reduce((sum, loan) => sum + getOpenQuantity(loan), 0);

      if (borrowerOpen.length === 0) {
        errors.push({ index: i, item: item.equipmentName, error: "borrower_not_found", borrowerName });
        continue;
      }
      if (qty > borrowerTotal) {
        errors.push({
          index: i,
          item: item.equipmentName,
          error: "too_many_borrower",
          borrowed: borrowerTotal,
          requested: qty,
        });
        continue;
      }
    }

    resolvedItems.push({ item, qty });
  }

  if (errors.length > 0) {
    return { error: "validation_failed", errors, processedCount: 0 };
  }

  // 2. Perform return for each resolved item
  const results = [];
  for (const { item, qty } of resolvedItems) {
    const res = await returnItem(item.equipmentName, qty, borrowerName, reporter);
    results.push(res);
  }

  return { success: true, results, borrowerName };
}

/**
 * Find all active loans across all equipment for a given borrower name.
 * @param {string} borrowerName 
 */
async function getActiveLoansByBorrower(borrowerName) {
  const target = normalizeBorrower(borrowerName);
  if (!target) return [];

  const allItems = await getAll();
  const borrowerLoans = [];

  for (const item of allItems) {
    const activeLoans = getActiveLoans(item);
    for (const loan of activeLoans) {
      const openQty = getOpenQuantity(loan);
      if (normalizeBorrower(loan.borrowerName) === target && openQty > 0) {
        borrowerLoans.push({
          equipmentId: item.id,
          equipmentName: item.equipmentName,
          borrowerName: loan.borrowerName,
          openQuantity: openQty,
          totalBorrowed: loan.quantity,
          borrowedAt: loan.borrowedAt,
        });
      }
    }
  }

  return borrowerLoans;
}

/**
 * Get all active borrowers across all equipment.
 */
async function getAllActiveBorrowers() {
  const allItems = await getAll();
  const borrowerMap = new Map();

  for (const item of allItems) {
    const activeLoans = getActiveLoans(item);
    for (const loan of activeLoans) {
      const openQty = getOpenQuantity(loan);
      if (openQty > 0) {
        const key = normalizeBorrower(loan.borrowerName);
        const existing = borrowerMap.get(key) || {
          borrowerName: loan.borrowerName || "Unknown",
          totalQuantity: 0,
          itemCount: 0,
          items: [],
        };
        existing.totalQuantity += openQty;
        existing.itemCount += 1;
        existing.items.push({
          equipmentId: item.id,
          equipmentName: item.equipmentName,
          quantity: openQty,
        });
        borrowerMap.set(key, existing);
      }
    }
  }

  return Array.from(borrowerMap.values());
}

/**
 * Return ALL items borrowed by a given borrower.
 * @param {string} borrowerName 
 * @param {object} reporter 
 */
async function returnAllByBorrower(borrowerName, reporter) {
  const loans = await getActiveLoansByBorrower(borrowerName);
  if (loans.length === 0) {
    return { error: "no_loans_found", borrowerName };
  }

  const itemsToReturn = loans.map((loan) => ({
    id: loan.equipmentId,
    equipmentName: loan.equipmentName,
    qty: loan.openQuantity,
  }));

  return returnMultiple(itemsToReturn, borrowerName, reporter);
}

/**
 * Add stock to an existing equipment item with audit logging.
 */
async function addStock(equipmentId, qtyToAdd, reporter) {
  const item = await findById(equipmentId);
  if (!item) return { error: "not_found" };

  const amount = Number(qtyToAdd);
  if (!amount || amount <= 0) return { error: "bad_quantity" };

  const totalQuantity = (Number(item.totalQuantity) || 0) + amount;
  const availableQuantity = (Number(item.availableQuantity) || 0) + amount;
  const status = computeStatus(availableQuantity, item.minimumStockLevel);

  const addedAt = admin.firestore.Timestamp.now();
  const addedBy = String((reporter && reporter.name) || "Admin").trim();
  const addedById = String((reporter && reporter.id) || "").trim();

  const logEntry = {
    addedQty: amount,
    oldTotal: item.totalQuantity,
    newTotal: totalQuantity,
    addedAt,
    addedBy,
    addedById,
  };

  await db.collection(COLLECTION).doc(item.id).update({
    totalQuantity,
    availableQuantity,
    status,
    stockInHistory: admin.firestore.FieldValue.arrayUnion(logEntry),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    item: { ...item, totalQuantity, availableQuantity, status },
    logEntry,
  };
}

/**
 * Update quantity on an active loan for a borrower on a specific equipment item.
 */
async function updateLoanQuantity(equipmentId, borrowerName, newQty, reporter) {
  let item = await findById(equipmentId);
  if (!item) {
    item = await findByName(equipmentId);
  }
  if (!item) return { error: "not_found" };

  const amount = Number(newQty);
  if (Number.isNaN(amount) || amount < 0) return { error: "bad_quantity" };

  const target = normalizeBorrower(borrowerName);
  const activeLoans = getActiveLoans(item);
  let loanIndex = activeLoans.findIndex((l) => normalizeBorrower(l.borrowerName) === target);

  if (loanIndex < 0) {
    loanIndex = activeLoans.findIndex(
      (l) =>
        normalizeBorrower(l.borrowerName).includes(target) ||
        target.includes(normalizeBorrower(l.borrowerName))
    );
  }

  if (loanIndex < 0) return { error: "loan_not_found" };

  const oldLoan = activeLoans[loanIndex];
  const oldOpenQty = getOpenQuantity(oldLoan);
  const diff = amount - oldOpenQty;

  if (diff > 0 && diff > item.availableQuantity) {
    return { error: "insufficient", available: item.availableQuantity };
  }

  const availableQuantity = Math.max(0, item.availableQuantity - diff);
  const borrowedQuantity = Math.max(0, item.borrowedQuantity + diff);
  const status = computeStatus(availableQuantity, item.minimumStockLevel);

  if (amount === 0) {
    activeLoans.splice(loanIndex, 1);
  } else {
    activeLoans[loanIndex] = {
      ...oldLoan,
      remainingQuantity: amount,
      quantity: amount,
      updatedAt: admin.firestore.Timestamp.now(),
      reportedBy: String((reporter && reporter.name) || oldLoan.reportedBy || "").trim(),
    };
  }

  await db.collection(COLLECTION).doc(item.id).update({
    availableQuantity,
    borrowedQuantity,
    status,
    activeLoans,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { item: { ...item, availableQuantity, borrowedQuantity, status, activeLoans } };
}

/**
 * Rename borrower across all equipment items globally.
 */
async function renameBorrowerGlobal(oldBorrowerName, newBorrowerName) {
  const items = await getAll();
  let updatedCount = 0;

  for (const item of items) {
    const res = await renameBorrowerRecord(item.equipmentName, oldBorrowerName, newBorrowerName);
    if (!res.error) updatedCount++;
  }

  return { updatedCount, oldBorrowerName, newBorrowerName };
}

/**
 * Delete borrower records across all equipment items globally.
 */
async function deleteBorrowerGlobal(borrowerName) {
  const items = await getAll();
  let updatedCount = 0;

  for (const item of items) {
    const res = await deleteBorrowerRecord(item.equipmentName, borrowerName);
    if (!res.error) updatedCount++;
  }

  return { updatedCount, borrowerName };
}

module.exports = {
  findByName,
  findById,
  getAll,
  searchEquipment,
  createEquipment,
  editField,
  addStock,
  updateLoanQuantity,
  renameBorrowerGlobal,
  deleteBorrowerGlobal,
  borrow,
  borrowMultiple,
  returnItem,
  returnMultiple,
  getActiveLoansByBorrower,
  getAllActiveBorrowers,
  returnAllByBorrower,
  renameBorrowerRecord,
  hideBorrowerFromReports,
  deleteBorrowerRecord,
  clearAllBorrowHistory,
  clearTransactionHistory,
  deleteEquipmentByName,
  attachImage,
  EDITABLE_FIELDS,
};

