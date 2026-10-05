import { FORMATS, SECTIONS, formatReport, formatTimestamp } from "../lib/report-format.js";
import { getReport, updateReport, deleteReport } from "../lib/report-store.js";
import { renderComposite } from "../lib/annotations.js";
import { getSettings, updateSettings, getApiKey } from "../lib/settings.js";
import { $, h, debounce, showStatus } from "../ui/ui.js";
import { createAnnotator } from "./annotator.js";
import { setupTriage } from "./triage.js";

const PREFS_KEY = "reportPrefs";
/** Sections that only exist for some reports; their toggles are hidden otherwise. */
const OPTIONAL_SECTIONS = { triage: (report) => Boolean(report.triage), element: (report) => Boolean(report.element) };
const FILE_EXTENSIONS = { markdown: "md", slack: "txt", text: "txt", ai: "md", json: "json" };
const COPY_LABELS = { ai: "Copy AI prompt", json: "Copy JSON" };

const id = new URLSearchParams(location.search).get("id");
const stored = id ? await getReport(id).catch(() => null) : null;

if (!stored) {
  $("#missing").hidden = false;
} else {
  await init(stored);
}

/**
 * Prefs remember the sections the user turned *off*, so sections added in
 * later versions are included by default.
 */
async function loadPrefs() {
  const { [PREFS_KEY]: prefs } = await chrome.storage.local.get(PREFS_KEY);
  const sectionIds = SECTIONS.map((section) => section.id);
  let excluded = [];
  if (Array.isArray(prefs?.excluded)) excluded = prefs.excluded.filter((id) => sectionIds.includes(id));
  else if (Array.isArray(prefs?.sections)) {
    // v1.0 stored the included list.
    excluded = ["description", "network", "console", "steps", "environment"].filter((id) => !prefs.sections.includes(id));
  }
  return {
    format: FORMATS.some((format) => format.id === prefs?.format) ? prefs.format : "markdown",
    excluded
  };
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "report";
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function init(record) {
  const { screenshot, ...report } = record;
  const prefs = await loadPrefs();

  const els = {
    layout: $("#layout"),
    title: $("#title"),
    pageLink: $("#page-link"),
    created: $("#created"),
    summary: $("#summary"),
    warnings: $("#warnings"),
    shotCard: $("#shot-card"),
    screenshot: $("#screenshot"),
    toolbar: $("#annotate-toolbar"),
    annotate: $("#annotate"),
    annotateLabel: $("#annotate-label"),
    actual: $("#actual"),
    expected: $("#expected"),
    format: $("#format"),
    toggles: $("#section-toggles"),
    copyText: $("#copy-text"),
    copyTextLabel: $("#copy-text-label"),
    preview: $("#preview"),
    charCount: $("#char-count")
  };

  // ------------------------------------------------------------- header

  document.title = `${report.title} · BugDetector`;
  els.title.value = report.title;
  els.actual.value = report.description?.actual || "";
  els.expected.value = report.description?.expected || "";
  els.created.textContent = `Captured ${formatTimestamp(report.createdAt)}`;
  els.pageLink.textContent = report.page.title ? `${report.page.title} — ${report.page.url}` : report.page.url;
  els.pageLink.href = report.page.url;

  const errorCount = report.console.filter((entry) => entry.level === "error").length;
  const warnCount = report.console.length - errorCount;
  const chip = (count, label, alert) =>
    h("span", { className: `chip${alert && count ? " alert" : ""}` }, h("strong", {}, String(count)), ` ${label}`);
  els.summary.append(
    chip(report.network.length, report.network.length === 1 ? "failed request" : "failed requests", true),
    chip(errorCount, errorCount === 1 ? "console error" : "console errors", true),
    chip(warnCount, warnCount === 1 ? "warning" : "warnings", false),
    chip(report.breadcrumbs.length, report.breadcrumbs.length === 1 ? "step" : "steps", false)
  );
  for (const warning of report.warnings || []) {
    els.warnings.append(h("p", { className: "notice" }, warning));
  }

  // --------------------------------------------------------- screenshot

  let annotator = null;
  report.annotations ??= [];

  /** Screenshot with annotations and blurs applied: the only version that leaves this page. */
  const composite = (options) => renderComposite(screenshot, annotator?.annotations ?? report.annotations, options);

  const persistAnnotations = debounce((annotations) => {
    updateReport(report.id, { annotations }).catch(() => {});
  }, 300);

  if (screenshot) {
    annotator = createAnnotator({
      canvas: els.screenshot,
      toolbar: els.toolbar,
      image: await createImageBitmap(screenshot),
      annotations: report.annotations,
      onChange: (annotations) => {
        report.annotations = annotations;
        persistAnnotations(annotations);
      }
    });
  } else {
    els.shotCard.hidden = true;
  }

  els.annotate.addEventListener("click", () => {
    annotator.setEditing(!annotator.editing);
    els.annotateLabel.textContent = annotator.editing ? "Done" : "Annotate";
    els.annotate.classList.toggle("btn-primary", annotator.editing);
    if (!annotator.editing) persistAnnotations.flush(report.annotations);
  });

  $("#copy-image").addEventListener("click", async () => {
    try {
      // ClipboardItem accepts a promise, which keeps the user activation alive while rendering.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": composite() })]);
      showStatus("Screenshot copied");
    } catch (error) {
      showStatus(`Couldn't copy image: ${error.message}`, 3000);
    }
  });
  $("#download-image").addEventListener("click", async () => {
    download(await composite(), `bug-${slugify(currentReport().title)}.png`);
  });
  $("#open-image").addEventListener("click", async () => {
    chrome.tabs.create({ url: URL.createObjectURL(await composite()) });
  });

  // ------------------------------------------------------------- export

  for (const format of FORMATS) {
    els.format.append(h("option", { value: format.id }, format.label));
  }
  els.format.value = prefs.format;

  const toggleById = new Map();
  for (const section of SECTIONS) {
    const label = h("label", { className: "toggle-chip" },
      h("input", { type: "checkbox", value: section.id, checked: !prefs.excluded.includes(section.id) }),
      h("span", {}, section.label)
    );
    toggleById.set(section.id, label);
    els.toggles.append(label);
  }

  function syncOptionalToggles() {
    for (const [id, hasData] of Object.entries(OPTIONAL_SECTIONS)) toggleById.get(id).hidden = !hasData(report);
  }

  function currentOptions() {
    const inputs = [...els.toggles.querySelectorAll("input")];
    return {
      format: els.format.value,
      sections: inputs.filter((input) => input.checked).map((input) => input.value),
      excluded: inputs.filter((input) => !input.checked).map((input) => input.value)
    };
  }

  function currentReport() {
    return {
      ...report,
      title: els.title.value.trim() || report.title,
      description: { actual: els.actual.value, expected: els.expected.value }
    };
  }

  function render() {
    const options = currentOptions();
    const text = formatReport(currentReport(), options);
    els.preview.textContent = text;
    els.charCount.textContent = `${text.length.toLocaleString()} characters`;
    els.copyTextLabel.textContent = COPY_LABELS[options.format] || "Copy report";
    return text;
  }

  const persistEdits = debounce(() => {
    const { title, description } = currentReport();
    updateReport(report.id, { title, description }).catch(() => {});
  }, 400);

  const persistPrefs = () => {
    const { format, excluded } = currentOptions();
    chrome.storage.local.set({ [PREFS_KEY]: { format, excluded } });
  };

  for (const input of [els.title, els.actual, els.expected]) {
    input.addEventListener("input", () => {
      render();
      persistEdits();
    });
  }
  els.title.addEventListener("keydown", (event) => {
    if (event.key === "Enter") els.title.blur();
  });
  els.title.addEventListener("change", () => {
    document.title = `${currentReport().title} · BugDetector`;
  });
  window.addEventListener("pagehide", () => persistEdits.flush());

  els.format.addEventListener("change", () => {
    render();
    persistPrefs();
  });
  els.toggles.addEventListener("change", () => {
    render();
    persistPrefs();
  });

  els.copyText.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(render());
      showStatus(screenshot ? "Report copied. Paste it, then copy the screenshot." : "Report copied");
    } catch (error) {
      showStatus(`Couldn't copy: ${error.message}`, 3000);
    }
  });

  $("#download-text").addEventListener("click", () => {
    const { format } = currentOptions();
    const type = format === "json" ? "application/json" : "text/plain";
    download(new Blob([render()], { type }), `bug-${slugify(currentReport().title)}.${FILE_EXTENSIONS[format]}`);
  });

  $("#delete").addEventListener("click", async () => {
    if (!confirm("Delete this report? This can't be undone.")) return;
    await deleteReport(report.id);
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) chrome.tabs.remove(tab.id);
  });

  // -------------------------------------------------------------- triage

  const settings = await getSettings();
  setupTriage({
    report,
    hasApiKey: Boolean(await getApiKey()),
    settings,
    hasScreenshot: Boolean(screenshot),
    getReport: currentReport,
    getScreenshot: composite,
    onIncludeScreenshotChange: (value) => updateSettings({ aiIncludeScreenshot: value }),
    onTriage: async (triage) => {
      report.triage = triage;
      syncOptionalToggles();
      render();
      await updateReport(report.id, { triage });
    },
    onUseTitle: (title) => {
      els.title.value = title;
      document.title = `${title} · BugDetector`;
      render();
      persistEdits.flush();
    }
  });

  syncOptionalToggles();
  render();
  els.layout.hidden = false;
}
