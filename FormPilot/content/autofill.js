/**
 * FormPilot autofill module.
 * Finds fields and fills values with React/Vue-compatible event dispatch.
 */

const FormPilotAutofill = (() => {
  function escapeCss(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function setNativeValue(element, value) {
    const valueSetter = Object.getOwnPropertyDescriptor(element, "value")?.set;
    const prototype = Object.getPrototypeOf(element);
    const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

    if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
      prototypeValueSetter.call(element, value);
    } else if (valueSetter) {
      valueSetter.call(element, value);
    } else {
      element.value = value;
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setChecked(element, checked) {
    const checkedSetter = Object.getOwnPropertyDescriptor(element, "checked")?.set;
    const prototype = Object.getPrototypeOf(element);
    const prototypeCheckedSetter = Object.getOwnPropertyDescriptor(prototype, "checked")?.set;

    if (prototypeCheckedSetter && checkedSetter !== prototypeCheckedSetter) {
      prototypeCheckedSetter.call(element, checked);
    } else if (checkedSetter) {
      checkedSetter.call(element, checked);
    } else {
      element.checked = checked;
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setSelectValue(element, value) {
    element.value = String(value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function queryWithinForm(form, selector) {
    if (!selector) return null;
    try {
      const match = form.querySelector(selector);
      return match || null;
    } catch {
      return null;
    }
  }

  function findByLabel(form, labelText) {
    if (!labelText) return null;

    const labels = Array.from(form.querySelectorAll("label"));
    for (const label of labels) {
      if (label.textContent.trim() === labelText.trim()) {
        const forId = label.getAttribute("for");
        if (forId) {
          const target = form.querySelector(`#${CSS.escape(forId)}`) || document.getElementById(forId);
          if (target && form.contains(target)) return target;
        }
        const nested = label.querySelector("input, textarea, select");
        if (nested) return nested;
      }
    }

    return null;
  }

  function findByTypeAndIndex(form, metadata) {
    const candidates = Array.from(form.querySelectorAll("input, textarea, select")).filter((field) => {
      const tag = field.tagName.toLowerCase();
      const type =
        tag === "textarea"
          ? "textarea"
          : tag === "select"
            ? "select"
            : (field.getAttribute("type") || "text").toLowerCase();
      return tag === metadata.tag && type === metadata.type;
    });

    return candidates[metadata.index] || null;
  }

  function resolveField(form, savedField) {
    const { selector, fallbackSelectors = [], metadata = {} } = savedField;
    const attempts = [
      selector,
      ...(fallbackSelectors || []),
      metadata.id ? `#${CSS.escape(metadata.id)}` : null,
      metadata.name ? `${metadata.tag || "input"}[name="${escapeCss(metadata.name)}"]` : null,
      metadata.ariaLabel ? `[aria-label="${escapeCss(metadata.ariaLabel)}"]` : null,
      metadata.placeholder ? `[placeholder="${escapeCss(metadata.placeholder)}"]` : null,
      metadata.autocomplete ? `[autocomplete="${escapeCss(metadata.autocomplete)}"]` : null
    ].filter(Boolean);

    for (const attempt of attempts) {
      const match = queryWithinForm(form, attempt);
      if (match) return match;
    }

    const byLabel = findByLabel(form, metadata.label);
    if (byLabel) return byLabel;

    return findByTypeAndIndex(form, metadata);
  }

  function toBoolean(value) {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "1" || value === "on") return true;
    if (value === "false" || value === "0" || value === "off" || value === "") return false;
    return Boolean(value);
  }

  function fillField(form, savedField) {
    const metadata = savedField.metadata || {};
    const type = metadata.type || "text";

    if (type === "radio") {
      const radios = Array.from(
        form.querySelectorAll(`input[type="radio"][name="${escapeCss(metadata.name)}"]`)
      );
      if (!radios.length) {
        throw new Error(`Radio group not found: ${metadata.name}`);
      }

      let matched = false;
      for (const radio of radios) {
        const shouldCheck = savedField.value !== "" && radio.value === String(savedField.value);
        setChecked(radio, shouldCheck);
        if (shouldCheck) matched = true;
      }

      if (savedField.value === "") {
        for (const radio of radios) {
          setChecked(radio, false);
        }
        return { status: "filled" };
      }

      if (!matched) {
        throw new Error(`Radio value not found: ${savedField.value}`);
      }

      return { status: "filled" };
    }

    const element = resolveField(form, savedField);
    if (!element) {
      throw new Error(`Field not found: ${savedField.fieldKey || metadata.name || metadata.id}`);
    }

    if (element.tagName === "SELECT") {
      setSelectValue(element, savedField.value);
      return { status: "filled" };
    }

    if (type === "checkbox") {
      setChecked(element, toBoolean(savedField.value));
      return { status: "filled" };
    }

    setNativeValue(element, String(savedField.value ?? ""));
    return { status: "filled" };
  }

  function fillForm(form, savedFields) {
    const summary = {
      filled: 0,
      skipped: 0,
      errors: []
    };

    for (const savedField of savedFields) {
      try {
        fillField(form, savedField);
        summary.filled += 1;
      } catch (error) {
        summary.skipped += 1;
        summary.errors.push({
          fieldKey: savedField.fieldKey,
          message: error.message
        });
      }
    }

    return summary;
  }

  /** Fills in whatever a profile is missing from what it has: full name <-> first + last. */
  function withDerivedNames(values) {
    const result = { ...values };
    if (!result.fullName && (result.firstName || result.lastName)) {
      result.fullName = [result.firstName, result.lastName].filter(Boolean).join(" ");
    }
    if (result.fullName && !result.firstName && !result.lastName) {
      const [first, ...rest] = result.fullName.split(/\s+/);
      result.firstName = first;
      if (rest.length) result.lastName = rest.join(" ");
    }
    return result;
  }

  /** Picks the <option> that best matches a value, by value or visible text. */
  function findMatchingOption(select, wanted) {
    const target = String(wanted).trim().toLowerCase();
    const options = Array.from(select.options).filter((option) => option.value !== "" && !option.disabled);
    const text = (option) => option.textContent.trim().toLowerCase();

    return (
      options.find((option) => option.value.toLowerCase() === target || text(option) === target) ||
      options.find((option) => text(option).startsWith(target) || target.startsWith(text(option))) ||
      null
    );
  }

  const PROFILE_SKIPPED_TYPES = new Set(["checkbox", "radio", "file", "password", "range", "color"]);

  /**
   * Fills fields in a form (or formless group) from a global profile, matching
   * each field to a profile value by what it looks like. Never submits.
   */
  function fillFromProfile(container, profileValues) {
    const values = withDerivedNames(profileValues);
    let filled = 0;

    for (const field of FormPilotDetector.getUsableFields(container)) {
      const type = FormPilotFingerprint.getFieldType(field);
      if (PROFILE_SKIPPED_TYPES.has(type)) continue;

      const key = FormPilotFieldTypes.classify(FormPilotFingerprint.buildFieldMetadata(field, 0));
      const value = key ? values[key] : "";
      if (!value) continue;

      if (field.tagName === "SELECT") {
        const option = findMatchingOption(field, value);
        if (!option) continue;
        setSelectValue(field, option.value);
      } else if (type === "number" && !/^\d+$/.test(value)) {
        continue;
      } else if (type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        continue;
      } else {
        setNativeValue(field, value);
      }
      filled += 1;
    }

    return { filled };
  }

  return {
    setNativeValue,
    setChecked,
    setSelectValue,
    resolveField,
    fillField,
    fillForm,
    fillFromProfile,
    findMatchingOption
  };
})();
