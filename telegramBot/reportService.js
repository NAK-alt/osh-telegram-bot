const ExcelJS = require("exceljs");
const path = require("path");
const os = require("os");
const { getAll } = require("./equipmentService");

const HEADERS = [
  { header: "Equipment Name", key: "equipmentName", width: 28 },
  { header: "Brand", key: "brand", width: 16 },
  { header: "Model", key: "model", width: 16 },
  { header: "Serial Number", key: "serialNumber", width: 18 },
  { header: "Storage Location", key: "storageLocation", width: 20 },
  { header: "Total Qty", key: "totalQuantity", width: 12 },
  { header: "Available Qty", key: "availableQuantity", width: 14 },
  { header: "Borrowed Qty", key: "borrowedQuantity", width: 14 },
  { header: "Last Borrowed By", key: "lastBorrowedBy", width: 20 },
  { header: "Last Reported By", key: "lastReportedBy", width: 20 },
  { header: "Min Stock Level", key: "minimumStockLevel", width: 15 },
  { header: "Status", key: "status", width: 14 },
  { header: "Description", key: "description", width: 30 },
];

const STATUS_COLORS = {
  Available: "FFC6EFCE",
  "Low Stock": "FFFFEB9C",
  "Out of Stock": "FFFFC7CE",
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
  return date ? date.toLocaleString() : "";
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

function styleHeaderRow(row) {
  row.font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F4E78" },
  };
  row.alignment = { vertical: "middle", horizontal: "center" };
  row.height = 22;
}

function styleTableBorders(sheet, lastRow, lastCol) {
  for (let r = 1; r <= lastRow; r++) {
    for (let c = 1; c <= lastCol; c++) {
      sheet.getRow(r).getCell(c).border = {
        top: { style: "thin", color: { argb: "FFD9D9D9" } },
        left: { style: "thin", color: { argb: "FFD9D9D9" } },
        bottom: { style: "thin", color: { argb: "FFD9D9D9" } },
        right: { style: "thin", color: { argb: "FFD9D9D9" } },
      };
    }
  }
}

function createSheet(workbook, name, headers) {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = headers.map(({ header, key, width }) => ({ header, key, width }));
  styleHeaderRow(sheet.getRow(1));
  return sheet;
}

function collectBorrowEvents(items) {
  return items
    .flatMap((item) => {
      const history = (Array.isArray(item.borrowHistory) ? item.borrowHistory : []).filter(isVisibleEntry);
      return history.map((entry) => ({
        borrowerName: entry.borrowerName || "",
        equipmentName: item.equipmentName || "",
        quantity: Number(entry.quantity) || 0,
        borrowedAt: entry.borrowedAt || null,
        reportedBy: entry.reportedBy || "",
        equipmentStatus: item.status || "",
      }));
    })
    .filter((entry) => entry.borrowerName || entry.equipmentName);
}

function collectReturnEvents(items) {
  return items
    .flatMap((item) => {
      const history = (Array.isArray(item.returnHistory) ? item.returnHistory : []).filter(isVisibleEntry);
      return history.map((entry) => ({
        borrowerName: entry.borrowerName || "",
        equipmentName: item.equipmentName || "",
        quantity: Number(entry.quantity) || 0,
        returnedAt: entry.returnedAt || null,
        reportedBy: entry.reportedBy || "",
      }));
    })
    .filter((entry) => entry.borrowerName || entry.equipmentName);
}

function collectActiveLoans(items) {
  return items
    .flatMap((item) => {
      const loans = (Array.isArray(item.activeLoans) ? item.activeLoans : []).filter(isVisibleEntry);
      return loans.map((loan) => ({
        borrowerName: loan.borrowerName || "",
        equipmentName: item.equipmentName || "",
        quantity: Number(loan.quantity) || 0,
        remainingQuantity: Number(loan.remainingQuantity ?? loan.quantity) || 0,
        borrowedAt: loan.borrowedAt || null,
        reportedBy: loan.reportedBy || "",
      }));
    })
    .filter((entry) => entry.borrowerName || entry.equipmentName);
}

async function writeWorkbookToTemp(workbook, filePrefix) {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const tmpPath = path.join(os.tmpdir(), `${filePrefix}-${timestamp}.xlsx`);
  await workbook.xlsx.writeFile(tmpPath);
  return tmpPath;
}

/**
 * Builds a clean, formatted .xlsx workbook of the full inventory and
 * returns the local file path. Caller is responsible for deleting the
 * temp file after sending it.
 */
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

async function generateMasterReport() {
  const items = await getAll();
  const workbook = buildWorkbook("OSH Equipment Master Report");

  // Sheet 1: Inventory
  const inventoryHeaders = [
    { header: "Equipment Name (Khmer)", key: "nameKhmer", width: 30 },
    { header: "Equipment Name (English)", key: "nameEnglish", width: 30 },
    { header: "Model", key: "model", width: 18 },
    { header: "Total Qty", key: "totalQuantity", width: 12 },
    { header: "Available Qty", key: "availableQuantity", width: 14 },
    { header: "Borrowed Qty", key: "borrowedQuantity", width: 14 },
    { header: "Status", key: "status", width: 14 },
  ];
  const invSheet = createSheet(workbook, "ស្តុកឧបករណ៍", inventoryHeaders);

  items.forEach((item) => {
    const names = parseEquipmentNames(item);
    const row = invSheet.addRow({
      nameKhmer: names.khmer,
      nameEnglish: names.english,
      model: item.model || "",
      totalQuantity: item.totalQuantity ?? 0,
      availableQuantity: item.availableQuantity ?? 0,
      borrowedQuantity: item.borrowedQuantity ?? 0,
      status: item.status || "",
    });

    row.font = { name: "Arial", size: 10 };
    row.alignment = { vertical: "middle" };

    const color = STATUS_COLORS[item.status];
    if (color) {
      row.getCell("status").fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: color },
      };
    }
  });
  styleTableBorders(invSheet, invSheet.rowCount, inventoryHeaders.length);
  invSheet.autoFilter = { from: "A1", to: `${invSheet.getColumn(inventoryHeaders.length).letter}1` };

  // Sheet 2: Active Borrowers
  const openLoansHeaders = [
    { header: "Borrower Name", key: "borrowerName", width: 26 },
    { header: "Equipment Name", key: "equipmentName", width: 30 },
    { header: "Borrowed Qty", key: "remainingQuantity", width: 14 },
    { header: "Borrowed At", key: "borrowedAt", width: 22 },
    { header: "Reported By", key: "reportedBy", width: 22 },
  ];
  const borrowersSheet = createSheet(workbook, "បញ្ជីអ្នកខ្ចីសកម្ម", openLoansHeaders);

  const activeLoans = collectActiveLoans(items).sort((a, b) => (toDate(b.borrowedAt)?.getTime() || 0) - (toDate(a.borrowedAt)?.getTime() || 0));
  activeLoans.forEach((loan) => {
    borrowersSheet.addRow({
      borrowerName: loan.borrowerName,
      equipmentName: loan.equipmentName,
      remainingQuantity: loan.remainingQuantity,
      borrowedAt: formatTimestamp(loan.borrowedAt),
      reportedBy: loan.reportedBy,
    }).font = { name: "Arial", size: 10 };
  });
  styleTableBorders(borrowersSheet, borrowersSheet.rowCount, openLoansHeaders.length);

  // Sheet 3: Stock In Log
  const stockInHeaders = [
    { header: "Equipment Name", key: "equipmentName", width: 30 },
    { header: "Added Qty", key: "addedQty", width: 14 },
    { header: "Old Total", key: "oldTotal", width: 14 },
    { header: "New Total", key: "newTotal", width: 14 },
    { header: "Added At", key: "addedAt", width: 22 },
    { header: "Added By", key: "addedBy", width: 22 },
  ];
  const stockInSheet = createSheet(workbook, "កំណត់ហេតុបន្ថែមស្តុក", stockInHeaders);
  const stockInEvents = items
    .flatMap((item) => {
      const history = Array.isArray(item.stockInHistory) ? item.stockInHistory : [];
      return history.map((e) => ({
        equipmentName: item.equipmentName || "",
        addedQty: e.addedQty || 0,
        oldTotal: e.oldTotal || 0,
        newTotal: e.newTotal || 0,
        addedAt: e.addedAt || null,
        addedBy: e.addedBy || "",
      }));
    })
    .sort((a, b) => (toDate(b.addedAt)?.getTime() || 0) - (toDate(a.addedAt)?.getTime() || 0));

  stockInEvents.forEach((ev) => {
    stockInSheet.addRow({
      equipmentName: ev.equipmentName,
      addedQty: ev.addedQty,
      oldTotal: ev.oldTotal,
      newTotal: ev.newTotal,
      addedAt: formatTimestamp(ev.addedAt),
      addedBy: ev.addedBy,
    }).font = { name: "Arial", size: 10 };
  });
  styleTableBorders(stockInSheet, stockInSheet.rowCount, stockInHeaders.length);

  // Sheet 4: Transaction History
  const historyHeaders = [
    { header: "Equipment Name", key: "equipmentName", width: 30 },
    { header: "Borrower Name", key: "borrowerName", width: 24 },
    { header: "Type", key: "type", width: 12 },
    { header: "Quantity", key: "quantity", width: 12 },
    { header: "At", key: "at", width: 22 },
    { header: "Reported By", key: "reportedBy", width: 22 },
  ];
  const historySheet = createSheet(workbook, "ប្រវត្តិប្រតិបត្តិការ", historyHeaders);

  const borrowEvents = collectBorrowEvents(items).map((e) => ({ ...e, type: "Borrow", at: e.borrowedAt }));
  const returnEvents = collectReturnEvents(items).map((e) => ({ ...e, type: "Return", at: e.returnedAt }));
  const allEvents = borrowEvents.concat(returnEvents).sort((a, b) => (toDate(b.at)?.getTime() || 0) - (toDate(a.at)?.getTime() || 0));

  allEvents.forEach((ev) => {
    historySheet.addRow({
      equipmentName: ev.equipmentName,
      borrowerName: ev.borrowerName,
      type: ev.type,
      quantity: ev.quantity,
      at: formatTimestamp(ev.at),
      reportedBy: ev.reportedBy,
    }).font = { name: "Arial", size: 10 };
  });
  styleTableBorders(historySheet, historySheet.rowCount, historyHeaders.length);

  return writeWorkbookToTemp(workbook, "OSH-Master-Report");
}

module.exports = {
  generateMasterReport,
  generateInventoryReport: generateMasterReport,
  generateBorrowerReport: generateMasterReport,
  generateStockHistoryReport: generateMasterReport,
};
