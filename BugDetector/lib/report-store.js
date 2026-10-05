/**
 * IndexedDB store for reports. Screenshots are kept as Blobs (no base64
 * bloat) in the same record. Shared by the service worker and the extension
 * pages, which all run on the extension's origin.
 */

const DB_NAME = "bugdetector";
const DB_VERSION = 1;
const STORE = "reports";

let dbPromise = null;

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("createdAt", "createdAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
}

async function withStore(mode, run) {
  const db = await openDb();
  const tx = db.transaction(STORE, mode);
  // Listen before issuing requests so completion can't be missed.
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  const [result] = await Promise.all([run(tx.objectStore(STORE)), done]);
  return result;
}

/** Saves a report (+ optional screenshot Blob) and prunes to `keep` newest. */
export async function saveReport(report, screenshot, { keep = 20 } = {}) {
  await withStore("readwrite", (store) => promisify(store.put({ ...report, screenshot: screenshot || null })));
  await pruneReports(keep);
  return report.id;
}

/** @returns {Promise<object|null>} report with `screenshot` Blob (or null) */
export async function getReport(id) {
  return (await withStore("readonly", (store) => promisify(store.get(id)))) ?? null;
}

/** Shallow-merges `patch` into a stored report. */
export async function updateReport(id, patch) {
  return withStore("readwrite", async (store) => {
    const current = await promisify(store.get(id));
    if (!current) return null;
    const next = { ...current, ...patch };
    await promisify(store.put(next));
    return next;
  });
}

/** Newest first, without screenshots (cheap enough for lists). */
export async function listReports(limit = 50) {
  return withStore("readonly", (store) => new Promise((resolve, reject) => {
    const out = [];
    const request = store.index("createdAt").openCursor(null, "prev");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || out.length >= limit) {
        resolve(out);
        return;
      }
      const { screenshot, ...summary } = cursor.value;
      out.push({ ...summary, hasScreenshot: Boolean(screenshot) });
      cursor.continue();
    };
  }));
}

export async function deleteReport(id) {
  await withStore("readwrite", (store) => promisify(store.delete(id)));
}

export async function clearReports() {
  await withStore("readwrite", (store) => promisify(store.clear()));
}

export async function pruneReports(keep) {
  await withStore("readwrite", (store) => new Promise((resolve, reject) => {
    let seen = 0;
    const request = store.index("createdAt").openCursor(null, "prev");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      seen += 1;
      if (seen > keep) cursor.delete();
      cursor.continue();
    };
  }));
}
