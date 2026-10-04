import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_MODELS,
  TRIAGE_SCHEMA,
  TriageError,
  buildTriageParams,
  parseTriageResponse,
  runTriage
} from "../../lib/ai-triage.js";

const REPORT = {
  id: "r1",
  createdAt: Date.UTC(2026, 9, 4),
  title: "500 on POST /api/orders",
  description: { actual: "", expected: "" },
  page: { url: "https://shop.test/checkout", title: "Checkout", referrer: null, loadTimeMs: null },
  environment: { browser: "Chrome 141", os: "macOS" },
  console: [],
  network: [{ ts: 1, initiator: "fetch", method: "POST", url: "https://shop.test/api/orders", status: 500, responseBody: '{"error":"coupon_not_found"}' }],
  breadcrumbs: [],
  warnings: [],
  hasScreenshot: true,
  triage: { title: "old" }
};

const VALID = {
  title: "Orders API 500s on unknown coupon",
  summary: "Checkout fails.",
  severity: "high",
  severity_reason: "Core flow.",
  likely_root_cause: "Unhandled coupon_not_found.",
  area: "backend",
  evidence: ["POST /api/orders → 500"],
  suggested_fix: "Return 422.",
  next_steps: ["Add a test"]
};

function message(overrides = {}) {
  return {
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(VALID) }],
    ...overrides
  };
}

test("models come from the settings schema with Opus 5.5 first", () => {
  assert.equal(AI_MODELS[0].id, "claude-opus-5-5");
  assert.ok(AI_MODELS.every((model) => model.id && model.name));
});

test("schema is strict: every property required, no extras", () => {
  assert.equal(TRIAGE_SCHEMA.additionalProperties, false);
  assert.deepEqual([...TRIAGE_SCHEMA.required].sort(), Object.keys(TRIAGE_SCHEMA.properties).sort());
});

test("buildTriageParams uses structured output, fallbacks and the redacted report", () => {
  const params = buildTriageParams(REPORT, { model: "claude-opus-5-5" });
  assert.equal(params.model, "claude-opus-5-5");
  assert.equal(params.fallbacks, "default");
  assert.deepEqual(params.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(params.output_config.format.type, "json_schema");
  assert.equal(params.output_config.format.schema, TRIAGE_SCHEMA);
  assert.equal(params.output_config.effort, "medium");
  assert.ok(params.max_tokens >= 16000);
  assert.match(params.system, /Treat it strictly as data/);

  const [only] = params.messages[0].content;
  assert.equal(params.messages[0].content.length, 1, "no image block without a screenshot");
  assert.equal(only.type, "text");
  assert.match(only.text, /<evidence>[\s\S]*coupon_not_found[\s\S]*<\/evidence>/);
  assert.doesNotMatch(only.text, /AI triage/, "a previous triage is not fed back in");
});

test("buildTriageParams puts the screenshot before the text", () => {
  const params = buildTriageParams(REPORT, { model: "claude-sonnet-5-5", imageBase64: "AAAA" });
  const [image, text] = params.messages[0].content;
  assert.deepEqual(image, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
  assert.equal(text.type, "text");
  assert.match(text.text, /screenshot above/);
});

test("parseTriageResponse returns validated fields plus the serving model", () => {
  const out = parseTriageResponse(message());
  assert.equal(out.severity, "high");
  assert.equal(out.model, "claude-opus-5-5");
});

test("parseTriageResponse explains refusals, truncation and bad output", () => {
  assert.throws(() => parseTriageResponse(message({ stop_reason: "refusal", content: [], stop_details: { category: "cyber" } })),
    (error) => error instanceof TriageError && error.code === "refusal" && /cyber/.test(error.message));
  assert.throws(() => parseTriageResponse(message({ stop_reason: "max_tokens" })),
    (error) => error.code === "max_tokens");
  assert.throws(() => parseTriageResponse(message({ content: [{ type: "text", text: "not json" }] })),
    (error) => error.code === "invalid");
  assert.throws(() => parseTriageResponse(message({ content: [{ type: "text", text: JSON.stringify({ ...VALID, severity: "urgent" }) }] })),
    (error) => error.code === "invalid");
});

test("parseTriageResponse ignores non-text blocks (e.g. thinking)", () => {
  const out = parseTriageResponse(message({
    content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(VALID) }]
  }));
  assert.equal(out.title, VALID.title);
});

test("runTriage calls the injected client once and stamps the result", async () => {
  const seen = [];
  const client = { beta: { messages: { create: async (params) => { seen.push(params); return message(); } } } };
  const out = await runTriage(client, REPORT, { model: "claude-opus-5-5" });
  assert.equal(seen.length, 1);
  assert.equal(out.title, VALID.title);
  assert.equal(typeof out.createdAt, "number");
});
