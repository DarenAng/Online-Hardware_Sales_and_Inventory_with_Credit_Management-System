// ============================================================
// env-settings.js -- reading a number setting from the .env file
// Loaded by: sessions.js and live-changes.js.
// Never sent to a browser.
// ============================================================

// reads a positive number from .env, or uses the default when it is missing
function numberSetting(value, defaultValue) {
  if (Number(value) > 0) {
    return Number(value);
  }
  return defaultValue;
}

module.exports = { numberSetting };
