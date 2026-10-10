import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/protocol.js";
import "../../shared/settings-schema.js";
import "../../shared/site-match.js";
import "../../shared/ring-buffer.js";

const { BugDetectorSettings: Settings, BugDetectorSites: Sites, BugDetectorRingBuffer: RingBuffer } = globalThis;

test("RingBuffer keeps the newest items in order", () => {
  const buffer = new RingBuffer(3);
  assert.equal(buffer.last(), undefined);
  for (const n of [1, 2, 3, 4, 5]) buffer.push(n);
  assert.deepEqual(buffer.toArray(), [3, 4, 5]);
  assert.equal(buffer.last(), 5);
  assert.equal(buffer.size, 3);
  buffer.clear();
  assert.deepEqual(buffer.toArray(), []);
  assert.throws(() => new RingBuffer(0), RangeError);
});

test("settings normalize fills defaults, drops unknown keys and validates values", () => {
  const out = Settings.normalize({
    autoDetect: "yes",
    sensitivity: "loud",
    cooldownSeconds: "999999",
    maxBodyChars: 50,
    blocklist: [" a.com ", "", "a.com", 42],
    extra: true
  });
  assert.equal(out.autoDetect, true, "wrong type falls back");
  assert.equal(out.sensitivity, "errors+network", "unknown enum falls back");
  assert.equal(out.cooldownSeconds, 3600, "clamped to max");
  assert.equal(out.maxBodyChars, 200, "clamped to min");
  assert.deepEqual(out.blocklist, ["a.com"], "trimmed, deduped, non-strings dropped");
  assert.equal("extra" in out, false);
  assert.deepEqual(Settings.normalize(), Settings.normalize({}));
});

test("settings normalize never returns the frozen default arrays", () => {
  const out = Settings.normalize();
  out.allowlist.push("x.test");
  assert.ok(!Settings.DEFAULTS.allowlist.includes("x.test"));
});

test("site patterns", () => {
  assert.ok(Sites.matchesHost("example.com", "example.com"));
  assert.ok(Sites.matchesHost("app.example.com", "example.com"));
  assert.ok(!Sites.matchesHost("badexample.com", "example.com"));
  assert.ok(Sites.matchesHost("app.example.com", "*.example.com"));
  assert.ok(!Sites.matchesHost("example.com", "*.example.com"));
  assert.ok(Sites.matchesHost("localhost:3000", "localhost"));
  assert.ok(Sites.matchesHost("localhost:3000", "localhost:3000"));
  assert.ok(!Sites.matchesHost("localhost:4000", "localhost:3000"));
  assert.ok(Sites.matchesHost("staging.app.io", "https://staging.app.io/dashboard"));
  assert.ok(!Sites.matchesHost("example.com", ""));
});

test("siteState honours mode, lists and mute", () => {
  const base = Settings.normalize();
  assert.deepEqual(Sites.siteState("shop.test", base), { enabled: true, muted: false });
  assert.deepEqual(Sites.siteState("shop.test", { ...base, blocklist: ["shop.test"] }), { enabled: false, muted: false });
  assert.deepEqual(Sites.siteState("shop.test", { ...base, siteMode: "allowlist" }), { enabled: false, muted: false });
  assert.deepEqual(Sites.siteState("localhost:5173", { ...base, siteMode: "allowlist" }), { enabled: true, muted: false });
  assert.deepEqual(Sites.siteState("shop.test", { ...base, mutedSites: ["shop.test"] }), { enabled: true, muted: true });
});

test("protocol is frozen and complete", () => {
  const { Msg, HOOK_EVENT } = globalThis.BugDetectorProtocol;
  assert.equal(HOOK_EVENT, "bugdetector:event");
  assert.ok(Object.isFrozen(Msg));
  assert.deepEqual(Object.keys(Msg).sort(), ["BADGE_UPDATE", "CAPTURE_FINISHED", "CAPTURE_REQUEST", "GET_STATS", "NO_ISSUES", "PREPARE_CAPTURE", "START_PICKER"]);
});

test("AI model setting only accepts known models", () => {
  assert.equal(Settings.normalize().aiModel, "claude-opus-5-5");
  assert.equal(Settings.normalize({ aiModel: "claude-sonnet-5-5" }).aiModel, "claude-sonnet-5-5");
  assert.equal(Settings.normalize({ aiModel: "gpt-4" }).aiModel, "claude-opus-5-5");
  assert.equal(Settings.normalize({ aiIncludeScreenshot: false }).aiIncludeScreenshot, false);
});
