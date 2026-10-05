/**
 * Capture orchestration: page snapshot → screenshot → report → redaction →
 * IndexedDB → report tab. Every step degrades gracefully: a page without the
 * content script (chrome://, Web Store, PDF) still yields a report with
 * whatever could be collected, plus a warning explaining what's missing.
 */
import { Msg } from "../lib/messages.js";
import { getSettings } from "../lib/settings.js";
import { buildReport } from "../lib/report-model.js";
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

async function runCapture(tab) {
  const settings = await getSettings();
  const warnings = [];
  const createdAt = Date.now();

  let snapshot = null;
  try {
    snapshot = await requestSnapshot(tab.id);
  } catch (error) {
    warnings.push(explain(error));
  }

  let screenshot = null;
  try {
    screenshot = await takeScreenshot(tab.windowId);
  } catch (error) {
    warnings.push(`Screenshot unavailable: ${error?.message || error}`);
  } finally {
    chrome.tabs.sendMessage(tab.id, { type: Msg.CAPTURE_FINISHED }, { frameId: 0 }).catch(() => {});
  }

  const webRequests = await getTabRequests(tab.id).catch(() => []);

  const report = redactReport(buildReport({
    id: crypto.randomUUID(),
    createdAt,
    tab,
    snapshot,
    webRequests,
    settings,
    warnings,
    hasScreenshot: Boolean(screenshot)
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
 * @returns {Promise<import("../lib/messages.js").CaptureResult>}
 */
export async function captureTab(tab) {
  if (!tab?.id) return { ok: false, error: "No tab to capture" };
  if (inFlight.has(tab.id)) return inFlight.get(tab.id);

  const job = runCapture(tab)
    .then((reportId) => ({ ok: true, reportId }))
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
