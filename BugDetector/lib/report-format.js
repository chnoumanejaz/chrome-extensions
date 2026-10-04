import "../shared/settings-schema.js";

/**
 * Renders a report as Markdown, Slack, plain text, an AI prompt or JSON.
 * Pure functions — unit tested in test/unit/report-format.test.mjs.
 */

export const FORMATS = Object.freeze([
  { id: "markdown", label: "Markdown (GitHub, Jira, Linear, Notion)" },
  { id: "slack", label: "Slack / Teams" },
  { id: "text", label: "Plain text (email, anything)" },
  { id: "ai", label: "AI prompt (Claude, ChatGPT…)" },
  { id: "json", label: "JSON" }
]);

export const SECTIONS = Object.freeze([
  { id: "description", label: "Description" },
  { id: "triage", label: "AI triage" },
  { id: "element", label: "Selected element" },
  { id: "network", label: "Failed requests" },
  { id: "console", label: "Console errors" },
  { id: "steps", label: "Steps before the bug" },
  { id: "environment", label: "Environment" }
]);

const ALL_SECTIONS = SECTIONS.map((section) => section.id);

/** Response headers worth showing in text formats (all are kept in JSON). */
const USEFUL_RESPONSE_HEADERS = [
  "content-type",
  "x-request-id",
  "x-correlation-id",
  "x-trace-id",
  "traceparent",
  "x-amzn-requestid",
  "x-amzn-trace-id",
  "cf-ray",
  "x-error",
  "x-error-code",
  "retry-after",
  "www-authenticate"
];

const MAX_STACK_LINES = 8;

function longestRun(text, char) {
  let longest = 0;
  let current = 0;
  for (const c of text) {
    current = c === char ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function fence(text, lang = "") {
  const ticks = "`".repeat(Math.max(3, longestRun(text, "`") + 1));
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function inlineCode(text) {
  const value = String(text);
  const ticks = "`".repeat(longestRun(value, "`") + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${ticks}${pad}${value}${pad}${ticks}`;
}

const DIALECTS = {
  markdown: {
    title: (t) => `## 🐞 ${t}`,
    heading: (t) => `### ${t}`,
    bold: (t) => `**${t}**`,
    code: inlineCode,
    block: fence,
    link: (text, url) => (text && text !== url ? `[${text.replace(/[[\]]/g, "")}](${url})` : url)
  },
  slack: {
    title: (t) => `:lady_beetle: *${t}*`,
    heading: (t) => `*${t}*`,
    bold: (t) => `*${t}*`,
    code: inlineCode,
    block: (text) => fence(text),
    link: (text, url) => (text && text !== url ? `${text} (${url})` : url)
  },
  text: {
    title: (t) => `BUG: ${t}\n${"=".repeat(Math.min(60, t.length + 5))}`,
    heading: (t) => `${t.toUpperCase()}\n${"-".repeat(Math.min(60, t.length))}`,
    bold: (t) => t,
    code: (t) => t,
    block: (text) => text.split("\n").map((line) => `    ${line}`).join("\n"),
    link: (text, url) => (text && text !== url ? `${text} (${url})` : url)
  }
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Local "YYYY-MM-DD HH:MM:SS" — stable across locales. */
export function formatTimestamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** "3s before", "2m 5s before", "at capture". */
export function relativeTime(ts, reference) {
  const seconds = Math.round((reference - ts) / 1000);
  if (seconds <= 0) return "at capture";
  if (seconds < 60) return `${seconds}s before`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s before`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m before`;
}

function prettyBody(body) {
  if (body == null || body === "") return null;
  const text = String(body);
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { text: JSON.stringify(JSON.parse(trimmed), null, 2), lang: "json" };
    } catch {
      // truncated or not JSON
    }
  }
  return { text, lang: "" };
}

function trimStack(stack) {
  const lines = String(stack).split("\n").map((line) => line.trimEnd()).filter(Boolean);
  // Drop the first line when it repeats the message ("TypeError: …").
  if (lines.length && !/^\s*at\s|@/.test(lines[0])) lines.shift();
  const kept = lines.slice(0, MAX_STACK_LINES).map((line) => line.trim());
  if (lines.length > MAX_STACK_LINES) kept.push(`… ${lines.length - MAX_STACK_LINES} more frames`);
  return kept.join("\n");
}

function headerLines(headers, only) {
  return Object.entries(headers || {})
    .filter(([key]) => !only || only.includes(key.toLowerCase()))
    .map(([key, value]) => `${key}: ${value}`);
}

function describeStatus(entry) {
  if (entry.status) return `${entry.status}${entry.statusText ? ` ${entry.statusText}` : ""}`;
  return entry.error || "Network error";
}

function viewportText(env) {
  if (!env.viewport) return null;
  const dpr = env.devicePixelRatio && env.devicePixelRatio !== 1 ? ` @${env.devicePixelRatio}x` : "";
  return `${env.viewport.width}×${env.viewport.height}${dpr}`;
}

/*
 * Section renderers return a list of blocks that are joined with blank lines.
 * Entries are bold "headline" paragraphs rather than list items, so code
 * blocks under them render correctly in every Markdown flavour.
 */

function renderNetwork(report, d) {
  const out = [d.heading(`Failed requests (${report.network.length})`)];
  if (!report.network.length) return [...out, "None captured."];

  report.network.forEach((entry, index) => {
    const meta = [];
    if (entry.durationMs != null) meta.push(`${entry.durationMs} ms`);
    if (entry.resourceType && entry.initiator !== "fetch" && entry.initiator !== "xhr") meta.push(entry.resourceType);
    meta.push(relativeTime(entry.ts, report.createdAt));

    const parts = [`${d.bold(`${index + 1}. ${entry.method} ${describeStatus(entry)}`)} ${d.code(entry.url)} · ${meta.join(" · ")}`];
    if (entry.status && entry.error) parts.push(`Error: ${entry.error}`);

    const requestHeaders = headerLines(entry.requestHeaders);
    if (requestHeaders.length) parts.push(`Request headers:\n${d.block(requestHeaders.join("\n"))}`);

    const request = prettyBody(entry.requestBody);
    if (request) parts.push(`Request body:\n${d.block(request.text, request.lang)}`);

    const responseHeaders = headerLines(entry.responseHeaders, USEFUL_RESPONSE_HEADERS);
    if (responseHeaders.length) parts.push(`Response headers:\n${d.block(responseHeaders.join("\n"))}`);

    const response = prettyBody(entry.responseBody);
    if (response) parts.push(`Response body:\n${d.block(response.text, response.lang)}`);

    out.push(parts.join("\n\n"));
  });
  return out;
}

function renderConsole(report, d) {
  const out = [d.heading(`Console errors (${report.console.length})`)];
  if (!report.console.length) return [...out, "None captured."];

  report.console.forEach((entry, index) => {
    const label = entry.level === "warn" ? "Warning: " : "";
    const repeat = entry.count > 1 ? ` (×${entry.count})` : "";
    const [headline, ...rest] = String(entry.message).split("\n");
    const parts = [`${d.bold(`${index + 1}. ${label}${headline}`)}${repeat} · ${relativeTime(entry.ts, report.createdAt)}`];
    const details = [];
    if (rest.length) details.push(rest.join("\n"));
    const stack = entry.stack ? trimStack(entry.stack) : "";
    if (entry.source && !stack.includes(entry.source)) details.push(`at ${entry.source}`);
    if (stack) details.push(stack);
    const detailText = details.join("\n").trim();
    if (detailText) parts.push(d.block(detailText));
    out.push(parts.join("\n"));
  });
  return out;
}

function renderSteps(report, d) {
  const heading = d.heading("Steps before the bug");
  if (!report.breadcrumbs.length) return [heading, "No interactions recorded."];
  return [heading, report.breadcrumbs
    .map((crumb, index) => `${index + 1}. ${crumb.text} ${d.code(relativeTime(crumb.ts, report.createdAt))}`)
    .join("\n")];
}

function renderEnvironment(report, d) {
  const env = report.environment;
  const rows = [
    ["Browser", `${env.browser} on ${env.os}`],
    ["Viewport", viewportText(env)],
    ["Screen", env.screen ? `${env.screen.width}×${env.screen.height}` : null],
    ["Language", env.language],
    ["Timezone", env.timezone],
    ["Color scheme", env.colorScheme],
    ["Online", env.online == null ? null : env.online ? "yes" : "no"],
    ["Page load", report.page.loadTimeMs != null ? `${(report.page.loadTimeMs / 1000).toFixed(2)} s` : null],
    ["Referrer", report.page.referrer],
    ["User agent", env.userAgent]
  ].filter(([, value]) => value);
  return [d.heading("Environment"), rows.map(([key, value]) => `- ${key}: ${value}`).join("\n")];
}


function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function renderTriage(report, d) {
  const triage = report.triage;
  if (!triage) return [];
  const model = globalThis.BugDetectorSettings.AI_MODELS.find((m) => triage.model?.startsWith(m.id))?.name || triage.model;
  const out = [d.heading(`AI triage${model ? ` (${model})` : ""}`)];
  out.push([
    `${d.bold("Severity:")} ${capitalize(triage.severity)}: ${triage.severity_reason}`,
    `${d.bold("Area:")} ${capitalize(triage.area)}`,
    `${d.bold("Summary:")} ${triage.summary}`
  ].join("\n"));
  out.push(`${d.bold("Likely root cause:")} ${triage.likely_root_cause}`);
  if (triage.evidence?.length) out.push(`${d.bold("Evidence:")}\n${triage.evidence.map((item) => `- ${item}`).join("\n")}`);
  out.push(`${d.bold("Suggested fix:")} ${triage.suggested_fix}`);
  if (triage.next_steps?.length) {
    out.push(`${d.bold("Next steps:")}\n${triage.next_steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`);
  }
  out.push("AI-generated: verify before acting on it.");
  return out;
}

function renderElement(report, d) {
  const el = report.element;
  if (!el) return [];
  const out = [d.heading("Selected element")];
  const size = el.rect ? ` · ${el.rect.width}×${el.rect.height} at (${el.rect.x}, ${el.rect.y})` : "";
  out.push(`${d.code(el.selector)}${el.text ? ` "${el.text}"` : ""}${size}`);
  if (el.issues?.length) {
    out.push(`${d.bold("Possible problems:")}\n${el.issues.map((issue) => `- ${issue}`).join("\n")}`);
  } else {
    out.push("No obvious problems detected (visible, enabled, not covered).");
  }
  const styles = Object.entries(el.styles || {}).map(([key, value]) => `${key}: ${value}`);
  if (styles.length) out.push(`Computed styles:\n${d.block(styles.join("\n"))}`);
  if (el.html) out.push(`HTML:\n${d.block(el.html, "html")}`);
  return out;
}

function renderDescription(report, d) {
  const { actual, expected } = report.description || {};
  const out = [];
  if (actual?.trim()) out.push(`${d.bold("What happened:")} ${actual.trim()}`);
  if (expected?.trim()) out.push(`${d.bold("Expected:")} ${expected.trim()}`);
  return out.length ? [out.join("\n")] : [];
}

function renderHuman(report, dialectId, sections) {
  const d = DIALECTS[dialectId];
  const env = report.environment;
  const blocks = [];

  const summary = [
    `${d.bold("Page:")} ${d.link(report.page.title, report.page.url)}`,
    `${d.bold("Captured:")} ${formatTimestamp(report.createdAt)}${env.timezone ? ` (${env.timezone})` : ""}`,
    `${d.bold("Browser:")} ${env.browser} on ${env.os}${viewportText(env) ? ` · ${viewportText(env)}` : ""}`
  ];
  blocks.push(`${d.title(report.title || "Bug report")}\n\n${summary.join("\n")}`);

  const renderers = {
    description: renderDescription,
    triage: renderTriage,
    element: renderElement,
    network: renderNetwork,
    console: renderConsole,
    steps: renderSteps,
    environment: renderEnvironment
  };
  for (const id of ALL_SECTIONS) {
    if (!sections.includes(id)) continue;
    blocks.push(...renderers[id](report, d));
  }

  if (report.warnings?.length) {
    blocks.push(report.warnings.map((warning) => `> ${warning}`).join("\n"));
  }

  const footer = `${report.hasScreenshot ? "Screenshot attached separately. " : ""}Captured with BugDetector.`;
  blocks.push(dialectId === "text" ? footer : `_${footer}_`);

  return blocks.join("\n\n");
}

function renderAiPrompt(report, sections) {
  const screenshot = report.hasScreenshot ? " (I'll also paste a screenshot of the page)" : "";
  return [
    "You are a senior web engineer helping me debug a bug in a web application.",
    `Below is evidence captured automatically from the browser at the moment the bug happened${screenshot}: failed network requests with their request/response bodies, console errors with stack traces, and the user's last interactions. Secrets were redacted as [REDACTED].`,
    "Please:\n1. Identify the most likely root cause and quote the evidence that points to it.\n2. Say whether the problem is most likely in the frontend, the backend/API, or configuration, and where to look.\n3. Suggest a concrete fix and how to verify it.\n4. If the evidence is inconclusive, tell me exactly what extra information to collect.",
    "---",
    renderHuman(report, "markdown", sections)
  ].join("\n\n");
}

function renderJson(report, sections) {
  const { id, version, createdAt, title, description, page, environment, console: logs, network, breadcrumbs, warnings, triage, element } = report;
  const out = { title, createdAt: new Date(createdAt).toISOString(), page };
  if (sections.includes("description")) out.description = description;
  if (sections.includes("triage") && triage) out.triage = triage;
  if (sections.includes("element") && element) out.element = element;
  if (sections.includes("network")) out.network = network;
  if (sections.includes("console")) out.console = logs;
  if (sections.includes("steps")) out.steps = breadcrumbs;
  if (sections.includes("environment")) out.environment = environment;
  if (warnings?.length) out.warnings = warnings;
  out.meta = { id, version, generator: "BugDetector" };
  return JSON.stringify(out, null, 2);
}

/**
 * @param {object} report
 * @param {{ format?: string, sections?: string[] }} [options]
 * @returns {string}
 */
export function formatReport(report, { format = "markdown", sections = ALL_SECTIONS } = {}) {
  switch (format) {
    case "ai": return renderAiPrompt(report, sections);
    case "json": return renderJson(report, sections);
    case "markdown":
    case "slack":
    case "text": return renderHuman(report, format, sections);
    default: throw new Error(`Unknown report format: ${format}`);
  }
}
