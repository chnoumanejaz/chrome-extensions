/**
 * Records failed requests per tab using chrome.webRequest. This catches what
 * the in-page hook can't: failed stylesheets/fonts/scripts, the document
 * itself, and requests made before the hook was installed. Entries live in
 * chrome.storage.session so they survive service-worker restarts.
 */

const MAX_PER_TAB = 50;
const keyFor = (tabId) => `net:${tabId}`;

/** Ignorable error codes: user/page navigations cancel requests all the time. */
const IGNORED_ERRORS = new Set(["net::ERR_ABORTED", "net::ERR_BLOCKED_BY_CLIENT"]);

// Serialises read-modify-write per tab so concurrent events don't overwrite each other.
const queues = new Map();

function enqueue(tabId, task) {
  const previous = queues.get(tabId) || Promise.resolve();
  const next = previous.then(task, task).finally(() => {
    if (queues.get(tabId) === next) queues.delete(tabId);
  });
  queues.set(tabId, next);
  return next;
}

function record(tabId, entry) {
  return enqueue(tabId, async () => {
    const key = keyFor(tabId);
    const stored = await chrome.storage.session.get(key);
    const list = stored[key] || [];
    list.push(entry);
    await chrome.storage.session.set({ [key]: list.slice(-MAX_PER_TAB) });
  });
}

/** Our own requests, and the favicon Chrome fetches on its own for every page. */
function isNoise(details) {
  const origin = `chrome-extension://${chrome.runtime.id}`;
  return details.initiator === origin
    || details.url.startsWith(origin)
    || /\/favicon\.ico(?:[?#]|$)/.test(details.url);
}

export function startNetworkMonitor() {
  const filter = { urls: ["<all_urls>"] };

  chrome.webRequest.onCompleted.addListener((details) => {
    if (details.tabId < 0 || details.statusCode < 400 || isNoise(details)) return;
    record(details.tabId, {
      ts: Math.round(details.timeStamp),
      initiator: "webRequest",
      resourceType: details.type,
      method: details.method,
      url: details.url,
      status: details.statusCode,
      statusText: details.statusLine?.replace(/^HTTP\/[\d.]+\s+\d+\s*/, "") || "",
      error: null
    });
  }, filter);

  chrome.webRequest.onErrorOccurred.addListener((details) => {
    if (details.tabId < 0 || IGNORED_ERRORS.has(details.error) || isNoise(details)) return;
    record(details.tabId, {
      ts: Math.round(details.timeStamp),
      initiator: "webRequest",
      resourceType: details.type,
      method: details.method,
      url: details.url,
      status: 0,
      error: details.error
    });
  }, filter);

  chrome.tabs.onRemoved.addListener((tabId) => {
    enqueue(tabId, () => chrome.storage.session.remove(keyFor(tabId)));
  });
}

/** @returns {Promise<import("../lib/messages.js").NetworkEntry[]>} */
export async function getTabRequests(tabId) {
  await queues.get(tabId);
  const key = keyFor(tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] || [];
}
