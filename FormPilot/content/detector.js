/**
 * FormPilot form detector.
 * Finds visible, usable forms including dynamically added ones.
 */

const FormPilotDetector = (() => {
  const EXCLUDED_FIELD_TYPES = new Set([
    "hidden",
    "submit",
    "button",
    "reset",
    "image"
  ]);

  let observer = null;
  let debounceTimer = null;

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

  function observe(callback) {
    if (observer) {
      observer.disconnect();
    }

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

    window.addEventListener("scroll", debouncedCallback, true);
    window.addEventListener("resize", debouncedCallback, { passive: true });
  }

  function disconnect() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(debounceTimer);
  }

  return {
    isElementVisible,
    getUsableFields,
    isValidForm,
    scanForms,
    observe,
    disconnect
  };
})();
