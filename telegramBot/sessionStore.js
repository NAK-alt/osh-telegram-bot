// Tiny in-memory session store for multi-step conversations (e.g. /add flow).
// Keyed by Telegram chat ID. Fine for a 1-2 person bot; not meant to scale.
const sessions = new Map();

function getSession(chatId) {
  return sessions.get(chatId) || null;
}

function setSession(chatId, data) {
  sessions.set(chatId, data);
}

function clearSession(chatId) {
  sessions.delete(chatId);
}

module.exports = { getSession, setSession, clearSession };
