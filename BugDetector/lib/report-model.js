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

/** What third parties use for tracking pixels, beacons and ad frames. */
const BACKGROUND_TYPES = new Set(["image", "ping", "media", "other", "xmlhttprequest", "sub_frame"]);

/** "static.files.bbci.co.uk" → "co.uk"-level approximation; errs towards "same site", i.e. towards reporting. */
function siteOf(url) {
  return new URL(url).hostname.split(".").slice(-2).join(".");
}

/**
 * A failure only the browser saw, from another site, for something a visitor
 * never notices (tracker pixels, beacons, ad iframes). A report that's filed
 * anyway still lists it, but it's no reason to say something is wrong with the
 * page. Scripts, stylesheets and fonts from other sites do break pages, so they count.
 */
function isBackgroundNoise(entry, pageUrl) {
  if (entry.initiator !== "webRequest" || !BACKGROUND_TYPES.has(entry.resourceType)) return false;
  try {
    return siteOf(entry.url) !== siteOf(pageUrl);
  } catch {
    return false;
  }
}

/**
 * True when detection ran and found nothing worth reporting: no console
 * errors, no failed requests (as seen by the page or the browser) and no
 * problem with the element the user picked (tracker noise doesn't count). Console warnings only count when
 * the alert level is "all", the same bar the "Bug detected" popup uses, so
 * this is true exactly when the user saw no alert. On a site where BugDetector
 * is switched off the page itself isn't watched, so only what the browser saw
 * (and the picked element) can count. A page BugDetector couldn't reach at all
 * never counts: there's nobody to ask.
 *
 * @param {import("./messages.js").PageSnapshot|null} snapshot
 * @param {import("./messages.js").NetworkEntry[]} webRequests
 * @param {{ ignoreUrlPatterns: string[], sensitivity?: string }} settings
 */
export function hasNoIssues(snapshot, webRequests, settings) {
  if (!snapshot) return false;
  const network = mergeNetwork(snapshot.network, webRequests, {
    since: snapshot.page.timeOrigin || 0,
    ignoreUrlPatterns: settings.ignoreUrlPatterns
  });
  const countsWarnings = settings.sensitivity === "all";
  const problems = snapshot.console.filter((entry) => entry.level === "error" || countsWarnings);
  const failures = network.filter((entry) => !isBackgroundNoise(entry, snapshot.page.url));
  return !problems.length && !failures.length && !snapshot.element?.issues?.length;
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
 * A box around the picked element, in screenshot pixels (captureVisibleTab
 * captures at devicePixelRatio). Returned as an editable annotation.
 */
export function elementAnnotations(element) {
  if (!element?.rect || !element.rect.width || !element.rect.height) return [];
  const dpr = element.devicePixelRatio || 1;
  const pad = 4 * dpr;
  const { x, y, width, height } = element.rect;
  return [{
    type: "box",
    color: "#e5484d",
    x1: Math.round(x * dpr - pad),
    y1: Math.round(y * dpr - pad),
    x2: Math.round((x + width) * dpr + pad),
    y2: Math.round((y + height) * dpr + pad)
  }];
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
 * @param {boolean} [input.manual]   nothing was detected and the user chose to file a report anyway:
 *                                   the report keeps only the environment (and the picked element),
 *                                   the user writes the rest. On a site where BugDetector is off the
 *                                   report says "not checked" instead of "0 issues"
 */
export function buildReport({ id, createdAt, tab, snapshot, webRequests, settings, warnings = [], hasScreenshot = false, manual = false }) {
  const env = snapshot?.env || {};
  const { browser, os } = parseEnvironment(env);
  const notes = [...warnings];

  if (snapshot && !snapshot.siteEnabled && !manual) {
    notes.push("BugDetector is disabled on this site, so only the screenshot and failed requests seen by the browser were captured.");
  }

  const report = {
    id,
    version: 1,
    createdAt,
    manual,
    detectionOff: Boolean(manual && snapshot && !snapshot.siteEnabled),
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
    console: manual ? [] : snapshot?.console || [],
    network: mergeNetwork(snapshot?.network, webRequests, {
      since: snapshot?.page.timeOrigin || 0,
      ignoreUrlPatterns: settings.ignoreUrlPatterns
    }),
    breadcrumbs: manual ? [] : snapshot?.breadcrumbs || [],
    element: snapshot?.element || null,
    annotations: hasScreenshot ? elementAnnotations(snapshot?.element) : [],
    triage: null,
    warnings: notes,
    hasScreenshot
  };

  report.title = suggestTitle(report);
  return report;
}
