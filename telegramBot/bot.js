require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const { getSession, setSession, clearSession } = require("./sessionStore");
const { getLanguage, setLanguage } = require("./languageStore");
const equipmentService = require("./equipmentService");
const {
  generateInventoryReport,
  generateBorrowerReport,
  generateStockHistoryReport,
} = require("./reportService");
const authStore = require("./authStore");

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
  { command: "borrow", description: "Borrow units — /borrow <name>" },
  { command: "return", description: "Return units — /return <name> <qty> [borrower]" },
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
  { command: "start", description: "ចាប់ផ្ដើម bot" },
  { command: "help", description: "បង្ហាញបញ្ជាទាំងអស់" },
  { command: "stock", description: "បង្ហាញឧបករណ៍ទាំងអស់ (ចុចដើម្បីមើល)" },
  { command: "view", description: "មើលឧបករណ៍មួយ + រូបភាព — /view <ឈ្មោះ>" },
  { command: "add", description: "បញ្ចូលឧបករណ៍ថ្មី (ជាជំហានៗ)" },
  { command: "edit", description: "កែ field — /edit <ឈ្មោះ> <field> <តម្លៃ>" },
  { command: "borrow", description: "ខ្ចីឧបករណ៍ — /borrow <ឈ្មោះ>" },
  { command: "return", description: "ប្រគល់ឧបករណ៍ — /return <ឈ្មោះ> <ចំនួន> [អ្នកខ្ចី]" },
  { command: "delete", description: "លុបឧបករណ៍ — /delete <ឈ្មោះ>" },
  { command: "report", description: "ទាញយករបាយការណ៍ (ជ្រើសប្រភេទ)" },
  { command: "borrower", description: "កែអ្នកខ្ចីក្នុងរបាយការណ៍ — rename | hide | delete" },
  { command: "language", description: "ប្ដូរភាសា bot" },
  { command: "cancel", description: "បោះបង់ flow បច្ចុប្បន្ន" },
  { command: "skip", description: "រំលងរូបភាពក្នុង /add" },
  { command: "adduser", description: "Admin៖ អនុញ្ញាតអ្នកប្រើ — /adduser <id> [ឈ្មោះ]" },
  { command: "removeuser", description: "Admin៖ លុបអ្នកប្រើ — /removeuser <id>" },
  { command: "listusers", description: "Admin៖ បង្ហាញអ្នកប្រើដែលបានអនុញ្ញាត" },
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
    ready: "OSH Equipment Bot ready. Type /help or tap a button below.",
    unauthorized: "You're not authorized to use this bot.",
    unauthorizedHint: "Ask the admin to add your Telegram ID to ALLOWED_TELEGRAM_IDS.",
    helpTitle: "Commands",
    cancelled: "Cancelled.",
    noEquipment: "No equipment found.",
    error: "Error",
    languagePrompt: "Choose a language: /language en or /language km",
    languageSet: "Language set to English.",
    pickItem: "Pick an item:",
    didYouMean: "No exact match. Did you mean one of these?",
    itemGone: "That item no longer exists.",
    nothingBorrowed: "Nothing is currently borrowed for this item.",
    confirmDelete: "Permanently delete this item and its photo/QR code?",
    deleted: "Deleted {name}.",
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
    ready: "OSH Equipment Bot ត្រៀមរួចរាល់។ វាយ /help ឬចុចប៊ូតុងខាងក្រោម។",
    unauthorized: "អ្នកមិនមានសិទ្ធិប្រើ bot នេះទេ។",
    unauthorizedHint: "សូមឲ្យ admin បន្ថែម Telegram ID របស់អ្នកទៅ ALLOWED_TELEGRAM_IDS។",
    helpTitle: "បញ្ជា",
    cancelled: "បានបោះបង់រួច។",
    noEquipment: "រកមិនឃើញឧបករណ៍ទេ។",
    error: "កំហុស",
    languagePrompt: "ជ្រើសរើសភាសា៖ /language en ឬ /language km",
    languageSet: "បានកំណត់ភាសា ខ្មែរ។",
    pickItem: "ជ្រើសឧបករណ៍៖",
    didYouMean: "មិនមានឈ្មោះត្រូវគ្នាទេ។ តើអ្នកចង់មានន័យថាមួយក្នុងចំណោមនេះ?",
    itemGone: "ឧបករណ៍នេះមិនមានទៀតទេ។",
    nothingBorrowed: "បច្ចុប្បន្នមិនមានខ្ចីអ្វីសម្រាប់ឧបករណ៍នេះទេ។",
    confirmDelete: "លុបឧបករណ៍នេះ និងរូបភាព/QR code ជារៀងរហូត?",
    deleted: "បានលុប {name} រួចហើយ។",
    menuBorrow: "ខ្ចី",
    menuReturn: "ប្រគល់",
    menuEdit: "កែ",
    menuDelete: "លុប",
    confirm: "បញ្ជាក់",
    cancel: "បោះបង់",
    other: "ផ្សេងទៀត (វាយឈ្មោះ)",
    back: "ត្រឡប់",
    prev: "‹ មុន",
    next: "បន្ទាប់ ›",
    unknownDate: "មិនស្គាល់កាលបរិច្ឆេទ",
    helpBtn: "ជំនួយ",
    langToggle: "ខ្មែរ",
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
  const name = escHtml(item.equipmentName);
  // "Added via Telegram bot" is an internal default, not a real note — never show it.
  const note =
    item.description && item.description !== "Added via Telegram bot"
      ? escHtml(item.description)
      : "";
  return {
    en:
      `<b>${name}</b>\n` +
      `Available: ${item.availableQuantity} / ${item.totalQuantity}  |  Borrowed: ${item.borrowedQuantity}\n` +
      `Min Stock: ${item.minimumStockLevel}\n` +
      `Status: ${item.status}\n` +
      (item.lastBorrowedBy ? `Last Borrowed By: ${escHtml(item.lastBorrowedBy)}\n` : "") +
      (item.storageLocation ? `Location: ${escHtml(item.storageLocation)}\n` : "") +
      (note ? `Notes: ${note}` : ""),
    km:
      `<b>${name}</b>\n` +
      `មានសល់: ${item.availableQuantity} / ${item.totalQuantity}  |  ខ្ចីចេញ: ${item.borrowedQuantity}\n` +
      `ចំនួនអប្បបរមា: ${item.minimumStockLevel}\n` +
      `ស្ថានភាព: ${item.status}\n` +
      (item.lastBorrowedBy ? `អ្នកខ្ចីចុងក្រោយ: ${escHtml(item.lastBorrowedBy)}\n` : "") +
      (item.storageLocation ? `ទីតាំង: ${escHtml(item.storageLocation)}\n` : "") +
      (note ? `កំណត់សម្គាល់: ${note}` : ""),
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

function stockKeyboard(chatId, items, page) {
  const totalPages = Math.max(1, Math.ceil(items.length / STOCK_PER_PAGE));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const slice = items.slice(p * STOCK_PER_PAGE, (p + 1) * STOCK_PER_PAGE);

  const rows = slice.map((it) => [
    {
      text: `${it.equipmentName} — ${it.availableQuantity}/${it.totalQuantity} ${it.status}`,
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
        text: `${it.equipmentName} (${it.availableQuantity}/${it.totalQuantity})`,
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

  const realFile =
    item.imagePath && item.imagePath !== "/uploads/placeholder.png"
      ? path.join(EQUIPMENT_DIR, path.basename(item.imagePath))
      : null;

  // Try to send a photo: the item's real image first, then the placeholder, so the
  // user still sees a picture even for items without a photo. If Telegram rejects
  // every photo send (400 / invalid file), fall back to a plain text message so the
  // item's details always show up instead of crashing with an "API error 400".
  const candidates = [];
  if (realFile && fs.existsSync(realFile)) candidates.push(realFile);
  if (fs.existsSync(PLACEHOLDER_FILE)) candidates.push(PLACEHOLDER_FILE);

  for (const file of candidates) {
    try {
      await bot.sendPhoto(chatId, file, { caption, ...opts });
      return;
    } catch (err) {
      console.error(
        `[sendView] sendPhoto failed for ${path.basename(file)}:`,
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

async function finishAddFlow(chatId, session, imagePath) {
  if (imagePath) {
    session.data.imagePath = imagePath;
  }

  const created = await equipmentService.createEquipment(session.data);
  clearSession(chatId);
  const currentLang = lang(chatId);
  return bot.sendMessage(chatId, `${tr(chatId, "Created!", "បានបង្កើតរួច!")}\n\n${formatItem(created)[currentLang]}`, { parse_mode: "HTML" });
}

// Shared return-result rendering (used by both /return command and the button flow).
function sendReturnResult(chatId, result, qty, equipmentName, borrowerName) {
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

  return bot.sendMessage(
    chatId,
    `${tr(chatId, "Returned", "បានប្រគល់")} ${qty}x ${esc(result.item.equipmentName)}.${borrowerSummary}`,
    { parse_mode: "Markdown" }
  );
}

// ---------- /start & /help ----------
bot.onText(/\/start/, (msg) => {
  if (!isAuthorized(msg)) return reject(msg);
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, t(chatId, "ready"), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: tr(chatId, "Stock", "ស្តុក"), callback_data: "stkpg:0" },
          { text: tr(chatId, "Add", "បញ្ចូល"), callback_data: "add" },
        ],
        [
          { text: tr(chatId, "Reports", "របាយការណ៍"), callback_data: "report" },
          { text: t(chatId, "helpBtn"), callback_data: "help" },
        ],
        [{ text: t(chatId, "langToggle"), callback_data: "langtgl" }],
      ],
    },
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
        "/borrow <name> — borrow units and capture borrower name",
        "/return <name> <qty> [borrower] — return units, optionally for a specific borrower",
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
        "/borrow <name> — ខ្ចីឧបករណ៍ និងកត់ឈ្មោះអ្នកខ្ចី",
        "/return <name> <qty> [borrower] — ប្រគល់ឧបករណ៍",
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

// ---------- /borrow <name> — starts a guided flow ----------
bot.onText(/^\/borrow\s+(.+)$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return reject(msg);
  const chatId = msg.chat.id;
  const equipmentName = match[1].trim();
  const item = await equipmentService.findByName(equipmentName);
  if (!item) return suggestOrWarn(chatId, equipmentName, "bor");

  setSession(chatId, { flow: "borrow", step: "borrower", data: { id: item.id, equipmentName: item.equipmentName } });
  return askBorrower(chatId, item);
});

// ---------- /return <name> <qty> ----------
bot.onText(/^\/return(?:@\w+)?\s+(.+)$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return reject(msg);
  const chatId = msg.chat.id;
  const rawArgs = match[1].trim();
  const parts = rawArgs.split(/\s+/).filter(Boolean);

  if (parts.length < 2) {
    return bot.sendMessage(chatId, tr(chatId, "Use: /return <equipment name> <qty> [borrower]", "ប្រើ៖ /return <ឈ្មោះឧបករណ៍> <ចំនួន> [អ្នកខ្ចី]"));
  }

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

  if (!parsed) {
    const exactItem = await equipmentService.findByName(rawArgs);
    if (exactItem) {
      return bot.sendMessage(chatId, tr(chatId, `How many units of ${exactItem.equipmentName} are being returned? Use /return ${exactItem.equipmentName} <qty> [borrower]`, `ប្រគល់ ${exactItem.equipmentName} ប៉ុន្មាន? ប្រើ /return ${exactItem.equipmentName} <qty> [borrower]`));
    }
    return suggestOrWarn(chatId, rawArgs, "ret");
  }

  const { equipmentName, qty, borrowerName } = parsed;
  const result = await equipmentService.returnItem(equipmentName, qty, borrowerName);
  sendReturnResult(chatId, result, qty, equipmentName, borrowerName);
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

// ---------- /report — pick a report type from buttons ----------
async function sendReportMenu(chatId) {
  await bot.sendMessage(chatId, tr(chatId, "Choose a report:", "ជ្រើសរើសរបាយការណ៍៖"), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: tr(chatId, "Full inventory", "ស្តុកទាំងមូល"), callback_data: "rep:inv" },
          { text: tr(chatId, "Borrowers", "អ្នកខ្ចី"), callback_data: "rep:bor" },
        ],
        [{ text: tr(chatId, "Stock + history", "ស្តុក + ប្រវត្តិ"), callback_data: "rep:stk" }],
      ],
    },
  });
}

bot.onText(/^\/report(?:@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return reject(msg);
  await sendReportMenu(msg.chat.id);
});

// Keep the typed variants working too.
bot.onText(/^\/report(?:@\w+)?\s+borrowers$/i, async (msg) => {
  if (!isAuthorized(msg)) return reject(msg);
  await sendReport(msg.chat.id, "borrowers");
});

bot.onText(/^\/report(?:@\w+)?\s+stock$/i, async (msg) => {
  if (!isAuthorized(msg)) return reject(msg);
  await sendReport(msg.chat.id, "stock");
});

async function sendReport(chatId, type) {
  try {
    if (type === "borrowers") {
      await bot.sendMessage(chatId, tr(chatId, "Generating borrower report...", "កំពុងបង្កើតរបាយការណ៍អ្នកខ្ចី..."));
      const filePath = await generateBorrowerReport();
      await bot.sendDocument(chatId, filePath, {
        caption: tr(chatId, `Borrower report — ${new Date().toLocaleString()}`, `របាយការណ៍អ្នកខ្ចី — ${new Date().toLocaleString()}`),
      });
      fs.unlink(filePath, () => {});
    } else if (type === "stock") {
      await bot.sendMessage(chatId, tr(chatId, "Generating stock history report...", "កំពុងបង្កើតរបាយការណ៍ស្តុក និងប្រវត្តិ..."));
      const filePath = await generateStockHistoryReport();
      await bot.sendDocument(chatId, filePath, {
        caption: tr(chatId, `Stock and history report — ${new Date().toLocaleString()}`, `របាយការណ៍ស្តុក និងប្រវត្តិ — ${new Date().toLocaleString()}`),
      });
      fs.unlink(filePath, () => {});
    } else {
      await bot.sendMessage(chatId, tr(chatId, "Generating report...", "កំពុងបង្កើតរបាយការណ៍..."));
      const filePath = await generateInventoryReport();
      await bot.sendDocument(chatId, filePath, {
        caption: tr(chatId, `Full inventory report — ${new Date().toLocaleString()}`, `របាយការណ៍ស្តុកទាំងមូល — ${new Date().toLocaleString()}`),
      });
      fs.unlink(filePath, () => {});
    }
  } catch (err) {
    console.error("[TelegramBot] /report error:", err);
    bot.sendMessage(chatId, tr(chatId, `Failed to generate report: ${err.message}`, `បង្កើតរបាយការណ៍មិនបាន៖ ${err.message}`));
  }
}

// ---------- /add ----------
bot.onText(/^\/add$/, (msg) => {
  if (!isAuthorized(msg)) return reject(msg);
  setSession(msg.chat.id, { flow: "add", step: "name", data: {} });
  bot.sendMessage(msg.chat.id, tr(msg.chat.id, "Let's add new equipment. What's the equipment name?", "តោះបញ្ចូលឧបករណ៍ថ្មី។ ឈ្មោះឧបករណ៍ជាអ្វី?"));
});

bot.onText(/^\/skip(?:@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return reject(msg);

  const chatId = msg.chat.id;
  const session = getSession(chatId);
  if (!session || session.flow !== "add" || session.step !== "photo") return;

  try {
    await finishAddFlow(chatId, session, null);
  } catch (err) {
    console.error("[TelegramBot] /skip error:", err);
    clearSession(chatId);
    bot.sendMessage(chatId, tr(chatId, `Something went wrong: ${err.message}. Flow cancelled, try /add again.`, `មានបញ្ហាមួយ៖ ${err.message}។ បានបោះបង់ flow ហើយ សូមសាកល្បង /add ម្ដងទៀត។`));
  }
});

// ---------- Flow prompts (used by button-driven flows) ----------
function askBorrower(chatId, item) {
  const suggestions = recentBorrowers(item);
  if (suggestions.length === 0) {
    return bot.sendMessage(chatId, tr(chatId, `Who is borrowing ${item.equipmentName}?`, `តើអ្នកណាកំពុងខ្ចី ${item.equipmentName}?`));
  }
  const rows = suggestions.slice(0, 6).map((name, i) => [
    { text: name, callback_data: `borp:${item.id}:${i}` },
  ]);
  rows.push([{ text: t(chatId, "other"), callback_data: `boro:${item.id}` }]);
  return bot.sendMessage(chatId, tr(chatId, `Who is borrowing ${item.equipmentName}?`, `តើអ្នកណាកំពុងខ្ចី ${item.equipmentName}?`), {
    reply_markup: { inline_keyboard: rows },
  });
}

// Commits the borrow after the user confirms on the review step. Centralised so the
// confirm callback and any future entry point share the same error handling.
async function runBorrow(chatId) {
  const session = getSession(chatId);
  if (!session || session.flow !== "borrow") return;

  const { equipmentName, borrowerName, qty } = session.data;
  const result = await equipmentService.borrow(equipmentName, qty, borrowerName);

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
  await bot.sendMessage(
    chatId,
    `${tr(chatId, `Borrowed ${qty}x ${result.item.equipmentName} for ${borrowerName}.`, `បានខ្ចី ${qty}x ${result.item.equipmentName} សម្រាប់ ${borrowerName}។`)}`,
    { parse_mode: "Markdown" }
  );
  return sendView(chatId, result.item);
}

const EDIT_FIELDS = [
  { key: "name", labelEn: "Name", labelKm: "ឈ្មោះ" },
  { key: "brand", labelEn: "Brand", labelKm: "ម៉ាក" },
  { key: "model", labelEn: "Model", labelKm: "ម៉ូដែល" },
  { key: "serial", labelEn: "Serial", labelKm: "Serial" },
  { key: "location", labelEn: "Location", labelKm: "ទីតាំង" },
  { key: "quantity", labelEn: "Quantity", labelKm: "ចំនួន" },
  { key: "minstock", labelEn: "Min stock", labelKm: "ចំនួនអប្បបរមា" },
  { key: "description", labelEn: "Notes", labelKm: "កំណត់សម្គាល់" },
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
        setSession(chatId, { flow: "borrow", step: "borrower", data: { id: item.id, equipmentName: item.equipmentName } });
        return askBorrower(chatId, item);
      }

      case "borp": {
        const item = await equipmentService.findById(id);
        if (!item) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        const idx = Number(rest[1]) || 0;
        const borrower = recentBorrowers(item)[idx];
        if (!borrower) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        setSession(chatId, {
          flow: "borrow",
          step: "quantity",
          data: { id: item.id, equipmentName: item.equipmentName, borrowerName: borrower },
        });
        return bot.sendMessage(chatId, tr(chatId, `How many units of ${item.equipmentName} are being borrowed?`, `${item.equipmentName} តើខ្ចីប៉ុន្មានគ្រឿង?`));
      }

      case "boro": {
        const item = await equipmentService.findById(id);
        if (!item) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        setSession(chatId, { flow: "borrow", step: "borrower", data: { id: item.id, equipmentName: item.equipmentName } });
        return bot.sendMessage(chatId, tr(chatId, `Who is borrowing ${item.equipmentName}? (type the name)`, `តើអ្នកណាកំពុងខ្ចី ${item.equipmentName}? (វាយឈ្មោះ)`));
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
        setSession(chatId, {
          flow: "return",
          step: "qty",
          data: { id: item.id, equipmentName: item.equipmentName, borrowerName: loan.borrowerName, max: openQuantity(loan) },
        });
        return bot.sendMessage(chatId, tr(chatId, `How many does ${loan.borrowerName} return? (max ${openQuantity(loan)})`, `${loan.borrowerName} ប្រគល់ប៉ុន្មាន? (អតិបរមា ${openQuantity(loan)})`));
      }

      case "reta": {
        const item = await equipmentService.findById(id);
        if (!item) return bot.sendMessage(chatId, t(chatId, "itemGone"));
        setSession(chatId, {
          flow: "return",
          step: "qty",
          data: { id: item.id, equipmentName: item.equipmentName, borrowerName: "", max: item.borrowedQuantity },
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
        const label = (EDIT_FIELDS.find((f) => f.key === field) || {}).labelEn || field;
        return bot.sendMessage(chatId, tr(chatId, `New value for ${label}?`, `តម្លៃថ្មីសម្រាប់ ${label}?`));
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

      case "report": {
        return sendReportMenu(chatId);
      }

      case "rep": {
        // Map the short callback codes to the report types sendReport expects.
        const repType = { inv: "inventory", bor: "borrowers", stk: "stock" }[rest[0]] || "inventory";
        return sendReport(chatId, repType);
      }

      case "add": {
        setSession(chatId, { flow: "add", step: "name", data: {} });
        return bot.sendMessage(chatId, tr(chatId, "Let's add new equipment. What's the equipment name?", "តោះបញ្ចូលឧបករណ៍ថ្មី។ ឈ្មោះឧបករណ៍ជាអ្វី?"));
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
  const session = getSession(chatId);
  if (!session) return;

  try {
    // ---- borrow flow ----
    if (session.flow === "borrow") {
      if (session.step === "borrower") {
        session.data.borrowerName = msg.text.trim();
        session.step = "quantity";
        setSession(chatId, session);
        return bot.sendMessage(chatId, tr(chatId, `How many units of ${session.data.equipmentName} are being borrowed?`, `${session.data.equipmentName} តើខ្ចីប៉ុន្មានគ្រឿង?`));
      }

      if (session.step === "quantity") {
        const qty = Number(msg.text.trim());
        if (isNaN(qty) || qty <= 0) {
          return bot.sendMessage(chatId, tr(chatId, "Please send a valid number for quantity.", "សូមផ្ញើចំនួនដែលត្រឹមត្រូវ។"));
        }

        // Stash the quantity and show a review step before committing, so a wrong
        // borrower name or wrong quantity can be caught before it's recorded.
        session.data.qty = qty;
        session.step = "confirm";
        setSession(chatId, session);

        const { equipmentName, borrowerName, id } = session.data;
        return bot.sendMessage(
          chatId,
          tr(
            chatId,
            `Please confirm:\nBorrow *${qty}× ${esc(equipmentName)}* for *${esc(borrowerName)}*?`,
            `សូមបញ្ជាក់៖\nខ្ចី *${qty}× ${esc(equipmentName)}* សម្រាប់ *${esc(borrowerName)}*?`
          ),
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: t(chatId, "confirm"), callback_data: `borc:${id}` },
                  { text: t(chatId, "cancel"), callback_data: `borx:${id}` },
                ],
              ],
            },
          }
        );
      }

      if (session.step === "confirm") {
        // Ignore typed text — the user must tap Confirm or Cancel.
        return bot.sendMessage(chatId, tr(chatId, "Tap Confirm or Cancel below.", "សូមចុច បញ្ជាក់ ឬ បោះបង់ ខាងក្រោម។"));
      }
    }

    // ---- return flow (button-driven) ----
    if (session.flow === "return" && session.step === "qty") {
      const qty = Number(msg.text.trim());
      if (isNaN(qty) || qty <= 0) {
        return bot.sendMessage(chatId, tr(chatId, "Please send a valid number for quantity.", "សូមផ្ញើចំនួនដែលត្រឹមត្រូវ។"));
      }
      const { equipmentName, borrowerName } = session.data;
      const result = await equipmentService.returnItem(equipmentName, qty, borrowerName || "");
      if (!result.error) clearSession(chatId);
      await sendReturnResult(chatId, result, qty, equipmentName, borrowerName || "");
      if (!result.error) {
        const fresh = await equipmentService.findByName(equipmentName);
        if (fresh) await sendView(chatId, fresh);
      }
      return;
    }

    // ---- edit flow (button-driven) ----
    if (session.flow === "edit" && session.step === "value") {
      const value = msg.text.trim();
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
      if (session.step === "name") {
        session.data.name = msg.text.trim();
        session.step = "quantity";
        setSession(chatId, session);
        return bot.sendMessage(chatId, tr(chatId, "Total quantity? (number)", "ចំនួនសរុប? (លេខ)"));
      }

      if (session.step === "quantity") {
        const qty = Number(msg.text.trim());
        if (isNaN(qty) || qty < 0) {
          return bot.sendMessage(chatId, tr(chatId, "Please send a valid number for quantity.", "សូមផ្ញើចំនួនដែលត្រឹមត្រូវ។"));
        }
        session.data.quantity = qty;
        session.step = "photo";
        setSession(chatId, session);
        return bot.sendMessage(chatId, tr(chatId, "Send a photo now, or type /skip to use the placeholder image.", "ផ្ញើរូបភាពឥឡូវនេះ ឬវាយ /skip ដើម្បីប្រើរូបភាពជំនួស។"));
      }

      if (session.step === "photo") {
        if (msg.photo && msg.photo.length > 0) {
          const fileId = msg.photo[msg.photo.length - 1].file_id; // largest size
          const ext = ".jpg";
          const filename = `${uuidv4()}${ext}`;
          const destPath = path.join(EQUIPMENT_DIR, filename);

          const downloadedPath = await bot.downloadFile(fileId, EQUIPMENT_DIR);
          fs.renameSync(downloadedPath, destPath);

          return finishAddFlow(chatId, session, `/uploads/equipment/${filename}`);
        }

        return bot.sendMessage(chatId, tr(chatId, "Send a photo, or type /skip.", "ផ្ញើរូបភាព ឬវាយ /skip។"));
      }
    }
  } catch (err) {
    console.error("[TelegramBot] flow error:", err);
    clearSession(chatId);
    bot.sendMessage(chatId, tr(chatId, `Something went wrong: ${err.message}. Flow cancelled, try again.`, `មានបញ្ហាមួយ៖ ${err.message}។ បានបោះបង់ flow ហើយ សូមសាកល្បងម្ដងទៀត។`));
  }
});

bot.on("polling_error", (err) => console.error("[TelegramBot] polling error:", err.message));

console.log("[TelegramBot] Bot started and polling for messages.");