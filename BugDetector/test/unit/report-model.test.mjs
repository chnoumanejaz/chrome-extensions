import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, mergeNetwork, parseEnvironment, suggestTitle } from "../../lib/report-model.js";

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
