/**
 * General FormPilot settings, stored in chrome.storage.local.
 *
 *   sensitiveMode  - what happens to passwords/cards/tokens when saving a preset:
 *                    "skip" leaves them out, "encrypt" stores them encrypted
 *   lastAutoSubmit - the "submit after filling" choice from the last save,
 *                    used as the default for the next one
 */

const FormPilotSettings = (() => {
  const STORAGE_KEY = "settings";
  const SENSITIVE_MODES = ["skip", "encrypt"];

  function sanitize(raw) {
    return {
      sensitiveMode: SENSITIVE_MODES.includes(raw?.sensitiveMode) ? raw.sensitiveMode : "skip",
      lastAutoSubmit: raw?.lastAutoSubmit === true
    };
  }

  async function get() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return sanitize(result[STORAGE_KEY]);
  }

  /** Merges a partial update into the stored settings. */
  async function update(changes) {
    const current = await get();
    await chrome.storage.local.set({ [STORAGE_KEY]: sanitize({ ...current, ...changes }) });
  }

  return { STORAGE_KEY, sanitize, get, update };
})();
