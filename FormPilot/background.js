/**
 * FormPilot background service worker.
 * Local-only — no network calls, no analytics.
 */

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    console.log("FormPilot installed. All data stays locally in your browser.");
  }
});
