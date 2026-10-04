/**
 * "Bug detected" toast, rendered in a closed shadow root so page CSS can't
 * leak in and page scripts can't reach inside. Exposes globalThis.BugDetectorToast
 * to the isolated content-script world only.
 */
(() => {
  if (globalThis.BugDetectorToast) return;

  const AUTO_HIDE_MS = 15000;

  const STYLES = `
    :host { all: initial; }
    .toast {
      --bg: #ffffff; --fg: #18181b; --muted: #71717a; --border: #e4e4e7;
      --accent: #e5484d; --accent-fg: #ffffff; --accent-hover: #d13d42; --ghost-hover: #f4f4f5;
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
      width: min(360px, calc(100vw - 40px)); box-sizing: border-box;
      display: grid; grid-template-columns: auto 1fr; gap: 4px 12px;
      padding: 14px 14px 12px; border-radius: 14px;
      background: var(--bg); color: var(--fg); border: 1px solid var(--border);
      box-shadow: 0 12px 32px -8px rgb(0 0 0 / 0.25), 0 2px 6px rgb(0 0 0 / 0.08);
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      opacity: 0; transform: translateY(12px) scale(0.98); pointer-events: none;
      transition: opacity 160ms ease, transform 160ms ease;
    }
    .toast[data-open] { opacity: 1; transform: none; pointer-events: auto; }
    @media (prefers-color-scheme: dark) {
      .toast { --bg: #1c1c1f; --fg: #f4f4f5; --muted: #a1a1aa; --border: #2e2e33; --ghost-hover: #27272a; }
    }
    @media (prefers-reduced-motion: reduce) { .toast { transition: none; } }
    .icon {
      grid-row: span 2; width: 32px; height: 32px; border-radius: 9px;
      display: grid; place-items: center; background: color-mix(in srgb, var(--accent) 14%, transparent);
    }
    .icon svg { width: 18px; height: 18px; color: var(--accent); }
    .head { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .title { font-weight: 600; font-size: 14px; }
    .count {
      font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 999px;
      background: var(--ghost-hover); color: var(--muted);
    }
    .count:empty { display: none; }
    .close {
      margin-left: auto; width: 24px; height: 24px; border: 0; border-radius: 6px;
      background: transparent; color: var(--muted); cursor: pointer; font-size: 18px; line-height: 1;
    }
    .close:hover { background: var(--ghost-hover); color: var(--fg); }
    .detail {
      color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
    }
    .actions { grid-column: 2; display: flex; align-items: center; gap: 8px; margin-top: 8px; }
    button.primary {
      border: 0; border-radius: 8px; padding: 7px 12px; cursor: pointer;
      background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600;
    }
    button.primary:hover { background: var(--accent-hover); }
    button.primary:disabled { opacity: 0.7; cursor: progress; }
    button.link {
      border: 0; background: transparent; color: var(--muted); cursor: pointer; font: inherit;
      padding: 7px 6px; border-radius: 8px;
    }
    button.link:hover { color: var(--fg); background: var(--ghost-hover); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  `;

  const BUG_ICON = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8 2l1.9 1.9M16 2l-1.9 1.9M9 7.1V6a3 3 0 0 1 6 0v1.1"/>
      <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6zM12 20v-9"/>
      <path d="M6.5 13H3M21 13h-3.5M6 9.5L3.5 8M18 9.5L20.5 8M6.5 17L4 19M17.5 17L20 19"/>
    </svg>`;

  let host = null;
  let parts = null;
  let handlers = {};
  let hideTimer = 0;
  let hovering = false;

  function build() {
    host = document.createElement("bug-detector-ui");
    const shadow = host.attachShadow({ mode: "closed" });

    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLES);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement("style");
      style.textContent = STYLES;
      shadow.append(style);
    }

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "alert");
    toast.setAttribute("aria-live", "polite");
    toast.innerHTML = `
      <div class="icon">${BUG_ICON}</div>
      <div class="head">
        <span class="title">Bug detected</span>
        <span class="count"></span>
        <button class="close" type="button" aria-label="Dismiss">×</button>
      </div>
      <div class="detail"></div>
      <div class="actions">
        <button class="primary" type="button">Capture bug</button>
        <button class="link pick" type="button" title="Click the element that's broken to include it in the report">Pick element</button>
        <button class="link mute" type="button" title="Keep collecting data, but don't show this popup on this site">Mute site</button>
      </div>`;
    shadow.append(toast);

    parts = {
      toast,
      count: toast.querySelector(".count"),
      detail: toast.querySelector(".detail"),
      capture: toast.querySelector(".primary"),
      mute: toast.querySelector(".mute")
    };

    parts.capture.addEventListener("click", () => handlers.onCapture?.());
    parts.mute.addEventListener("click", () => handlers.onMute?.());
    toast.querySelector(".pick").addEventListener("click", () => handlers.onPick?.());
    toast.querySelector(".close").addEventListener("click", () => {
      hide();
      handlers.onDismiss?.();
    });
    toast.addEventListener("mouseenter", () => { hovering = true; clearTimeout(hideTimer); });
    toast.addEventListener("mouseleave", () => { hovering = false; scheduleHide(); });
  }

  function mount() {
    if (!host) build();
    if (!host.isConnected) (document.body || document.documentElement).append(host);
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    if (hovering) return;
    hideTimer = setTimeout(() => {
      hide();
      handlers.onDismiss?.();
    }, AUTO_HIDE_MS);
  }

  /**
   * @param {{ detail: string, count: number, onCapture: Function,
   *           onPick: Function, onDismiss: Function, onMute: Function }} options
   */
  function show(options) {
    mount();
    handlers = options;
    parts.detail.textContent = options.detail;
    parts.detail.title = options.detail;
    parts.count.textContent = options.count > 1 ? `${options.count} issues` : "";
    parts.capture.disabled = false;
    parts.capture.textContent = "Capture bug";
    host.setAttribute("data-open", "");
    // Next frame so the transition runs when the host was just inserted.
    requestAnimationFrame(() => parts.toast.setAttribute("data-open", ""));
    scheduleHide();
  }

  function setBusy(label) {
    if (!parts) return;
    parts.capture.disabled = true;
    parts.capture.textContent = label;
  }

  function hide() {
    clearTimeout(hideTimer);
    if (!host) return;
    host.removeAttribute("data-open");
    parts.toast.removeAttribute("data-open");
  }

  function isOpen() {
    return Boolean(host?.hasAttribute("data-open"));
  }

  /** Removes the toast from the layout entirely (used right before a screenshot). */
  function detach() {
    hide();
    host?.remove();
  }

  function isOwnElement(node) {
    return Boolean(host) && node === host;
  }

  globalThis.BugDetectorToast = Object.freeze({ show, hide, setBusy, isOpen, detach, isOwnElement });
})();
