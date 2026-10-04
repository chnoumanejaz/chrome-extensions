import "../shared/site-match.js";
import { Msg } from "../lib/messages.js";
import { getSettings, updateSettings } from "../lib/settings.js";
import { listReports } from "../lib/report-store.js";
import { $, h, timeAgo, getCaptureShortcut, openShortcutSettings, openReport } from "../ui/ui.js";

const Sites = globalThis.BugDetectorSites;

const els = {
  host: $("#page-host"),
  stats: $("#page-stats"),
  notice: $("#page-notice"),
  capture: $("#capture"),
  captureLabel: $("#capture-label"),
  captureError: $("#capture-error"),
  shortcut: $("#shortcut"),
  autoDetect: $("#auto-detect"),
  sensitivity: $("#sensitivity"),
  siteRow: $("#site-row"),
  siteEnabled: $("#site-enabled"),
  siteHint: $("#site-hint"),
  recent: $("#recent-list")
};

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let settings = await getSettings();
let host = "";

function tabHost() {
  try {
    const url = new URL(tab?.url || "");
    return /^https?:$/.test(url.protocol) ? url.host : "";
  } catch {
    return "";
  }
}

function chip(count, label, alert) {
  return h("span", { className: `chip${alert && count ? " alert" : ""}` }, h("strong", {}, String(count)), ` ${label}`);
}

function plural(count, word) {
  return count === 1 ? word : `${word}s`;
}

async function renderPage() {
  host = tabHost();
  els.host.textContent = host || (tab?.title ?? "This page");

  let pageStats = null;
  if (tab?.id && host) {
    pageStats = await chrome.tabs.sendMessage(tab.id, { type: Msg.GET_STATS }, { frameId: 0 }).catch(() => null);
  }

  els.stats.replaceChildren();
  if (pageStats) {
    const { errors, failedRequests, warnings } = pageStats.stats;
    els.stats.append(
      chip(errors, plural(errors, "error"), true),
      chip(failedRequests, `failed ${plural(failedRequests, "request")}`, true),
      chip(warnings, plural(warnings, "warning"), false)
    );
    els.notice.hidden = true;
  } else {
    els.notice.hidden = false;
    els.notice.textContent = host
      ? "BugDetector isn't running on this tab yet. Reload the page to start collecting errors (a screenshot can still be captured)."
      : "This page can't be inspected (browser pages and the Web Store are off-limits).";
  }

  renderSite();
}

function renderSite() {
  els.siteRow.hidden = !host;
  if (!host) return;
  const state = Sites.siteState(host, settings);
  els.siteEnabled.checked = state.enabled;
  els.siteHint.replaceChildren(!state.enabled
    ? "Not collecting anything here"
    : state.muted ? "Collecting, popup muted here" : "Collecting errors here");
  if (state.enabled && state.muted) {
    els.siteHint.append(" · ", h("button", { className: "linklike", type: "button", onclick: unmute }, "Unmute"));
  }
}

function renderSettings() {
  els.autoDetect.checked = settings.autoDetect;
  els.sensitivity.value = settings.sensitivity;
  els.sensitivity.disabled = !settings.autoDetect;
}

async function renderRecent() {
  const reports = await listReports(5).catch(() => []);
  els.recent.replaceChildren();
  if (!reports.length) {
    els.recent.append(h("li", { className: "empty" }, "No reports yet. Capture one when something breaks."));
    return;
  }
  for (const report of reports) {
    let site = "";
    try {
      site = new URL(report.page.url).host;
    } catch {
      // ignore
    }
    els.recent.append(h("li", {},
      h("button", { type: "button", onclick: () => openReport(report.id) },
        h("span", { className: "title" }, report.title),
        h("span", { className: "meta" }, [site, timeAgo(report.createdAt)].filter(Boolean).join(" · "))
      )
    ));
  }
}

async function save(patch) {
  settings = await updateSettings(patch);
  renderSettings();
  renderSite();
}

async function unmute() {
  await save({ mutedSites: settings.mutedSites.filter((pattern) => !Sites.matchesHost(host, pattern)) });
}

els.autoDetect.addEventListener("change", () => save({ autoDetect: els.autoDetect.checked }));
els.sensitivity.addEventListener("change", () => save({ sensitivity: els.sensitivity.value }));

els.siteEnabled.addEventListener("change", () => {
  const enable = els.siteEnabled.checked;
  const hostname = host.replace(/:\d+$/, "");
  const without = (list) => list.filter((pattern) => !Sites.matchesHost(host, pattern));

  if (settings.siteMode === "allowlist") {
    save({ allowlist: enable ? [...settings.allowlist, hostname] : without(settings.allowlist) });
  } else {
    save({ blocklist: enable ? without(settings.blocklist) : [...settings.blocklist, hostname] });
  }
});

els.capture.addEventListener("click", async () => {
  els.capture.disabled = true;
  els.captureLabel.textContent = "Capturing…";
  els.captureError.hidden = true;

  const result = await chrome.runtime.sendMessage({ type: Msg.CAPTURE_REQUEST, tabId: tab?.id })
    .catch((error) => ({ ok: false, error: error.message }));

  if (result?.ok) {
    window.close();
    return;
  }
  els.capture.disabled = false;
  els.captureLabel.textContent = "Capture bug";
  els.captureError.hidden = false;
  els.captureError.textContent = `Capture failed: ${result?.error || "unknown error"}`;
});

$("#open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("#change-shortcut").addEventListener("click", openShortcutSettings);

getCaptureShortcut().then((shortcut) => {
  els.shortcut.textContent = shortcut || "Not set";
});

renderSettings();
renderPage();
renderRecent();
