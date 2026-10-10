/**
 * Capture orchestration: page snapshot → screenshot → report → redaction →
 * IndexedDB → report tab. Every step degrades gracefully: a page without the
 * content script (chrome://, Web Store, PDF) still yields a report with
 * whatever could be collected, plus a warning explaining what's missing.
 */
import { Msg } from "../lib/messages.js";
import { getSettings } from "../lib/settings.js";
import { buildReport, hasNoIssues } from "../lib/report-model.js";
import { redactReport } from "../lib/redact.js";
import { saveReport } from "../lib/report-store.js";
import { getTabRequests } from "./network-monitor.js";

const SNAPSHOT_TIMEOUT_MS = 3000;

// One capture per tab at a time (shortcut mashing, toast + shortcut together).
const inFlight = new Map();

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
  ]).finally(() => clearTimeout(timer));
}

async function requestSnapshot(tabId) {
  return withTimeout(
    chrome.tabs.sendMessage(tabId, { type: Msg.PREPARE_CAPTURE }, { frameId: 0 }),
    SNAPSHOT_TIMEOUT_MS,
    "The page did not respond"
  );
}

async function takeScreenshot(windowId) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  return (await fetch(dataUrl)).blob();
}

function explain(error) {
  const message = error?.message || String(error);
  if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
    return "Page details unavailable: BugDetector can't run on this page (browser pages, the Web Store and PDFs are off-limits). Reload the page if it was open before the extension was installed.";
  }
  return `Page details unavailable: ${message}`;
}

/**
 * Tells the page nothing was detected so it can ask whether to file a report
 * anyway. The picked element travels along because the snapshot consumed it;
 * the page keeps it for the follow-up request.
 *
 * @returns {Promise<boolean>} false when the page didn't take the question (for
 *   example a tab still running an older content script), so nobody is left waiting
 */
async function askAboutEmptyCapture(tabId, element) {
  const answer = await chrome.tabs.sendMessage(tabId, { type: Msg.NO_ISSUES, element }, { frameId: 0 }).catch(() => null);
  return answer === true;
}

/** @returns {Promise<string|null>} the report id, or null when the user is being asked about an empty capture */
async function runCapture(tab, { force }) {
  const settings = await getSettings();
  const warnings = [];
  const createdAt = Date.now();

  let snapshot = null;
  try {
    snapshot = await requestSnapshot(tab.id);
  } catch (error) {
    warnings.push(explain(error));
  }

  const webRequests = await getTabRequests(tab.id).catch(() => []);

  let nothingDetected = hasNoIssues(snapshot, webRequests, settings);
  if (nothingDetected && !force) {
    if (await askAboutEmptyCapture(tab.id, snapshot.element)) return null;
    nothingDetected = false; // can't ask: capture as usual rather than doing nothing
  }

  let screenshot = null;
  try {
    screenshot = await takeScreenshot(tab.windowId);
  } catch (error) {
    warnings.push(`Screenshot unavailable: ${error?.message || error}`);
  } finally {
    chrome.tabs.sendMessage(tab.id, { type: Msg.CAPTURE_FINISHED }, { frameId: 0 }).catch(() => {});
  }

  const report = redactReport(buildReport({
    id: crypto.randomUUID(),
    createdAt,
    tab,
    snapshot,
    webRequests,
    settings,
    warnings,
    hasScreenshot: Boolean(screenshot),
    manual: nothingDetected
  }), settings);

  await saveReport(report, screenshot, { keep: settings.maxReports });

  await chrome.tabs.create({
    url: chrome.runtime.getURL(`report/report.html?id=${encodeURIComponent(report.id)}`),
    index: tab.index + 1,
    openerTabId: tab.id
  });

  return report.id;
}

/**
 * @param {chrome.tabs.Tab} tab
 * @param {{ force?: boolean }} [options]  force: capture even if nothing was detected
 * @returns {Promise<import("../lib/messages.js").CaptureResult>}
 */
export async function captureTab(tab, { force = false } = {}) {
  if (!tab?.id) return { ok: false, error: "No tab to capture" };
  if (inFlight.has(tab.id)) return inFlight.get(tab.id);

  const job = runCapture(tab, { force })
    .then((reportId) => (reportId ? { ok: true, reportId } : { ok: false, reason: "no-issues" }))
    .catch((error) => {
      console.error("BugDetector capture failed:", error);
      return { ok: false, error: error?.message || String(error) };
    })
    .finally(() => inFlight.delete(tab.id));

  inFlight.set(tab.id, job);
  return job;
}

export async function captureActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return captureTab(tab);
}
