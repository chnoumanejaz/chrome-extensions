import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, hasNoIssues, mergeNetwork, parseEnvironment, suggestTitle } from "../../lib/report-model.js";

const CHROME_MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

test("parseEnvironment prefers UA client hints and skips GREASE brands", () => {
  const env = parseEnvironment({
    userAgent: CHROME_MAC_UA,
    uaBrands: [{ brand: "Chromium", version: "141" }, { brand: "Google Chrome", version: "141" }, { brand: "Not?A_Brand", version: "8" }],
    uaPlatform: "macOS"
  });
  assert.deepEqual(env, { browser: "Chrome 141", os: "macOS" });

  const edge = parseEnvironment({
    uaBrands: [{ brand: "Microsoft Edge", version: "140" }, { brand: "Chromium", version: "140" }],
    uaPlatform: "Windows"
  });
  assert.deepEqual(edge, { browser: "Microsoft Edge 140", os: "Windows" });
});

test("parseEnvironment falls back to the UA string", () => {
  assert.deepEqual(parseEnvironment({ userAgent: CHROME_MAC_UA }), { browser: "Chrome 141", os: "macOS" });
  assert.deepEqual(parseEnvironment({}), { browser: "Unknown browser", os: "Unknown OS" });
});

test("mergeNetwork prefers hook entries, keeps web-only failures, and drops stale/ignored ones", () => {
  const hook = [
    { ts: 10_000, initiator: "fetch", method: "POST", url: "https://a.test/api/orders", status: 500, responseBody: "{}" },
    { ts: 11_000, initiator: "resource", method: "GET", url: "https://a.test/img.png", status: 0 }
  ];
  const web = [
    { ts: 10_050, initiator: "webRequest", method: "POST", url: "https://a.test/api/orders", status: 500 },
    { ts: 11_010, initiator: "webRequest", method: "GET", url: "https://a.test/img.png", status: 404 },
    { ts: 9_500, initiator: "webRequest", method: "GET", url: "https://a.test/app.css", status: 404 },
    { ts: 1_000, initiator: "webRequest", method: "GET", url: "https://a.test/old", status: 500 },
    { ts: 10_500, initiator: "webRequest", method: "GET", url: "https://www.google-analytics.com/collect", status: 0 }
  ];

  const merged = mergeNetwork(hook, web, { since: 9_000, ignoreUrlPatterns: ["google-analytics.com"] });
  assert.deepEqual(merged.map((e) => `${e.initiator} ${e.url} ${e.status}`), [
    "webRequest https://a.test/app.css 404",
    "fetch https://a.test/api/orders 500",
    "webRequest https://a.test/img.png 404"
  ]);
});

test("suggestTitle prefers API failures, then errors, then host", () => {
  const base = { page: { url: "https://shop.test/checkout" }, console: [], network: [] };
  assert.equal(suggestTitle(base), "Bug on shop.test");

  const withError = { ...base, console: [{ level: "error", message: "TypeError: x is undefined\n  at foo" }] };
  assert.equal(suggestTitle(withError), "TypeError: x is undefined");

  const withApi = { ...withError, network: [{ initiator: "fetch", method: "POST", url: "https://shop.test/api/orders?id=1", status: 500 }] };
  assert.equal(suggestTitle(withApi), "500 on POST /api/orders?id=1");

  const withNetworkError = { ...base, network: [{ initiator: "xhr", method: "GET", url: "https://shop.test/api", status: 0 }] };
  assert.equal(suggestTitle(withNetworkError), "Network error on GET /api");
});

test("buildReport works without a page snapshot", () => {
  const report = buildReport({
    id: "r1",
    createdAt: 5000,
    tab: { url: "chrome://settings", title: "Settings" },
    snapshot: null,
    webRequests: [],
    settings: { ignoreUrlPatterns: [] },
    warnings: ["Page details unavailable"]
  });
  assert.equal(report.page.url, "chrome://settings");
  assert.equal(report.title, "Bug report");
  assert.deepEqual(report.console, []);
  assert.deepEqual(report.warnings, ["Page details unavailable"]);
});

test("buildReport notes when the site is disabled", () => {
  const report = buildReport({
    id: "r2",
    createdAt: 5000,
    tab: {},
    snapshot: {
      siteEnabled: false,
      page: { url: "https://x.test/", title: "X", referrer: null, timeOrigin: 0, loadTimeMs: null },
      env: {},
      console: [],
      network: [],
      breadcrumbs: []
    },
    webRequests: [],
    settings: { ignoreUrlPatterns: [] }
  });
  assert.match(report.warnings[0], /disabled on this site/);
});

test("mergeNetwork explains network failures with the browser's error code", () => {
  const hook = [{ ts: 10_000, initiator: "fetch", method: "GET", url: "http://127.0.0.1:9/x", status: 0, error: "TypeError: Failed to fetch" }];
  const web = [{ ts: 10_005, initiator: "webRequest", method: "GET", url: "http://127.0.0.1:9/x", status: 0, error: "net::ERR_CONNECTION_REFUSED" }];
  const [entry, ...rest] = mergeNetwork(hook, web);
  assert.equal(rest.length, 0);
  assert.equal(entry.initiator, "fetch");
  assert.equal(entry.error, "TypeError: Failed to fetch (net::ERR_CONNECTION_REFUSED)");
});

test("buildReport keeps the picked element and pre-annotates it in screenshot pixels", async () => {
  const { elementAnnotations } = await import("../../lib/report-model.js");
  const element = { selector: "#x", rect: { x: 10, y: 20, width: 100, height: 30 }, devicePixelRatio: 2 };
  assert.deepEqual(elementAnnotations(element), [{ type: "box", color: "#e5484d", x1: 12, y1: 32, x2: 228, y2: 108 }]);
  assert.deepEqual(elementAnnotations({ rect: { x: 0, y: 0, width: 0, height: 10 } }), []);
  assert.deepEqual(elementAnnotations(null), []);

  const snapshot = {
    siteEnabled: true,
    page: { url: "https://x.test/", title: "X", referrer: null, timeOrigin: 0, loadTimeMs: null },
    env: {}, console: [], network: [], breadcrumbs: [], element
  };
  const base = { id: "r", createdAt: 1, tab: {}, snapshot, webRequests: [], settings: { ignoreUrlPatterns: [] } };
  const withShot = buildReport({ ...base, hasScreenshot: true });
  assert.equal(withShot.element.selector, "#x");
  assert.equal(withShot.annotations.length, 1);
  assert.equal(withShot.triage, null);
  assert.deepEqual(buildReport({ ...base, hasScreenshot: false }).annotations, []);
});

const PAGE = { url: "https://x.test/", title: "X", referrer: null, timeOrigin: 9_000, loadTimeMs: null };
const cleanSnapshot = (overrides = {}) => ({
  siteEnabled: true, page: PAGE, env: {}, console: [], network: [], breadcrumbs: [{ ts: 1, kind: "click", text: "Clicked a" }], element: null,
  ...overrides
});
const SETTINGS = { ignoreUrlPatterns: ["google-analytics.com"] };

test("hasNoIssues is true only when detection ran and found nothing", () => {
  assert.equal(hasNoIssues(cleanSnapshot(), [], SETTINGS), true);

  assert.equal(hasNoIssues(cleanSnapshot({ console: [{ level: "error", message: "boom" }] }), [], SETTINGS), false, "console error");
  assert.equal(hasNoIssues(cleanSnapshot({ console: [{ level: "error", message: "boom" }] }), [], { ...SETTINGS, sensitivity: "errors" }), false, "console error at any alert level");
  assert.equal(hasNoIssues(cleanSnapshot({ network: [{ ts: 10_000, initiator: "fetch", method: "GET", url: "https://x.test/a", status: 500 }] }), [], SETTINGS), false, "failed fetch");

  const webOnly = [{ ts: 10_000, initiator: "webRequest", method: "GET", url: "https://x.test/app.css", status: 404 }];
  assert.equal(hasNoIssues(cleanSnapshot(), webOnly, SETTINGS), false, "failure only the browser saw");

  const stale = [{ ts: 100, initiator: "webRequest", method: "GET", url: "https://x.test/old", status: 500 }];
  const ignored = [{ ts: 10_000, initiator: "webRequest", method: "GET", url: "https://www.google-analytics.com/collect", status: 0 }];
  assert.equal(hasNoIssues(cleanSnapshot(), [...stale, ...ignored], SETTINGS), true, "requests from before this page load and ignored URLs don't count");

  assert.equal(hasNoIssues(cleanSnapshot({ element: { selector: "#ok", issues: [] } }), [], SETTINGS), true, "a healthy picked element");
  assert.equal(hasNoIssues(cleanSnapshot({ element: { selector: "#x", issues: ["Element is disabled."] } }), [], SETTINGS), false, "a broken picked element");
});

test("console warnings only count at the alert level that would have popped up for them", () => {
  const warned = cleanSnapshot({ console: [{ level: "warn", message: "Deprecated prop" }] });
  assert.equal(hasNoIssues(warned, [], SETTINGS), true, "unset sensitivity");
  assert.equal(hasNoIssues(warned, [], { ...SETTINGS, sensitivity: "errors+network" }), true, "default alert level");
  assert.equal(hasNoIssues(warned, [], { ...SETTINGS, sensitivity: "all" }), false, "warnings alert level");
});

test("tracker noise only the browser saw doesn't count, but real breakage does", () => {
  const web = (overrides) => [{ ts: 10_000, initiator: "webRequest", method: "GET", status: 0, ...overrides }];
  const page = { ...PAGE, url: "https://www.shop.test/cart" };
  const noisy = (entries, snapshot = {}) => hasNoIssues(cleanSnapshot({ page, ...snapshot }), entries, SETTINGS);

  assert.equal(noisy(web({ url: "https://ping.tracker.example/p?id=1", resourceType: "ping", error: "net::ERR_BLOCKED_BY_ORB" })), true, "third-party beacon");
  assert.equal(noisy(web({ url: "https://sync.adtech.example/k.gif", resourceType: "image", status: 404 })), true, "third-party pixel");
  assert.equal(noisy(web({ url: "https://accounts.example.com/login?passive=true", resourceType: "sub_frame", status: 401 })), true, "third-party iframe");

  assert.equal(noisy(web({ url: "https://cdn.other.example/app.css", resourceType: "stylesheet", status: 404 })), false, "third-party stylesheet breaks the page");
  assert.equal(noisy(web({ url: "https://cdn.other.example/app.js", resourceType: "script", status: 500 })), false, "third-party script");
  assert.equal(noisy(web({ url: "https://www.shop.test/logo.png", resourceType: "image", status: 404 })), false, "own broken image");
  assert.equal(noisy(web({ url: "https://static.shop.test/hero.jpg", resourceType: "image", status: 404 })), false, "own subdomain");
  assert.equal(noisy(web({ url: "https://www.shop.test/api/jwt", resourceType: "xmlhttprequest", status: 403 })), false, "own API");
  assert.equal(
    noisy([], { network: [{ ts: 10_000, initiator: "fetch", method: "GET", url: "https://api.other.example/v1", status: 500 }] }),
    false, "an API call the page itself made, even to another site"
  );
});

test("hasNoIssues: a page BugDetector couldn't reach can't be asked, so it never counts", () => {
  assert.equal(hasNoIssues(null, [], SETTINGS), false, "no content script on the page");
});

test("hasNoIssues on a site where BugDetector is off only weighs what the browser saw", () => {
  const off = cleanSnapshot({ siteEnabled: false });
  assert.equal(hasNoIssues(off, [], SETTINGS), true, "nothing from the browser");

  const broken = [{ ts: 10_000, initiator: "webRequest", method: "GET", url: "https://x.test/app.css", resourceType: "stylesheet", status: 404 }];
  assert.equal(hasNoIssues(off, broken, SETTINGS), false, "a failure the browser saw is still evidence");
});

test("a manual report keeps the environment and picked element but no detected data", () => {
  const element = { selector: "#x", rect: { x: 1, y: 2, width: 3, height: 4 }, devicePixelRatio: 1, issues: [] };
  const base = { id: "m", createdAt: 1, tab: {}, webRequests: [], settings: SETTINGS, hasScreenshot: true };

  const warning = { level: "warn", message: "Deprecated prop" };
  const manual = buildReport({ ...base, snapshot: cleanSnapshot({ element, console: [warning], env: { userAgent: CHROME_MAC_UA } }), manual: true });
  assert.equal(manual.manual, true);
  assert.deepEqual(manual.breadcrumbs, []);
  assert.deepEqual(manual.console, [], "even sub-threshold warnings are left out");
  assert.deepEqual(manual.network, []);
  assert.equal(manual.environment.browser, "Chrome 141");
  assert.equal(manual.element.selector, "#x");
  assert.equal(manual.annotations.length, 1);
  assert.equal(manual.title, "Bug on x.test");

  assert.equal(manual.detectionOff, false);

  const off = buildReport({ ...base, snapshot: cleanSnapshot({ siteEnabled: false }), manual: true });
  assert.equal(off.manual, true);
  assert.equal(off.detectionOff, true, "the report says 'not checked', not '0 issues'");
  assert.deepEqual(off.warnings, [], "the 'not checked' line replaces the generic disabled-site note");

  const offWithEvidence = buildReport({ ...base, snapshot: cleanSnapshot({ siteEnabled: false }) });
  assert.match(offWithEvidence.warnings[0], /disabled on this site/, "a normal capture on a disabled site keeps its note");
  assert.equal(offWithEvidence.detectionOff, false);

  const normal = buildReport({ ...base, snapshot: cleanSnapshot() });
  assert.equal(normal.manual, false);
  assert.equal(normal.breadcrumbs.length, 1, "automatic reports keep their steps");
});
