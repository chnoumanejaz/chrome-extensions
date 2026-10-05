/**
 * AI triage card on the report page. The Anthropic SDK bundle is imported
 * lazily, only when the user actually runs triage.
 */
import { AI_MODELS, MAX_IMAGE_EDGE, TriageError, runTriage } from "../lib/ai-triage.js";
import { getApiKey } from "../lib/settings.js";
import { $, h } from "../ui/ui.js";

const SEVERITY_LABELS = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
const AREA_LABELS = { frontend: "Frontend", backend: "Backend / API", network: "Network", configuration: "Configuration", unknown: "Unclear" };

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function modelName(id) {
  return AI_MODELS.find((model) => id?.startsWith(model.id))?.name || id || "Claude";
}

function list(tag, items) {
  return h(tag, {}, items.map((item) => h("li", {}, item)));
}

function renderResult(container, triage, onUseTitle) {
  container.replaceChildren(
    h("div", { className: "triage-badges" },
      h("span", { className: `severity severity-${triage.severity}` }, `${SEVERITY_LABELS[triage.severity]} severity`),
      h("span", { className: "chip" }, AREA_LABELS[triage.area] || triage.area)
    ),
    h("p", { className: "triage-summary" }, triage.summary),
    h("dl", { className: "triage-fields" },
      h("dt", {}, "Suggested title"),
      h("dd", { className: "triage-title-row" },
        h("span", {}, triage.title),
        h("button", { type: "button", className: "btn btn-ghost btn-sm", onclick: () => onUseTitle(triage.title) }, "Use this title")
      ),
      h("dt", {}, "Why this severity"),
      h("dd", {}, triage.severity_reason),
      h("dt", {}, "Likely root cause"),
      h("dd", {}, triage.likely_root_cause),
      triage.evidence.length ? [h("dt", {}, "Evidence"), h("dd", {}, list("ul", triage.evidence))] : null,
      h("dt", {}, "Suggested fix"),
      h("dd", {}, triage.suggested_fix),
      triage.next_steps.length ? [h("dt", {}, "Next steps"), h("dd", {}, list("ol", triage.next_steps))] : null
    ),
    h("p", { className: "small muted" }, "AI-generated. Verify before acting on it. Included in the report when the “AI triage” section is on.")
  );
  container.hidden = false;
}

async function explain(error) {
  if (error instanceof TriageError) return error.message;
  try {
    const { describeClaudeError } = await import("../lib/claude-client.js");
    return describeClaudeError(error);
  } catch {
    return error?.message || String(error);
  }
}

/**
 * @param {object} options
 * @param {object} options.report
 * @param {boolean} options.hasApiKey
 * @param {object} options.settings
 * @param {boolean} options.hasScreenshot
 * @param {() => object} options.getReport          current (edited) report
 * @param {(opts: object) => Promise<Blob>} options.getScreenshot   annotated composite
 * @param {(value: boolean) => void} options.onIncludeScreenshotChange
 * @param {(triage: object) => Promise<void>} options.onTriage
 * @param {(title: string) => void} options.onUseTitle
 */
export function setupTriage(options) {
  const els = {
    meta: $("#triage-meta"),
    intro: $("#triage-intro"),
    result: $("#triage-result"),
    error: $("#triage-error"),
    actions: $("#triage-actions"),
    includeShot: $("#triage-include-shot"),
    run: $("#triage-run"),
    runLabel: $("#triage-run-label"),
    setup: $("#triage-setup")
  };

  $("#open-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

  if (!options.hasApiKey) {
    els.actions.hidden = true;
    els.setup.hidden = false;
  }

  els.includeShot.checked = options.hasScreenshot && options.settings.aiIncludeScreenshot;
  els.includeShot.disabled = !options.hasScreenshot;
  els.includeShot.addEventListener("change", () => options.onIncludeScreenshotChange(els.includeShot.checked));

  function showTriage(triage) {
    els.intro.hidden = true;
    els.meta.textContent = modelName(triage.model);
    els.runLabel.textContent = "Analyze again";
    renderResult(els.result, triage, options.onUseTitle);
  }

  if (options.report.triage) showTriage(options.report.triage);

  els.run.addEventListener("click", async () => {
    els.run.disabled = true;
    els.run.classList.add("busy");
    els.runLabel.textContent = "Analyzing… (up to a minute)";
    els.error.hidden = true;

    try {
      const apiKey = await getApiKey();
      if (!apiKey) throw new TriageError("Add your Claude API key in Settings first.", "no_key");
      // Imported lazily so the SDK bundle only loads when triage is used.
      const { createClaudeClient } = await import("../lib/claude-client.js");

      let imageBase64 = null;
      if (els.includeShot.checked) {
        imageBase64 = await blobToBase64(await options.getScreenshot({ maxEdge: MAX_IMAGE_EDGE }));
      }

      const triage = await runTriage(createClaudeClient(apiKey), options.getReport(), {
        model: options.settings.aiModel,
        imageBase64
      });
      await options.onTriage(triage);
      showTriage(triage);
    } catch (error) {
      els.error.textContent = await explain(error);
      els.error.hidden = false;
      els.runLabel.textContent = options.report.triage ? "Analyze again" : "Analyze with Claude";
    } finally {
      els.run.disabled = false;
      els.run.classList.remove("busy");
    }
  });
}
