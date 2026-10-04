import "../shared/settings-schema.js";

const Schema = globalThis.BugDetectorSettings;

export const DEFAULT_SETTINGS = Schema.DEFAULTS;
export const SENSITIVITY_OPTIONS = Schema.SENSITIVITY;
export const normalizeSettings = Schema.normalize;

const KEY = Schema.STORAGE_KEY;

/** @returns {Promise<typeof DEFAULT_SETTINGS>} */
export async function getSettings() {
  const stored = await chrome.storage.sync.get(KEY);
  return normalizeSettings(stored[KEY]);
}

/** Merges `patch` into the stored settings and returns the normalised result. */
export async function updateSettings(patch) {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...patch });
  await chrome.storage.sync.set({ [KEY]: next });
  return next;
}

export async function resetSettings() {
  const next = normalizeSettings();
  await chrome.storage.sync.set({ [KEY]: next });
  return next;
}

/**
 * Calls `listener(settings)` whenever settings change in any context.
 * @returns {() => void} unsubscribe
 */
export function onSettingsChanged(listener) {
  const handler = (changes, area) => {
    if (area === "sync" && changes[KEY]) listener(normalizeSettings(changes[KEY].newValue));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
