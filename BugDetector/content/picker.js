/**
 * "Select the broken element" picker. Highlights the element under the
 * pointer; click (or Enter) selects it, ↑ moves to the parent, ↓ cycles to
 * the element underneath (for elements covered by an invisible overlay),
 * Esc cancels. While active, page clicks are swallowed so nothing triggers.
 * Isolated content-script world; exposes globalThis.BugDetectorPicker.
 */
(() => {
  if (globalThis.BugDetectorPicker) return;

  const STYLES = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; cursor: crosshair; }
    .box {
      position: fixed; box-sizing: border-box; border: 2px solid #e5484d; border-radius: 3px;
      background: rgb(229 72 77 / 0.12); transition: all 60ms ease-out; display: none;
    }
    .label {
      position: fixed; max-width: min(460px, calc(100vw - 16px)); padding: 3px 8px; border-radius: 6px;
      background: #18181b; color: #fafafa; font: 600 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: none;
    }
    .label span { color: #a1a1aa; font-weight: 400; }
    .hint {
      position: fixed; left: 50%; top: 14px; transform: translateX(-50%);
      display: flex; gap: 14px; align-items: center; padding: 8px 14px; border-radius: 999px;
      background: #18181b; color: #fafafa; box-shadow: 0 8px 24px rgb(0 0 0 / 0.3);
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; white-space: nowrap;
    }
    .hint strong { color: #ff8b8f; }
    kbd { font: 11px ui-monospace, monospace; padding: 1px 5px; border-radius: 4px; background: #3f3f46; }
    @media (prefers-reduced-motion: reduce) { .box { transition: none; } }
  `;

  let host = null;
  let parts = null;
  let active = null; // { onPick, onCancel, stack, index, current }

  function build() {
    host = document.createElement("bug-detector-picker");
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
    const layer = document.createElement("div");
    layer.className = "layer";
    layer.innerHTML = `
      <div class="box"></div>
      <div class="label"></div>
      <div class="hint" role="status">
        <span><strong>Click the broken element</strong></span>
        <span><kbd>↑</kbd> parent</span>
        <span><kbd>↓</kbd> element underneath</span>
        <span><kbd>Esc</kbd> cancel</span>
      </div>`;
    shadow.append(layer);
    parts = { box: layer.querySelector(".box"), label: layer.querySelector(".label") };
  }

  function isOwn(node) {
    return node === host;
  }

  function highlight(el) {
    active.current = el;
    if (!el) {
      parts.box.style.display = parts.label.style.display = "none";
      return;
    }
    const rect = el.getBoundingClientRect();
    Object.assign(parts.box.style, {
      display: "block",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`
    });
    const name = globalThis.BugDetectorInspector.shortName(el);
    parts.label.innerHTML = "";
    parts.label.append(name, Object.assign(document.createElement("span"), {
      textContent: `  ${Math.round(rect.width)}×${Math.round(rect.height)}`
    }));
    parts.label.style.display = "block";
    const below = rect.top < 30;
    parts.label.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 300))}px`;
    parts.label.style.top = below ? `${Math.min(innerHeight - 24, rect.bottom + 6)}px` : `${rect.top - 24}px`;
  }

  const INTERACTIVE = "a, button, input, select, textarea, summary, [role='button'], [role='link'], [onclick]";

  /**
   * elementsFromPoint skips `pointer-events: none` elements, a classic cause
   * of "this button does nothing". Surface interactive descendants under
   * the pointer so they can still be picked.
   */
  function unhittableWithin(el, x, y) {
    const found = [];
    let node = el;
    for (;;) {
      const child = [...node.children].find((c) => {
        const r = c.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      });
      if (!child) break;
      if (child.matches(INTERACTIVE)) found.unshift(child);
      node = child;
    }
    return found;
  }

  function stackAt(x, y) {
    const stack = document.elementsFromPoint(x, y)
      .filter((el) => !isOwn(el) && el !== document.documentElement && el !== document.body);
    return stack.length ? [...unhittableWithin(stack[0], x, y), ...stack] : stack;
  }

  function onMove(event) {
    const stack = stackAt(event.clientX, event.clientY);
    // Keep a ↓/↑ choice while the pointer stays over the same stack.
    if (stack[0] === active.stack[0] && active.current) return;
    active.stack = stack;
    active.index = 0;
    highlight(stack[0] || null);
  }

  function swallow(event) {
    if (!active) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onClick(event) {
    swallow(event);
    if (event.button === 0) pick();
  }

  function onKey(event) {
    if (!active) return;
    const { key } = event;
    if (!["Escape", "Enter", "ArrowUp", "ArrowDown"].includes(key)) return;
    swallow(event);
    if (key === "Escape") return cancel();
    if (key === "Enter") return pick();
    if (key === "ArrowUp" && active.current?.parentElement && active.current.parentElement !== document.body) {
      highlight(active.current.parentElement);
    }
    if (key === "ArrowDown" && active.stack.length) {
      active.index = (active.index + 1) % active.stack.length;
      highlight(active.stack[active.index]);
    }
  }

  const POINTER_EVENTS = ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "contextmenu", "auxclick"];

  function listen(add) {
    const method = add ? "addEventListener" : "removeEventListener";
    window[method]("pointermove", onMove, true);
    window[method]("click", onClick, true);
    window[method]("keydown", onKey, true);
    for (const type of POINTER_EVENTS) window[method](type, swallow, true);
  }

  function stop() {
    listen(false);
    host?.remove();
    const done = active;
    active = null;
    return done;
  }

  function pick() {
    const el = active?.current;
    if (!el) return;
    const { onPick } = stop();
    onPick(el);
  }

  function cancel() {
    stop()?.onCancel?.();
  }

  /** @param {{ onPick: (el: Element) => void, onCancel?: () => void }} handlers */
  function start(handlers) {
    if (active) return;
    if (!host) build();
    active = { ...handlers, stack: [], index: 0, current: null };
    (document.body || document.documentElement).append(host);
    highlight(null);
    listen(true);
  }

  globalThis.BugDetectorPicker = Object.freeze({
    start,
    cancel,
    isActive: () => Boolean(active),
    isOwnElement: isOwn
  });
})();
