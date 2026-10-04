import "../shared/settings-schema.js";

const Schema = globalThis.BugDetectorSettings;

export const DEFAULT_SETTINGS = Schema.DEFAULTS;
export const SENSITIVITY_OPTIONS = Schema.SENSITIVITY;
export const normalizeSettings = Schema.normalize;

const KEY = Schema.STORAGE_KEY;
const API_KEY = "anthropicApiKey";

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

/*
 * The Claude API key is kept in chrome.storage.local (this device only),
 * never in chrome.storage.sync with the other settings.
 */

/** @returns {Promise<string>} "" when not set */
export async function getApiKey() {
  const stored = await chrome.storage.local.get(API_KEY);
  return typeof stored[API_KEY] === "string" ? stored[API_KEY] : "";
}

export async function setApiKey(value) {
  const key = String(value || "").trim();
  if (key) await chrome.storage.local.set({ [API_KEY]: key });
  else await chrome.storage.local.remove(API_KEY);
  return key;
}
