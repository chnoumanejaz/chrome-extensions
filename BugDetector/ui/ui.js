/** Small DOM helpers shared by the extension pages. */

/** @returns {HTMLElement} */
export function $(selector, root = document) {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

/** Creates an element: h("li", { className: "row", onclick }, "text", child). */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key in el && key !== "list") el[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  el.append(...children.flat().filter((child) => child != null && child !== false));
  return el;
}

export function debounce(fn, ms) {
  let timer = 0;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  debounced.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return debounced;
}

let statusTimer = 0;

/** Brief bottom-centre confirmation ("Copied!"). */
export function showStatus(text, ms = 1800) {
  let el = document.querySelector(".toast-status");
  if (!el) {
    el = h("div", { className: "toast-status", role: "status", "aria-live": "polite" });
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.classList.remove("show"), ms);
}

export function timeAgo(ts, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** The capture shortcut as configured at chrome://extensions/shortcuts ("" when unset). */
export async function getCaptureShortcut() {
  const commands = await chrome.commands.getAll();
  return commands.find((command) => command.name === "capture-bug")?.shortcut || "";
}

export function openShortcutSettings() {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
}

export function openReport(id) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`report/report.html?id=${encodeURIComponent(id)}`) });
}
