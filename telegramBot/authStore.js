const { db, admin } = require("../firebase/firebaseAdmin");

// Firestore collection that holds every Telegram user allowed to use the bot.
// Admins (the bootstrap IDs in ALLOWED_TELEGRAM_IDS) are always authorized even if
// this collection is empty or unreachable.
const COLLECTION = "botUsers";

// Admin / bootstrap IDs from the env var. These can run /adduser, /removeuser,
// /listusers and are never blocked.
const ADMIN_IDS = (process.env.ALLOWED_TELEGRAM_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

// In-memory cache of authorized non-admin user IDs. Loaded once at startup and
// kept in sync when users are added/removed, so authorizing a message is a sync
// Set lookup (no Firestore read per message).
let cache = new Set();
let loaded = false;

async function load() {
  try {
    const snap = await db.collection(COLLECTION).get();
    cache = new Set(snap.docs.map((doc) => doc.id));
  } catch (err) {
    console.error("[authStore] Failed to load allowlist from Firestore:", err.message);
    // Leave cache as-is (empty) — admins still work via ADMIN_IDS.
  }
  loaded = true;
}

function isAdmin(id) {
  return ADMIN_IDS.includes(String(id));
}

// Synchronous authorization check. Admins (env) always pass. Other users pass only
// if they're in the cache. Until the first load() finishes, only admins pass — a
// safe default.
function isAuthorizedId(id) {
  const sid = String(id);
  if (ADMIN_IDS.includes(sid)) return true;
  return cache.has(sid);
}

async function addUser(telegramId, name, addedBy) {
  const id = String(telegramId || "").trim();
  if (!/^\d+$/.test(id)) return { error: "bad_id" };
  if (ADMIN_IDS.includes(id)) return { error: "is_admin" };
  if (cache.has(id)) return { error: "already_exists" };

  await db.collection(COLLECTION).doc(id).set({
    telegramId: id,
    name: String(name || "").trim(),
    addedBy: String(addedBy || ""),
    addedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  cache.add(id);
  return { ok: true, id };
}

async function removeUser(telegramId) {
  const id = String(telegramId || "").trim();
  if (ADMIN_IDS.includes(id)) return { error: "is_admin" };
  if (!cache.has(id)) return { error: "not_found" };

  await db.collection(COLLECTION).doc(id).delete();
  cache.delete(id);
  return { ok: true, id };
}

async function listUsers() {
  const snap = await db.collection(COLLECTION).orderBy("addedAt", "desc").get();
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

// Resolve the stored display name for one Telegram user id. Returns "" for admins
// (who aren't in the botUsers collection) or unknown ids — callers fall back to the
// Telegram first/last name. Used to label "who input this transaction".
async function getUserName(telegramId) {
  const id = String(telegramId || "").trim();
  if (!id) return "";
  try {
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists) return "";
    return String((doc.data() || {}).name || "");
  } catch (err) {
    console.error("[authStore] getUserName failed:", err.message);
    return "";
  }
}

module.exports = {
  ADMIN_IDS,
  load,
  isAdmin,
  isAuthorizedId,
  addUser,
  removeUser,
  listUsers,
  getUserName,
};