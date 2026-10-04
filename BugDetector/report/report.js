import { FORMATS, SECTIONS, formatReport, formatTimestamp } from "../lib/report-format.js";
import { getReport, updateReport, deleteReport } from "../lib/report-store.js";
import { $, h, debounce, showStatus } from "../ui/ui.js";

const PREFS_KEY = "reportPrefs";
const FILE_EXTENSIONS = { markdown: "md", slack: "txt", text: "txt", ai: "md", json: "json" };
const COPY_LABELS = { ai: "Copy AI prompt", json: "Copy JSON" };

const id = new URLSearchParams(location.search).get("id");
const stored = id ? await getReport(id).catch(() => null) : null;

if (!stored) {
  $("#missing").hidden = false;
} else {
  await init(stored);
}

async function loadPrefs() {
  const { [PREFS_KEY]: prefs } = await chrome.storage.local.get(PREFS_KEY);
  const sectionIds = SECTIONS.map((section) => section.id);
  return {
    format: FORMATS.some((format) => format.id === prefs?.format) ? prefs.format : "markdown",
    sections: Array.isArray(prefs?.sections) ? prefs.sections.filter((s) => sectionIds.includes(s)) : sectionIds
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

  let screenshotUrl = null;
  if (screenshot) {
    screenshotUrl = URL.createObjectURL(screenshot);
    els.screenshot.src = screenshotUrl;
  } else {
    els.shotCard.hidden = true;
  }

  $("#copy-image").addEventListener("click", async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ [screenshot.type || "image/png"]: screenshot })]);
      showStatus("Screenshot copied");
    } catch (error) {
      showStatus(`Couldn't copy image: ${error.message}`, 3000);
    }
  });
  $("#download-image").addEventListener("click", () => {
    download(screenshot, `bug-${slugify(report.title)}.png`);
  });
  $("#open-image").addEventListener("click", () => {
    chrome.tabs.create({ url: screenshotUrl });
  });

  // ------------------------------------------------------------- export

  for (const format of FORMATS) {
    els.format.append(h("option", { value: format.id }, format.label));
  }
  els.format.value = prefs.format;

  for (const section of SECTIONS) {
    els.toggles.append(h("label", { className: "toggle-chip" },
      h("input", { type: "checkbox", value: section.id, checked: prefs.sections.includes(section.id) }),
      h("span", {}, section.label)
    ));
  }

  function currentOptions() {
    return {
      format: els.format.value,
      sections: [...els.toggles.querySelectorAll("input:checked")].map((input) => input.value)
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

  const persistPrefs = () => chrome.storage.local.set({ [PREFS_KEY]: currentOptions() });

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

  render();
  els.layout.hidden = false;
}
