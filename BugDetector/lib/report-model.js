/**
 * Builds the report object from a page snapshot + webRequest observations.
 * Pure functions — unit tested in test/unit/report-model.test.mjs.
 */

const MAX_NETWORK = 50;
const DEDUPE_WINDOW_MS = 3000;

/**
 * Derives a readable browser + OS from UA-CH data (preferred) or the UA string.
 * @returns {{ browser: string, os: string }}
 */
export function parseEnvironment(env = {}) {
  const ua = env.userAgent || "";
  let browser = "";

  const brands = (env.uaBrands || []).filter((b) => !/not.?a.?brand|chromium/i.test(b.brand));
  if (brands.length) {
    const brand = brands.find((b) => b.brand !== "Google Chrome") || brands[0];
    browser = `${brand.brand.replace(/^Google /, "")} ${brand.version}`;
  } else {
    const patterns = [
      [/Edg\/(\d+)/, "Edge"],
      [/OPR\/(\d+)/, "Opera"],
      [/Firefox\/(\d+)/, "Firefox"],
      [/Chrome\/(\d+)/, "Chrome"],
      [/Version\/(\d+).*Safari/, "Safari"]
    ];
    for (const [regex, name] of patterns) {
      const match = ua.match(regex);
      if (match) {
        browser = `${name} ${match[1]}`;
        break;
      }
    }
  }

  let os = env.uaPlatform || "";
  if (!os) {
    if (/Windows/.test(ua)) os = "Windows";
    else if (/Android/.test(ua)) os = "Android";
    else if (/iPhone|iPad/.test(ua)) os = "iOS";
    else if (/Mac OS X/.test(ua)) os = "macOS";
    else if (/CrOS/.test(ua)) os = "ChromeOS";
    else if (/Linux/.test(ua)) os = "Linux";
  }

  return { browser: browser || "Unknown browser", os: os || "Unknown OS" };
}

function containsAny(text, patterns) {
  const haystack = String(text || "").toLowerCase();
  return patterns.some((pattern) => haystack.includes(pattern.toLowerCase()));
}

function sameRequest(a, b) {
  return a.method === b.method && a.url === b.url && Math.abs(a.ts - b.ts) <= DEDUPE_WINDOW_MS;
}

/**
 * Merges failures seen by the page hook (rich: bodies, headers) with the ones
 * seen by chrome.webRequest (complete: CSS, fonts, early requests, status for
 * failed resources). Hook fetch/XHR entries win; webRequest entries win over
 * the hook's bare "resource failed to load" entries.
 *
 * @param {import("./messages.js").NetworkEntry[]} hookEntries
 * @param {import("./messages.js").NetworkEntry[]} webEntries
 * @param {{ since?: number, ignoreUrlPatterns?: string[] }} options
 */
export function mergeNetwork(hookEntries = [], webEntries = [], { since = 0, ignoreUrlPatterns = [] } = {}) {
  const recentWeb = webEntries.filter((entry) => entry.ts >= since - 1000 && !containsAny(entry.url, ignoreUrlPatterns));

  // The page only sees "TypeError: Failed to fetch"; the browser knows why
  // (net::ERR_CONNECTION_REFUSED, ERR_NAME_NOT_RESOLVED, …).
  const rich = hookEntries
    .filter((entry) => entry.initiator !== "resource")
    .map((entry) => {
      const twin = entry.status === 0 && recentWeb.find((web) => web.error && sameRequest(entry, web));
      return twin ? { ...entry, error: entry.error ? `${entry.error} (${twin.error})` : twin.error } : entry;
    });
  const bareResources = hookEntries.filter((entry) => entry.initiator === "resource");

  const web = recentWeb.filter((entry) => !rich.some((hook) => sameRequest(hook, entry)));

  const resources = bareResources.filter((entry) => !web.some((w) => w.url === entry.url));

  return [...rich, ...web, ...resources]
    .sort((a, b) => a.ts - b.ts)
    .slice(-MAX_NETWORK);
}

function shortPath(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname + (parsed.search.length > 30 ? "?…" : parsed.search);
  } catch {
    return url;
  }
}

function firstLine(text, max = 90) {
  const line = String(text || "").split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Picks a useful default title: the first API failure, else the first error. */
export function suggestTitle(report) {
  const api = report.network.find((entry) => entry.initiator === "fetch" || entry.initiator === "xhr")
    || report.network.find((entry) => ["xmlhttprequest", "fetch"].includes(entry.resourceType));
  if (api) {
    const what = api.status ? `${api.status}` : "Network error";
    return `${what} on ${api.method} ${shortPath(api.url)}`;
  }
  const error = report.console.find((entry) => entry.level === "error");
  if (error) return firstLine(error.message);
  if (report.network.length) {
    const first = report.network[0];
    return `${first.status || "Failed"} loading ${shortPath(first.url)}`;
  }
  let host = "";
  try {
    const url = new URL(report.page.url);
    if (/^https?:$/.test(url.protocol)) host = url.hostname;
  } catch {
    // ignore
  }
  return host ? `Bug on ${host}` : "Bug report";
}

/**
 * @param {object} input
 * @param {string} input.id
 * @param {number} input.createdAt              epoch ms
 * @param {{ url?: string, title?: string }} input.tab
 * @param {import("./messages.js").PageSnapshot|null} input.snapshot
 * @param {import("./messages.js").NetworkEntry[]} input.webRequests
 * @param {{ ignoreUrlPatterns: string[] }} input.settings
 * @param {string[]} [input.warnings]
 * @param {boolean} [input.hasScreenshot]
 */
export function buildReport({ id, createdAt, tab, snapshot, webRequests, settings, warnings = [], hasScreenshot = false }) {
  const env = snapshot?.env || {};
  const { browser, os } = parseEnvironment(env);
  const notes = [...warnings];

  if (snapshot && !snapshot.siteEnabled) {
    notes.push("BugDetector is disabled on this site, so only the screenshot and failed requests seen by the browser were captured.");
  }

  const report = {
    id,
    version: 1,
    createdAt,
    title: "",
    description: { actual: "", expected: "" },
    page: {
      url: snapshot?.page.url || tab.url || "",
      title: snapshot?.page.title || tab.title || "",
      referrer: snapshot?.page.referrer || null,
      loadTimeMs: snapshot?.page.loadTimeMs ?? null
    },
    environment: {
      browser,
      os,
      userAgent: env.userAgent || null,
      language: env.language || null,
      timezone: env.timezone || null,
      viewport: env.viewport || null,
      screen: env.screen || null,
      devicePixelRatio: env.devicePixelRatio || null,
      online: env.online ?? null,
      colorScheme: env.colorScheme || null
    },
    console: snapshot?.console || [],
    network: mergeNetwork(snapshot?.network, webRequests, {
      since: snapshot?.page.timeOrigin || 0,
      ignoreUrlPatterns: settings.ignoreUrlPatterns
    }),
    breadcrumbs: snapshot?.breadcrumbs || [],
    warnings: notes,
    hasScreenshot
  };

  report.title = suggestTitle(report);
  return report;
}
