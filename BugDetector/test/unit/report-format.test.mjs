import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReport, relativeTime, SECTIONS, FORMATS } from "../../lib/report-format.js";

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);

function sampleReport(overrides = {}) {
  return {
    id: "r1",
    version: 1,
    createdAt: NOW,
    title: "500 on POST /api/orders",
    description: { actual: "Spinner never stops", expected: "Order confirmation" },
    page: { url: "https://shop.test/checkout", title: "Checkout", referrer: null, loadTimeMs: 1234 },
    environment: {
      browser: "Chrome 141", os: "macOS", userAgent: "UA", language: "en-US", timezone: "UTC",
      viewport: { width: 1440, height: 900 }, screen: { width: 2880, height: 1800 },
      devicePixelRatio: 2, online: true, colorScheme: "light"
    },
    console: [{
      ts: NOW - 2000, type: "error", level: "error",
      message: "TypeError: Cannot read properties of undefined (reading 'total')",
      stack: "TypeError: Cannot read properties of undefined (reading 'total')\n    at render (app.js:88:12)\n    at main (app.js:5:1)",
      source: "https://shop.test/app.js:88:12", count: 2
    }],
    network: [{
      ts: NOW - 3000, initiator: "fetch", method: "POST", url: "https://shop.test/api/orders",
      status: 500, statusText: "Internal Server Error", durationMs: 812,
      requestHeaders: { "content-type": "application/json", authorization: "[REDACTED]" },
      requestBody: '{"cartId":"c_12"}',
      responseHeaders: { "content-type": "application/json", "x-request-id": "req_1", etag: "W/1" },
      responseBody: '{"error":"coupon_not_found"}'
    }],
    breadcrumbs: [
      { ts: NOW - 20000, kind: "load", text: "Opened https://shop.test/checkout" },
      { ts: NOW - 4000, kind: "click", text: 'Clicked "Place order" (button.primary)' }
    ],
    warnings: [],
    hasScreenshot: true,
    ...overrides
  };
}

test("relativeTime", () => {
  assert.equal(relativeTime(NOW, NOW), "at capture");
  assert.equal(relativeTime(NOW - 3000, NOW), "3s before");
  assert.equal(relativeTime(NOW - 125000, NOW), "2m 5s before");
  assert.equal(relativeTime(NOW - 3_720_000, NOW), "1h 2m before");
});

test("markdown contains every section with useful detail", () => {
  const md = formatReport(sampleReport());
  assert.match(md, /^## 🐞 500 on POST \/api\/orders/);
  assert.match(md, /\*\*Page:\*\* \[Checkout\]\(https:\/\/shop\.test\/checkout\)/);
  assert.match(md, /\*\*What happened:\*\* Spinner never stops/);
  assert.match(md, /### Failed requests \(1\)/);
  assert.match(md, /\n\n\*\*1\. POST 500 Internal Server Error\*\* `https:\/\/shop\.test\/api\/orders` · 812 ms · 3s before\n/);
  assert.match(md, /\n\nRequest body:\n```json\n/, "detail blocks are separate paragraphs, not nested in a list");
  assert.match(md, /```json\n\{\n {2}"error": "coupon_not_found"\n\}\n```/, "JSON bodies are pretty-printed");
  assert.match(md, /x-request-id: req_1/);
  assert.doesNotMatch(md, /etag/, "noisy response headers are hidden");
  assert.match(md, /### Console errors \(1\)/);
  assert.match(md, /\*\*1\. TypeError: Cannot read properties of undefined \(reading 'total'\)\*\* \(×2\) · 2s before\n```/);
  assert.match(md, /at render \(app\.js:88:12\)/);
  assert.match(md, /### Steps before the bug\n\n1\. Opened https:\/\/shop\.test\/checkout `20s before`/);
  assert.match(md, /- Viewport: 1440×900 @2x/);
  assert.match(md, /_Screenshot attached separately\. Captured with BugDetector\._$/);
});

test("sections can be excluded", () => {
  const md = formatReport(sampleReport(), { sections: ["console"] });
  assert.doesNotMatch(md, /Failed requests/);
  assert.doesNotMatch(md, /Steps before the bug/);
  assert.doesNotMatch(md, /What happened/);
  assert.match(md, /Console errors/);
});

test("slack and text dialects avoid markdown headings", () => {
  const slack = formatReport(sampleReport(), { format: "slack" });
  assert.match(slack, /^:lady_beetle: \*500 on POST/);
  assert.doesNotMatch(slack, /^#/m);
  assert.doesNotMatch(slack, /\*\*/);

  const text = formatReport(sampleReport(), { format: "text" });
  assert.match(text, /^BUG: 500 on POST/);
  assert.doesNotMatch(text, /```|\*\*|^#/m);
  assert.match(text, /FAILED REQUESTS \(1\)/);
});

test("ai prompt wraps the markdown report with instructions", () => {
  const ai = formatReport(sampleReport(), { format: "ai" });
  assert.match(ai, /^You are a senior web engineer/);
  assert.match(ai, /I'll also paste a screenshot/);
  assert.match(ai, /Identify the most likely root cause/);
  assert.match(ai, /## 🐞 500 on POST/);
});

test("json output is valid and respects sections", () => {
  const data = JSON.parse(formatReport(sampleReport(), { format: "json", sections: ["network"] }));
  assert.equal(data.title, "500 on POST /api/orders");
  assert.equal(data.network.length, 1);
  assert.equal(data.console, undefined);
  assert.equal(data.meta.generator, "BugDetector");
});

test("code containing backticks gets a longer fence", () => {
  const report = sampleReport({
    network: [],
    console: [{ ts: NOW, type: "console", level: "error", message: "bad", stack: "at x (```weird```.js:1:1)", source: null, count: 1 }]
  });
  assert.match(formatReport(report), /````\n[^`]*```weird```[^`]*\n````/);
});

test("empty report still renders cleanly", () => {
  const md = formatReport(sampleReport({ console: [], network: [], breadcrumbs: [], description: { actual: "", expected: "" }, hasScreenshot: false }));
  assert.match(md, /Failed requests \(0\)\n\nNone captured\./);
  assert.match(md, /_Captured with BugDetector\._$/);
});

test("exports metadata used by the report page", () => {
  assert.deepEqual(SECTIONS.map((s) => s.id), ["description", "network", "console", "steps", "environment"]);
  assert.deepEqual(FORMATS.map((f) => f.id), ["markdown", "slack", "text", "ai", "json"]);
  assert.throws(() => formatReport(sampleReport(), { format: "nope" }), /Unknown report format/);
});

test("source location is not repeated when the stack already contains it", () => {
  const report = sampleReport({
    network: [],
    console: [{
      ts: NOW, type: "error", level: "error", message: "Uncaught TypeError: boom",
      stack: "TypeError: boom\n    at http://x.test/:83:22", source: "http://x.test/:83:22", count: 1
    }]
  });
  const md = formatReport(report);
  assert.equal(md.split("http://x.test/:83:22").length - 1, 1);
});
