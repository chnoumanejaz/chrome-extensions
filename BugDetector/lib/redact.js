/**
 * Redaction of secrets and personal data before a report is stored.
 * Pure functions — unit tested in test/unit/redact.test.mjs.
 */

export const REDACTED = "[REDACTED]";

// Case-sensitive with a minimum length so prose like "basic usage" or "token expired" survives.
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]{8,}=*/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when a key/param name contains any of the sensitive fragments. */
export function isSensitiveKey(name, keys) {
  const lower = String(name).toLowerCase().replace(/-/g, "_");
  return keys.some((key) => lower.includes(key.toLowerCase().replace(/-/g, "_")));
}

export function truncate(text, max) {
  if (text == null) return text;
  const value = String(text);
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… [truncated ${value.length - max} chars]`;
}

/** @param {Record<string,string>|undefined} headers */
export function redactHeaders(headers, names) {
  if (!headers) return headers;
  const blocked = new Set(names.map((name) => name.toLowerCase()));
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = blocked.has(key.toLowerCase()) ? REDACTED : redactInlineSecrets(String(value));
  }
  return out;
}

/** Masks tokens that are dangerous wherever they appear (auth schemes, JWTs). */
export function redactInlineSecrets(text) {
  return String(text)
    .replace(BEARER, (_, scheme) => `${scheme} ${REDACTED}`)
    .replace(JWT, REDACTED);
}

function redactValue(value, keys) {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, keys));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = isSensitiveKey(key, keys) && inner !== null && typeof inner !== "object"
        ? REDACTED
        : redactValue(inner, keys);
    }
    return out;
  }
  return typeof value === "string" ? redactInlineSecrets(value) : value;
}

/**
 * Redacts a free-form body or message. Valid JSON is walked structurally;
 * anything else (including truncated JSON) is handled with patterns for
 * `"key": "value"`, `key=value` and `key: value`.
 */
export function redactText(text, { keys, maskEmails = false }) {
  if (text == null || text === "") return text;
  let out = String(text);

  const trimmed = out.trim();
  let structured = false;
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 2_000_000) {
    try {
      out = JSON.stringify(redactValue(JSON.parse(trimmed), keys));
      structured = true;
    } catch {
      // not JSON — fall through to patterns
    }
  }

  if (!structured && keys.length) {
    const names = keys.map(escapeRegExp).join("|");
    // "password": "x"  /  "token":123
    out = out.replace(
      new RegExp(`("[^"]*(?:${names})[^"]*"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"?|[^,}\\]\\s]+)`, "gi"),
      `$1"${REDACTED}"`
    );
    // password=x&...  /  token: abc
    out = out.replace(
      new RegExp(`(\\b[\\w.-]*(?:${names})[\\w.-]*\\s*[=:]\\s*)(?!"|\\[REDACTED\\])([^&\\s,;"']+)`, "gi"),
      `$1${REDACTED}`
    );
  }

  out = redactInlineSecrets(out);
  if (maskEmails) out = out.replace(EMAIL, "[EMAIL]");
  return out;
}

/** Masks sensitive query parameters (and inline secrets) in a URL. */
export function redactUrl(url, { keys, maskEmails = false }) {
  if (!url) return url;
  let out = String(url);
  try {
    const parsed = new URL(out);
    let changed = false;
    for (const name of [...parsed.searchParams.keys()]) {
      if (isSensitiveKey(name, keys)) {
        parsed.searchParams.set(name, REDACTED);
        changed = true;
      }
    }
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      changed = true;
    }
    if (changed) out = parsed.href.replaceAll(encodeURIComponent(REDACTED), REDACTED);
  } catch {
    // not an absolute URL — leave the structure alone
  }
  out = redactInlineSecrets(out);
  if (maskEmails) out = out.replace(EMAIL, "[EMAIL]").replace(/[A-Za-z0-9._%+-]+%40[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL]");
  return out;
}

/**
 * Returns a redacted copy of a report (see lib/report-model.js).
 * Bodies are redacted first and truncated afterwards so key patterns are
 * still visible to the redactor.
 */
export function redactReport(report, settings) {
  const opts = { keys: settings.redactKeys, maskEmails: settings.maskEmails };
  const text = (value) => redactText(value, opts);
  const body = (value) => truncate(redactText(value, opts), settings.maxBodyChars);
  const url = (value) => redactUrl(value, opts);

  return {
    ...report,
    page: {
      ...report.page,
      url: url(report.page.url),
      referrer: url(report.page.referrer),
      title: settings.maskEmails ? text(report.page.title) : report.page.title
    },
    console: report.console.map((entry) => ({
      ...entry,
      message: text(entry.message),
      stack: entry.stack ? text(entry.stack) : entry.stack,
      source: entry.source ? url(entry.source) : entry.source
    })),
    network: report.network.map((entry) => ({
      ...entry,
      url: url(entry.url),
      error: entry.error ? text(entry.error) : entry.error,
      requestHeaders: redactHeaders(entry.requestHeaders, settings.redactHeaders),
      responseHeaders: redactHeaders(entry.responseHeaders, settings.redactHeaders),
      requestBody: body(entry.requestBody),
      responseBody: body(entry.responseBody)
    })),
    breadcrumbs: report.breadcrumbs.map((entry) => ({ ...entry, text: text(entry.text) }))
  };
}
