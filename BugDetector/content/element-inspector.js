/**
 * Describes an element the user marked as broken: a unique selector, safe
 * attributes, a sanitised HTML snippet, key computed styles and diagnostics
 * that explain the usual "this button does nothing" causes.
 * Isolated content-script world; exposes globalThis.BugDetectorInspector.
 */
(() => {
  if (globalThis.BugDetectorInspector) return;

  const STYLE_PROPS = ["display", "visibility", "opacity", "pointer-events", "position", "z-index", "cursor", "overflow"];
  const SAFE_ATTR = /^(id|class|role|name|type|href|src|title|alt|for|disabled|readonly|required|tabindex|form|action|method|aria-[\w-]+|data-(testid|test|cy|qa))$/;
  const MAX_HTML = 1500;
  const MAX_TEXT = 200;

  function clean(text, max) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  /** Class names that look generated (css-1x2y3z, sc-abc, hashes) make brittle selectors. */
  function stableClasses(el) {
    return [...el.classList]
      .filter((name) => !/\d{3,}|^(css|sc|jsx|svelte|emotion)-|[A-Za-z0-9]{8,}_|^_|[:[\]/]/.test(name))
      .slice(0, 2);
  }

  function segment(el) {
    let part = el.tagName.toLowerCase();
    const classes = stableClasses(el);
    if (classes.length) part += classes.map((name) => `.${CSS.escape(name)}`).join("");
    const parent = el.parentElement;
    if (parent) {
      const sameTag = [...parent.children].filter((child) => child.tagName === el.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
    }
    return part;
  }

  /** Shortest reasonable selector that matches only `el`. */
  function uniqueSelector(el) {
    if (el.id && isUnique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
    for (const attr of ["data-testid", "data-test", "data-cy"]) {
      const value = el.getAttribute(attr);
      if (value && isUnique(`[${attr}="${CSS.escape(value)}"]`)) return `[${attr}="${CSS.escape(value)}"]`;
    }

    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      if (node !== el && node.id && isUnique(`#${CSS.escape(node.id)}`)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        return parts.join(" > ");
      }
      parts.unshift(segment(node));
      const selector = parts.join(" > ");
      if (isUnique(selector)) return selector;
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  /** Short human label for diagnostics: tag#id.class */
  function shortName(el) {
    let name = el.tagName.toLowerCase();
    if (el.id) return `${name}#${el.id}`;
    const classes = stableClasses(el);
    if (classes.length) name += `.${classes.join(".")}`;
    return name;
  }

  function visibleText(el) {
    if (el instanceof HTMLInputElement) {
      if (["button", "submit", "reset"].includes(el.type)) return clean(el.value, MAX_TEXT);
      return clean(el.labels?.[0]?.innerText || el.placeholder || el.getAttribute("aria-label"), MAX_TEXT);
    }
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      return clean(el.labels?.[0]?.innerText || el.getAttribute("aria-label"), MAX_TEXT);
    }
    return clean(el.innerText || el.textContent, MAX_TEXT);
  }

  function safeAttributes(el) {
    const out = {};
    for (const attr of el.attributes) {
      if (SAFE_ATTR.test(attr.name)) out[attr.name] = clean(attr.value, 200);
    }
    return out;
  }

  /** outerHTML without form values (value attributes, textarea text). */
  function sanitizedHtml(el) {
    const clone = el.cloneNode(true);
    const scrub = (node) => {
      if (node instanceof Element) {
        const isButton = node.tagName === "INPUT" && /^(button|submit|reset|image)$/i.test(node.getAttribute("type") || "");
        if (/^(input|textarea|select|option)$/i.test(node.tagName) && node.hasAttribute("value") && !isButton) {
          node.setAttribute("value", "…");
        }
        if (node.tagName === "TEXTAREA") node.textContent = "";
        if (node.tagName === "SCRIPT" || node.tagName === "STYLE") node.textContent = "…";
      }
    };
    scrub(clone);
    clone.querySelectorAll?.("*").forEach(scrub);
    const html = clone.outerHTML.replace(/\s+/g, " ");
    return html.length > MAX_HTML ? `${html.slice(0, MAX_HTML)}… [truncated]` : html;
  }

  function diagnose(el, rect, style) {
    const issues = [];

    if (el.disabled) issues.push("Element is disabled.");
    const ariaDisabled = el.closest("[aria-disabled='true']");
    if (ariaDisabled) issues.push(`aria-disabled="true"${ariaDisabled === el ? "" : ` on ancestor ${shortName(ariaDisabled)}`}.`);
    const inert = el.closest("[inert]");
    if (inert) issues.push(`Inside an inert subtree (${shortName(inert)}).`);

    if (style.display === "none") issues.push("display: none.");
    if (style.visibility === "hidden" || style.visibility === "collapse") issues.push(`visibility: ${style.visibility}.`);
    if (Number(style.opacity) === 0) issues.push("opacity: 0 (invisible).");
    if (rect.width === 0 || rect.height === 0) issues.push(`Zero size (${Math.round(rect.width)}×${Math.round(rect.height)}).`);

    if (style.pointerEvents === "none") {
      let source = el;
      while (source.parentElement && getComputedStyle(source.parentElement).pointerEvents === "none") {
        source = source.parentElement;
      }
      issues.push(`pointer-events: none${source === el ? "" : ` (inherited from ${shortName(source)})`}: clicks pass through it.`);
    }

    const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    if (!inViewport && rect.width && rect.height) issues.push("Outside the visible viewport.");

    if (inViewport && rect.width && rect.height) {
      const x = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
      const y = Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
      const top = document.elementFromPoint(x, y);
      if (top && top !== el && !el.contains(top) && !(style.pointerEvents === "none" && top.contains(el))) {
        const topStyle = getComputedStyle(top);
        const details = [
          `z-index ${topStyle.zIndex}`,
          Number(topStyle.opacity) === 0 ? "opacity 0, invisible" : null,
          topStyle.backgroundColor === "rgba(0, 0, 0, 0)" ? "transparent background" : null
        ].filter(Boolean).join(", ");
        issues.push(`Covered by ${uniqueSelector(top)} (${details}): clicks at its centre hit that element instead.`);
      }
    }

    return issues;
  }

  /** @returns {object} plain, structured-clone-safe description */
  function inspect(el) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const styles = {};
    for (const prop of STYLE_PROPS) styles[prop] = style.getPropertyValue(prop);

    return {
      selector: uniqueSelector(el),
      tag: el.tagName.toLowerCase(),
      text: visibleText(el),
      attributes: safeAttributes(el),
      html: sanitizedHtml(el),
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      devicePixelRatio: window.devicePixelRatio,
      styles,
      issues: diagnose(el, rect, style)
    };
  }

  globalThis.BugDetectorInspector = Object.freeze({ inspect, uniqueSelector, shortName });
})();
