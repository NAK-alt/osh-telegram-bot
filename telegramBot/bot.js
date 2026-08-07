process.env.NTBA_FIX_350 = "1";
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const path = require("path");
const fs = require("fs");
const https = require("https");
const storageService = require("../services/storageService");

const { getSession, setSession, clearSession } = require("./sessionStore");
const { getLanguage, setLanguage } = require("./languageStore");
const equipmentService = require("./equipmentService");
const {
  generateMasterReport,
  generateInventoryReport,
  generateBorrowerReport,
  generateStockHistoryReport,
} = require("./reportService");
const authStore = require("./authStore");
const officerService = require("./officerService");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  console.error("[TelegramBot] Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

if (authStore.ADMIN_IDS.length === 0) {
  console.warn(
    "[TelegramBot] WARNING: ALLOWED_TELEGRAM_IDS is empty — no admin can run /adduser, " +
    "and the bot will reject everyone. Add your Telegram numeric user ID(s) (comma-separated)."
  );
}

const bot = new TelegramBot(TOKEN, { polling: true });
const EQUIPMENT_DIR = path.join(__dirname, "..", "uploads", "equipment");
const PLACEHOLDER_FILE = path.join(__dirname, "..", "uploads", "placeholder.png");
const STOCK_PER_PAGE = 8;

// Load the Firestore allowlist so non-admin users can be authorized. Admins (env)
// work immediately regardless; this just populates the cache for added users.
authStore.load().catch((err) =>
  console.error("[TelegramBot] Could not load user allowlist:", err.message)
);

// ---------- "/" command menu (the autocomplete suggestions Telegram shows when you type /) ----------
const COMMANDS_EN = [
  { command: "start", description: "Start the bot" },
  { command: "help", description: "List all commands" },
  { command: "stock", description: "List all equipment (tap to view)" },
  { command: "view", description: "View one item + photo — /view <name>" },
  { command: "add", description: "Add new equipment (step by step)" },
  { command: "edit", description: "Edit a field — /edit <name> <field> <value>" },
  { command: "borrow", description: "Borrow equipment — /borrow [name] or /borrow (multi)" },
  { command: "return", description: "Return equipment — /return [name] or /return all <borrower>" },
  { command: "delete", description: "Delete an item — /delete <name>" },
  { command: "report", description: "Download a report (pick a type)" },
  { command: "borrower", description: "Fix borrower in reports — rename | hide | delete" },
  { command: "language", description: "Switch the bot language" },
  { command: "cancel", description: "Cancel the current flow" },
  { command: "skip", description: "Skip the photo in the /add flow" },
  { command: "adduser", description: "Admin: allow a user — /adduser <id> [name]" },
  { command: "removeuser", description: "Admin: remove a user — /removeuser <id>" },
  { command: "listusers", description: "Admin: list allowed users" },
];

const COMMANDS_KM = [
  { command: "start", description: "ចាប់ផ្ដើមប្រើប្រាស់ប្រព័ន្ធ" },
  { command: "help", description: "បង្ហាញបញ្ជីប្រតិបត្តិការទាំងអស់" },
  { command: "stock", description: "ពិនិត្យបញ្ជីស្តុកឧបករណ៍ទាំងអស់" },
  { command: "view", description: "ពិនិត្យព័ត៌មានលម្អិតឧបករណ៍ — /view <ឈ្មោះ>" },
  { command: "add", description: "បន្ថែមឧបករណ៍ថ្មីចូលក្នុងស្តុក" },
  { command: "edit", description: "បើកម៉ឺនុយកែប្រែទិន្នន័យ និងស្តុក" },
  { command: "borrow", description: "ស្នើខ្ចីឧបករណ៍ (មួយ ឬច្រើនមុខ)" },
  { command: "return", description: "ស្នើប្រគល់ឧបករណ៍ (មួយ ឬច្រើនមុខ)" },
  { command: "delete", description: "លុបទិន្នន័យឧបករណ៍ចេញពីស្តុក" },
  { command: "report", description: "ទាញយករបាយការណ៍ស្តុក និងការខ្ចី (Excel)" },
  { command: "borrower", description: "កែប្រែទិន្នន័យអ្នកខ្ចីក្នុងរបាយការណ៍" },
  { command: "language", description: "ផ្លាស់ប្ដូរភាសាប្រើប្រាស់ប្រព័ន្ធ" },
  { command: "cancel", description: "បោះបង់ប្រតិបត្តិការបច្ចុប្បន្ន" },
  { command: "skip", description: "រំលងការបញ្ចូលរូបភាព" },
  { command: "adduser", description: "ផ្តល់សិទ្ធិដល់អ្នកប្រើប្រាស់ — /adduser <id>" },
  { command: "removeuser", description: "ដកសិទ្ធិអ្នកប្រើប្រាស់ — /removeuser <id>" },
  { command: "listusers", description: "បង្ហាញបញ្ជីអ្នកដែលមានសិទ្ធិប្រើប្រាស់" },
];

// Default menu — Khmer.
bot.setMyCommands(COMMANDS_KM).catch((err) =>
  console.error("[TelegramBot] setMyCommands (default) failed:", err.message)
);
// Also overwrite the per-language English menu with Khmer commands, so users whose
// Telegram app is set to English still see Khmer "/" suggestions. (Telegram caches
// per-language menus, so we must actively replace the old English one.)
bot.setMyCommands(COMMANDS_KM, { language_code: "en" }).catch((err) =>
  console.error("[TelegramBot] setMyCommands (en) failed:", err.message)
);
bot.setMyCommands(COMMANDS_KM, { language_code: "km" }).catch((err) =>
  console.error("[TelegramBot] setMyCommands (km) failed:", err.message)
);

const TEXT = {
  en: {
    ready: "OSH Equipment Management System ready. Type /help or tap a button below.",
    unauthorized: "You're not authorized to use this system.",
    unauthorizedHint: "Please contact the admin to allow your Telegram ID.",
    helpTitle: "Commands & Operations",
    cancelled: "Operation cancelled.",
    noEquipment: "No equipment found in system.",
    error: "System Notice",
    languagePrompt: "Choose a language: /language en or /language km",
    languageSet: "Language set to English.",
    pickItem: "Please select an equipment item:",
    didYouMean: "No exact match found. Did you mean one of these?",
    itemGone: "That item no longer exists in system.",
    nothingBorrowed: "No active loans found for this item.",
    confirmDelete: "Are you sure you want to permanently delete this item and its photo/QR code?",
    deleted: "Deleted {name} successfully.",
    menuBorrow: "Borrow",
    menuReturn: "Return",
    menuEdit: "Edit",
    menuDelete: "Delete",
    confirm: "Confirm",
    cancel: "Cancel",
    other: "Other (type name)",
    back: "Back",
    prev: "‹ Prev",
    next: "Next ›",
    unknownDate: "Unknown date",
    helpBtn: "Help",
    langToggle: "English",
  },
  km: {
    ready: "ប្រព័ន្ធគ្រប់គ្រងឧបករណ៍ OSH ត្រូវបានរៀបចំរួចរាល់។ សូមវាយ /help ឬជ្រើសរើសប្រតិបត្តិការខាងក្រោម៖",
    unauthorized: "លោក/លោកស្រីមិនទាន់មានសិទ្ធិចូលប្រើប្រាស់ប្រព័ន្ធនេះនៅឡើយទេ។",
    unauthorizedHint: "សូមទំនាក់ទំនងអ្នកគ្រប់គ្រង (Admin) ដើម្បីបន្ថែម Telegram ID របស់លោក/លោកស្រី។",
    helpTitle: "បញ្ជីប្រតិបត្តិការ និងការប្រើប្រាស់",
    cancelled: "ប្រតិបត្តិការត្រូវបានបោះបង់ដោយជោគជ័យ។",
    noEquipment: "ពុំទាន់មានទិន្នន័យឧបករណ៍ក្នុងប្រព័ន្ធនៅឡើយទេ។",
    error: "សេចក្តីជូនដំណឹងអំពីកំហុស",
    languagePrompt: "សូមជ្រើសរើសភាសាប្រើប្រាស់៖ /language en ឬ /language km",
    languageSet: "បានកំណត់ភាសាប្រើប្រាស់ជា៖ ភាសាខ្មែរ។",
    pickItem: "សូមជ្រើសរើសឧបករណ៍៖",
    didYouMean: "រកមិនឃើញឈ្មោះពិតប្រាកដទេ។ តើលោក/លោកស្រីសំដៅលើឧបករណ៍មួយណាដូចខាងក្រោម?",
    itemGone: "ទិន្នន័យឧបករណ៍នេះមិនមាននៅក្នុងប្រព័ន្ធទៀតទេ។",
    nothingBorrowed: "ពុំមានប្រវត្តិខ្ចីសកម្មសម្រាប់ឧបករណ៍នេះនាពេលបច្ចុប្បន្នទេ។",
    confirmDelete: "តើលោក/លោកស្រីពិតជាប្រាកដថាចង់លុបទិន្នន័យឧបករណ៍នេះ រួមទាំងរូបភាព និងលេខកូដ QR ជារៀងរហូត?",
    deleted: "បានលុបទិន្នន័យ {name} ដោយជោគជ័យ។",
    menuBorrow: "📥 ខ្ចីឧបករណ៍",
    menuReturn: "📤 ប្រគល់ឧបករណ៍",
    menuEdit: "✏️ កែប្រែ",
    menuDelete: "🗑️ លុប",
    confirm: "✅ បញ្ជាក់",
    cancel: "❌ បោះបង់",
    other: "ផ្សេងៗ (បញ្ចូលឈ្មោះ)",
    back: "⬅️ ត្រឡប់ក្រោយ",
    prev: "‹ ទំព័រមុន",
    next: "ទំព័របន្ទាប់ ›",
    unknownDate: "ពុំស្គាល់កាលបរិច្ឆេទ",
    helpBtn: "❓ ជំនួយ",
    langToggle: "ភាសាខ្មែរ",
  },
};

function lang(chatId) {
  return getLanguage(chatId) === "km" ? "km" : "en";
}

function t(chatId, key, vars) {
  let str = TEXT[lang(chatId)][key] || TEXT.en[key] || "";
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return str;
}

function tr(chatId, enText, kmText) {
  return lang(chatId) === "km" ? kmText : enText;
}

function setChatLanguage(chatId, code) {
  setLanguage(chatId, code);
  return code === "km" ? TEXT.km.languageSet : TEXT.en.languageSet;
}

function isAuthorized(msg) {
  return authStore.isAuthorizedId(msg.from.id);
}

function userAuthorized(from) {
  return authStore.isAuthorizedId(from.id);
}

function reject(msg) {
  const id = msg.from.id;
  bot.sendMessage(
    msg.chat.id,
    tr(
      msg.chat.id,
      `${TEXT.en.unauthorized}\nYour Telegram ID is ${id}. Ask an admin to run: /adduser ${id}`,
      `${TEXT.km.unauthorized}\nTelegram ID របស់អ្នកគឺ ${id}។ សូមឲ្យ admin រត់៖ /adduser ${id}`
    )
  );
}

// Resolve the Telegram user who actually input a transaction to a friendly name +
// id, so we can record "who logged this" alongside the borrower. Name precedence:
// stored botUsers name → Telegram first/last name → @username → numeric id.
async function resolveReporter(from) {
  const id = String((from && from.id) || "");
  let name = "";
  if (from) {
    name = `${from.first_name || ""}${from.last_name ? " " + from.last_name : ""}`.trim();
    if (!name && from.username) name = `@${from.username}`;
  }
  try {
    const stored = await authStore.getUserName(id);
    if (stored) name = stored;
  } catch (err) {
    console.error("[TelegramBot] resolveReporter getUserName failed:", err.message);
  }
  if (!name) name = id;
  return { id, name };
}

// Escape Markdown special chars in user-provided values so names with *, _, etc.
// don't break the message formatting. Used by the short status/confirm messages
// that still use parse_mode: "Markdown".
function esc(value) {
  return String(value ?? "").replace(/([*_`\[])/g, "\\$1");
}

// Escape for parse_mode: "HTML". Used by formatItem, which is rendered as the photo
// caption — HTML is far more forgiving than Markdown (no unmatched-tag 400s).
function escHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatItem(item) {
  const nameKhmer = item.equipmentNameKhmer || "";
  const nameEnglish = item.equipmentNameEnglish || "";
  let nameDisplay = escHtml(item.equipmentName || "Equipment");
  if (nameKhmer && nameEnglish) {
    nameDisplay = `${escHtml(nameKhmer)} (${escHtml(nameEnglish)})`;
  }

  const avail = Number.isNaN(Number(item.availableQuantity)) ? 0 : (Number(item.availableQuantity) || 0);
  const total = Number.isNaN(Number(item.totalQuantity)) ? 0 : (Number(item.totalQuantity) || 0);
  const borrowed = Number.isNaN(Number(item.borrowedQuantity)) ? 0 : (Number(item.borrowedQuantity) || 0);

  return {
    en:
      `<b>${nameDisplay}</b>\n` +
      (item.model ? `Model: ${escHtml(item.model)}\n` : "") +
      `Available: ${avail} / ${total}  |  Borrowed: ${borrowed}\n` +
      `Status: ${item.status}`,
    km:
      `<b>${nameDisplay}</b>\n` +
      (item.model ? `ម៉ូឌែល៖ ${escHtml(item.model)}\n` : "") +
      `សល់ក្នុងស្តុក៖ ${avail} / ${total}  |  ខ្ចីចេញ៖ ${borrowed}\n` +
      `ស្ថានភាព៖ ${item.status}`,
  };
}

function formatTimestamp(value) {
  if (!value) return "Unknown date";
  if (typeof value.toDate === "function") return value.toDate().toLocaleString();
  if (value._seconds) return new Date(value._seconds * 1000).toLocaleString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown date" : parsed.toLocaleString();
}

function openQuantity(loan) {
  return Number(loan.remainingQuantity ?? loan.quantity ?? 0) || 0;
}

// Distinct borrower names that have interacted with this item, most-recent first.
function recentBorrowers(item) {
  const loans = Array.isArray(item.activeLoans) ? item.activeLoans : [];
  const history = Array.isArray(item.borrowHistory) ? item.borrowHistory : [];
  const seen = new Set();
  const result = [];
  for (const loan of loans) {
    const name = (loan.borrowerName || "").trim();
    const key = name.toLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      result.push(name);
    }
  }
  for (const entry of history) {
    const name = (entry.borrowerName || "").trim();
    const key = name.toLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      result.push(name);
    }
  }
  return result;
}

const borrowerKeyMap = new Map();
let borrowerKeyCounter = 0;

function setBorrowerKey(name) {
  const str = String(name || "").trim();
  if (!str) return "";
  for (const [key, val] of borrowerKeyMap.entries()) {
    if (val === str) return key;
  }
  borrowerKeyCounter = (borrowerKeyCounter + 1) % 10000;
  const key = `b${borrowerKeyCounter}`;
  borrowerKeyMap.set(key, str);
  return key;
}

function getBorrowerByKey(key) {
  const str = String(key || "").trim();
  if (borrowerKeyMap.has(str)) {
    return borrowerKeyMap.get(str);
  }
  try {
    return decodeURIComponent(str);
  } catch (_) {
    return str;
  }
}

// ---------- Inline keyboards ----------
function viewMenuKeyboard(chatId) {
  return {
    inline_keyboard: [
      [
        { text: t(chatId, "menuBorrow"), callback_data: "bor:{id}" },
        { text: t(chatId, "menuReturn"), callback_data: "ret:{id}" },
      ],
      [
        { text: t(chatId, "menuEdit"), callback_data: "edt:{id}" },
        { text: t(chatId, "menuDelete"), callback_data: "del:{id}" },
      ],
    ],
  };
}

function formatEquipmentLabel(it) {
  let kmName = String(it.equipmentNameKhmer || "").trim();
  let enName = String(it.equipmentNameEnglish || "").trim();
  const rawName = String(it.equipmentName || "").trim();

  if (!kmName && !enName && rawName) {
    const match = rawName.match(/^([^(]+)(?:\(([^)]+)\))?/);
    if (match) {
      kmName = match[1].trim();
      enName = match[2] ? match[2].trim() : "";
    } else {
      kmName = rawName;
    }
  } else if (!kmName && rawName) {
    kmName = rawName;
  }

  const modelStr = String(it.model || "").trim();
  const qtyStr = `${it.availableQuantity ?? 0}/${it.totalQuantity ?? 0}`;

  const parts = [kmName, enName, modelStr, qtyStr].filter(Boolean);
  return parts.join(" ");
}

function stockKeyboard(chatId, items, page) {
  const totalPages = Math.max(1, Math.ceil(items.length / STOCK_PER_PAGE));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const slice = items.slice(p * STOCK_PER_PAGE, (p + 1) * STOCK_PER_PAGE);

  const rows = slice.map((it) => [
    {
      text: formatEquipmentLabel(it),
      callback_data: `view:${it.id}`,
    },
  ]);

  const nav = [];
  if (p > 0) nav.push({ text: t(chatId, "prev"), callback_data: `stkpg:${p - 1}` });
  nav.push({ text: `${p + 1}/${totalPages}`, callback_data: "noop" });
  if (p < totalPages - 1) nav.push({ text: t(chatId, "next"), callback_data: `stkpg:${p + 1}` });
  rows.push(nav);

  return { inline_keyboard: rows };
}

function suggestKeyboard(items, action) {
  return {
    inline_keyboard: items.map((it) => [
      {
        text: formatEquipmentLabel(it),
        callback_data: `${action}:${it.id}`,
      },
    ]),
  };
}

function fillKeyboard(template, id) {
  const json = JSON.stringify(template).replace(/{id}/g, id);
  return JSON.parse(json);
}

// Send (or re-send) an item's details + photo with the action menu.
async function sendView(chatId, item, { withMenu = true } = {}) {
  const currentLang = lang(chatId);
  const caption = formatItem(item)[currentLang];
  const reply_markup = withMenu ? fillKeyboard(viewMenuKeyboard(chatId), item.id) : undefined;
  // formatItem returns HTML, so the caption must be parsed as HTML (not Markdown).
  const opts = { parse_mode: "HTML", reply_markup };

  const candidates = [];

  // Storage-backed images resolve to a signed HTTPS URL -> send by URL (works on
  // Railway, no local file needed). Legacy /uploads/equipment/... paths fall back to
  // the file on disk (only present locally). Placeholder shows for no-image items.
  if (item.imagePath && item.imagePath !== "/uploads/placeholder.png") {
    try {
      const resolved = await storageService.resolveImageUrl(item.imagePath);
      if (resolved && /^https?:\/\//i.test(resolved)) {
        candidates.push(resolved);
      } else {
        const realFile = path.join(EQUIPMENT_DIR, path.basename(item.imagePath));
        if (fs.existsSync(realFile)) candidates.push(realFile);
      }
    } catch (err) {
      console.error("[sendView] resolveImageUrl failed:", err && err.message ? err.message : err);
    }
  }

  // Fallbacks: placeholder file, then a plain text message so details always show.
  if (fs.existsSync(PLACEHOLDER_FILE)) candidates.push(PLACEHOLDER_FILE);

  for (const candidate of candidates) {
    try {
      await bot.sendPhoto(chatId, candidate, { caption, ...opts });
      return;
    } catch (err) {
      console.error(
        `[sendView] sendPhoto failed for ${typeof candidate === "string" ? path.basename(candidate) : candidate}:`,
        err && err.message ? err.message : err
      );
    }
  }

  await bot.sendMessage(chatId, caption, { parse_mode: "HTML", reply_markup });
}

// When an exact name lookup fails, show tappable "Did you mean …?" suggestions.
async function suggestOrWarn(chatId, query, action) {
  const matches = await equipmentService.searchEquipment(query);
  if (matches.length === 0) {
    return bot.sendMessage(chatId, tr(chatId, `No equipment found matching "${query}".`, `រកមិនឃើញឧបករណ៍ "${query}" ទេ។`));
  }
  return bot.sendMessage(chatId, t(chatId, "didYouMean"), {
    reply_markup: suggestKeyboard(matches, action),
  });
}

// Download a Telegram photo by fileId into a Buffer (instead of to disk) so we can
// hand the bytes straight to Firebase Storage. Uses https.get (Node-version
// independent, no global-fetch assumption).
function downloadTelegramFileAsBuffer(fileId) {
  return new Promise((resolve, reject) => {
    bot.getFileLink(fileId).then((fileUrl) => {
      https.get(fileUrl, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Telegram file download failed (HTTP ${response.statusCode})`));
          response.resume();
          return;
        }
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
      }).on("error", reject);
    }).catch(reject);
  });
}

async function finishAddFlow(chatId, session, imagePath) {
  if (imagePath) {
    session.data.imagePath = imagePath;
  }

  const created = await equipmentService.createEquipment(session.data);
  clearSession(chatId);
  await bot.sendMessage(
    chatId,
    tr(chatId, "✅ Added equipment successfully!", "✅ បានបន្ថែមឧបករណ៍ថ្មីដោយជោគជ័យ!")
  );
  return sendView(chatId, created);
}

// Shared return-result rendering (used by both /return command and the button flow).
function sendReturnResult(chatId, result, qty, equipmentName, borrowerName, reporterName) {
  if (result.error === "not_found") return bot.sendMessage(chatId, tr(chatId, `No equipment found with name ${equipmentName}.`, `រកមិនឃើញឧបករណ៍ឈ្មោះ ${equipmentName} ទេ។`));
  if (result.error === "bad_quantity") return bot.sendMessage(chatId, tr(chatId, "Quantity must be a positive number.", "ចំនួនត្រូវតែជាលេខវិជ្ជមាន។"));
  if (result.error === "borrower_not_found") {
    return bot.sendMessage(chatId, tr(chatId, `No active loan found for ${borrowerName} on ${equipmentName}.`, `រកមិនឃើញការខ្ចីសកម្មរបស់ ${borrowerName} សម្រាប់ ${equipmentName} ទេ។`));
  }
  if (result.error === "too_many_borrower") {
    return bot.sendMessage(chatId, tr(chatId, `${borrowerName} only has ${result.borrowed} outstanding for ${equipmentName}.`, `${borrowerName} មាននៅសល់តែ ${result.borrowed} សម្រាប់ ${equipmentName} ប៉ុណ្ណោះ។`));
  }
  if (result.error === "too_many") {
    return bot.sendMessage(chatId, tr(chatId, `Only ${result.borrowed} total are currently borrowed for ${equipmentName}.`, `សរុបមានខ្ចី ${result.borrowed} ប៉ុណ្ណោះសម្រាប់ ${equipmentName}។`));
  }

  const borrowerSummary =
    Array.isArray(result.returnedByBorrower) && result.returnedByBorrower.length
      ? `\n${tr(chatId, "Returned from", "បានប្រគល់ពី")}: ` +
        result.returnedByBorrower.map((entry) => `${esc(entry.borrowerName)} (${entry.quantity})`).join(", ")
      : "";
  const inputBy = reporterName
    ? `\n${tr(chatId, "Input by", "បានបញ្ចូលដោយ")}: ${esc(reporterName)}`
    : "";

  return bot.sendMessage(
    chatId,
    `${tr(chatId, "Returned", "បានប្រគល់")} ${qty}x ${esc(result.item.equipmentName)}.${borrowerSummary}${inputBy}`,
    { parse_mode: "Markdown" }
  );
}

function getMainReplyKeyboard(chatId) {
  const isKm = lang(chatId) === "km";
  return {
    keyboard: [
      [
        { text: isKm ? "📥 ខ្ចីឧបករណ៍ (Borrow)" : "📥 Borrow Equipment" },
        { text: isKm ? "📤 ប្រគល់ឧបករណ៍ (Return)" : "📤 Return Equipment" },
      ],
      [
        { text: isKm ? "📦 ស្តុកឧបករណ៍ (Stock)" : "📦 View Stock" },
        { text: isKm ? "➕ បញ្ចូលឧបករណ៍ (Add)" : "➕ Add Equipment" },
      ],
      [
        { text: isKm ? "📊 របាយការណ៍ (Reports)" : "📊 Reports" },
        { text: isKm ? "✏️ កែប្រែប្រព័ន្ធ (Edit)" : "✏️ Edit System" },
      ],
    ],
    resize_keyboard: true,
  };
}

function sendEditMasterMenu(chatId) {
  const isKm = lang(chatId) === "km";
  const rows = [
    [
      {
        text: isKm ? "📦 កែប្រែ / លុប ឧបករណ៍ (Edit Equipment)" : "📦 Edit / Delete Equipment",
        callback_data: "edtm_equip",
      },
    ],
    [
      {
        text: isKm ? "👤 កែប្រែ / លុប អ្នកខ្ចី (Edit Borrower)" : "👤 Edit / Delete Borrower",
        callback_data: "edtm_bor",
      },
    ],
    [
      {
        text: isKm ? "📝 កែប្រែប្រវត្តិខ្ចី (Edit Loan Entry)" : "📝 Edit Loan Entry",
        callback_data: "edtm_loan",
      },
    ],
    [
      {
        text: isKm ? "➕ បន្ថែមស្តុកឧបករណ៍ (Add Stock + Log)" : "➕ Add Stock + History Log",
        callback_data: "edtm_stockin",
      },
    ],
    [
      {
        text: isKm ? "🗑️ លុបប្រវត្តិប្រតិបត្តិការ (Clear History Sheet)" : "🗑️ Clear Transaction History",
        callback_data: "edtm_clearhist",
      },
    ],
    [{ text: t(chatId, "cancel"), callback_data: "borm_cancel" }],
  ];

  return bot.sendMessage(
    chatId,
    tr(
      chatId,
      "✏️ *Master Edit Menu*\nWhat would you like to edit or manage?",
      "✏️ *ម៉ឺនុយកែប្រែប្រព័ន្ធ*\nតើអ្នកចង់កែប្រែ ឬគ្រប់គ្រងផ្នែកណា?"
    ),
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }
  );
}

// ---------- /start & /help ----------
bot.onText(/\/start/, (msg) => {
  if (!isAuthorized(msg)) return reject(msg);
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, t(chatId, "ready"), {
    reply_markup: getMainReplyKeyboard(chatId),
  });
});

bot.onText(/^\/language(?:@\w+)?(?:\s+(en|km))?$/i, (msg, match) => {
  if (!isAuthorized(msg)) return reject(msg);
  const chatId = msg.chat.id;
  const choice = (match[1] || "").toLowerCase();
  if (!choice) {
    return bot.sendMessage(chatId, t(chatId, "languagePrompt"));
  }
  if (choice !== "en" && choice !== "km") {
    return bot.sendMessage(chatId, t(chatId, "languagePrompt"));
  }
  return bot.sendMessage(chatId, setChatLanguage(chatId, choice));
});

bot.onText(/\/help/, (msg) => {
  if (!isAuthorized(msg)) return reject(msg);
  sendHelp(msg.chat.id);
});

function sendHelp(chatId) {
  const currentLang = lang(chatId);
  const helpLines = currentLang === "en"
    ? [
        "/stock — list all equipment (tap an item for details + actions)",
        "/view <name> — view one item's details + photo",
        "/add — step-by-step add new equipment",
        "/edit <name> <field> <value> — edit a field",
        "   fields: name, brand, model, serial, location, quantity, minstock, description",
        "/borrow — start guided borrow flow (single or multiple items)",
        "   or /borrow <name>",
        "   or batch: /borrow <borrower> | <item1> <qty1> | <item2> <qty2>",
        "/return — start guided return flow (pick items or borrower)",
        "   or /return all <borrower> (return ALL items for borrower)",
        "   or /return <name> <qty> [borrower]",
        "   or batch: /return <borrower> | <item1> <qty1> | <item2> <qty2>",
        "/delete <name> — delete an item (asks for confirmation)",
        "/report — download a report (Inventory / Borrowers / Stock)",
        "/borrower rename <equipment> | <old> | <new> — fix a borrower name in reports",
        "/borrower hide <equipment> | <borrower> — hide a borrower from reports",
        "/borrower delete <equipment> | <borrower> — delete a borrower's records (undoes a misinput borrow)",
        "/language — switch the bot language",
        "/cancel — cancel the current flow",
        "",
        "User management (admin only):",
        "/adduser <id> [name] — allow a new user to use the bot",
        "/removeuser <id> — remove a user's access",
        "/listusers — list admins + allowed users",
        "",
        "Tip: you can also tap the buttons under any item instead of typing commands.",
      ]
    : [
        "/stock — បង្ហាញឧបករណ៍ទាំងអស់ (ចុចឧបករណ៍មួយដើម្បីមើល + ប្រើប្រាស់)",
        "/view <name> — មើលព័ត៌មាន និងរូបភាពរបស់ឧបករណ៍មួយ",
        "/add — បញ្ចូលឧបករណ៍ថ្មីជាជំហានៗ",
        "/edit <name> <field> <value> — កែប្រែ field មួយ",
        "   fields: name, brand, model, serial, location, quantity, minstock, description",
        "/borrow — ចាប់ផ្ដើមខ្ចីឧបករណ៍ (មួយ ឬច្រើនមុខ)",
        "   ឬ /borrow <ឈ្មោះ>",
        "   ឬ batch: /borrow <អ្នកខ្ចី> | <ឧបករណ៍១> <ចំនួន១> | <ឧបករណ៍២> <ចំនួន២>",
        "/return — ចាប់ផ្ដើមប្រគល់ឧបករណ៍ (ជ្រើសឧបករណ៍ ឬអ្នកខ្ចី)",
        "   ឬ /return all <អ្នកខ្ចី> (ប្រគល់ឧបករណ៍ទាំងអស់របស់អ្នកខ្ចី)",
        "   ឬ /return <ឈ្មោះ> <ចំនួន> [អ្នកខ្ចី]",
        "   ឬ batch: /return <អ្នកខ្ចី> | <ឧបករណ៍១> <ចំនួន១> | <ឧបករណ៍២> <ចំនួន២>",
        "/delete <name> — លុបឧបករណ៍ (សូមបញ្ជាក់)",
        "/report — ទាញយករបាយការណ៍ (ស្តុក / អ្នកខ្ចី / ប្រវត្តិ)",
        "/borrower rename <ឧបករណ៍> | <ឈ្មោះចាស់> | <ឈ្មោះថ្មី> — កែឈ្មោះអ្នកខ្ចីក្នុងរបាយការណ៍",
        "/borrower hide <ឧបករណ៍> | <អ្នកខ្ចី> — លាក់អ្នកខ្ចីចេញពីរបាយការណ៍",
        "/borrower delete <ឧបករណ៍> | <អ្នកខ្ចី> — លុបកំណត់ត្រាខ្ចីរបស់អ្នកខ្ចី (លុបការខ្ចីខុស)",
        "/language — ប្ដូរភាសា bot",
        "/cancel — បោះបង់ flow បច្ចុប្បន្ន",
        "",
        "ការគ្រប់គ្រងអ្នកប្រើ (សម្រាប់ admin ប៉ុណ្ណោះ)៖",
        "/adduser <id> [ឈ្មោះ] — អនុញ្ញាតអ្នកប្រើថ្មីឲ្យប្រើ bot",
        "/removeuser <id> — លុបសិទ្ធិអ្នកប្រើ",
        "/listusers — បង្ហាញ admin និងអ្នកប្រើដែលបានអនុញ្ញាត",
        "",
        "ជំនួយ៖ អ្នកអាចចុចប៊ូតុងខាងក្រោមឧបករណ៍ ជំនួសការវាយបញ្ជា។",
      ];

  return bot.sendMessage(chatId, `*${t(chatId, "helpTitle")}*\n${helpLines.join("\n")}`, { parse_mode: "Markdown" });
}

bot.onText(/^\/borrower(?:@\w+)?\s+(rename|hide|delete)\s+(.+)$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return reject(msg);
  const chatId = msg.chat.id;
  const action = match[1].toLowerCase();
  const rawArgs = match[2].trim();

  try {
    if (action === "rename") {
      const parts = rawArgs.split("|").map((part) => part.trim()).filter(Boolean);
      if (parts.length !== 3) {
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            "Use: /borrower rename <equipment> | <old borrower> | <new borrower>",
            "ប្រើ៖ /borrower rename <ឧបករណ៍> | <ឈ្មោះចាស់> | <ឈ្មោះថ្មី>"
          )
        );
      }

      const [equipmentName, oldBorrowerName, newBorrowerName] = parts;
      const result = await equipmentService.renameBorrowerRecord(equipmentName, oldBorrowerName, newBorrowerName);
      if (result.error === "not_found") {
        return suggestOrWarn(chatId, equipmentName, "view");
      }

      return bot.sendMessage(
        chatId,
        tr(
          chatId,
          `Updated borrower name from ${oldBorrowerName} to ${newBorrowerName} for ${equipmentName}.`,
          `បានកែឈ្មោះអ្នកខ្ចីពី ${oldBorrowerName} ទៅ ${newBorrowerName} សម្រាប់ ${equipmentName}។`
        )
      );
    }

    if (action === "hide") {
      const parts = rawArgs.split("|").map((part) => part.trim()).filter(Boolean);
      if (parts.length !== 2) {
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            "Use: /borrower hide <equipment> | <borrower>",
            "ប្រើ៖ /borrower hide <ឧបករណ៍> | <អ្នកខ្ចី>"
          )
        );
      }

      const [equipmentName, borrowerName] = parts;
      const result = await equipmentService.hideBorrowerFromReports(equipmentName, borrowerName);
      if (result.error === "not_found") {
        return suggestOrWarn(chatId, equipmentName, "view");
      }

      return bot.sendMessage(
        chatId,
        tr(
          chatId,
          `Hidden ${borrowerName} from reports for ${equipmentName}.`,
          `បានលាក់ ${borrowerName} ចេញពីរបាយការណ៍សម្រាប់ ${equipmentName}។`
        )
      );
    }

    if (action === "delete") {
      const parts = rawArgs.split("|").map((part) => part.trim()).filter(Boolean);
      if (parts.length !== 2) {
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            "Use: /borrower delete <equipment> | <borrower>",
            "ប្រើ៖ /borrower delete <ឧបករណ៍> | <អ្នកខ្ចី>"
          )
        );
      }

      const [equipmentName, borrowerName] = parts;
      const result = await equipmentService.deleteBorrowerRecord(equipmentName, borrowerName);
      if (result.error === "not_found") {
        return suggestOrWarn(chatId, equipmentName, "view");
      }
      if (result.error === "borrower_not_found") {
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            `No borrow record found for ${borrowerName} on ${equipmentName}.`,
            `រកមិនឃើញកំណត់ត្រាខ្ចីសម្រាប់ ${borrowerName} លើ ${equipmentName} ទេ។`
          )
        );
      }

      return bot.sendMessage(
        chatId,
        tr(
          chatId,
          `Deleted ${borrowerName}'s borrow records for ${equipmentName} (returned ${result.released} units to stock).`,
          `បានលុបកំណត់ត្រាខ្ចីរបស់ ${borrowerName} សម្រាប់ ${equipmentName} (បានបន្ថែម ${result.released} គ្រឿងទៅស្តុកវិញ)។`
        )
      );
    }
  } catch (err) {
    bot.sendMessage(chatId, `${t(chatId, "error")}: ${err.message}`);
  }
});

bot.onText(/\/cancel/, (msg) => {
  clearSession(msg.chat.id);
  bot.sendMessage(msg.chat.id, t(msg.chat.id, "cancelled"));
});

// ---------- User management (admin only) ----------
// Admins are the bootstrap IDs in ALLOWED_TELEGRAM_IDS. Added users live in the
// Firestore botUsers collection so they can be granted access without a redeploy.
function adminOnly(msg) {
  return authStore.isAdmin(msg.from.id);
}

bot.onText(/^\/adduser(?:@\w+)?\s+(\d+)(?:\s+(.+))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return reject(msg);
  if (!adminOnly(msg)) {
    return bot.sendMessage(msg.chat.id, tr(msg.chat.id, "Admins only.", "សម្រាប់ admin ប៉ុណ្ណោះ។"));
  }
  const chatId = msg.chat.id;
  const id = match[1];
  const name = (match[2] || "").trim();
  try {
    const result = await authStore.addUser(id, name, msg.from.id);
    if (result.error === "bad_id") {
      return bot.sendMessage(chatId, tr(chatId, "Use: /adduser <telegram id> [name]", "ប្រើ៖ /adduser <telegram id> [ឈ្មោះ]"));
    }
    if (result.error === "is_admin") {
      return bot.sendMessage(chatId, tr(chatId, `${id} is already an admin.`, `${id} គឺជា admin រួចហើយ។`));
    }
    if (result.error === "already_exists") {
      return bot.sendMessage(chatId, tr(chatId, `${id} is already allowed.`, `${id} បានអនុញ្ញាតរួចហើយ។`));
    }
    return bot.sendMessage(
      chatId,
      tr(
        chatId,
        `✅ Added user ${id}${name ? ` (${name})` : ""}. They can use the bot now.`,
        `✅ បានបន្ថែមអ្នកប្រើ ${id}${name ? ` (${name})` : ""}។ គេអាចប្រើ bot បានហើយ។`
      )
    );
  } catch (err) {
    bot.sendMessage(chatId, `${t(chatId, "error")}: ${err.message}`);
  }
});

bot.onText(/^\/removeuser(?:@\w+)?\s+(\d+)$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return reject(msg);
  if (!adminOnly(msg)) {
    return bot.sendMessage(msg.chat.id, tr(msg.chat.id, "Admins only.", "សម្រាប់ admin ប៉ុណ្ណោះ។"));
  }
  const chatId = msg.chat.id;
  const id = match[1];
  try {
    const result = await authStore.removeUser(id);
    if (result.error === "is_admin") {
      return bot.sendMessage(chatId, tr(chatId, `${id} is an admin and can't be removed.`, `${id} គឺជា admin មិនអាចលប់បានទេ។`));
    }
    if (result.error === "not_found") {
      return bot.sendMessage(chatId, tr(chatId, `${id} is not in the allowlist.`, `${id} មិនមានក្នុងបញ្ជីអនុញ្ញាតទេ។`));
    }
    return bot.sendMessage(chatId, tr(chatId, `Removed user ${id}.`, `បានលុបអ្នកប្រើ ${id} រួចហើយ។`));
  } catch (err) {
    bot.sendMessage(chatId, `${t(chatId, "error")}: ${err.message}`);
  }
});

bot.onText(/^\/listusers(?:@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return reject(msg);
  if (!adminOnly(msg)) {
    return bot.sendMessage(msg.chat.id, tr(msg.chat.id, "Admins only.", "សម្រាប់ admin ប៉ុណ្ណោះ។"));
  }
  const chatId = msg.chat.id;
  try {
    const users = await authStore.listUsers();
    const adminLines = authStore.ADMIN_IDS.map((id) => `• ${id} (admin)`);
    const userLines = users.length
      ? users.map((u) => `• ${u.id}${u.name ? ` — ${u.name}` : ""}`)
      : [tr(chatId, "(no added users yet)", "(មិនទាន់មានអ្នកប្រើទេ)")];
    const body =
      tr(chatId, "Admins:", "Admin៖") + "\n" + adminLines.join("\n") +
      "\n\n" + tr(chatId, "Allowed users:", "អ្នកប្រើដែលបានអនុញ្ញាត៖") + "\n" + userLines.join("\n");
    return bot.sendMessage(chatId, body);
  } catch (err) {
    bot.sendMessage(chatId, `${t(chatId, "error")}: ${err.message}`);
  }
});

// ---------- /stock — paginated tappable list ----------
bot.onText(/^\/stock(?:@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return reject(msg);
  const chatId = msg.chat.id;
  try {
    const items = await equipmentService.getAll();
    if (items.length === 0) {
      return bot.sendMessage(chatId, t(chatId, "noEquipment"));
    }
    await bot.sendMessage(chatId, `${t(chatId, "pickItem")} (${items.length})`, {
      reply_markup: stockKeyboard(chatId, items, 0),
    });
  } catch (err) {
    bot.sendMessage(chatId, `${t(chatId, "error")}: ${err.message}`);
  }
});

// ---------- /view <name> ----------
bot.onText(/^\/view\s+(.+)$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return reject(msg);
  const chatId = msg.chat.id;
  const equipmentName = match[1].trim();
  try {
    const item = await equipmentService.findByName(equipmentName);
    if (!item) return suggestOrWarn(chatId, equipmentName, "view");
    await sendView(chatId, item);
  } catch (err) {
    bot.sendMessage(chatId, `${t(chatId, "error")}: ${err.message}`);
  }
});

// ---------- Batch input parsers & multi-item helpers ----------
function parseBatchBorrowInput(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;

  if (text.includes("|")) {
    const parts = text.split("|").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const borrowerName = parts[0];
      const items = [];
      for (let i = 1; i < parts.length; i++) {
        const itemPart = parts[i];
        const match = itemPart.match(/^(.+?)[,\s:]+(\d+)$/);
        if (match) {
          items.push({ equipmentName: match[1].trim(), qty: Number(match[2]) });
        }
      }
      if (items.length > 0) {
        return { borrowerName, items };
      }
    }
  }

  if (text.includes(":")) {
    const [borrowerPart, itemsPart] = text.split(":").map((p) => p.trim());
    if (borrowerPart && itemsPart) {
      const itemEntries = itemsPart.split(",").map((p) => p.trim()).filter(Boolean);
      const items = [];
      for (const entry of itemEntries) {
        const match = entry.match(/^(.+?)[,\s:]+(\d+)$/);
        if (match) {
          items.push({ equipmentName: match[1].trim(), qty: Number(match[2]) });
        }
      }
      if (items.length > 0) {
        return { borrowerName: borrowerPart, items };
      }
    }
  }

  return null;
}

function parseBatchReturnInput(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;

  if (text.includes("|")) {
    const parts = text.split("|").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const borrowerName = parts[0];
      const items = [];
      for (let i = 1; i < parts.length; i++) {
        const itemPart = parts[i];
        const match = itemPart.match(/^(.+?)[,\s:]+(\d+)$/);
        if (match) {
          items.push({ equipmentName: match[1].trim(), qty: Number(match[2]) });
        }
      }
      if (items.length > 0) {
        return { borrowerName, items };
      }
    }
  }

  return null;
}

function renderBorrowCart(chatId, sessionData) {
  const { borrowerName, items = [], reporter } = sessionData;
  const itemsText = items
    .map((it, idx) => `${idx + 1}. *${esc(it.equipmentName)}* — ${it.qty}x`)
    .join("\n");
  const inputByLine = reporter && reporter.name
    ? `\n${tr(chatId, "Input by", "បានបញ្ចូលដោយ")}: ${esc(reporter.name)}`
    : "";

  const text = tr(
    chatId,
    `📋 *Borrow Cart for ${esc(borrowerName)}:*\n${itemsText || tr(chatId, "(No items added yet)", "(មិនទាន់មានឧបករណ៍)")}${inputByLine}\n\nWhat would you like to do next?`,
    `📋 *បញ្ជីខ្ចីសម្រាប់ ${esc(borrowerName)}៖*\n${itemsText || tr(chatId, "(មិនទាន់មានឧបករណ៍)", "(មិនទាន់មានឧបករណ៍)")}${inputByLine}\n\nតើអ្នកចង់ធ្វើអ្វីបន្ទាប់?`
  );

  const rows = [];
  rows.push([{ text: tr(chatId, "➕ Add another item", "➕ បន្ថែមឧបករណ៍មួយទៀត"), callback_data: "borm_add" }]);
  if (items.length > 0) {
    rows.push([{ text: tr(chatId, "✅ Finish & Confirm Borrow", "✅ បញ្ចប់ និងខ្ចី"), callback_data: "borm_fin" }]);
  }
  rows.push([{ text: t(chatId, "cancel"), callback_data: "borm_cancel" }]);

  return { text, reply_markup: { inline_keyboard: rows } };
}

function renderReturnCart(chatId, sessionData) {
  const { borrowerName, items = [], reporter } = sessionData;
  const borrowerTitle = borrowerName ? esc(borrowerName) : tr(chatId, "Any borrower", "អ្នកខ្ចីណាក៏បាន");
  const itemsText = items
    .map((it, idx) => `${idx + 1}. *${esc(it.equipmentName)}* — ${it.qty}x`)
    .join("\n");
  const inputByLine = reporter && reporter.name
    ? `\n${tr(chatId, "Input by", "បានបញ្ចូលដោយ")}: ${esc(reporter.name)}`
    : "";

  const text = tr(
    chatId,
    `📋 *Return Cart (${borrowerTitle}):*\n${itemsText || tr(chatId, "(No items added yet)", "(មិនទាន់មានឧបករណ៍)")}${inputByLine}\n\nWhat would you like to do next?`,
    `📋 *បញ្ជីប្រគល់ (${borrowerTitle})៖*\n${itemsText || tr(chatId, "(មិនទាន់មានឧបករណ៍)", "(មិនទាន់មានឧបករណ៍)")}${inputByLine}\n\nតើអ្នកចង់ធ្វើអ្វីបន្ទាប់?`
  );

  const rows = [];
  rows.push([{ text: tr(chatId, "➕ Add another item", "➕ បន្ថែមឧបករណ៍មួយទៀត"), callback_data: "retm_add" }]);
  if (items.length > 0) {
    rows.push([{ text: tr(chatId, "✅ Finish & Confirm Return", "✅ បញ្ចប់ និងប្រគល់"), callback_data: "retm_fin" }]);
  }
  rows.push([{ text: t(chatId, "cancel"), callback_data: "retm_cancel" }]);

  return { text, reply_markup: { inline_keyboard: rows } };
}

function sendMultiBorrowResult(chatId, result, reporterName) {
  if (result.error === "bad_borrower") {
    return bot.sendMessage(chatId, tr(chatId, "Borrower name is required.", "ត្រូវបញ្ចូលឈ្មោះអ្នកខ្ចី។"));
  }
  if (result.error === "validation_failed") {
    const errorLines = result.errors.map((e) => {
      if (e.error === "not_found") return `• ${e.item}: ${tr(chatId, "Item not found", "រកមិនឃើញឧបករណ៍")}`;
      if (e.error === "insufficient") return `• ${e.item}: ${tr(chatId, `Only ${e.available} available (requested ${e.requested})`, `មានសល់តែ ${e.available} (ស្នើ ${e.requested})`)}`;
      if (e.error === "bad_quantity") return `• ${e.item}: ${tr(chatId, "Invalid quantity", "ចំនួនមិនត្រឹមត្រូវ")}`;
      return `• ${e.item}: ${e.error}`;
    });
    return bot.sendMessage(
      chatId,
      `⚠️ *${tr(chatId, "Could not process borrow:", "មិនអាចដំណើរការការខ្ចី៖")}*\n${errorLines.join("\n")}`,
      { parse_mode: "Markdown" }
    );
  }

  const borrower = esc(result.borrowerName);
  const itemsText = result.results
    .map((res) => `• *${esc(res.item.equipmentName)}* (${res.item.borrowedQuantity} total borrowed)`)
    .join("\n");
  const inputByLine = reporterName
    ? `\n${tr(chatId, "Input by", "បានបញ្ចូលដោយ")}: ${esc(reporterName)}`
    : "";

  return bot.sendMessage(
    chatId,
    `✅ *${tr(chatId, `Successfully borrowed for ${borrower}:`, `បានខ្ចីជោគជ័យសម្រាប់ ${borrower}៖`)}*\n${itemsText}${inputByLine}`,
    { parse_mode: "Markdown" }
  );
}

function sendMultiReturnResult(chatId, result, reporterName) {
  if (result.error === "no_loans_found") {
    return bot.sendMessage(chatId, tr(chatId, `No active loans found for ${result.borrowerName}.`, `រកមិនឃើញការខ្ចីសកម្មសម្រាប់ ${result.borrowerName} ទេ។`));
  }
  if (result.error === "validation_failed") {
    const errorLines = result.errors.map((e) => {
      if (e.error === "not_found") return `• ${e.item}: ${tr(chatId, "Item not found", "រកមិនឃើញឧបករណ៍")}`;
      if (e.error === "borrower_not_found") return `• ${e.item}: ${tr(chatId, `No active loan for ${e.borrowerName}`, `មិនមានការខ្ចីសកម្មសម្រាប់ ${e.borrowerName}`)}`;
      if (e.error === "too_many_borrower") return `• ${e.item}: ${tr(chatId, `Only ${e.borrowed} outstanding for ${e.borrowerName}`, `មាននៅសល់តែ ${e.borrowed} សម្រាប់ ${e.borrowerName}`)}`;
      if (e.error === "too_many") return `• ${e.item}: ${tr(chatId, `Only ${e.borrowed} total borrowed`, `សរុបមានខ្ចីតែ ${e.borrowed}`)}`;
      return `• ${e.item}: ${e.error}`;
    });
    return bot.sendMessage(
      chatId,
      `⚠️ *${tr(chatId, "Could not process return:", "មិនអាចដំណើរការការប្រគល់៖")}*\n${errorLines.join("\n")}`,
      { parse_mode: "Markdown" }
    );
  }

  const borrowerText = result.borrowerName ? ` ${tr(chatId, "from", "ពី")} *${esc(result.borrowerName)}*` : "";
  const itemsText = result.results
    .map((res) => `• *${esc(res.item.equipmentName)}*`)
    .join("\n");
  const inputByLine = reporterName
    ? `\n${tr(chatId, "Input by", "បានបញ្ចូលដោយ")}: ${esc(reporterName)}`
    : "";

  return bot.sendMessage(
    chatId,
    `✅ *${tr(chatId, "Successfully returned items", "បានប្រគល់ឧបករណ៍ជោគជ័យ")}${borrowerText}:*\n${itemsText}${inputByLine}`,
    { parse_mode: "Markdown" }
  );
}

async function sendEquipmentPicker(chatId, prefix, page = 0, filterActiveOnly = false, messageIdToEdit = null) {
  let items = await equipmentService.getAll();
  if (filterActiveOnly) {
    items = items.filter((it) => it.availableQuantity > 0);
  }

  if (items.length === 0) {
    const text = tr(chatId, "No equipment available.", "មិនមានឧបករណ៍ដែលសល់ទេ។");
    if (messageIdToEdit) {
      try {
        return await bot.editMessageText(text, { chat_id: chatId, message_id: messageIdToEdit });
      } catch (_) {}
    }
    return bot.sendMessage(chatId, text);
  }

  const pageLimit = 8;
  const totalPages = Math.max(1, Math.ceil(items.length / pageLimit));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const slice = items.slice(p * pageLimit, (p + 1) * pageLimit);

  const rows = slice.map((it) => [
    {
      text: formatEquipmentLabel(it),
      callback_data: `${prefix}:${it.id}`,
    },
  ]);

  const nav = [];
  if (p > 0) nav.push({ text: t(chatId, "prev"), callback_data: `${prefix}_pg:${p - 1}` });
  nav.push({ text: `${p + 1}/${totalPages}`, callback_data: "noop" });
  if (p < totalPages - 1) nav.push({ text: t(chatId, "next"), callback_data: `${prefix}_pg:${p + 1}` });
  rows.push(nav);
  rows.push([{ text: t(chatId, "cancel"), callback_data: `${prefix}_cancel` }]);

  const text = tr(chatId, "Select an equipment item:", "ជ្រើសរើសឧបករណ៍៖");
  if (messageIdToEdit) {
    try {
      return await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageIdToEdit,
        reply_markup: { inline_keyboard: rows },
      });
    } catch (_) {}
  }

  return bot.sendMessage(
    chatId,
    text,
    { reply_markup: { inline_keyboard: rows } }
  );
}

// ---------- /borrow command (supports single, batch, or multi-guided) ----------
bot.onText(/^\/borrow(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return reject(msg);
  const chatId = msg.chat.id;
  const rawArg = match[1] ? match[1].trim() : "";
  const reporter = await resolveReporter(msg.from);

  // 1. Direct batch command: /borrow John | Helmet 2 | Glove 5
  if (rawArg) {
    const batch = parseBatchBorrowInput(rawArg);
    if (batch) {
      const result = await equipmentService.borrowMultiple(batch.items, batch.borrowerName, reporter);
      return sendMultiBorrowResult(chatId, result, reporter.name);
    }
  }

  // 2. No argument: Start multi-borrow guided flow
  if (!rawArg) {
    setSession(chatId, {
      flow: "borrow_multi",
      step: "borrower",
      data: { borrowerName: "", items: [], reporter },
    });
    return askBorrower(chatId, null);
  }

  // 3. Single item argument: /borrow <name>
  const item = await equipmentService.findByName(rawArg);
  if (item) {
    setSession(chatId, {
      flow: "borrow_multi",
      step: "borrower",
      data: { borrowerName: "", items: [], currentItem: item, reporter },
    });
    return askBorrower(chatId, item);
  }

  // 4. Officer search argument: /borrow <officer_name_or_id>
  const matchedOfficers = await officerService.searchOfficers(rawArg);
  if (matchedOfficers.length > 0) {
    const rows = matchedOfficers.map((off) => [
      {
        text: off.group ? `[ក្រុមទី ${off.group}] 👤 ${off.name}` : `👤 ${off.name}`,
        callback_data: `bor_select_idx:${off.index}`,
      },
    ]);
    rows.push([{ text: t(chatId, "cancel"), callback_data: "borm_cancel" }]);
    return bot.sendMessage(
      chatId,
      tr(
        chatId,
        `Matching officer(s) for "${esc(rawArg)}":\nTap a name to select borrower:`,
        `មន្ត្រីដែលត្រូវគ្នានឹង "${esc(rawArg)}"៖\nចុចលើឈ្មោះដើម្បីជ្រើសរើសអ្នកខ្ចី៖`
      ),
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }
    );
  }

  return suggestOrWarn(chatId, rawArg, "bor");
});

// ---------- /return command (supports single, all, batch, or multi-guided) ----------
bot.onText(/^\/return(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return reject(msg);
  const chatId = msg.chat.id;
  const rawArg = match[1] ? match[1].trim() : "";
  const reporter = await resolveReporter(msg.from);

  // 1. Return all for borrower: /return all John
  if (/^all\s+(.+)$/i.test(rawArg)) {
    const borrowerName = rawArg.replace(/^all\s+/i, "").trim();
    const result = await equipmentService.returnAllByBorrower(borrowerName, reporter);
    return sendMultiReturnResult(chatId, result, reporter.name);
  }

  // 2. Batch return command: /return John | Helmet 2 | Glove 5
  if (rawArg) {
    const batch = parseBatchReturnInput(rawArg);
    if (batch) {
      const result = await equipmentService.returnMultiple(batch.items, batch.borrowerName, reporter);
      return sendMultiReturnResult(chatId, result, reporter.name);
    }
  }

  // 3. Single item return command: /return <name> <qty> [borrower]
  if (rawArg) {
    const parts = rawArg.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      let parsed = null;
      for (let prefixLength = parts.length - 1; prefixLength >= 1; prefixLength--) {
        const equipmentName = parts.slice(0, prefixLength).join(" ").trim();
        const qty = parts[prefixLength];
        if (!/^\d+$/.test(qty)) continue;

        const item = await equipmentService.findByName(equipmentName);
        if (item) {
          parsed = {
            equipmentName,
            qty,
            borrowerName: parts.slice(prefixLength + 1).join(" ").trim(),
          };
          break;
        }
      }

      if (parsed) {
        const { equipmentName, qty, borrowerName } = parsed;
        const result = await equipmentService.returnItem(equipmentName, qty, borrowerName, reporter);
        return sendReturnResult(chatId, result, qty, equipmentName, borrowerName, result.reportedBy);
      }
    }
  }

  // 4. Guided multi-return flow: /return (no args or single item name without qty)
  const activeBorrowers = await equipmentService.getAllActiveBorrowers();
  if (activeBorrowers.length === 0) {
    return bot.sendMessage(chatId, tr(chatId, "No active loans found across all equipment.", "មិនមានការខ្ចីសកម្មនៅលើឧបករណ៍ទាំងអស់ទេ។"));
  }

  setSession(chatId, {
    flow: "return_multi",
    step: "select_borrower",
    data: { borrowerName: "", items: [], reporter },
  });

  const rows = activeBorrowers.map((b) => [
    {
      text: `👤 ${b.borrowerName} (${b.itemCount} items, ${b.totalQuantity} units)`,
      callback_data: `retm_borrower:${setBorrowerKey(b.borrowerName)}`,
    },
  ]);
  rows.push([{ text: tr(chatId, "📦 Return items by picking equipment", "📦 ប្រគល់ដោយជ្រើសរើសឧបករណ៍"), callback_data: "retm_any_borrower" }]);
  rows.push([{ text: t(chatId, "cancel"), callback_data: "retm_cancel" }]);

  return bot.sendMessage(
    chatId,
    tr(chatId, "Who is returning equipment?", "តើអ្នកណាប្រគល់ឧបករណ៍?"),
    { reply_markup: { inline_keyboard: rows } }
  );
});

// ---------- /edit <name> <field> <value...> ----------
bot.onText(/^\/edit\s+(.+)\s+(name|brand|model|serial|location|quantity|minstock|description)\s+(.+)$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return reject(msg);
  const chatId = msg.chat.id;
  const [, equipmentName, field, value] = match;

  const result = await equipmentService.editField(equipmentName.trim(), field, value);

  if (result.error === "not_found") return suggestOrWarn(chatId, equipmentName.trim(), "edt");
  if (result.error === "bad_field") {
    return bot.sendMessage(chatId, tr(chatId, `Invalid field. Valid fields: ${result.validFields.join(", ")}`, `Field មិនត្រឹមត្រូវ។ field ដែលអនុញ្ញាត៖ ${result.validFields.join(", ")}`));
  }

  bot.sendMessage(chatId, `${tr(chatId, "Updated.", "បានកែប្រែរួច។")}`, { parse_mode: "Markdown" });
  sendView(chatId, result.item);
});

// ---------- /edit ----------
bot.onText(/^\/edit(?:@\w+)?$/i, (msg) => {
  if (!isAuthorized(msg)) return reject(msg);
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, tr(chatId, "Opening Edit Menu...", "កំពុងបើកម៉ឺនុយកែប្រែ..."), {
    reply_markup: getMainReplyKeyboard(chatId),
  });
  return sendEditMasterMenu(chatId);
});

// ---------- /delete <name> ----------
bot.onText(/^\/delete\s+(.+)\s+confirm$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return reject(msg);
  const chatId = msg.chat.id;
  const equipmentName = match[1].trim();

  const result = await equipmentService.deleteEquipmentByName(equipmentName);
  if (result.error === "not_found") return suggestOrWarn(chatId, equipmentName, "del");

  bot.sendMessage(chatId, tr(chatId, `Deleted ${result.item.equipmentName}.`, `បានលុប ${result.item.equipmentName} រួចហើយ។`));
});

bot.onText(/^\/delete\s+(.+)$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return reject(msg);
  const chatId = msg.chat.id;
  const equipmentName = match[1].trim();
  const item = await equipmentService.findByName(equipmentName);
  if (!item) return suggestOrWarn(chatId, equipmentName, "del");

  return bot.sendMessage(chatId, `${t(chatId, "confirmDelete")}\n*${esc(item.equipmentName)}*`, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: t(chatId, "confirm"), callback_data: `delok:${item.id}` },
          { text: t(chatId, "cancel"), callback_data: "delno" },
        ],
      ],
    },
  });
});

// ---------- /report — generate and send the single Master Report ----------
async function sendReport(chatId) {
  try {
    await bot.sendMessage(
      chatId,
      tr(
        chatId,
        "📊 Generating Master Equipment Report (Excel)...",
        "📊 កំពុងរៀបចំរបាយការណ៍សរុបប្រព័ន្ធគ្រប់គ្រងឧបករណ៍ OSH (Excel)..."
      )
    );
    const filePath = await generateMasterReport();
    const dateStr = new Date().toLocaleString();
    await bot.sendDocument(chatId, filePath, {
      caption: tr(
        chatId,
        `📊 OSH Master Equipment Report — ${dateStr}`,
        `📊 របាយការណ៍សរុបប្រព័ន្ធគ្រប់គ្រងឧបករណ៍ OSH — ${dateStr}`
      ),
    });
    fs.unlink(filePath, () => {});
  } catch (err) {
    console.error("[TelegramBot] /report error:", err);
    bot.sendMessage(
      chatId,
      tr(chatId, `Failed to generate report: ${err.message}`, `បង្កើតរបាយការណ៍មិនបាន៖ ${err.message}`)
    );
  }
}

async function sendReportMenu(chatId) {
  return sendReport(chatId);
}

bot.onText(/^\/report(?:@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return reject(msg);
  await sendReport(msg.chat.id);
});

// ---------- /add ----------
bot.onText(/^\/add$/, (msg) => {
  if (!isAuthorized(msg)) return reject(msg);
  setSession(msg.chat.id, { flow: "add", step: "name", data: {} });
  bot.sendMessage(
    msg.chat.id,
    tr(
      msg.chat.id,
      "Adding new equipment. Please enter Khmer Name:",
      "សូមបញ្ចូលឈ្មោះ (ភាសាខ្មែរ)៖"
    )
  );
});

bot.onText(/^\/skip(?:@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return reject(msg);

  const chatId = msg.chat.id;
  const session = getSession(chatId);
  if (!session || session.flow !== "add") return;

  if (session.step === "nameEnglish") {
    session.step = "model";
    setSession(chatId, session);
    return bot.sendMessage(
      chatId,
      tr(
        chatId,
        "Please enter the Model number/name (or type /skip to skip):",
        "សូមបញ្ចូលម៉ូឌែល/ជំនាន់ (Model) [ឬវាយ /skip ដើម្បីរំលង]៖"
      )
    );
  }

  if (session.step === "model") {
    session.step = "quantity";
    setSession(chatId, session);
    return bot.sendMessage(
      chatId,
      tr(
        chatId,
        "Please enter the total quantity (number):",
        "សូមបញ្ចូលចំនួនសរុបនៃឧបករណ៍ (ជាលេខ)៖"
      )
    );
  }

  if (session.step === "photo") {
    try {
      await finishAddFlow(chatId, session, null);
    } catch (err) {
      console.error("[TelegramBot] /skip error:", err);
      clearSession(chatId);
      bot.sendMessage(chatId, tr(chatId, `Something went wrong: ${err.message}. Flow cancelled, try /add again.`, `មានបញ្ហាមួយ៖ ${err.message}។ បានបោះបង់ flow ហើយ សូមសាកល្បង /add ម្ដងទៀត។`));
    }
  }
});

// ---------- Flow prompts (used by button-driven flows) ----------
async function sendOfficerPicker(chatId, prefix = "boroffpg", page = 0, item = null) {
  const officers = await officerService.loadOfficers();
  if (officers.length === 0) {
    return {
      title: tr(chatId, "No officers found in directory.", "មិនមានទិន្នន័យមន្ត្រីក្នុងបញ្ជីទេ។"),
      reply_markup: { inline_keyboard: [[{ text: t(chatId, "cancel"), callback_data: "borm_cancel" }]] },
    };
  }

  const pageLimit = 6;
  const totalPages = Math.max(1, Math.ceil(officers.length / pageLimit));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const slice = officers.slice(p * pageLimit, (p + 1) * pageLimit);

  const rows = slice.map((off) => [
    {
      text: off.group ? `[ក្រុមទី ${off.group}] 👤 ${off.name}` : `👤 ${off.name}`,
      callback_data: `bor_select_idx:${off.index}`,
    },
  ]);

  const nav = [];
  if (p > 0) nav.push({ text: t(chatId, "prev"), callback_data: `${prefix}:${p - 1}` });
  nav.push({ text: `${p + 1}/${totalPages}`, callback_data: "noop" });
  if (p < totalPages - 1) nav.push({ text: t(chatId, "next"), callback_data: `${prefix}:${p + 1}` });
  rows.push(nav);
  rows.push([{ text: t(chatId, "cancel"), callback_data: "borm_cancel" }]);

  const itemName = item ? esc(item.equipmentName) : "";
  const title = itemName
    ? tr(chatId, `Select borrower for *${itemName}* (${p + 1}/${totalPages}):`, `ជ្រើសរើសអ្នកខ្ចីសម្រាប់ *${itemName}* (ទំព័រ ${p + 1}/${totalPages})៖`)
    : tr(chatId, `Select borrower (${p + 1}/${totalPages}):`, `ជ្រើសរើសអ្នកខ្ចី (ទំព័រ ${p + 1}/${totalPages})៖`);

  return { title, reply_markup: { inline_keyboard: rows } };
}

async function sendGroupSelector(chatId, item = null) {
  const officers = await officerService.loadOfficers();
  if (officers.length === 0) {
    return bot.sendMessage(
      chatId,
      tr(chatId, "No officers found in directory.", "មិនមានទិន្នន័យមន្ត្រីក្នុងបញ្ជីទេ។"),
      { reply_markup: { inline_keyboard: [[{ text: t(chatId, "cancel"), callback_data: "borm_cancel" }]] } }
    );
  }

  const groups = Array.from(
    new Set(officers.map((o) => o.group).filter(Boolean))
  ).sort((a, b) => (parseInt(a, 10) || 999) - (parseInt(b, 10) || 999));

  const rows = [];
  for (let i = 0; i < groups.length; i += 4) {
    const chunk = groups.slice(i, i + 4);
    rows.push(
      chunk.map((g) => ({
        text: `ក្រុមទី ${g}`,
        callback_data: `borgrp:${g}`,
      }))
    );
  }

  rows.push([
    {
      text: tr(chatId, `📋 Show All Officers (${officers.length})`, `📋 បង្ហាញមន្ត្រីទាំងអស់ (${officers.length} នាក់)`),
      callback_data: "borgrp:all",
    },
  ]);
  rows.push([{ text: t(chatId, "cancel"), callback_data: "borm_cancel" }]);

  const itemName = item ? esc(item.equipmentName) : "";
  const title = itemName
    ? tr(
        chatId,
        `Select Group or type a name to search borrower for *${itemName}*:`,
        `សូមជ្រើសរើសក្រុម ឬវាយឈ្មោះស្វែងរកអ្នកខ្ចីសម្រាប់ *${itemName}*៖`
      )
    : tr(
        chatId,
        `Select Group or type a name to search borrower:`,
        `សូមជ្រើសរើសក្រុម ឬវាយឈ្មោះស្វែងរកអ្នកខ្ចី៖`
      );

  return bot.sendMessage(chatId, title, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows },
  });
}

async function askBorrower(chatId, item) {
  return sendGroupSelector(chatId, item);
}

// Commits the borrow after the user confirms on the review step. Centralised so the
// confirm callback and any future entry point share the same error handling.
async function runBorrow(chatId) {
  const session = getSession(chatId);
  if (!session || session.flow !== "borrow") return;

  const { equipmentName, borrowerName, qty, reporter } = session.data;
  const result = await equipmentService.borrow(equipmentName, qty, borrowerName, reporter);

  if (result.error === "not_found") {
    clearSession(chatId);
    return bot.sendMessage(chatId, tr(chatId, `No equipment found with name ${equipmentName}.`, `រកមិនឃើញឧបករណ៍ឈ្មោះ ${equipmentName} ទេ។`));
  }
  if (result.error === "bad_quantity") {
    session.step = "quantity";
    setSession(chatId, session);
    return bot.sendMessage(chatId, tr(chatId, "Quantity must be a positive number. Try again:", "ចំនួនត្រូវតែជាលេខវិជ្ជមាន។ សូមបញ្ចូលម្ដងទៀត៖"));
  }
  if (result.error === "bad_borrower") {
    clearSession(chatId);
    return bot.sendMessage(chatId, tr(chatId, "Borrower name is required.", "ត្រូវបញ្ចូលឈ្មោះអ្នកខ្ចី។"));
  }
  if (result.error === "insufficient") {
    // Availability changed between the quantity step and confirmation — let them retry.
    session.step = "quantity";
    setSession(chatId, session);
    return bot.sendMessage(
      chatId,
      tr(chatId, `Only ${result.available} available — can't borrow ${qty}. Send a new quantity:`, `មានសល់តែ ${result.available} ប៉ុណ្ណោះ មិនអាចខ្ចី ${qty} បាន។ សូមបញ្ចូលចំនួនថ្មី៖`)
    );
  }

  clearSession(chatId);
  const inputBy = result.reportedBy
    ? `\n${tr(chatId, "Input by", "បានបញ្ចូលដោយ")}: ${esc(result.reportedBy)}`
    : "";
  await bot.sendMessage(
    chatId,
    `${tr(chatId, `Borrowed ${qty}x ${result.item.equipmentName} for ${borrowerName}.`, `បានខ្ចី ${qty}x ${result.item.equipmentName} សម្រាប់ ${borrowerName}។`)}${inputBy}`,
    { parse_mode: "Markdown" }
  );
  return sendView(chatId, result.item);
}

const EDIT_FIELDS = [
  { key: "name_km", labelEn: "Khmer Name", labelKm: "ឈ្មោះ (ភាសាខ្មែរ)" },
  { key: "name_en", labelEn: "English Name", labelKm: "ឈ្មោះ (ភាសាអង់គ្លេស)" },
  { key: "model", labelEn: "Model", labelKm: "ម៉ូឌែល / ជំនាន់" },
  { key: "quantity", labelEn: "Total Quantity", labelKm: "បរិមាណសរុប (ស្តុក)" },
];

function editFieldKeyboard(chatId, item) {
  const rows = EDIT_FIELDS.map((f) => [
    { text: lang(chatId) === "km" ? f.labelKm : f.labelEn, callback_data: `edtf:${item.id}:${f.key}` },
  ]);
  rows.push([{ text: t(chatId, "cancel"), callback_data: "delno" }]);
  return { inline_keyboard: rows };
}

// ---------- Callback query router (inline button taps) ----------
bot.on("callback_query", async (query) => {
  const fromId = query.from.id;
  const chatId = query.message ? query.message.chat.id : fromId;
  const data = query.data || "";

  // Always acknowledge so the loading spinner clears.
  bot.answerCallbackQuery(query.id).catch(() => {});

  if (!userAuthorized(query.from)) {
    return bot.sendMessage(chatId, `${TEXT.en.unauthorized}\n${TEXT.en.unauthorizedHint}`);
  }

  const [action, ...rest] = data.split(":");
  const id = rest[0];

  try {
    switch (action) {
      case "noop":
        return;

      case "help": {
        return sendHelp(chatId);
      }

      case "langtgl": {
        const next = lang(chatId) === "km" ? "en" : "km";
        return bot.sendMessage(chatId, setChatLanguage(chatId, next));
      }

      case "stkpg": {
        const page = Number(rest[0]) || 0;
        const items = await equipmentService.getAll();
        if (items.length === 0) {
          return bot.sendMessage(chatId, t(chatId, "noEquipment"));
        }
        const text = `${t(chatId, "pickItem")} (${items.length})`;
        try {
          await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: stockKeyboard(chatId, items, page),
          });
        } catch (_) {
          // edit fails if message content is identical — fall back to a new message.
          await bot.sendMessage(chatId, text, { reply_markup: stockKeyboard(chatId, items, page) });
        }
        return;
      }

      case "view": {
        const item = await equipmentService.findById(id);
        if (!item) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        return sendView(chatId, item);
      }

      case "bor": {
        const item = await equipmentService.findById(id);
        if (!item) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        const reporter = await resolveReporter(query.from);
        setSession(chatId, { flow: "borrow", step: "borrower", data: { id: item.id, equipmentName: item.equipmentName, reporter } });
        return askBorrower(chatId, item);
      }

      case "boroffpg": {
        const page = Number(id) || 0;
        const session = getSession(chatId);
        const item = session && session.data ? session.data.currentItem : null;
        const picker = await sendOfficerPicker(chatId, "boroffpg", page, item);
        try {
          await bot.editMessageText(picker.title, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: "Markdown",
            reply_markup: picker.reply_markup,
          });
        } catch (_) {
          await bot.sendMessage(chatId, picker.title, { parse_mode: "Markdown", reply_markup: picker.reply_markup });
        }
        return;
      }

      case "bor_select_idx": {
        let borrowerName = "";
        if ((id || "").startsWith("rec_")) {
          borrowerName = getBorrowerByKey(id.slice(4));
        } else {
          const idx = Number(id);
          const off = await officerService.getOfficerByIndex(idx);
          if (off) borrowerName = off.name;
        }

        if (!borrowerName) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        const session = getSession(chatId);

        if (session && session.flow === "borrow_multi") {
          session.data.borrowerName = borrowerName;

          if (session.data.currentItem) {
            session.step = "item_qty";
            setSession(chatId, session);
            const item = session.data.currentItem;
            return bot.sendMessage(
              chatId,
              tr(
                chatId,
                `How many units of *${esc(item.equipmentName)}* for *${esc(borrowerName)}*? (Available: ${item.availableQuantity})`,
                `*${esc(item.equipmentName)}* សម្រាប់ *${esc(borrowerName)}* តើខ្ចីប៉ុន្មានគ្រឿង? (មានសល់៖ ${item.availableQuantity})`
              ),
              { parse_mode: "Markdown" }
            );
          }

          session.step = "pick_item";
          setSession(chatId, session);
          return sendEquipmentPicker(chatId, "borm_pick", 0, true);
        }

        const reporter = await resolveReporter(query.from);
        setSession(chatId, {
          flow: "borrow_multi",
          step: "pick_item",
          data: { borrowerName, items: [], reporter },
        });
        return sendEquipmentPicker(chatId, "borm_pick", 0, true);
      }

      case "borp": {
        const item = await equipmentService.findById(id);
        if (!item) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        const idx = Number(rest[1]) || 0;
        const borrower = recentBorrowers(item)[idx];
        if (!borrower) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        const reporter = await resolveReporter(query.from);
        setSession(chatId, {
          flow: "borrow",
          step: "quantity",
          data: { id: item.id, equipmentName: item.equipmentName, borrowerName: borrower, reporter },
        });
        return bot.sendMessage(chatId, tr(chatId, `How many units of ${item.equipmentName} are being borrowed?`, `${item.equipmentName} តើខ្ចីប៉ុន្មានគ្រឿង?`));
      }

      case "boro": {
        const reporter = await resolveReporter(query.from);
        if (id === "multi" || !id) {
          setSession(chatId, { flow: "borrow_multi", step: "borrower", data: { borrowerName: "", items: [], reporter } });
          return bot.sendMessage(
            chatId,
            tr(
              chatId,
              "Please type the borrower's name, group number, or officer search keyword:",
              "សូមវាយឈ្មោះអ្នកខ្ចី ឬលេខក្រុម ឬពាក្យគន្លឹះស្វែងរកមន្ត្រី៖"
            )
          );
        }
        const item = await equipmentService.findById(id);
        if (!item) {
          setSession(chatId, { flow: "borrow_multi", step: "borrower", data: { borrowerName: "", items: [], reporter } });
          return bot.sendMessage(
            chatId,
            tr(
              chatId,
              "Please type the borrower's name, group number, or officer search keyword:",
              "សូមវាយឈ្មោះអ្នកខ្ចី ឬលេខក្រុម ឬពាក្យគន្លឹះស្វែងរកមន្ត្រី៖"
            )
          );
        }
        setSession(chatId, { flow: "borrow_multi", step: "borrower", data: { borrowerName: "", items: [], currentItem: item, reporter } });
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            `Who is borrowing *${esc(item.equipmentName)}*? (type the name or officer search keyword)`,
            `តើអ្នកណាកំពុងខ្ចី *${esc(item.equipmentName)}*? (វាយឈ្មោះ ឬពាក្យគន្លឹះស្វែងរកមន្ត្រី)`
          ),
          { parse_mode: "Markdown" }
        );
      }

      case "borc": {
        // Borrow confirm — commit the borrow stashed in the session.
        const session = getSession(chatId);
        if (!session || session.flow !== "borrow" || session.step !== "confirm") return;
        return runBorrow(chatId);
      }

      case "borx": {
        const session = getSession(chatId);
        if (session && session.flow === "borrow") {
          clearSession(chatId);
          return bot.sendMessage(chatId, t(chatId, "cancelled"));
        }
        return;
      }

      case "ret": {
        const item = await equipmentService.findById(id);
        if (!item) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        const loans = (Array.isArray(item.activeLoans) ? item.activeLoans : []).filter((l) => openQuantity(l) > 0);
        if (loans.length === 0) return bot.sendMessage(chatId, t(chatId, "nothingBorrowed"));

        const rows = loans.map((l, i) => [
          { text: `${l.borrowerName} (${openQuantity(l)})`, callback_data: `retb:${item.id}:${i}` },
        ]);
        rows.push([{ text: tr(chatId, "Return (any borrower)", "ប្រគល់ (អ្នកខ្ចីណាក៏បាន)"), callback_data: `reta:${item.id}` }]);
        return bot.sendMessage(chatId, tr(chatId, "Who is returning, and how many?", "តើអ្នកណាប្រគល់ ចំនួនប៉ុន្មាន?"), {
          reply_markup: { inline_keyboard: rows },
        });
      }

      case "retb": {
        const item = await equipmentService.findById(id);
        if (!item) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        const idx = Number(rest[1]) || 0;
        const loans = (Array.isArray(item.activeLoans) ? item.activeLoans : []).filter((l) => openQuantity(l) > 0);
        const loan = loans[idx];
        if (!loan) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        const reporter = await resolveReporter(query.from);
        setSession(chatId, {
          flow: "return",
          step: "qty",
          data: { id: item.id, equipmentName: item.equipmentName, borrowerName: loan.borrowerName, max: openQuantity(loan), reporter },
        });
        return bot.sendMessage(chatId, tr(chatId, `How many does ${loan.borrowerName} return? (max ${openQuantity(loan)})`, `${loan.borrowerName} ប្រគល់ប៉ុន្មាន? (អតិបរមា ${openQuantity(loan)})`));
      }

      case "reta": {
        const item = await equipmentService.findById(id);
        if (!item) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        const reporter = await resolveReporter(query.from);
        setSession(chatId, {
          flow: "return",
          step: "qty",
          data: { id: item.id, equipmentName: item.equipmentName, borrowerName: "", max: item.borrowedQuantity, reporter },
        });
        return bot.sendMessage(chatId, tr(chatId, `How many units of ${item.equipmentName} are being returned?`, `${item.equipmentName} តើប្រគល់ប៉ុន្មានគ្រឿង?`));
      }

      case "edt": {
        const item = await equipmentService.findById(id);
        if (!item) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        return bot.sendMessage(chatId, tr(chatId, "Which field do you want to edit?", "តើចង់កែ field មួយណា?"), {
          reply_markup: editFieldKeyboard(chatId, item),
        });
      }

      case "edtf": {
        const item = await equipmentService.findById(id);
        if (!item) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        const field = rest[1];
        if (!equipmentService.EDITABLE_FIELDS[field]) return;
        setSession(chatId, {
          flow: "edit",
          step: "value",
          data: { id: item.id, equipmentName: item.equipmentName, field },
        });
        const fieldObj = EDIT_FIELDS.find((f) => f.key === field);
        const isKm = lang(chatId) === "km";
        const label = fieldObj ? (isKm ? fieldObj.labelKm : fieldObj.labelEn) : field;
        return bot.sendMessage(
          chatId,
          tr(chatId, `Please enter new value for ${label}:`, `សូមបញ្ចូលព័ត៌មានថ្មីសម្រាប់ ${label}៖`)
        );
      }

      case "del": {
        const item = await equipmentService.findById(id);
        if (!item) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        return bot.sendMessage(chatId, `${t(chatId, "confirmDelete")}\n*${esc(item.equipmentName)}*`, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: t(chatId, "confirm"), callback_data: `delok:${item.id}` },
                { text: t(chatId, "cancel"), callback_data: "delno" },
              ],
            ],
          },
        });
      }

      case "delok": {
        const item = await equipmentService.findById(id);
        if (!item) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        await equipmentService.deleteEquipmentByName(item.equipmentName);
        return bot.sendMessage(chatId, tr(chatId, `Deleted ${item.equipmentName}.`, `បានលុប ${item.equipmentName} រួចហើយ។`));
      }

      case "delno": {
        clearSession(chatId);
        return bot.sendMessage(chatId, t(chatId, "cancelled"));
      }

      case "report":
      case "rep": {
        return sendReport(chatId);
      }
      case "edtm_equip": {
        return sendEquipmentPicker(chatId, "edte_pick", 0, false);
      }

      case "edte_pick": {
        const item = await equipmentService.findById(id);
        if (!item) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        const rows = [
          [
            { text: tr(chatId, "✏️ Edit Item Fields", "✏️ កែប្រែព័ត៌មានឧបករណ៍"), callback_data: `edt:${item.id}` },
            { text: tr(chatId, "➕ Add Stock (+Qty)", "➕ បន្ថែមស្តុក"), callback_data: `edts_pick:${item.id}` },
          ],
          [
            { text: tr(chatId, "🗑️ Delete Equipment", "🗑️ លុបឧបករណ៍"), callback_data: `del:${item.id}` },
          ],
          [{ text: t(chatId, "cancel"), callback_data: "borm_cancel" }],
        ];
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            `*${esc(item.equipmentName)}*\nTotal: ${item.totalQuantity} | Available: ${item.availableQuantity} | Borrowed: ${item.borrowedQuantity}\nChoose an action:`,
            `*${esc(item.equipmentName)}*\nសរុប៖ ${item.totalQuantity} | សល់៖ ${item.availableQuantity} | ខ្ចី៖ ${item.borrowedQuantity}\nជ្រើសរើសសកម្មភាព៖`
          ),
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }
        );
      }

      case "edtm_bor": {
        const activeBorrowers = await equipmentService.getAllActiveBorrowers();
        if (activeBorrowers.length === 0) {
          return bot.sendMessage(chatId, tr(chatId, "No active borrowers found across equipment.", "មិនមានអ្នកខ្ចីសកម្មនៅលើឧបករណ៍ទាំងអស់ទេ។"));
        }
        const rows = activeBorrowers.map((b) => [
          {
            text: `👤 ${b.borrowerName} (${b.itemCount} items, ${b.totalQuantity} units)`,
            callback_data: `edtb_pick:${setBorrowerKey(b.borrowerName)}`,
          },
        ]);
        rows.push([{ text: t(chatId, "cancel"), callback_data: "borm_cancel" }]);
        return bot.sendMessage(
          chatId,
          tr(chatId, "Select a borrower to edit or delete:", "ជ្រើសរើសអ្នកខ្ចីដើម្បីកែប្រែ ឬលុប៖"),
          { reply_markup: { inline_keyboard: rows } }
        );
      }

      case "edtb_pick": {
        const borrowerName = getBorrowerByKey(id || "");
        const rows = [
          [
            { text: tr(chatId, "✏️ Rename Borrower", "✏️ ប្តូរឈ្មោះអ្នកខ្ចី"), callback_data: `edtb_ren:${setBorrowerKey(borrowerName)}` },
          ],
          [
            { text: tr(chatId, "🗑️ Delete Borrower Records", "🗑️ លុបទិន្នន័យអ្នកខ្ចី"), callback_data: `edtb_del:${setBorrowerKey(borrowerName)}` },
          ],
          [
            { text: tr(chatId, "👁️ Hide from Reports", "👁️ លាក់ពីរបាយការណ៍"), callback_data: `edtb_hide:${setBorrowerKey(borrowerName)}` },
          ],
          [{ text: t(chatId, "cancel"), callback_data: "borm_cancel" }],
        ];
        return bot.sendMessage(
          chatId,
          tr(chatId, `Borrower: *${esc(borrowerName)}*\nSelect action:`, `អ្នកខ្ចី៖ *${esc(borrowerName)}*\nជ្រើសរើសសកម្មភាព៖`),
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }
        );
      }

      case "edtb_ren": {
        const borrowerName = getBorrowerByKey(id || "");
        setSession(chatId, { flow: "edit_borrower", step: "rename", data: { oldName: borrowerName } });
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            `Type the new name for borrower *${esc(borrowerName)}*:`,
            `សូមវាយឈ្មោះថ្មីសម្រាប់អ្នកខ្ចី *${esc(borrowerName)}*៖`
          ),
          { parse_mode: "Markdown" }
        );
      }

      case "edtb_del": {
        const borrowerName = getBorrowerByKey(id || "");
        const res = await equipmentService.deleteBorrowerGlobal(borrowerName);
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            `Deleted all records for borrower *${esc(borrowerName)}* and restored available stock.`,
            `បានលុបទិន្នន័យទាំងអស់សម្រាប់អ្នកខ្ចី *${esc(borrowerName)}* និងបានស្ដារស្តុកឡើងវិញ។`
          ),
          { parse_mode: "Markdown" }
        );
      }

      case "edtb_hide": {
        const borrowerName = getBorrowerByKey(id || "");
        const items = await equipmentService.getAll();
        for (const item of items) {
          await equipmentService.hideBorrowerFromReports(item.equipmentName, borrowerName);
        }
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            `Borrower *${esc(borrowerName)}* hidden from future reports.`,
            `បានលាក់អ្នកខ្ចី *${esc(borrowerName)}* ពីរបាយការណ៍រួចរាល់។`
          ),
          { parse_mode: "Markdown" }
        );
      }

      case "edtm_loan": {
        const activeBorrowers = await equipmentService.getAllActiveBorrowers();
        if (activeBorrowers.length === 0) {
          return bot.sendMessage(chatId, tr(chatId, "No active loans found to edit.", "មិនមានការខ្ចីសកម្មសម្រាប់កែប្រែទេ។"));
        }
        const rows = activeBorrowers.map((b) => [
          {
            text: `👤 ${b.borrowerName} (${b.itemCount} items, ${b.totalQuantity} units)`,
            callback_data: `edtl_bor:${setBorrowerKey(b.borrowerName)}`,
          },
        ]);
        rows.push([{ text: t(chatId, "cancel"), callback_data: "borm_cancel" }]);
        return bot.sendMessage(
          chatId,
          tr(chatId, "Select a borrower whose loan entry you want to edit:", "ជ្រើសរើសអ្នកខ្ចីដែលចង់កែប្រែប្រវត្តិខ្ចី៖"),
          { reply_markup: { inline_keyboard: rows } }
        );
      }

      case "edtl_bor": {
        const borrowerName = getBorrowerByKey(id || "");
        const loans = await equipmentService.getActiveLoansByBorrower(borrowerName);
        if (loans.length === 0) {
          return bot.sendMessage(chatId, tr(chatId, "No active loans found for this borrower.", "មិនមានការខ្ចីសកម្មសម្រាប់អ្នកខ្ចីនេះទេ។"));
        }
        const rows = loans.map((l) => [
          {
            text: `📦 ${l.equipmentName} (${l.openQuantity} units)`,
            callback_data: `edtl_pick:${l.equipmentId}:${setBorrowerKey(borrowerName)}`,
          },
        ]);
        rows.push([{ text: t(chatId, "cancel"), callback_data: "borm_cancel" }]);
        return bot.sendMessage(
          chatId,
          tr(chatId, `Active loans for *${esc(borrowerName)}*:\nSelect an item to edit quantity or cancel:`, `ការខ្ចីសកម្មសម្រាប់ *${esc(borrowerName)}*៖\nជ្រើសរើសឧបករណ៍ដើម្បីកែប្រែចំនួន ឬបោះបង់៖`),
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }
        );
      }

      case "edtl_pick": {
        const equipId = id;
        const borrowerName = getBorrowerByKey(rest[1] || "");
        const item = await equipmentService.findById(equipId);
        if (!item) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        const rows = [
          [
            { text: tr(chatId, "✏️ Edit Borrowed Qty", "✏️ កែប្រែចំនួនខ្ចី"), callback_data: `edtl_qty:${equipId}:${setBorrowerKey(borrowerName)}` },
          ],
          [
            { text: tr(chatId, "🗑️ Cancel Loan Entry", "🗑️ បោះបង់ការខ្ចីនេះ"), callback_data: `edtl_del:${equipId}:${setBorrowerKey(borrowerName)}` },
          ],
          [{ text: t(chatId, "cancel"), callback_data: "borm_cancel" }],
        ];
        return bot.sendMessage(
          chatId,
          tr(chatId, `Loan Entry: *${esc(item.equipmentName)}* for *${esc(borrowerName)}*\nSelect action:`, `ទិន្នន័យខ្ចី៖ *${esc(item.equipmentName)}* សម្រាប់ *${esc(borrowerName)}*\nជ្រើសរើសសកម្មភាព៖`),
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }
        );
      }

      case "edtl_qty": {
        const equipId = id;
        const borrowerName = getBorrowerByKey(rest[1] || "");
        const item = await equipmentService.findById(equipId);
        if (!item) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        setSession(chatId, { flow: "edit_loan", step: "qty", data: { equipmentId: equipId, borrowerName, equipmentName: item.equipmentName } });
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            `Type new borrowed quantity for *${esc(borrowerName)}* on *${esc(item.equipmentName)}*:`,
            `សូមវាយចំនួនខ្ចីថ្មីសម្រាប់ *${esc(borrowerName)}* លើឧបករណ៍ *${esc(item.equipmentName)}*៖`
          ),
          { parse_mode: "Markdown" }
        );
      }

      case "edtl_del": {
        const equipId = id;
        const borrowerName = getBorrowerByKey(rest[1] || "");
        const reporter = await resolveReporter(query.from);
        const res = await equipmentService.updateLoanQuantity(equipId, borrowerName, 0, reporter);
        if (res.error) {
          return bot.sendMessage(chatId, tr(chatId, "Failed to update loan.", "មិនអាចកែប្រែការខ្ចីបានទេ។"));
        }
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            `Cancelled loan entry for *${esc(borrowerName)}* on *${esc(res.item.equipmentName)}*. Restored stock!`,
            `បានបោះបង់ការខ្ចីសម្រាប់ *${esc(borrowerName)}* លើ *${esc(res.item.equipmentName)}*។ បានស្ដារស្តុកឡើងវិញ!`
          ),
          { parse_mode: "Markdown" }
        );
      }

      case "edtm_stockin": {
        return sendEquipmentPicker(chatId, "edts_pick", 0, false);
      }

      case "edts_pick": {
        const item = await equipmentService.findById(id);
        if (!item) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        const reporter = await resolveReporter(query.from);
        setSession(chatId, { flow: "add_stock", step: "qty", data: { equipmentId: item.id, equipmentName: item.equipmentName, item, reporter } });
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            `Adding stock for *${esc(item.equipmentName)}*\nCurrent Total: ${item.totalQuantity} | Available: ${item.availableQuantity}\n\nType the number of units to ADD:`,
            `បន្ថែមស្តុកសម្រាប់ *${esc(item.equipmentName)}*\nសរុបបច្ចុប្បន្ន៖ ${item.totalQuantity} | សល់៖ ${item.availableQuantity}\n\nសូមវាយចំនួនគ្រឿងដែលត្រូវបន្ថែម៖`
          ),
          { parse_mode: "Markdown" }
        );
      }

      case "edtm_clearhist": {
        const rows = [
          [
            {
              text: tr(chatId, "⚠️ Yes, Clear History", "⚠️ ពិតជាចង់លុបប្រវត្តិ"),
              callback_data: "edtm_clearhist_do",
            },
            { text: t(chatId, "cancel"), callback_data: "borm_cancel" },
          ],
        ];
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            "⚠️ *Clear Transaction History*\nAre you sure you want to clear all transaction history from the *ប្រវត្តិប្រតិបត្តិការ* sheet and reset active loans?",
            "⚠️ *លុបប្រវត្តិប្រតិបត្តិការ*\nតើអ្នកពិតជាចង់លុបប្រវត្តិប្រតិបត្តិការទាំងអស់ចេញពីសន្លឹក *ប្រវត្តិប្រតិបត្តិការ* និងស្ដារស្តុកឡើងវិញ?"
          ),
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }
        );
      }

      case "edtm_clearhist_do": {
        const result = await equipmentService.clearTransactionHistory(true);
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            `✅ *Transaction History Cleared!*\nCleared all transaction history across ${result.count} equipment item(s). The *ប្រវត្តិប្រតិបត្តិការ* sheet is now reset.`,
            `✅ *បានលុបប្រវត្តិប្រតិបត្តិការរួចរាល់!*\nបានលុបប្រវត្តិប្រតិបត្តិការទាំងអស់លើ ${result.count} ឧបករណ៍។ សន្លឹក *ប្រវត្តិប្រតិបត្តិការ* ត្រូវបានស្ដារជាថ្មី។`
          ),
          { parse_mode: "Markdown" }
        );
      }
      case "add": {
        setSession(chatId, { flow: "add", step: "name", data: {} });
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            "Adding new equipment. Please enter Khmer Name:",
            "សូមបញ្ចូលឈ្មោះ (ភាសាខ្មែរ)៖"
          )
        );
      }

      case "borm_pick_pg":
      case "borm_pg":
      case "retm_pick_pg":
      case "retm_pg":
      case "edte_pick_pg":
      case "edts_pick_pg": {
        const page = Number(rest[0]) || 0;
        const filterActive = action.startsWith("borm");
        let prefix = "borm_pick";
        if (action.startsWith("retm")) prefix = "retm_pick";
        else if (action.startsWith("edte")) prefix = "edte_pick";
        else if (action.startsWith("edts")) prefix = "edts_pick";

        const messageId = query.message ? query.message.message_id : null;
        return sendEquipmentPicker(chatId, prefix, page, filterActive, messageId);
      }

      case "borgrp": {
        const targetGroup = rest[0];
        if (targetGroup === "all") {
          const picker = await sendOfficerPicker(chatId, "boroffpg", 0, null);
          return bot.sendMessage(chatId, picker.title, {
            parse_mode: "Markdown",
            reply_markup: picker.reply_markup,
          });
        }
        if (targetGroup === "main") {
          return sendGroupSelector(chatId, null);
        }

        const officers = await officerService.loadOfficers();
        const filtered = officers.filter((o) => o.group === targetGroup);
        if (filtered.length === 0) {
          return bot.sendMessage(
            chatId,
            tr(chatId, `No officers found in Group ${targetGroup}.`, `មិនមានទិន្នន័យមន្ត្រីក្នុងក្រុមទី ${targetGroup} ទេ។`)
          );
        }

        const rows = filtered.map((off) => [
          {
            text: `[ក្រុមទី ${off.group}] 👤 ${off.name}`,
            callback_data: `bor_select_idx:${off.index}`,
          },
        ]);
        rows.push([
          {
            text: tr(chatId, "⬅️ Back to Group Selection", "⬅️ ជ្រើសរើសក្រុមផ្សេង"),
            callback_data: "borgrp:main",
          },
        ]);
        rows.push([{ text: t(chatId, "cancel"), callback_data: "borm_cancel" }]);

        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            `Officers in *Group ${targetGroup}* (${filtered.length}):\nTap a name to select borrower:`,
            `បញ្ជីមន្ត្រីក្នុង *ក្រុមទី ${targetGroup}* (${filtered.length} នាក់)៖\nសូមចុចលើឈ្មោះដើម្បីជ្រើសរើសអ្នកខ្ចី៖`
          ),
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }
        );
      }

      case "borm_add": {
        const session = getSession(chatId);
        if (!session || session.flow !== "borrow_multi") return;
        session.step = "pick_item";
        setSession(chatId, session);
        return sendEquipmentPicker(chatId, "borm_pick", 0, true);
      }

      case "borm_pick": {
        const item = await equipmentService.findById(id);
        if (!item) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        const session = getSession(chatId) || {
          flow: "borrow_multi",
          step: "item_qty",
          data: { borrowerName: "", items: [], reporter: await resolveReporter(query.from) },
        };
        session.flow = "borrow_multi";
        session.step = "item_qty";
        session.data.currentItem = item;
        setSession(chatId, session);
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            `How many units of *${esc(item.equipmentName)}* are being borrowed? (Available: ${item.availableQuantity})`,
            `*${esc(item.equipmentName)}* តើខ្ចីប៉ុន្មានគ្រឿង? (មានសល់៖ ${item.availableQuantity})`
          ),
          { parse_mode: "Markdown" }
        );
      }

      case "borm_fin": {
        const session = getSession(chatId);
        if (!session || session.flow !== "borrow_multi") return;
        const { borrowerName, items, reporter } = session.data;
        if (!borrowerName) {
          session.step = "borrower";
          setSession(chatId, session);
          return bot.sendMessage(chatId, tr(chatId, "Please type or choose borrower name first:", "សូមវាយ ឬជ្រើសរើសឈ្មោះអ្នកខ្ចីជាមុនសិន៖"));
        }
        if (!items || items.length === 0) {
          return bot.sendMessage(chatId, tr(chatId, "Cart is empty. Tap '➕ Add another item' first.", "បញ្ជីទទេស្អាត។ សូមចុច '➕ បន្ថែមឧបករណ៍មួយទៀត' ជាមុនសិន។"));
        }

        const result = await equipmentService.borrowMultiple(items, borrowerName, reporter);
        clearSession(chatId);
        return sendMultiBorrowResult(chatId, result, reporter ? reporter.name : "");
      }

      case "borm_cancel":
      case "retm_cancel":
      case "edte_pick_cancel":
      case "edts_pick_cancel": {
        clearSession(chatId);
        return bot.sendMessage(chatId, t(chatId, "cancelled"));
      }

      case "retm_borrower": {
        const borrowerName = getBorrowerByKey(id || "");
        const loans = await equipmentService.getActiveLoansByBorrower(borrowerName);
        if (loans.length === 0) {
          return bot.sendMessage(chatId, tr(chatId, `No active loans for ${borrowerName}.`, `មិនមានការខ្ចីសកម្មសម្រាប់ ${borrowerName} ទេ។`));
        }

        const totalQty = loans.reduce((sum, l) => sum + l.openQuantity, 0);
        const itemSummary = loans.map((l) => `• ${l.equipmentName}: ${l.openQuantity} units`).join("\n");

        const rows = [
          [
            {
              text: tr(chatId, `🔄 Return ALL (${totalQty} units)`, `🔄 ប្រគល់ទាំងអស់ (${totalQty} គ្រឿង)`),
              callback_data: `retm_all_confirm:${setBorrowerKey(borrowerName)}`,
            },
          ],
          [
            {
              text: tr(chatId, "📋 Pick specific items to return", "📋 ជ្រើសរើសឧបករណ៍ប្រគល់"),
              callback_data: `retm_select:${setBorrowerKey(borrowerName)}`,
            },
          ],
          [{ text: t(chatId, "cancel"), callback_data: "retm_cancel" }],
        ];

        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            `📦 *Active loans for ${esc(borrowerName)}:*\n${itemSummary}\n\nChoose how to return:`,
            `📦 *ការខ្ចីសកម្មសម្រាប់ ${esc(borrowerName)}៖*\n${itemSummary}\n\nជ្រើសរើសវិធីប្រគល់៖`
          ),
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }
        );
      }

      case "retm_all_confirm": {
        const borrowerName = getBorrowerByKey(id || "");
        const loans = await equipmentService.getActiveLoansByBorrower(borrowerName);
        const totalQty = loans.reduce((sum, l) => sum + l.openQuantity, 0);

        const rows = [
          [
            {
              text: t(chatId, "confirm"),
              callback_data: `retm_all_do:${setBorrowerKey(borrowerName)}`,
            },
            { text: t(chatId, "cancel"), callback_data: "retm_cancel" },
          ],
        ];

        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            `Are you sure you want to return ALL ${loans.length} item type(s) (${totalQty} units) borrowed by *${esc(borrowerName)}*?`,
            `តើអ្នកពិតជាចង់ប្រគល់ឧបករណ៍ទាំងអស់ ${loans.length} មុខ (${totalQty} គ្រឿង) របស់ *${esc(borrowerName)}*?`
          ),
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }
        );
      }

      case "retm_all_do": {
        const borrowerName = getBorrowerByKey(id || "");
        const reporter = await resolveReporter(query.from);
        const result = await equipmentService.returnAllByBorrower(borrowerName, reporter);
        return sendMultiReturnResult(chatId, result, reporter ? reporter.name : "");
      }

      case "retm_select":
      case "retm_any_borrower": {
        const borrowerName = action === "retm_select" ? getBorrowerByKey(id || "") : "";
        const reporter = await resolveReporter(query.from);
        setSession(chatId, {
          flow: "return_multi",
          step: "pick_item",
          data: { borrowerName, items: [], reporter },
        });
        return sendEquipmentPicker(chatId, "retm_pick", 0, false);
      }

      case "retm_add": {
        const session = getSession(chatId);
        if (!session || session.flow !== "return_multi") return;
        session.step = "pick_item";
        setSession(chatId, session);
        return sendEquipmentPicker(chatId, "retm_pick", 0, false);
      }

      case "retm_pick": {
        const item = await equipmentService.findById(id);
        if (!item) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        const session = getSession(chatId) || {
          flow: "return_multi",
          step: "item_qty",
          data: { borrowerName: "", items: [], reporter: await resolveReporter(query.from) },
        };
        session.flow = "return_multi";
        session.step = "item_qty";
        session.data.currentItem = item;
        setSession(chatId, session);
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            `How many units of *${esc(item.equipmentName)}* are being returned? (Currently borrowed total: ${item.borrowedQuantity})`,
            `*${esc(item.equipmentName)}* តើប្រគល់ប៉ុន្មានគ្រឿង? (សរុបខ្ចីចេញ៖ ${item.borrowedQuantity})`
          ),
          { parse_mode: "Markdown" }
        );
      }

      case "retm_fin": {
        const session = getSession(chatId);
        if (!session || session.flow !== "return_multi") return;
        const { borrowerName, items, reporter } = session.data;
        if (!items || items.length === 0) {
          return bot.sendMessage(chatId, tr(chatId, "Return cart is empty.", "បញ្ជីប្រគល់ទទេស្អាត។"));
        }

        const result = await equipmentService.returnMultiple(items, borrowerName || "", reporter);
        clearSession(chatId);
        return sendMultiReturnResult(chatId, result, reporter ? reporter.name : "");
      }

      default:
        return;
    }
  } catch (err) {
    console.error("[TelegramBot] callback error:", err);
    bot.sendMessage(chatId, `${t(chatId, "error")}: ${err.message}`);
  }
});

// ---------- Generic message handler: drives the /add, /borrow, /return, /edit flows + photo uploads ----------
bot.on("message", async (msg) => {
  const text = msg.text ? msg.text.trim() : "";

  if (text.startsWith("/")) return; // commands handled above
  if (!isAuthorized(msg)) return;

  const chatId = msg.chat.id;

  // Handle Persistent Bottom Reply Keyboard Buttons
  if (text.includes("Borrow") || text.includes("ខ្ចី")) {
    clearSession(chatId);
    const reporter = await resolveReporter(msg.from);
    setSession(chatId, {
      flow: "borrow_multi",
      step: "borrower",
      data: { borrowerName: "", items: [], reporter },
    });
    return askBorrower(chatId, null);
  }

  if (text.includes("Return") || text.includes("ប្រគល់")) {
    clearSession(chatId);
    const reporter = await resolveReporter(msg.from);
    const activeBorrowers = await equipmentService.getAllActiveBorrowers();
    if (activeBorrowers.length === 0) {
      return bot.sendMessage(chatId, tr(chatId, "No active loans found across all equipment.", "មិនមានការខ្ចីសកម្មនៅលើឧបករណ៍ទាំងអស់ទេ។"));
    }
    setSession(chatId, {
      flow: "return_multi",
      step: "select_borrower",
      data: { borrowerName: "", items: [], reporter },
    });

    const rows = activeBorrowers.map((b) => [
      {
        text: `👤 ${b.borrowerName} (${b.itemCount} items, ${b.totalQuantity} units)`,
        callback_data: `retm_borrower:${setBorrowerKey(b.borrowerName)}`,
      },
    ]);
    rows.push([{ text: tr(chatId, "📦 Return items by picking equipment", "📦 ប្រគល់ដោយជ្រើសរើសឧបករណ៍"), callback_data: "retm_any_borrower" }]);
    rows.push([{ text: t(chatId, "cancel"), callback_data: "retm_cancel" }]);

    return bot.sendMessage(
      chatId,
      tr(chatId, "Who is returning equipment?", "តើអ្នកណាប្រគល់ឧបករណ៍?"),
      { reply_markup: { inline_keyboard: rows } }
    );
  }

  if (text.includes("Stock") || text.includes("ស្តុក")) {
    clearSession(chatId);
    const items = await equipmentService.getAll();
    if (items.length === 0) {
      return bot.sendMessage(chatId, t(chatId, "noEquipment"));
    }
    return bot.sendMessage(chatId, `${t(chatId, "pickItem")} (${items.length})`, {
      reply_markup: stockKeyboard(chatId, items, 0),
    });
  }

  if (text.includes("Add") || text.includes("បញ្ចូល")) {
    clearSession(chatId);
    setSession(chatId, { flow: "add", step: "name", data: {} });
    return bot.sendMessage(
      chatId,
      tr(
        chatId,
        "Adding new equipment. Please enter Khmer Name:",
        "សូមបញ្ចូលឈ្មោះ (ភាសាខ្មែរ)៖"
      )
    );
  }

  if (text.includes("Reports") || text.includes("របាយការណ៍")) {
    clearSession(chatId);
    return sendReportMenu(chatId);
  }

  if (text.includes("Edit") || text.includes("កែប្រែ")) {
    clearSession(chatId);
    return sendEditMasterMenu(chatId);
  }

  const session = getSession(chatId);
  if (!session) return;

  try {
    // ---- borrow_multi flow ----
    if (session.flow === "borrow_multi") {
      if (session.step === "borrower") {
        const inputName = (msg.text || "").trim();
        const matchedOfficers = await officerService.searchOfficers(inputName);

        if (matchedOfficers.length > 0) {
          const rows = matchedOfficers.map((off) => [
            {
              text: off.group ? `[ក្រុមទី ${off.group}] 👤 ${off.name}` : `👤 ${off.name}`,
              callback_data: `bor_select_idx:${off.index}`,
            },
          ]);
          rows.push([
            {
              text: tr(chatId, `Use exact typed name: "${esc(inputName)}"`, `ប្រើឈ្មោះដែលបានវាយ៖ "${esc(inputName)}"`),
              callback_data: `bor_select_idx:rec_${setBorrowerKey(inputName)}`,
            },
          ]);
          rows.push([{ text: t(chatId, "cancel"), callback_data: "borm_cancel" }]);

          return bot.sendMessage(
            chatId,
            tr(
              chatId,
              `Matching officer(s) for "${esc(inputName)}":\nTap a name to select borrower:`,
              `មន្ត្រីដែលត្រូវគ្នានឹង "${esc(inputName)}"៖\nចុចលើឈ្មោះដើម្បីជ្រើសរើសអ្នកខ្ចី៖`
            ),
            { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }
          );
        }

        session.data.borrowerName = inputName;

        // If starting from single item command:
        if (session.data.currentItem) {
          session.step = "item_qty";
          setSession(chatId, session);
          const item = session.data.currentItem;
          return bot.sendMessage(
            chatId,
            tr(
              chatId,
              `How many units of *${esc(item.equipmentName)}* for *${esc(session.data.borrowerName)}*? (Available: ${item.availableQuantity})`,
              `*${esc(item.equipmentName)}* សម្រាប់ *${esc(session.data.borrowerName)}* តើខ្ចីប៉ុន្មានគ្រឿង? (មានសល់៖ ${item.availableQuantity})`
            ),
            { parse_mode: "Markdown" }
          );
        }

        session.step = "pick_item";
        setSession(chatId, session);
        return sendEquipmentPicker(chatId, "borm_pick", 0, true);
      }

      if (session.step === "item_qty") {
        const qty = Number((msg.text || "").trim());
        const item = session.data.currentItem;
        if (!item || Number.isNaN(qty) || qty <= 0) {
          return bot.sendMessage(chatId, tr(chatId, "Please enter a valid positive number for quantity.", "សូមបញ្ចូលចំនួនវិជ្ជមានដែលត្រឹមត្រូវ។"));
        }
        if (qty > item.availableQuantity) {
          return bot.sendMessage(
            chatId,
            tr(chatId, `Only ${item.availableQuantity} available for ${item.equipmentName}. Enter a valid quantity:`, `មានសល់តែ ${item.availableQuantity} សម្រាប់ ${item.equipmentName}។ សូមបញ្ចូលចំនួនដែលត្រឹមត្រូវ៖`)
          );
        }

        // Add to items list in session
        session.data.items = session.data.items || [];
        session.data.items.push({ id: item.id, equipmentName: item.equipmentName, qty });
        session.data.currentItem = null;
        session.step = "cart";
        setSession(chatId, session);

        const cartUI = renderBorrowCart(chatId, session.data);
        return bot.sendMessage(chatId, cartUI.text, { parse_mode: "Markdown", reply_markup: cartUI.reply_markup });
      }
    }

    // ---- return_multi flow ----
    if (session.flow === "return_multi") {
      if (session.step === "item_qty") {
        const qty = Number((msg.text || "").trim());
        const item = session.data.currentItem;
        if (!item || Number.isNaN(qty) || qty <= 0) {
          return bot.sendMessage(chatId, tr(chatId, "Please enter a valid positive number for quantity.", "សូមបញ្ចូលចំនួនវិជ្ជមានដែលត្រឹមត្រូវ។"));
        }
        if (qty > item.borrowedQuantity) {
          return bot.sendMessage(
            chatId,
            tr(chatId, `Only ${item.borrowedQuantity} total borrowed for ${item.equipmentName}. Enter a valid quantity:`, `សរុបមានខ្ចីតែ ${item.borrowedQuantity} សម្រាប់ ${item.equipmentName}។ សូមបញ្ចូលចំនួនដែលត្រឹមត្រូវ៖`)
          );
        }

        session.data.items = session.data.items || [];
        session.data.items.push({ id: item.id, equipmentName: item.equipmentName, qty });
        session.data.currentItem = null;
        session.step = "cart";
        setSession(chatId, session);

        const cartUI = renderReturnCart(chatId, session.data);
        return bot.sendMessage(chatId, cartUI.text, { parse_mode: "Markdown", reply_markup: cartUI.reply_markup });
      }
    }

    // ---- return flow (button-driven) ----
    if (session.flow === "return" && session.step === "qty") {
      const qty = Number((msg.text || "").trim());
      if (isNaN(qty) || qty <= 0) {
        return bot.sendMessage(chatId, tr(chatId, "Please send a valid number for quantity.", "សូមផ្ញើចំនួនដែលត្រឹមត្រូវ។"));
      }
      const { equipmentName, borrowerName, reporter } = session.data;
      const result = await equipmentService.returnItem(equipmentName, qty, borrowerName || "", reporter);
      if (!result.error) clearSession(chatId);
      await sendReturnResult(chatId, result, qty, equipmentName, borrowerName || "", result.reportedBy);
      if (!result.error) {
        const fresh = await equipmentService.findByName(equipmentName);
        if (fresh) await sendView(chatId, fresh);
      }
      return;
    }

    // ---- edit flow (button-driven) ----
    if (session.flow === "edit" && session.step === "value") {
      const value = (msg.text || "").trim();
      const { equipmentName, field } = session.data;
      const result = await equipmentService.editField(equipmentName, field, value);
      if (result.error === "not_found") {
        clearSession(chatId);
        return bot.sendMessage(chatId, tr(chatId, `No equipment found with name ${equipmentName}.`, `រកមិនឃើញឧបករណ៍ឈ្មោះ ${equipmentName} ទេ។`));
      }
      if (result.error === "bad_field") {
        clearSession(chatId);
        return bot.sendMessage(chatId, tr(chatId, `Invalid field. Valid fields: ${result.validFields.join(", ")}`, `Field មិនត្រឹមត្រូវ។ field ដែលអនុញ្ញាត៖ ${result.validFields.join(", ")}`));
      }
      clearSession(chatId);
      await bot.sendMessage(chatId, tr(chatId, "Updated.", "បានកែប្រែរួច។"));
      return sendView(chatId, result.item);
    }

    // ---- add flow ----
    if (session.flow === "add") {
      if (session.step === "name" || session.step === "nameKhmer") {
        session.data.nameKhmer = (msg.text || "").trim();
        session.step = "nameEnglish";
        setSession(chatId, session);
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            "Please enter English Name (or type /skip to skip):",
            "សូមបញ្ចូលឈ្មោះ (ភាសាអង់គ្លេស) [ឬវាយ /skip ដើម្បីរំលង]៖"
          )
        );
      }

      if (session.step === "nameEnglish") {
        if (msg.text && !msg.text.startsWith("/skip")) {
          session.data.nameEnglish = (msg.text || "").trim();
        }
        session.step = "model";
        setSession(chatId, session);
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            "Please enter Model (or type /skip to skip):",
            "សូមបញ្ចូលម៉ូឌែល / ជំនាន់ [ឬវាយ /skip ដើម្បីរំលង]៖"
          )
        );
      }

      if (session.step === "model") {
        if (msg.text && !msg.text.startsWith("/skip")) {
          session.data.model = (msg.text || "").trim();
        }
        session.step = "quantity";
        setSession(chatId, session);
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            "Please enter Total Quantity (number):",
            "សូមបញ្ចូលបរិមាណសរុប (ស្តុក) (ជាលេខ)៖"
          )
        );
      }

      if (session.step === "quantity") {
        const qty = Number((msg.text || "").trim());
        if (isNaN(qty) || qty < 0) {
          return bot.sendMessage(
            chatId,
            tr(
              chatId,
              "Please enter a valid positive number for total quantity.",
              "សូមបញ្ចូលចំនួនសរុបដែលត្រឹមត្រូវ (ជាលេខវិជ្ជមាន)៖"
            )
          );
        }
        session.data.quantity = qty;
        session.step = "photo";
        setSession(chatId, session);
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            "Please send an equipment photo, or type /skip to use default image:",
            "សូមផ្ញើរូបភាពឧបករណ៍ ឬវាយ /skip ដើម្បីរំលងការបញ្ចូលរូបភាព៖"
          )
        );
      }

      if (session.step === "photo") {
        let fileId = null;
        if (msg.photo && msg.photo.length > 0) {
          fileId = msg.photo[msg.photo.length - 1].file_id; // largest size
        } else if (msg.document && (msg.document.mime_type?.startsWith("image/") || /\.(jpg|jpeg|png|webp|heic)$/i.test(msg.document.file_name || ""))) {
          fileId = msg.document.file_id;
        }

        if (fileId) {
          try {
            const buffer = await downloadTelegramFileAsBuffer(fileId);
            const { storagePath } = await storageService.uploadEquipmentImage(buffer, {
              ext: ".jpg",
              contentType: "image/jpeg",
            });
            return finishAddFlow(chatId, session, storagePath);
          } catch (err) {
            console.error("[TelegramBot] photo upload failed:", err);
            return bot.sendMessage(
              chatId,
              tr(
                chatId,
                `Could not save the photo: ${err.message}. Try /add again or /skip.`,
                `មិនអាចរក្សារូបភាព៖ ${err.message}។ សាក /add ម្ដងទៀត ឬ /skip។`
              )
            );
          }
        }

        return bot.sendMessage(chatId, tr(chatId, "Send a photo, or type /skip.", "សូមផ្ញើរូបភាព ឬវាយ /skip។"));
      }
    }

    // ---- add_stock flow ----
    if (session.flow === "add_stock" && session.step === "qty") {
      const qtyToAdd = Number((msg.text || "").trim());
      if (Number.isNaN(qtyToAdd) || qtyToAdd <= 0) {
        return bot.sendMessage(chatId, tr(chatId, "Please enter a valid positive number for stock addition.", "សូមបញ្ចូលចំនួនវិជ្ជមានដែលត្រឹមត្រូវ។"));
      }
      const { equipmentId, reporter } = session.data;
      const result = await equipmentService.addStock(equipmentId, qtyToAdd, reporter);
      clearSession(chatId);
      if (result.error) {
        return bot.sendMessage(chatId, tr(chatId, "Failed to add stock.", "មិនអាចបន្ថែមស្តុកបានទេ។"));
      }
      const addedBy = result.logEntry.addedBy ? `\n${tr(chatId, "Added by", "បានបន្ថែមដោយ")}: ${esc(result.logEntry.addedBy)}` : "";
      await bot.sendMessage(
        chatId,
        tr(
          chatId,
          `✅ Added +${qtyToAdd} units to *${esc(result.item.equipmentName)}*.\nNew Total Stock: ${result.item.totalQuantity} (Available: ${result.item.availableQuantity}).${addedBy}`,
          `✅ បានបន្ថែម +${qtyToAdd} គ្រឿង ទៅលើ *${esc(result.item.equipmentName)}*។\nស្តុកសរុបថ្មី៖ ${result.item.totalQuantity} (សល់៖ ${result.item.availableQuantity})។${addedBy}`
        ),
        { parse_mode: "Markdown" }
      );
      return sendView(chatId, result.item);
    }

    // ---- edit_borrower flow ----
    if (session.flow === "edit_borrower" && session.step === "rename") {
      const newName = (msg.text || "").trim();
      const { oldName } = session.data;
      if (!newName) {
        return bot.sendMessage(chatId, tr(chatId, "Borrower name cannot be empty.", "ឈ្មោះអ្នកខ្ចីមិនអាចទទេបានទេ។"));
      }
      clearSession(chatId);
      const res = await equipmentService.renameBorrowerGlobal(oldName, newName);
      return bot.sendMessage(
        chatId,
        tr(
          chatId,
          `✅ Renamed borrower from *${esc(oldName)}* to *${esc(newName)}* across all active records.`,
          `✅ បានប្តូរឈ្មោះអ្នកខ្ចីពី *${esc(oldName)}* ទៅជា *${esc(newName)}* លើគ្រប់ទិន្នន័យរួចរាល់។`
        ),
        { parse_mode: "Markdown" }
      );
    }

    // ---- edit_loan flow ----
    if (session.flow === "edit_loan" && session.step === "qty") {
      const newQty = Number((msg.text || "").trim());
      if (Number.isNaN(newQty) || newQty < 0) {
        return bot.sendMessage(chatId, tr(chatId, "Please enter a valid non-negative number.", "សូមបញ្ចូលចំនួនដែលត្រឹមត្រូវ (លេខមិនអវិជ្ជមាន)។"));
      }
      const { equipmentId, borrowerName, equipmentName } = session.data;
      const reporter = await resolveReporter(msg.from);
      clearSession(chatId);
      const res = await equipmentService.updateLoanQuantity(equipmentId, borrowerName, newQty, reporter);
      if (res.error === "not_found") {
        return bot.sendMessage(chatId, tr(chatId, `Equipment not found.`, `រកមិនឃើញឧបករណ៍ទេ។`));
      }
      if (res.error === "loan_not_found") {
        return bot.sendMessage(chatId, tr(chatId, `Loan entry for ${borrowerName} was not found.`, `រកមិនឃើញកំណត់ត្រាខ្ចីសម្រាប់ ${borrowerName} ទេ។`));
      }
      if (res.error === "insufficient") {
        return bot.sendMessage(chatId, tr(chatId, `Not enough available stock (${res.available} available) to increase loan to ${newQty}.`, `មិនមានស្តុកសល់គ្រប់គ្រាន់ (សល់ ${res.available}) សម្រាប់កើនឡើងដល់ ${newQty} ទេ។`));
      }
      if (res.error) {
        return bot.sendMessage(chatId, tr(chatId, `Failed to update loan quantity: ${res.error}`, `មិនអាចកែប្រែចំនួនខ្ចីបានទេ៖ ${res.error}`));
      }
      return bot.sendMessage(
        chatId,
        tr(
          chatId,
          `✅ Updated borrowed quantity to ${newQty} units for *${esc(borrowerName)}* on *${esc(equipmentName)}*.`,
          `✅ បានកែប្រែចំនួនខ្ចីទៅជា ${newQty} គ្រឿង សម្រាប់ *${esc(borrowerName)}* លើ *${esc(equipmentName)}* រួចរាល់។`
        ),
        { parse_mode: "Markdown" }
      );
    }
  } catch (err) {
    console.error("[TelegramBot] flow error:", err);
    clearSession(chatId);
    bot.sendMessage(chatId, tr(chatId, `Something went wrong: ${err.message}. Flow cancelled, try again.`, `មានបញ្ហាមួយ៖ ${err.message}។ បានបោះបង់ flow ហើយ សូមសាកល្បងម្ដងទៀត។`));
  }
});

bot.on("polling_error", (err) => {
  if (err && err.message && err.message.includes("409 Conflict")) return;
  console.error("[TelegramBot] polling error:", err.message);
});

// Gracefully stop polling on SIGTERM / SIGINT so Railway rolling restarts don't trigger 409 Conflict errors
const shutdown = (signal) => {
  console.log(`[TelegramBot] Received ${signal}. Gracefully stopping Telegram polling...`);
  bot.stopPolling()
    .then(() => {
      console.log("[TelegramBot] Polling stopped successfully.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("[TelegramBot] Error stopping polling:", err.message);
      process.exit(1);
    });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

console.log("[TelegramBot] Bot started and polling for messages.");