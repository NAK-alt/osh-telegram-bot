// Tiny in-memory language store keyed by Telegram chat ID.
// Fine for a small bot; it resets when the server restarts.
const languages = new Map();

function getLanguage(chatId) {
  return languages.get(chatId) || "km";
}

function setLanguage(chatId, language) {
  languages.set(chatId, language);
}

module.exports = { getLanguage, setLanguage };