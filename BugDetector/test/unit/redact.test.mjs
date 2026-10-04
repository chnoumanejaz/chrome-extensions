import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/settings-schema.js";
import {
  REDACTED,
  redactHeaders,
  redactText,
  redactUrl,
  redactReport,
  truncate,
  isSensitiveKey
} from "../../lib/redact.js";

const settings = globalThis.BugDetectorSettings.normalize();
const opts = { keys: settings.redactKeys, maskEmails: false };

test("isSensitiveKey matches fragments case-insensitively and treats - as _", () => {
  assert.ok(isSensitiveKey("userPassword", ["password"]));
  assert.ok(isSensitiveKey("X-Api-Key", ["api_key"]));
  assert.ok(!isSensitiveKey("username", ["password"]));
});

test("redactHeaders masks configured headers and inline bearer tokens", () => {
  const out = redactHeaders(
    { Authorization: "Bearer abc.def", "content-type": "application/json", "x-debug": "Bearer leaked123" },
    settings.redactHeaders
  );
  assert.equal(out.Authorization, REDACTED);
  assert.equal(out["content-type"], "application/json");
  assert.equal(out["x-debug"], `Bearer ${REDACTED}`);
});

test("redactText walks valid JSON and masks sensitive keys at any depth", () => {
  const input = JSON.stringify({ user: { email: "a@b.co", password: "hunter2" }, items: [{ token: "t1" }], ok: true });
  const out = JSON.parse(redactText(input, opts));
  assert.equal(out.user.password, REDACTED);
  assert.equal(out.items[0].token, REDACTED);
  assert.equal(out.user.email, "a@b.co");
  assert.equal(out.ok, true);
});

test("redactText keeps nested objects under sensitive keys but redacts their leaves", () => {
  const out = JSON.parse(redactText(JSON.stringify({ secret: { value: "x" } }), opts));
  assert.deepEqual(out, { secret: { value: "x" } });
  const leaf = JSON.parse(redactText(JSON.stringify({ secret_value: "x" }), opts));
  assert.equal(leaf.secret_value, REDACTED);
});

test("redactText handles truncated JSON with pattern fallback", () => {
  const out = redactText('{"cartId":"c1","password":"hunter2","token": 12345, "note":"trunc', opts);
  assert.ok(!out.includes("hunter2"));
  assert.ok(!out.includes("12345"));
  assert.ok(out.includes('"cartId":"c1"'));
});

test("redactText handles form-encoded and key: value text", () => {
  assert.equal(redactText("user=ada&password=hunter2&x=1", opts), `user=ada&password=${REDACTED}&x=1`);
  assert.equal(redactText("api_key: abc123 sent", opts), `api_key: ${REDACTED} sent`);
});

test("redactText masks JWTs anywhere and emails only when enabled", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  assert.equal(redactText(`token was ${jwt}`, { keys: [] }), `token was ${REDACTED}`);
  assert.equal(redactText("Basic usage: the token expired", { keys: [] }), "Basic usage: the token expired");
  assert.equal(redactText("contact ada@example.com", opts), "contact ada@example.com");
  assert.equal(redactText("contact ada@example.com", { ...opts, maskEmails: true }), "contact [EMAIL]");
});

test("redactUrl masks sensitive query params and credentials", () => {
  const out = redactUrl("https://user:pw@api.test/x?api_key=abc&page=2&access_token=zzz", opts);
  assert.equal(out, `https://api.test/x?api_key=${REDACTED}&page=2&access_token=${REDACTED}`);
  assert.equal(redactUrl("https://api.test/x?page=2", opts), "https://api.test/x?page=2");
});

test("truncate appends how much was cut", () => {
  assert.equal(truncate("abcdef", 3), "abc… [truncated 3 chars]");
  assert.equal(truncate("abc", 3), "abc");
  assert.equal(truncate(null, 3), null);
});

test("redactReport redacts before truncating and covers every section", () => {
  const report = {
    page: { url: "https://app.test/?token=abc", referrer: null, title: "Checkout" },
    console: [{ message: "Auth failed for Bearer abc123def456", stack: null, source: null }],
    network: [{
      url: "https://app.test/api?api_key=k",
      error: null,
      requestHeaders: { authorization: "Bearer zzz" },
      responseHeaders: { "set-cookie": "sid=1" },
      requestBody: JSON.stringify({ password: "p", padding: "x".repeat(50) }),
      responseBody: null
    }],
    breadcrumbs: [{ ts: 1, kind: "click", text: "Clicked Save" }]
  };
  const out = redactReport(report, { ...settings, maxBodyChars: 30 });
  assert.equal(out.page.url, `https://app.test/?token=${REDACTED}`);
  assert.equal(out.console[0].message, `Auth failed for Bearer ${REDACTED}`);
  assert.equal(out.network[0].requestHeaders.authorization, REDACTED);
  assert.equal(out.network[0].responseHeaders["set-cookie"], REDACTED);
  assert.ok(out.network[0].requestBody.startsWith(`{"password":"${REDACTED}"`));
  assert.ok(out.network[0].requestBody.includes("[truncated"));
  assert.equal(report.network[0].requestHeaders.authorization, "Bearer zzz", "input not mutated");
});

test("redactReport covers the picked element", () => {
  const report = {
    page: { url: "https://app.test/", referrer: null, title: "" },
    console: [], network: [], breadcrumbs: [],
    element: {
      selector: "#reset",
      text: "Reset for ada@example.com",
      html: '<a href="/reset?token=abc123" data-jwt="eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U">Reset</a>',
      attributes: { href: "https://app.test/reset?token=abc123", title: "Bearer abcdefghijkl" },
      issues: []
    }
  };
  const out = redactReport(report, { ...settings, maskEmails: true });
  assert.equal(out.element.text, "Reset for [EMAIL]");
  assert.equal(out.element.attributes.href, `https://app.test/reset?token=${REDACTED}`);
  assert.equal(out.element.attributes.title, `Bearer ${REDACTED}`);
  assert.ok(!out.element.html.includes("eyJhbGci"));
  assert.ok(!out.element.html.includes("abc123"));
});
