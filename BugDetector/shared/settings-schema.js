/**
 * Settings schema: defaults + normalisation. Universal file (see shared/protocol.js).
 * Settings are a flat object stored under one chrome.storage.sync key.
 */
(() => {
  if (globalThis.BugDetectorSettings) return;

  const STORAGE_KEY = "settings";

  const SENSITIVITY = Object.freeze(["errors", "errors+network", "all"]);
  const SITE_MODES = Object.freeze(["all", "allowlist"]);

  const DEFAULTS = Object.freeze({
    /** Show the "Bug detected" toast automatically. */
    autoDetect: true,
    /** errors | errors+network | all (adds console warnings). */
    sensitivity: "errors+network",
    /** Minimum gap between two toasts after one is dismissed. */
    cooldownSeconds: 10,
    /** all = run everywhere except blocklist; allowlist = only listed sites. */
    siteMode: "all",
    allowlist: Object.freeze(["localhost", "127.0.0.1"]),
    blocklist: Object.freeze([]),
    /** Sites where data is still collected but the toast never shows. */
    mutedSites: Object.freeze([]),
    /** Console/error messages containing any of these are ignored. */
    ignoreMessagePatterns: Object.freeze(["ResizeObserver loop"]),
    /** Requests whose URL contains any of these are ignored. */
    ignoreUrlPatterns: Object.freeze([
      "google-analytics.com",
      "googletagmanager.com",
      "doubleclick.net",
      "facebook.com/tr",
      "hotjar.com",
      "clarity.ms",
      "sentry.io"
    ]),
    redactHeaders: Object.freeze([
      "authorization",
      "proxy-authorization",
      "cookie",
      "set-cookie",
      "x-api-key",
      "x-auth-token",
      "x-csrf-token",
      "x-xsrf-token"
    ]),
    /** JSON keys / query params containing any of these are masked. */
    redactKeys: Object.freeze([
      "password",
      "passwd",
      "secret",
      "token",
      "apikey",
      "api_key",
      "access_key",
      "authorization",
      "credit_card",
      "card_number",
      "cvv",
      "ssn"
    ]),
    maskEmails: false,
    /** Request/response bodies are truncated to this many characters. */
    maxBodyChars: 4000,
    /** Saved reports kept in IndexedDB (oldest pruned first). */
    maxReports: 20
  });

  const NUMBER_RANGES = Object.freeze({
    cooldownSeconds: [0, 3600],
    maxBodyChars: [200, 100000],
    maxReports: [1, 200]
  });

  const ENUMS = Object.freeze({ sensitivity: SENSITIVITY, siteMode: SITE_MODES });

  function cleanList(list) {
    const seen = new Set();
    for (const item of list) {
      if (typeof item !== "string") continue;
      const value = item.trim();
      if (value) seen.add(value);
    }
    return [...seen];
  }

  /**
   * Returns a complete, valid settings object. Unknown keys are dropped,
   * invalid values fall back to defaults. Never mutates the input.
   */
  function normalize(stored) {
    const source = stored && typeof stored === "object" ? stored : {};
    const out = {};

    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      const value = source[key];

      if (Array.isArray(fallback)) {
        out[key] = Array.isArray(value) ? cleanList(value) : [...fallback];
      } else if (typeof fallback === "number") {
        const [min, max] = NUMBER_RANGES[key];
        const num = Number(value);
        out[key] = value === undefined || value === "" || !Number.isFinite(num)
          ? fallback
          : Math.min(max, Math.max(min, Math.round(num)));
      } else if (ENUMS[key]) {
        out[key] = ENUMS[key].includes(value) ? value : fallback;
      } else {
        out[key] = typeof value === typeof fallback ? value : fallback;
      }
    }

    return out;
  }

  globalThis.BugDetectorSettings = Object.freeze({
    STORAGE_KEY,
    DEFAULTS,
    SENSITIVITY,
    SITE_MODES,
    normalize
  });
})();
