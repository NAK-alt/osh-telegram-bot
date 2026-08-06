const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");

const EXCEL_PATHS = [
  path.join(__dirname, "..", "..", "បញ្ជីមន្រ្តី.xlsx"),
  path.join(__dirname, "..", "បញ្ជីមន្រ្តី.xlsx"),
  path.join(__dirname, "..", "uploads", "បញ្ជីមន្រ្តី.xlsx"),
];

let cachedOfficers = [];
let lastLoadedTime = 0;

function normalize(str) {
  return String(str || "").trim().toLowerCase();
}

async function loadOfficers(forceReload = false) {
  if (cachedOfficers.length > 0 && !forceReload && Date.now() - lastLoadedTime < 60000) {
    return cachedOfficers;
  }

  const filePath = EXCEL_PATHS.find((p) => fs.existsSync(p));
  if (!filePath) {
    console.warn("[officerService] Excel file បញ្ជីមន្រ្តី.xlsx not found.");
    return cachedOfficers;
  }

  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const sheet = wb.worksheets[0];
    const officers = [];

    sheet.eachRow((row, rowNum) => {
      if (rowNum < 4) return; // Headers at row 3

      const getVal = (col) => {
        let v = row.getCell(col).value;
        if (v && typeof v === "object") {
          if (v.richText) return v.richText.map((t) => t.text).join("");
          if (v.result !== undefined) return v.result;
          if (v.text) return v.text;
        }
        return v ? String(v).trim() : "";
      };

      const name = getVal(2);
      if (!name) return;

      const group = getVal(3);
      const role = getVal(4);
      const groupRole = getVal(5);
      const id = getVal(6);
      const province = getVal(7);
      const phone = getVal(8);

      officers.push({
        name,
        id,
        role,
        groupRole,
        group,
        province,
        phone,
        searchKey: normalize(`${name} ${id} ${phone} ${role} ${province}`),
      });
    });

    cachedOfficers = officers;
    lastLoadedTime = Date.now();
    console.log(`[officerService] Loaded ${cachedOfficers.length} officers from Excel.`);
    return cachedOfficers;
  } catch (err) {
    console.error("[officerService] Failed to read officer Excel file:", err.message);
    return cachedOfficers;
  }
}

/**
 * Search officer list by partial query (matches name, id, phone, or role).
 * @param {string} query 
 * @param {number} limit 
 */
async function searchOfficers(query, limit = 8) {
  const officers = await loadOfficers();
  const q = normalize(query);
  if (!q) return officers.slice(0, limit);

  const results = [];
  for (const off of officers) {
    const key = off.searchKey;
    const nameNorm = normalize(off.name);
    let score = 0;

    if (nameNorm === q || off.id === q) score = 100;
    else if (nameNorm.startsWith(q) || off.id.startsWith(q)) score = 80;
    else if (key.includes(q)) score = 60;
    else continue;

    results.push({ officer: off, score });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit).map((r) => r.officer);
}

/**
 * Get all officer names list.
 */
async function getAllOfficerNames() {
  const officers = await loadOfficers();
  return officers.map((o) => o.name);
}

module.exports = {
  loadOfficers,
  searchOfficers,
  getAllOfficerNames,
};
