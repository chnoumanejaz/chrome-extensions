/**
 * Message protocol shared by every extension context.
 *
 * Files in `shared/` are "universal": they load as classic content scripts
 * (listed in manifest.json) AND as side-effect ES module imports from the
 * service worker, extension pages and Node tests. They publish a frozen
 * namespace on globalThis instead of using `export`.
 */
(() => {
  if (globalThis.BugDetectorProtocol) return;

  globalThis.BugDetectorProtocol = Object.freeze({
    /** DOM event the MAIN-world page hook dispatches (must match content/page-hook.js). */
    HOOK_EVENT: "bugdetector:event",

    /** chrome.runtime message types. */
    Msg: Object.freeze({
      /** SW → collector: hide in-page UI and return a page snapshot. */
      PREPARE_CAPTURE: "bd/prepare-capture",
      /** SW → collector: capture finished (ok or failed); restore UI state. */
      CAPTURE_FINISHED: "bd/capture-finished",
      /** collector/popup → SW: capture a report for a tab. */
      CAPTURE_REQUEST: "bd/capture-request",
      /** popup → collector: counts for the current page. */
      GET_STATS: "bd/get-stats",
      /** collector → SW: number of detected issues, shown on the toolbar badge. */
      BADGE_UPDATE: "bd/badge-update"
    })
  });
})();
