process.env.TZ = process.env.TZ || "Asia/Phnom_Penh";
const ExcelJS = require("exceljs");
const path = require("path");
const os = require("os");
const { getAll } = require("./equipmentService");

const TIMEZONE = process.env.TIMEZONE || "Asia/Phnom_Penh";

const STATUS_KM = {
  Available: "មានក្នុងស្តុក",
  "Low Stock": "ជិតអស់ស្តុក",
  "Out of Stock": "អស់ពីស្តុក",
};

// Executive styling color palette
const PALETTE = {
  headerBg: "FF1E3A5F",         // Modern corporate deep slate navy
  headerBorder: "FF0F2338",     // Header bottom boundary line
  headerSideBorder: "FF2A4D7A", // Header cell separators
  headerText: "FFFFFFFF",       // Crisp white text
  rowEven: "FFFFFFFF",          // Clean white
  rowOdd: "FFF8FAFC",           // Soft Tailwind Slate-50 for subtle zebra striping
  cellBorder: "FFE2E8F0",       // Light subtle cell borders
  textColor: "FF1F2937",        // High-contrast slate charcoal text

  // Sheet 1 status pill colors
  statusAvailableBg: "FFD1E7DD",
  statusAvailableText: "FF0F5132",
  statusLowStockBg: "FFFFF3CD",
  statusLowStockText: "FF664D03",
  statusOutOfStockBg: "FFF8D7DA",
  statusOutOfStockText: "FF842029",

  // Sheet 4 return status pill colors
  returnedBg: "FFD1E7DD",
  returnedText: "FF0F5132",
  pendingBg: "FFFFF3CD",
  pendingText: "FF664D03",
};

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  if (value._seconds) return new Date(value._seconds * 1000);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatTimestamp(value) {
  const date = toDate(value);
  if (!date) return "";
  return date
    .toLocaleString("en-GB", {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    })
    .toUpperCase();
}

function isVisibleEntry(entry) {
  return entry && entry.reportHidden !== true;
}

function getLatestVisibleBorrowMeta(item) {
  const entries = (Array.isArray(item.borrowHistory) ? item.borrowHistory : [])
    .filter(isVisibleEntry)
    .map((entry) => ({
      borrowerName: entry.borrowerName || "",
      reportedBy: entry.reportedBy || "",
      borrowedAt: toDate(entry.borrowedAt),
    }))
    .filter((entry) => entry.borrowerName && entry.borrowedAt);

  if (entries.length === 0) {
    return { borrowerName: "", reportedBy: "", borrowedAt: null };
  }

  entries.sort((left, right) => right.borrowedAt - left.borrowedAt);
  return entries[0];
}

function buildWorkbook(title) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "OSH Equipment System";
  workbook.created = new Date();
  workbook.title = title;
  return workbook;
}

function styleHeaderRow(row, colCount) {
  row.height = 32;
  row.font = { name: "Segoe UI", bold: true, size: 11, color: { argb: PALETTE.headerText } };
  row.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: PALETTE.headerBg },
  };
  row.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  for (let c = 1; c <= colCount; c++) {
    row.getCell(c).border = {
      top: { style: "thin", color: { argb: PALETTE.headerSideBorder } },
      bottom: { style: "medium", color: { argb: PALETTE.headerBorder } },
      left: { style: "thin", color: { argb: PALETTE.headerSideBorder } },
      right: { style: "thin", color: { argb: PALETTE.headerSideBorder } },
    };
  }
}

function createStyledSheet(workbook, name, headers) {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 1, showGridLines: true }],
  });
  sheet.columns = headers.map(({ header, key, width }) => ({ header, key, width }));
  styleHeaderRow(sheet.getRow(1), headers.length);
  return sheet;
}

function styleDataRow(row, rowIndex, headersConfig) {
  row.height = 25;
  const isEven = rowIndex % 2 === 0;
  const rowBg = isEven ? PALETTE.rowEven : PALETTE.rowOdd;

  headersConfig.forEach((h) => {
    const cell = row.getCell(h.key);
    const align = h.align || "left";

    cell.font = { name: "Segoe UI", size: 10, color: { argb: PALETTE.textColor } };
    cell.alignment = {
      vertical: "middle",
      horizontal: align,
      wrapText: align === "left",
    };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: rowBg },
    };
    cell.border = {
      top: { style: "thin", color: { argb: PALETTE.cellBorder } },
      bottom: { style: "thin", color: { argb: PALETTE.cellBorder } },
      left: { style: "thin", color: { argb: PALETTE.cellBorder } },
      right: { style: "thin", color: { argb: PALETTE.cellBorder } },
    };
  });
}

function applyStatusBadge(cell, status) {
  if (status === "មានក្នុងស្តុក" || status === "Available") {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: PALETTE.statusAvailableBg } };
    cell.font = { name: "Segoe UI", size: 10, bold: true, color: { argb: PALETTE.statusAvailableText } };
  } else if (status === "ជិតអស់ស្តុក" || status === "Low Stock") {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: PALETTE.statusLowStockBg } };
    cell.font = { name: "Segoe UI", size: 10, bold: true, color: { argb: PALETTE.statusLowStockText } };
  } else if (status === "អស់ពីស្តុក" || status === "Out of Stock") {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: PALETTE.statusOutOfStockBg } };
    cell.font = { name: "Segoe UI", size: 10, bold: true, color: { argb: PALETTE.statusOutOfStockText } };
  }
}

function applyReturnStatusBadge(cell, status) {
  if (status === "បានប្រគល់") {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: PALETTE.returnedBg } };
    cell.font = { name: "Segoe UI", size: 10, bold: true, color: { argb: PALETTE.returnedText } };
  } else if (status === "មិនទាន់ប្រគល់") {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: PALETTE.pendingBg } };
    cell.font = { name: "Segoe UI", size: 10, bold: true, color: { argb: PALETTE.pendingText } };
  }
}

function applyAutoFilter(sheet, headersConfig) {
  const lastColLetter = sheet.getColumn(headersConfig.length).letter;
  sheet.autoFilter = { from: "A1", to: `${lastColLetter}1` };
}

function parseEquipmentNames(item) {
  if (item.equipmentNameKhmer || item.equipmentNameEnglish) {
    return {
      khmer: item.equipmentNameKhmer || item.equipmentName || "",
      english: item.equipmentNameEnglish || "",
    };
  }
  const match = String(item.equipmentName || "").match(/^(.+?)\s*\((.+?)\)$/);
  if (match) {
    return {
      khmer: match[1].trim(),
      english: match[2].trim(),
    };
  }
  return {
    khmer: item.equipmentName || "",
    english: "",
  };
}

function collectActiveLoans(items) {
  return items
    .flatMap((item) => {
      const loans = (Array.isArray(item.activeLoans) ? item.activeLoans : []).filter(isVisibleEntry);
      const names = parseEquipmentNames(item);
      const eqName = names.khmer || item.equipmentName || "";
      return loans.map((loan) => ({
        borrowerName: loan.borrowerName || "",
        equipmentName: eqName,
        quantity: Number(loan.quantity) || 0,
        remainingQuantity: Number(loan.remainingQuantity ?? loan.quantity) || 0,
        borrowedAt: loan.borrowedAt || null,
        reportedBy: loan.reportedBy || "",
      }));
    })
    .filter((entry) => entry.borrowerName || entry.equipmentName);
}

function groupActiveLoansByBorrower(items) {
  const activeLoans = collectActiveLoans(items).filter(
    (loan) => loan.remainingQuantity > 0
  );

  const map = new Map();

  for (const loan of activeLoans) {
    const rawBorrower = (loan.borrowerName || "Unknown").trim();
    if (!rawBorrower) continue;

    const key = rawBorrower.toLowerCase();
    if (!map.has(key)) {
      map.set(key, {
        borrowerName: rawBorrower,
        equipmentMap: new Map(),
        totalQuantity: 0,
        latestBorrowedAt: null,
        reporters: new Set(),
      });
    }

    const entry = map.get(key);

    const eqName = (loan.equipmentName || "Unknown").trim();
    const qty = loan.remainingQuantity;
    const currentEqQty = entry.equipmentMap.get(eqName) || 0;
    entry.equipmentMap.set(eqName, currentEqQty + qty);

    entry.totalQuantity += qty;

    const bDate = toDate(loan.borrowedAt);
    if (bDate) {
      if (!entry.latestBorrowedAt || bDate > entry.latestBorrowedAt) {
        entry.latestBorrowedAt = bDate;
      }
    }

    if (loan.reportedBy && loan.reportedBy.trim()) {
      entry.reporters.add(loan.reportedBy.trim());
    }
  }

  const rows = [];
  for (const group of map.values()) {
    const equipmentString = Array.from(group.equipmentMap.entries())
      .map(([eqName, qty]) => `${eqName}(${qty})`)
      .join(" + ");

    rows.push({
      borrowerName: group.borrowerName,
      equipmentName: equipmentString,
      remainingQuantity: group.totalQuantity,
      borrowedAt: group.latestBorrowedAt,
      reportedBy: Array.from(group.reporters).join(", "),
    });
  }

  rows.sort((a, b) => (b.borrowedAt?.getTime() || 0) - (a.borrowedAt?.getTime() || 0));

  return rows;
}

/**
 * Merges borrow and return events into unified, single-row loan records.
 * Returns do NOT generate redundant separate rows; instead, their return
 * date and return status are merged directly into the original loan row.
 */
function collectTransactionHistory(items) {
  const allRows = [];

  items.forEach((item) => {
    const names = parseEquipmentNames(item);
    const eqName = names.khmer || item.equipmentName || "";

    const borrowHistory = (Array.isArray(item.borrowHistory) ? item.borrowHistory : [])
      .filter(isVisibleEntry);
    const returnHistory = (Array.isArray(item.returnHistory) ? item.returnHistory : [])
      .filter(isVisibleEntry);
    const activeLoans = (Array.isArray(item.activeLoans) ? item.activeLoans : [])
      .filter(isVisibleEntry);

    // Group returns by normalized borrower
    const returnsByBorrower = new Map();
    for (const ret of returnHistory) {
      const bKey = (ret.borrowerName || "").trim().toLowerCase();
      if (!returnsByBorrower.has(bKey)) returnsByBorrower.set(bKey, []);
      returnsByBorrower.get(bKey).push({
        returnedAt: toDate(ret.returnedAt),
        quantity: Number(ret.quantity) || 0,
        reportedBy: ret.reportedBy || "",
        usedQty: 0,
      });
    }

    // Sort returns ascending by date for chronological FIFO matching
    for (const list of returnsByBorrower.values()) {
      list.sort((a, b) => (a.returnedAt?.getTime() || 0) - (b.returnedAt?.getTime() || 0));
    }

    // Map active open loans per borrower
    const activeLoanMap = new Map();
    for (const loan of activeLoans) {
      const bKey = (loan.borrowerName || "").trim().toLowerCase();
      const remaining = Number(loan.remainingQuantity ?? loan.quantity) || 0;
      activeLoanMap.set(bKey, (activeLoanMap.get(bKey) || 0) + remaining);
    }

    // Sort borrow records ascending by date for chronological matching
    const sortedBorrows = borrowHistory
      .map((b) => ({
        borrowerName: b.borrowerName || "",
        quantity: Number(b.quantity) || 0,
        borrowedAt: toDate(b.borrowedAt),
        reportedBy: b.reportedBy || "",
      }))
      .sort((a, b) => (a.borrowedAt?.getTime() || 0) - (b.borrowedAt?.getTime() || 0));

    // Match each borrow with corresponding returns
    for (const b of sortedBorrows) {
      const bKey = (b.borrowerName || "").trim().toLowerCase();
      const returnList = returnsByBorrower.get(bKey) || [];

      let remainingQty = b.quantity;

      for (const ret of returnList) {
        const available = ret.quantity - ret.usedQty;
        if (available > 0 && remainingQty > 0) {
          const matched = Math.min(remainingQty, available);
          ret.usedQty += matched;
          remainingQty -= matched;

          allRows.push({
            equipmentName: eqName,
            borrowerName: b.borrowerName,
            quantity: matched,
            borrowedAt: b.borrowedAt,
            isReturned: "បានប្រគល់",
            returnedAt: ret.returnedAt,
            reportedBy: ret.reportedBy || b.reportedBy,
            sortDate: ret.returnedAt || b.borrowedAt,
          });
        }
      }

      // If portion of units remain unreturned
      if (remainingQty > 0) {
        const remainingActive = activeLoanMap.get(bKey) || 0;
        const isActuallyReturned = remainingActive <= 0 && returnList.length > 0;
        const fallbackRetAt = isActuallyReturned ? returnList[returnList.length - 1].returnedAt : null;

        allRows.push({
          equipmentName: eqName,
          borrowerName: b.borrowerName,
          quantity: remainingQty,
          borrowedAt: b.borrowedAt,
          isReturned: isActuallyReturned ? "បានប្រគល់" : "មិនទាន់ប្រគល់",
          returnedAt: fallbackRetAt,
          reportedBy: b.reportedBy,
          sortDate: fallbackRetAt || b.borrowedAt,
        });
      }
    }
  });

  // Sort descending by most recent activity
  allRows.sort((a, b) => (toDate(b.sortDate)?.getTime() || 0) - (toDate(a.sortDate)?.getTime() || 0));
  return allRows;
}

async function writeWorkbookToTemp(workbook, filePrefix) {
  const d = new Date();
  const localDateStr = d.toLocaleDateString("en-CA", { timeZone: TIMEZONE });
  const localTimeStr = d.toLocaleTimeString("en-GB", { timeZone: TIMEZONE }).replace(/:/g, "-");
  const tmpPath = path.join(os.tmpdir(), `${filePrefix}-${localDateStr}-${localTimeStr}.xlsx`);
  await workbook.xlsx.writeFile(tmpPath);
  return tmpPath;
}

async function generateMasterReport() {
  const items = await getAll();
  const workbook = buildWorkbook("OSH Equipment Master Report");

  // Sheet 1: Inventory (ស្តុកឧបករណ៍)
  const inventoryHeaders = [
    { header: "ឈ្មោះឧបករណ៍ (ខ្មែរ)", key: "nameKhmer", width: 34, align: "left" },
    { header: "ឈ្មោះឧបករណ៍ (អង់គ្លេស)", key: "nameEnglish", width: 32, align: "left" },
    { header: "ម៉ូឌែល", key: "model", width: 18, align: "center" },
    { header: "ចំនួនសរុប", key: "totalQuantity", width: 14, align: "center" },
    { header: "ចំនួននៅសល់", key: "availableQuantity", width: 14, align: "center" },
    { header: "ចំនួនបានខ្ចី", key: "borrowedQuantity", width: 14, align: "center" },
    { header: "ស្ថានភាព", key: "status", width: 18, align: "center" },
  ];
  const invSheet = createStyledSheet(workbook, "ស្តុកឧបករណ៍", inventoryHeaders);

  items.forEach((item, index) => {
    const names = parseEquipmentNames(item);
    const statusKm = STATUS_KM[item.status] || item.status || "";
    const row = invSheet.addRow({
      nameKhmer: names.khmer,
      nameEnglish: names.english,
      model: item.model || "",
      totalQuantity: item.totalQuantity ?? 0,
      availableQuantity: item.availableQuantity ?? 0,
      borrowedQuantity: item.borrowedQuantity ?? 0,
      status: statusKm,
    });

    styleDataRow(row, index, inventoryHeaders);
    applyStatusBadge(row.getCell("status"), statusKm);
  });
  applyAutoFilter(invSheet, inventoryHeaders);

  // Sheet 2: Active Borrowers (បញ្ជីអ្នកខ្ចីសកម្ម)
  const openLoansHeaders = [
    { header: "ឈ្មោះអ្នកខ្ចី", key: "borrowerName", width: 28, align: "left" },
    { header: "ឈ្មោះឧបករណ៍", key: "equipmentName", width: 48, align: "left" },
    { header: "ចំនួនខ្ចី", key: "remainingQuantity", width: 14, align: "center" },
    { header: "កាលបរិច្ឆេទខ្ចី", key: "borrowedAt", width: 26, align: "center" },
    { header: "អ្នកកត់ត្រា", key: "reportedBy", width: 22, align: "left" },
  ];
  const borrowersSheet = createStyledSheet(workbook, "បញ្ជីអ្នកខ្ចីសកម្ម", openLoansHeaders);

  const borrowerRows = groupActiveLoansByBorrower(items);
  borrowerRows.forEach((borrower, index) => {
    const row = borrowersSheet.addRow({
      borrowerName: borrower.borrowerName,
      equipmentName: borrower.equipmentName,
      remainingQuantity: borrower.remainingQuantity,
      borrowedAt: formatTimestamp(borrower.borrowedAt),
      reportedBy: borrower.reportedBy,
    });
    styleDataRow(row, index, openLoansHeaders);
  });
  applyAutoFilter(borrowersSheet, openLoansHeaders);

  // Sheet 3: Stock In Log (កំណត់ហេតុបន្ថែមស្តុក)
  const stockInHeaders = [
    { header: "ឈ្មោះឧបករណ៍", key: "equipmentName", width: 34, align: "left" },
    { header: "ចំនួនបន្ថែម", key: "addedQty", width: 14, align: "center" },
    { header: "ស្តុកចាស់សរុប", key: "oldTotal", width: 16, align: "center" },
    { header: "ស្តុកថ្មីសរុប", key: "newTotal", width: 16, align: "center" },
    { header: "កាលបរិច្ឆេទបន្ថែម", key: "addedAt", width: 26, align: "center" },
    { header: "អ្នកបន្ថែម", key: "addedBy", width: 22, align: "left" },
  ];
  const stockInSheet = createStyledSheet(workbook, "កំណត់ហេតុបន្ថែមស្តុក", stockInHeaders);
  const stockInEvents = items
    .flatMap((item) => {
      const history = Array.isArray(item.stockInHistory) ? item.stockInHistory : [];
      const names = parseEquipmentNames(item);
      const eqName = names.khmer || item.equipmentName || "";
      return history.map((e) => ({
        equipmentName: eqName,
        addedQty: e.addedQty || 0,
        oldTotal: e.oldTotal || 0,
        newTotal: e.newTotal || 0,
        addedAt: e.addedAt || null,
        addedBy: e.addedBy || "",
      }));
    })
    .sort((a, b) => (toDate(b.addedAt)?.getTime() || 0) - (toDate(a.addedAt)?.getTime() || 0));

  stockInEvents.forEach((ev, index) => {
    const row = stockInSheet.addRow({
      equipmentName: ev.equipmentName,
      addedQty: ev.addedQty,
      oldTotal: ev.oldTotal,
      newTotal: ev.newTotal,
      addedAt: formatTimestamp(ev.addedAt),
      addedBy: ev.addedBy,
    });
    styleDataRow(row, index, stockInHeaders);
  });
  applyAutoFilter(stockInSheet, stockInHeaders);

  // Sheet 4: Transaction History (ប្រវត្តិប្រតិបត្តិការ) — Merged Single-Row Loan Records
  const historyHeaders = [
    { header: "ឈ្មោះឧបករណ៍", key: "equipmentName", width: 34, align: "left" },
    { header: "ឈ្មោះអ្នកខ្ចី", key: "borrowerName", width: 28, align: "left" },
    { header: "ចំនួន", key: "quantity", width: 14, align: "center" },
    { header: "កាលបរិច្ឆេទខ្ចី", key: "borrowedAt", width: 26, align: "center" },
    { header: "ស្ថានភាពប្រគល់", key: "isReturned", width: 20, align: "center" },
    { header: "កាលបរិច្ឆេទប្រគល់", key: "returnedAt", width: 26, align: "center" },
    { header: "អ្នកកត់ត្រា", key: "reportedBy", width: 24, align: "left" },
  ];
  const historySheet = createStyledSheet(workbook, "ប្រវត្តិប្រតិបត្តិការ", historyHeaders);

  const transactions = collectTransactionHistory(items);

  transactions.forEach((ev, index) => {
    const row = historySheet.addRow({
      equipmentName: ev.equipmentName,
      borrowerName: ev.borrowerName,
      quantity: ev.quantity,
      borrowedAt: formatTimestamp(ev.borrowedAt),
      isReturned: ev.isReturned,
      returnedAt: formatTimestamp(ev.returnedAt),
      reportedBy: ev.reportedBy,
    });
    styleDataRow(row, index, historyHeaders);
    applyReturnStatusBadge(row.getCell("isReturned"), ev.isReturned);
  });
  applyAutoFilter(historySheet, historyHeaders);

  return writeWorkbookToTemp(workbook, "OSH-Master-Report");
}

module.exports = {
  generateMasterReport,
  generateInventoryReport: generateMasterReport,
  generateBorrowerReport: generateMasterReport,
  generateStockHistoryReport: generateMasterReport,
  groupActiveLoansByBorrower,
  collectActiveLoans,
};
