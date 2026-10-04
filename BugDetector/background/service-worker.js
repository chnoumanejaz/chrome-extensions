/**
 * BugDetector service worker (ES module). Wires browser events to the
 * capture pipeline. Listeners are registered synchronously at top level so
 * they fire after the worker is woken up.
 */
import { Msg } from "../lib/messages.js";
import { captureActiveTab, captureTab } from "./capture.js";
import { startNetworkMonitor } from "./network-monitor.js";

const BADGE_COLOR = "#e5484d";

startNetworkMonitor();

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "capture-bug") {
    if (tab) captureTab(tab);
    else captureActiveTab();
  } else if (command === "pick-element") {
    const target = tab || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (target?.id) startPicker(target.id);
  }
});

/** Starts the element picker in a tab; the collector requests the capture once picked. */
async function startPicker(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: Msg.START_PICKER }, { frameId: 0 });
    return { ok: true };
  } catch {
    return { ok: false, error: "BugDetector isn't running on this page. Reload it and try again." };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case Msg.CAPTURE_REQUEST: {
      // From the in-page toast (sender.tab) or the popup (explicit tabId).
      const job = message.tabId
        ? chrome.tabs.get(message.tabId).then(captureTab)
        : captureTab(sender.tab);
      job.then(sendResponse, (error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    case Msg.START_PICKER: {
      startPicker(message.tabId).then(sendResponse);
      return true;
    }

    case Msg.BADGE_UPDATE: {
      const tabId = sender.tab?.id;
      if (tabId != null && sender.frameId === 0) {
        const count = Number(message.count) || 0;
        chrome.action.setBadgeText({ tabId, text: count ? (count > 99 ? "99+" : String(count)) : "" });
        chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
      }
      return false;
    }

    default:
      return false;
  }
});

// A new document starts with a clean slate; its collector re-reports issues.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") chrome.action.setBadgeText({ tabId, text: "" });
});

/**
 * Tabs that were already open when the extension was installed/updated have
 * no content scripts; inject them so capture works without a reload.
 */
async function injectIntoOpenTabs() {
  const manifest = chrome.runtime.getManifest();
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });

  await Promise.all(tabs.map(async (tab) => {
    for (const script of manifest.content_scripts) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: script.js,
          world: script.world === "MAIN" ? "MAIN" : "ISOLATED"
        });
      } catch {
        // Discarded tabs, error pages, etc.
      }
    }
  }));
}

chrome.runtime.onInstalled.addListener(() => {
  injectIntoOpenTabs();
});

// Handy for debugging from the service worker console and used by the e2e test.
globalThis.BugDetector = Object.freeze({ captureTab, captureActiveTab, startPicker });
