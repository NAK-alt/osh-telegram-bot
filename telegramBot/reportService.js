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
async function generateInventoryReport() {
  const items = await getAll();
  const workbook = buildWorkbook("Inventory Report");
  const sheet = createSheet(workbook, "Inventory", HEADERS);

  items.forEach((item) => {
    const latestVisible = getLatestVisibleBorrowMeta(item);
    const row = sheet.addRow({
      equipmentName: item.equipmentName || "",
      brand: item.brand || "",
      model: item.model || "",
      serialNumber: item.serialNumber || "",
      storageLocation: item.storageLocation || "",
      totalQuantity: item.totalQuantity ?? 0,
      availableQuantity: item.availableQuantity ?? 0,
      borrowedQuantity: item.borrowedQuantity ?? 0,
      lastBorrowedBy: latestVisible.borrowerName,
      lastReportedBy: latestVisible.reportedBy,
      minimumStockLevel: item.minimumStockLevel ?? 0,
      status: item.status || "",
      description: item.description || "",
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

  styleTableBorders(sheet, sheet.rowCount, HEADERS.length);
  sheet.autoFilter = { from: "A1", to: `${sheet.getColumn(HEADERS.length).letter}1` };

  return writeWorkbookToTemp(workbook, "OSH-Inventory-Report");
}

async function generateBorrowerReport() {
  const items = await getAll();
  const events = collectBorrowEvents(items).sort((left, right) => {
    const leftTime = toDate(left.borrowedAt)?.getTime() || 0;
    const rightTime = toDate(right.borrowedAt)?.getTime() || 0;
    return rightTime - leftTime;
  });

  const workbook = buildWorkbook("Borrower Report");
  const summarySheet = createSheet(workbook, "By Borrower", [
    { header: "Borrower Name", key: "borrowerName", width: 24 },
    { header: "Equipment Name", key: "equipmentName", width: 28 },
    { header: "Total Borrowed", key: "totalBorrowed", width: 14 },
    { header: "Last Borrowed At", key: "lastBorrowedAt", width: 22 },
  ]);
  const historySheet = createSheet(workbook, "Borrow History", [
    { header: "Borrower Name", key: "borrowerName", width: 24 },
    { header: "Equipment Name", key: "equipmentName", width: 28 },
    { header: "Quantity", key: "quantity", width: 12 },
    { header: "Borrowed At", key: "borrowedAt", width: 22 },
    { header: "Reported By", key: "reportedBy", width: 22 },
    { header: "Equipment Status", key: "equipmentStatus", width: 16 },
  ]);
  const returnHistorySheet = createSheet(workbook, "Return History", [
    { header: "Borrower Name", key: "borrowerName", width: 24 },
    { header: "Equipment Name", key: "equipmentName", width: 28 },
    { header: "Quantity", key: "quantity", width: 12 },
    { header: "Returned At", key: "returnedAt", width: 22 },
    { header: "Reported By", key: "reportedBy", width: 22 },
  ]);
  const openLoansSheet = createSheet(workbook, "Open Loans", [
    { header: "Borrower Name", key: "borrowerName", width: 24 },
    { header: "Equipment Name", key: "equipmentName", width: 28 },
    { header: "Original Qty", key: "quantity", width: 14 },
    { header: "Remaining Qty", key: "remainingQuantity", width: 14 },
    { header: "Borrowed At", key: "borrowedAt", width: 22 },
    { header: "Reported By", key: "reportedBy", width: 22 },
  ]);

  const summaryMap = new Map();
  const activeLoans = collectActiveLoans(items);
  const returnEvents = collectReturnEvents(items).sort((left, right) => {
    const leftTime = toDate(left.returnedAt)?.getTime() || 0;
    const rightTime = toDate(right.returnedAt)?.getTime() || 0;
    return rightTime - leftTime;
  });

  events.forEach((event) => {
    historySheet.addRow({
      borrowerName: event.borrowerName,
      equipmentName: event.equipmentName,
      quantity: event.quantity,
      borrowedAt: formatTimestamp(event.borrowedAt),
      reportedBy: event.reportedBy,
      equipmentStatus: event.equipmentStatus,
    }).font = { name: "Arial", size: 10 };

    const key = `${event.borrowerName}::${event.equipmentName}`;
    const current = summaryMap.get(key) || {
      borrowerName: event.borrowerName,
      equipmentName: event.equipmentName,
      totalBorrowed: 0,
      lastBorrowedAt: null,
    };

    current.totalBorrowed += event.quantity;
    const eventDate = toDate(event.borrowedAt);
    if (!current.lastBorrowedAt || (eventDate && eventDate > current.lastBorrowedAt)) {
      current.lastBorrowedAt = eventDate;
    }

    summaryMap.set(key, current);
  });

  returnEvents.forEach((event) => {
    returnHistorySheet.addRow({
      borrowerName: event.borrowerName,
      equipmentName: event.equipmentName,
      quantity: event.quantity,
      returnedAt: formatTimestamp(event.returnedAt),
      reportedBy: event.reportedBy,
    }).font = { name: "Arial", size: 10 };
  });

  activeLoans
    .sort((left, right) => {
      const leftTime = toDate(left.borrowedAt)?.getTime() || 0;
      const rightTime = toDate(right.borrowedAt)?.getTime() || 0;
      return rightTime - leftTime;
    })
    .forEach((loan) => {
      openLoansSheet.addRow({
        borrowerName: loan.borrowerName,
        equipmentName: loan.equipmentName,
        quantity: loan.quantity,
        remainingQuantity: loan.remainingQuantity,
        borrowedAt: formatTimestamp(loan.borrowedAt),
        reportedBy: loan.reportedBy,
      }).font = { name: "Arial", size: 10 };
    });

  Array.from(summaryMap.values())
    .sort((left, right) => {
      if (left.borrowerName !== right.borrowerName) {
        return left.borrowerName.localeCompare(right.borrowerName);
      }
      return left.equipmentName.localeCompare(right.equipmentName);
    })
    .forEach((row) => {
      summarySheet.addRow({
        borrowerName: row.borrowerName,
        equipmentName: row.equipmentName,
        totalBorrowed: row.totalBorrowed,
        lastBorrowedAt: row.lastBorrowedAt ? row.lastBorrowedAt.toLocaleString() : "",
      }).font = { name: "Arial", size: 10 };
    });

  styleTableBorders(summarySheet, summarySheet.rowCount, 4);
  styleTableBorders(historySheet, historySheet.rowCount, 6);
  styleTableBorders(returnHistorySheet, returnHistorySheet.rowCount, 5);
  styleTableBorders(openLoansSheet, openLoansSheet.rowCount, 6);

  return writeWorkbookToTemp(workbook, "OSH-Borrower-Report");
}

async function generateStockHistoryReport() {
  const items = await getAll();
  const workbook = buildWorkbook("Stock and History Report");

  const stockSheet = createSheet(workbook, "Current Stock", [
    { header: "Equipment Name", key: "equipmentName", width: 28 },
    { header: "Total Qty", key: "totalQuantity", width: 12 },
    { header: "Available Qty", key: "availableQuantity", width: 14 },
    { header: "Borrowed Qty", key: "borrowedQuantity", width: 14 },
    { header: "Status", key: "status", width: 14 },
    { header: "Last Borrowed By", key: "lastBorrowedBy", width: 20 },
    { header: "Last Reported By", key: "lastReportedBy", width: 20 },
    { header: "Last Borrowed At", key: "lastBorrowedAt", width: 22 },
  ]);
  const historySheet = createSheet(workbook, "Recent History", [
    { header: "Equipment Name", key: "equipmentName", width: 28 },
    { header: "Borrower Name", key: "borrowerName", width: 24 },
    { header: "Type", key: "type", width: 12 },
    { header: "Quantity", key: "quantity", width: 12 },
    { header: "At", key: "at", width: 22 },
    { header: "Reported By", key: "reportedBy", width: 22 },
  ]);

  const borrowEvents = collectBorrowEvents(items).map((event) => ({
    equipmentName: event.equipmentName,
    borrowerName: event.borrowerName,
    type: "Borrow",
    quantity: event.quantity,
    at: event.borrowedAt,
    reportedBy: event.reportedBy,
  }));
  const returnEvents = collectReturnEvents(items).map((event) => ({
    equipmentName: event.equipmentName,
    borrowerName: event.borrowerName,
    type: "Return",
    quantity: event.quantity,
    at: event.returnedAt,
    reportedBy: event.reportedBy,
  }));
  const recentEvents = borrowEvents
    .concat(returnEvents)
    .sort((left, right) => {
      const leftTime = toDate(left.at)?.getTime() || 0;
      const rightTime = toDate(right.at)?.getTime() || 0;
      return rightTime - leftTime;
    })
    .slice(0, 100);

  items.forEach((item) => {
    const latestVisible = getLatestVisibleBorrowMeta(item);
    stockSheet.addRow({
      equipmentName: item.equipmentName || "",
      totalQuantity: item.totalQuantity ?? 0,
      availableQuantity: item.availableQuantity ?? 0,
      borrowedQuantity: item.borrowedQuantity ?? 0,
      status: item.status || "",
      lastBorrowedBy: latestVisible.borrowerName,
      lastReportedBy: latestVisible.reportedBy,
      lastBorrowedAt: formatTimestamp(latestVisible.borrowedAt),
    }).font = { name: "Arial", size: 10 };
  });

  recentEvents.forEach((event) => {
    historySheet.addRow({
      equipmentName: event.equipmentName,
      borrowerName: event.borrowerName,
      type: event.type,
      quantity: event.quantity,
      at: formatTimestamp(event.at),
      reportedBy: event.reportedBy,
    }).font = { name: "Arial", size: 10 };
  });

  const stockInSheet = createSheet(workbook, "Stock In Log", [
    { header: "Equipment Name", key: "equipmentName", width: 28 },
    { header: "Added Qty", key: "addedQty", width: 14 },
    { header: "Old Total", key: "oldTotal", width: 14 },
    { header: "New Total", key: "newTotal", width: 14 },
    { header: "Added At", key: "addedAt", width: 22 },
    { header: "Added By", key: "addedBy", width: 22 },
  ]);

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

  styleTableBorders(stockSheet, stockSheet.rowCount, 8);
  styleTableBorders(historySheet, historySheet.rowCount, 6);
  styleTableBorders(stockInSheet, stockInSheet.rowCount, 6);

  return writeWorkbookToTemp(workbook, "OSH-Stock-History-Report");
}

module.exports = {
  generateInventoryReport,
  generateBorrowerReport,
  generateStockHistoryReport,
};
