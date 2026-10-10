/**
 * FormPilot form detector.
 * Finds visible, usable forms including dynamically added ones, and
 * (optionally) groups of fields that have no <form> tag around them.
 */

const FormPilotDetector = (() => {
  const EXCLUDED_FIELD_TYPES = new Set([
    "hidden",
    "submit",
    "button",
    "reset",
    "image"
  ]);

  // A button without type="submit" only counts as a submit control if it says so.
  const SUBMIT_TEXT_PATTERN =
    /\b(submit|sign ?in|log ?in|login|sign ?up|register|create (an )?account|save|send|continue|next|checkout|pay|place order|subscribe|join|confirm|update|book|reserve|get started)\b/i;

  // Anything bigger than this is a whole page of inputs, not one form.
  const MAX_FORMLESS_FIELDS = 40;

  let observer = null;
  let debounceTimer = null;
  let windowListener = null;
  let formlessContainers = [];

  function getFieldType(field) {
    if (field.tagName === "TEXTAREA") return "textarea";
    if (field.tagName === "SELECT") return "select";
    return (field.getAttribute("type") || "text").toLowerCase();
  }

  function isElementVisible(el) {
    if (!el || !(el instanceof Element)) return false;

    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (parseFloat(style.opacity) === 0) return false;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    return true;
  }

  function isUsableField(field) {
    if (!field || field.disabled) return false;
    const tag = field.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return false;
    if (tag === "INPUT" && EXCLUDED_FIELD_TYPES.has(getFieldType(field))) return false;
    if (!isElementVisible(field)) return false;
    return true;
  }

  function getUsableFields(form) {
    return Array.from(form.querySelectorAll("input, textarea, select")).filter(isUsableField);
  }

  function isValidForm(form) {
    if (!form || form.tagName !== "FORM") return false;
    if (!isElementVisible(form)) return false;
    return getUsableFields(form).length > 0;
  }

  function scanForms(root = document) {
    const forms = Array.from(root.querySelectorAll("form"));
    return forms.filter(isValidForm);
  }

  function getControlLabel(control) {
    if (control.tagName === "INPUT") return control.value || "";
    return control.getAttribute("aria-label") || control.textContent || "";
  }

  /**
   * Finds the button that submits a form or a formless group: an explicit
   * type="submit" first, otherwise a button whose text says sign in / save / etc.
   * Disabled buttons are skipped unless `allowDisabled` (used for detection,
   * since many forms keep their button disabled until the fields are valid).
   */
  function findSubmitControl(container, { allowDisabled = false } = {}) {
    const controls = Array.from(
      container.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')
    ).filter((control) => {
      if ((control.getAttribute("type") || "").toLowerCase() === "reset") return false;
      if (!allowDisabled && (control.disabled || control.getAttribute("aria-disabled") === "true")) return false;
      return isElementVisible(control);
    });

    const explicit = controls.find((control) => (control.getAttribute("type") || "").toLowerCase() === "submit");
    if (explicit) return explicit;

    return controls.find((control) => SUBMIT_TEXT_PATTERN.test(getControlLabel(control))) || null;
  }

  /**
   * A "proper" group of fields: at least two distinct fields (a radio group
   * counts once), at least one that takes typed/selected input rather than
   * only checkboxes and radios, and a submit-style button.
   */
  function isProperFieldGroup(node, fields) {
    const distinct = new Set(
      fields.map((field) => (getFieldType(field) === "radio" && field.name ? `radio:${field.name}` : field))
    );
    if (distinct.size < 2) return false;
    if (!fields.some((field) => !["checkbox", "radio"].includes(getFieldType(field)))) return false;
    if (!isElementVisible(node)) return false;
    return findSubmitControl(node, { allowDisabled: true }) !== null;
  }

  /** Walks up from a field to the smallest ancestor that forms a proper group. */
  function findGroupFor(field, orphanFields) {
    let node = field.parentElement;

    while (node && node !== document.body && node !== document.documentElement) {
      // Anything above a real <form> would swallow it, so stop here.
      if (node.querySelector("form")) return null;

      const inside = orphanFields.filter((candidate) => node.contains(candidate));
      if (inside.length > MAX_FORMLESS_FIELDS) return null;
      if (isProperFieldGroup(node, inside)) return node;

      node = node.parentElement;
    }

    return null;
  }

  /**
   * Finds groups of visible fields that aren't inside a <form>: the pieces of
   * a login or signup built from plain divs. Returns the container elements
   * in document order.
   */
  function scanFormless() {
    const orphanFields = Array.from(document.querySelectorAll("input, textarea, select")).filter(
      (field) => !field.form && !field.closest("form") && isUsableField(field)
    );

    if (orphanFields.length < 2) {
      formlessContainers = [];
      return formlessContainers;
    }

    const found = new Set();
    for (const field of orphanFields) {
      const container = findGroupFor(field, orphanFields);
      if (container) found.add(container);
    }

    // If one group wraps another, keep the inner one.
    const containers = Array.from(found);
    formlessContainers = containers.filter(
      (container) => !containers.some((other) => other !== container && container.contains(other))
    );
    return formlessContainers;
  }

  /** Position of a formless container among the ones found by the last scan. */
  function getFormlessIndex(container) {
    return formlessContainers.indexOf(container);
  }

  function observe(callback) {
    disconnect();

    const debouncedCallback = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(callback, 150);
    };

    observer = new MutationObserver(debouncedCallback);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "disabled"]
    });

    windowListener = debouncedCallback;
    window.addEventListener("scroll", windowListener, true);
    window.addEventListener("resize", windowListener, { passive: true });
  }

  function disconnect() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (windowListener) {
      window.removeEventListener("scroll", windowListener, true);
      window.removeEventListener("resize", windowListener);
      windowListener = null;
    }
    clearTimeout(debounceTimer);
  }

  return {
    isElementVisible,
    getUsableFields,
    isValidForm,
    scanForms,
    scanFormless,
    getFormlessIndex,
    findSubmitControl,
    observe,
    disconnect
  };
})();
