/**
 * Generates a short, human-readable equipment code, e.g. "EQ-2026-0export4".
 * Uses a fixed prefix + timestamp fragment to keep things simple without
 * needing a separate counter document.
 */
function generateEquipmentCode(prefix = "EQ") {
  const timestamp = Date.now().toString().slice(-6);
  return `${prefix.substring(0, 3).toUpperCase()}-${timestamp}`;
}

module.exports = { generateEquipmentCode };
