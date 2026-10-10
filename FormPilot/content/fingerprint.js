/**
 * FormPilot fingerprint module.
 * Builds stable form identifiers from page + form + field metadata.
 */

const FormPilotFingerprint = (() => {
  const EXCLUDED_FIELD_TYPES = new Set([
    "hidden",
    "submit",
    "button",
    "reset",
    "image"
  ]);

  function normalize(value) {
    if (value == null) return "";
    return String(value).trim().toLowerCase();
  }

  function hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
  }

  function escapeCss(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function getFieldLabel(field) {
    if (field.id) {
      const label = document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
      if (label) return label.textContent.trim();
    }

    const parentLabel = field.closest("label");
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll("input, textarea, select").forEach((el) => el.remove());
      return clone.textContent.trim();
    }

    const ariaLabelledBy = field.getAttribute("aria-labelledby");
    if (ariaLabelledBy) {
      const labelEl = document.getElementById(ariaLabelledBy);
      if (labelEl) return labelEl.textContent.trim();
    }

    return "";
  }

  function getNearbyHeading(form) {
    const inForm = form.querySelector("h1, h2, h3, h4, h5, h6");
    if (inForm) return inForm.textContent.trim();

    let node = form.previousElementSibling;
    let depth = 0;
    while (node && depth < 3) {
      if (/^H[1-6]$/i.test(node.tagName)) {
        return node.textContent.trim();
      }
      const heading = node.querySelector?.("h1, h2, h3, h4, h5, h6");
      if (heading) return heading.textContent.trim();
      node = node.previousElementSibling;
      depth++;
    }

    return "";
  }

  /** True for a group of fields found without a <form> tag (see FormPilotDetector.scanFormless). */
  function isFormlessContainer(form) {
    return form.tagName !== "FORM";
  }

  function getSubmitButtonText(form) {
    const submitEl = isFormlessContainer(form)
      ? FormPilotDetector.findSubmitControl(form, { allowDisabled: true })
      : form.querySelector('button[type="submit"]') ||
        form.querySelector('input[type="submit"]') ||
        form.querySelector('[type="submit"]');

    if (!submitEl) return "";

    if (submitEl.tagName === "INPUT") {
      return submitEl.value?.trim() || "";
    }

    return submitEl.textContent?.trim() || "";
  }

  function getFormIndex(form) {
    if (isFormlessContainer(form)) return FormPilotDetector.getFormlessIndex(form);
    const forms = Array.from(document.querySelectorAll("form"));
    return forms.indexOf(form);
  }

  function getFieldType(field) {
    if (field.tagName === "TEXTAREA") return "textarea";
    if (field.tagName === "SELECT") return "select";
    return (field.getAttribute("type") || "text").toLowerCase();
  }

  function isUsableField(field) {
    if (!field || field.disabled) return false;
    const tag = field.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return false;
    if (tag === "INPUT" && EXCLUDED_FIELD_TYPES.has(getFieldType(field))) return false;
    return true;
  }

  function getUsableFields(form) {
    return Array.from(form.querySelectorAll("input, textarea, select")).filter(isUsableField);
  }

  function buildFieldMetadata(field, index) {
    return {
      tag: field.tagName.toLowerCase(),
      type: getFieldType(field),
      name: field.name || "",
      id: field.id || "",
      class: field.className || "",
      placeholder: field.placeholder || "",
      label: getFieldLabel(field),
      ariaLabel: field.getAttribute("aria-label") || "",
      autocomplete: field.getAttribute("autocomplete") || "",
      index
    };
  }

  function buildFieldKey(metadata) {
    return (
      metadata.name ||
      metadata.id ||
      metadata.label ||
      metadata.placeholder ||
      metadata.ariaLabel ||
      metadata.autocomplete ||
      `${metadata.tag}_${metadata.type}_${metadata.index}`
    );
  }

  function isUniqueSelector(form, selector, field) {
    try {
      const matches = form.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === field;
    } catch {
      return false;
    }
  }

  function generateSelector(field, form) {
    const fallbacks = [];
    let selector = "";

    if (field.id && isUniqueSelector(form, `#${CSS.escape(field.id)}`, field)) {
      selector = `#${CSS.escape(field.id)}`;
      fallbacks.push(`#${CSS.escape(field.id)}`);
    }

    if (field.name) {
      const nameSelector = `${field.tagName.toLowerCase()}[name="${escapeCss(field.name)}"]`;
      if (!selector && isUniqueSelector(form, nameSelector, field)) {
        selector = nameSelector;
      }
      fallbacks.push(nameSelector);
    }

    const type = getFieldType(field);
    if (field.name) {
      fallbacks.push(`${field.tagName.toLowerCase()}[type="${type}"][name="${escapeCss(field.name)}"]`);
    }

    const autocomplete = field.getAttribute("autocomplete");
    if (autocomplete) {
      fallbacks.push(`${field.tagName.toLowerCase()}[autocomplete="${escapeCss(autocomplete)}"]`);
    }

    const placeholder = field.placeholder;
    if (placeholder) {
      fallbacks.push(`${field.tagName.toLowerCase()}[placeholder="${escapeCss(placeholder)}"]`);
    }

    const ariaLabel = field.getAttribute("aria-label");
    if (ariaLabel) {
      fallbacks.push(`${field.tagName.toLowerCase()}[aria-label="${escapeCss(ariaLabel)}"]`);
    }

    const usableFields = getUsableFields(form);
    const index = usableFields.indexOf(field);
    const nthSelector = `${field.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
    fallbacks.push(nthSelector);

    if (!selector) {
      selector = fallbacks.find((candidate) => isUniqueSelector(form, candidate, field)) || fallbacks[0] || nthSelector;
    }

    const uniqueFallbacks = [...new Set(fallbacks.filter((item) => item && item !== selector))];

    return {
      selector,
      fallbackSelectors: uniqueFallbacks
    };
  }

  function buildFormMetadata(form, formIndex) {
    const heading = getNearbyHeading(form);
    const fields = getUsableFields(form).map((field, index) => buildFieldMetadata(field, index));

    return {
      kind: isFormlessContainer(form) ? "container" : "form",
      origin: window.location.origin,
      pathname: window.location.pathname,
      pageUrl: window.location.href.split("#")[0],
      domain: window.location.hostname,
      formIndex: formIndex >= 0 ? formIndex : getFormIndex(form),
      formId: form.id || "",
      formName: form.name || "",
      formClass: form.className || "",
      formAction: form.getAttribute("action") || "",
      formMethod: (form.getAttribute("method") || "get").toLowerCase(),
      nearbyHeading: heading,
      submitButtonText: getSubmitButtonText(form),
      formTitle: heading || form.getAttribute("name") || form.id || `Form ${formIndex + 1}`,
      fields
    };
  }

  function generateFingerprint(form, formIndex) {
    const meta = buildFormMetadata(form, formIndex);
    const payload = {
      origin: normalize(meta.origin),
      pathname: normalize(meta.pathname),
      formIndex: meta.formIndex,
      formId: normalize(meta.formId),
      formName: normalize(meta.formName),
      formClass: normalize(meta.formClass),
      formAction: normalize(meta.formAction),
      formMethod: normalize(meta.formMethod),
      nearbyHeading: normalize(meta.nearbyHeading),
      submitButtonText: normalize(meta.submitButtonText),
      fields: meta.fields.map((field) => ({
        tag: normalize(field.tag),
        type: normalize(field.type),
        name: normalize(field.name),
        id: normalize(field.id),
        class: normalize(field.class),
        placeholder: normalize(field.placeholder),
        label: normalize(field.label),
        ariaLabel: normalize(field.ariaLabel),
        autocomplete: normalize(field.autocomplete),
        index: field.index
      }))
    };

    // Only added for formless groups, so fingerprints of real forms never change.
    if (meta.kind === "container") payload.kind = "container";

    return hashString(JSON.stringify(payload));
  }

  function getStorageKey(form, formIndex) {
    const fingerprint = generateFingerprint(form, formIndex);
    const origin = window.location.origin;
    const pathname = window.location.pathname;
    return `${origin}${pathname}::${fingerprint}`;
  }

  function readFieldValue(field) {
    const type = getFieldType(field);

    if (field.tagName === "SELECT") {
      return field.value;
    }

    if (type === "checkbox") {
      return field.checked;
    }

    if (type === "radio") {
      return field.checked ? field.value : null;
    }

    return field.value;
  }

  function collectFieldData(form) {
    const fields = getUsableFields(form);
    const collected = [];

    for (let index = 0; index < fields.length; index++) {
      const field = fields[index];
      const metadata = buildFieldMetadata(field, index);
      const value = readFieldValue(field);

      if (metadata.type === "radio" && value === null) {
        continue;
      }

      const { selector, fallbackSelectors } = generateSelector(field, form);

      collected.push({
        fieldKey: buildFieldKey(metadata),
        value,
        selector,
        fallbackSelectors,
        metadata
      });
    }

    // Include unchecked radio groups with empty value marker
    const radioNames = new Set();
    for (const field of fields) {
      if (getFieldType(field) === "radio" && field.name) {
        radioNames.add(field.name);
      }
    }

    for (const name of radioNames) {
      const group = fields.filter((field) => field.name === name && getFieldType(field) === "radio");
      const checked = group.find((field) => field.checked);
      if (!checked && group[0]) {
        const metadata = buildFieldMetadata(group[0], fields.indexOf(group[0]));
        const { selector, fallbackSelectors } = generateSelector(group[0], form);
        collected.push({
          fieldKey: buildFieldKey(metadata),
          value: "",
          selector,
          fallbackSelectors,
          metadata: { ...metadata, type: "radio", name }
        });
      }
    }

    return collected;
  }

  return {
    buildFormMetadata,
    buildFieldMetadata,
    buildFieldKey,
    generateFingerprint,
    getStorageKey,
    generateSelector,
    collectFieldData,
    getUsableFields,
    getFieldType,
    readFieldValue
  };
})();
