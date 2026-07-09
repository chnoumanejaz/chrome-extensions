/**
 * FormPilot content script orchestrator.
 * Detects forms, injects floating buttons, and manages save/fill UI.
 */

const FormPilotContent = (() => {
  const formButtons = new WeakMap();
  const formRegistry = new WeakMap();
  const trackedForms = new Set();
  let activePanel = null;
  let cssText = "";
  let outsideClickHandler = null;

  async function loadStyles() {
    if (cssText) return cssText;
    try {
      const url = chrome.runtime.getURL("content/floating-button.css");
      const response = await fetch(url);
      cssText = await response.text();
    } catch {
      cssText = "";
    }
    return cssText;
  }

  async function getAllForms() {
    const result = await chrome.storage.local.get("forms");
    return result.forms || {};
  }

  async function getFormRecord(storageKey) {
    const forms = await getAllForms();
    return forms[storageKey] || null;
  }

  async function saveFormRecord(storageKey, record) {
    const forms = await getAllForms();
    forms[storageKey] = record;
    await chrome.storage.local.set({ forms });
    return record;
  }

  function getFormContext(form) {
    const forms = Array.from(document.querySelectorAll("form"));
    const formIndex = forms.indexOf(form);
    const storageKey = FormPilotFingerprint.getStorageKey(form, formIndex);
    const formMeta = FormPilotFingerprint.buildFormMetadata(form, formIndex);
    const fingerprint = FormPilotFingerprint.generateFingerprint(form, formIndex);

    return {
      form,
      formIndex,
      storageKey,
      formMeta,
      fingerprint
    };
  }

  function updateButtonPosition(form, buttonHost) {
    const rect = form.getBoundingClientRect();
    const top = Math.max(8, rect.top + 8);
    const hostWidth = buttonHost.offsetWidth || 28;

    buttonHost.style.top = `${top}px`;
    buttonHost.style.left = `${Math.max(8, rect.right - hostWidth - 8)}px`;
  }

  function closePanel() {
    if (activePanel) {
      activePanel.remove();
      activePanel = null;
    }
    document.removeEventListener("keydown", onEscapeKey);
    if (outsideClickHandler) {
      document.removeEventListener("click", outsideClickHandler, true);
      outsideClickHandler = null;
    }
  }

  function onEscapeKey(event) {
    if (event.key === "Escape") {
      closePanel();
    }
  }

  function onOutsideClick(event) {
    if (!activePanel) return;
    const path = event.composedPath();
    if (!path.includes(activePanel)) {
      closePanel();
    }
  }

  function positionPanel(panelHost, anchorRect) {
    const panelWidth = 300;
    const top = Math.min(window.innerHeight - 20, anchorRect.bottom + 8);
    let left = anchorRect.right - panelWidth;
    left = Math.max(12, Math.min(left, window.innerWidth - panelWidth - 12));

    panelHost.style.top = `${top}px`;
    panelHost.style.left = `${left}px`;
  }

  function showStatus(container, message, isError = false) {
    const existing = container.querySelector(".formpilot-status");
    if (existing) existing.remove();

    const status = document.createElement("div");
    status.className = `formpilot-status${isError ? " formpilot-status-error" : ""}`;
    status.textContent = message;
    container.appendChild(status);
  }

  async function handleSavePreset(context, panelContainer, refreshPanel) {
    const presetName = window.prompt("Enter a name for this preset:");
    if (!presetName || !presetName.trim()) return;

    try {
      const now = new Date().toISOString();
      const fields = FormPilotFingerprint.collectFieldData(context.form);
      const preset = {
        id: `preset_${Date.now()}`,
        name: presetName.trim(),
        createdAt: now,
        updatedAt: now,
        fields
      };

      let record = await getFormRecord(context.storageKey);
      if (!record) {
        record = {
          pageUrl: context.formMeta.pageUrl,
          origin: context.formMeta.origin,
          pathname: context.formMeta.pathname,
          domain: context.formMeta.domain,
          formFingerprint: context.fingerprint,
          formTitle: context.formMeta.formTitle,
          createdAt: now,
          updatedAt: now,
          presets: []
        };
      }

      record.presets = record.presets || [];
      record.presets.push(preset);
      record.updatedAt = now;

      await saveFormRecord(context.storageKey, record);
      showStatus(panelContainer, `Saved preset "${preset.name}".`);
      await refreshWidget(context);
      if (refreshPanel) await refreshPanel();
      setTimeout(closePanel, 600);
    } catch (error) {
      showStatus(panelContainer, `Save failed: ${error.message}`, true);
    }
  }

  function submitForm(form) {
    const submitBtn =
      form.querySelector('button[type="submit"]:not([disabled])') ||
      form.querySelector('input[type="submit"]:not([disabled])') ||
      form.querySelector('button:not([type]):not([disabled])') ||
      form.querySelector('[type="submit"]:not([disabled])');

    if (submitBtn) {
      submitBtn.click();
      return true;
    }

    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
      return true;
    }

    return false;
  }

  async function handleFillPreset(context, preset, panelContainer, options = {}) {
    const { autoSubmit = false, onComplete } = options;

    try {
      const summary = FormPilotAutofill.fillForm(context.form, preset.fields);

      if (autoSubmit) {
        // Brief delay so React/Vue controlled inputs settle before submit
        await new Promise((resolve) => setTimeout(resolve, 80));
        submitForm(context.form);
      }

      if (panelContainer) {
        if (summary.skipped > 0) {
          showStatus(
            panelContainer,
            autoSubmit
              ? `Filled and submitted (${summary.filled} field(s)).`
              : `Filled ${summary.filled} field(s). Skipped ${summary.skipped}.`,
            summary.filled === 0
          );
        } else {
          showStatus(
            panelContainer,
            autoSubmit ? `Filled and submitted.` : `Filled ${summary.filled} field(s).`
          );
        }
      }

      if (onComplete) onComplete(true, summary);
      return summary;
    } catch (error) {
      if (panelContainer) {
        showStatus(panelContainer, `Fill failed: ${error.message}`, true);
      }
      if (onComplete) onComplete(false, error);
      throw error;
    }
  }

  async function handleDeletePreset(context, presetId, panelContainer, refreshPanel) {
    const confirmed = window.confirm("Delete this preset?");
    if (!confirmed) return;

    try {
      const record = await getFormRecord(context.storageKey);
      if (!record) return;

      record.presets = (record.presets || []).filter((preset) => preset.id !== presetId);
      record.updatedAt = new Date().toISOString();

      if (record.presets.length === 0) {
        const forms = await getAllForms();
        delete forms[context.storageKey];
        await chrome.storage.local.set({ forms });
      } else {
        await saveFormRecord(context.storageKey, record);
      }

      showStatus(panelContainer, "Preset deleted.");
      await refreshWidget(context);
      if (refreshPanel) await refreshPanel();
    } catch (error) {
      showStatus(panelContainer, `Delete failed: ${error.message}`, true);
    }
  }

  async function openPanel(context, anchorRect) {
    closePanel();
    await loadStyles();

    const panelHost = document.createElement("div");
    panelHost.className = "formpilot-root formpilot-panel-host";
    panelHost.style.position = "fixed";
    panelHost.style.zIndex = "2147483647";
    panelHost.style.pointerEvents = "none";

    const shadow = panelHost.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = cssText;
    shadow.appendChild(style);

    const panel = document.createElement("div");
    panel.className = "formpilot-panel";
    shadow.appendChild(panel);

    document.body.appendChild(panelHost);
    activePanel = panelHost;
    positionPanel(panelHost, anchorRect);

    document.addEventListener("keydown", onEscapeKey);
    outsideClickHandler = onOutsideClick;
    setTimeout(() => {
      document.addEventListener("click", outsideClickHandler, true);
    }, 0);

    const renderPanel = async () => {
      panel.innerHTML = "";

      const header = document.createElement("div");
      header.className = "formpilot-panel-header";

      const title = document.createElement("h3");
      title.className = "formpilot-panel-title";
      title.textContent = "FormPilot";

      const closeBtn = document.createElement("button");
      closeBtn.className = "formpilot-close";
      closeBtn.type = "button";
      closeBtn.setAttribute("aria-label", "Close");
      closeBtn.textContent = "×";
      closeBtn.addEventListener("click", closePanel);

      header.appendChild(title);
      header.appendChild(closeBtn);
      panel.appendChild(header);

      const warning = document.createElement("div");
      warning.className = "formpilot-warning";
      warning.textContent =
        "Data is stored locally in your browser. Avoid saving sensitive passwords, payment cards, or private personal data.";
      panel.appendChild(warning);

      const privacy = document.createElement("div");
      privacy.className = "formpilot-privacy";
      privacy.textContent = "All saved data stays locally in your browser.";
      panel.appendChild(privacy);

      const record = await getFormRecord(context.storageKey);
      const presets = record?.presets || [];

      if (presets.length > 0) {
        const sectionTitle = document.createElement("p");
        sectionTitle.className = "formpilot-section-title";
        sectionTitle.textContent = "Click a preset to fill and submit:";
        panel.appendChild(sectionTitle);

        const list = document.createElement("div");
        list.className = "formpilot-preset-list";

        for (const preset of presets) {
          const item = document.createElement("button");
          item.className = "formpilot-preset-item formpilot-preset-item-clickable";
          item.type = "button";
          item.title = `Fill and submit: ${preset.name}`;

          const name = document.createElement("span");
          name.className = "formpilot-preset-name";
          name.textContent = preset.name;

          const deleteBtn = document.createElement("span");
          deleteBtn.className = "formpilot-preset-delete";
          deleteBtn.setAttribute("role", "button");
          deleteBtn.setAttribute("aria-label", `Delete ${preset.name}`);
          deleteBtn.textContent = "×";
          deleteBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            handleDeletePreset(context, preset.id, panel, renderPanel);
          });

          item.appendChild(name);
          item.appendChild(deleteBtn);
          item.addEventListener("click", async (event) => {
            event.stopPropagation();
            await handleFillPreset(context, preset, panel, { autoSubmit: true });
            closePanel();
          });
          list.appendChild(item);
        }

        panel.appendChild(list);
      } else {
        const empty = document.createElement("p");
        empty.className = "formpilot-empty";
        empty.textContent = "No saved presets for this form yet.";
        panel.appendChild(empty);
      }

      const footer = document.createElement("div");
      footer.className = "formpilot-footer";

      const saveBtn = document.createElement("button");
      saveBtn.className = "formpilot-btn formpilot-btn-primary";
      saveBtn.type = "button";
      saveBtn.textContent = "Save Current Form Data";
      saveBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        handleSavePreset(context, panel, renderPanel);
      });

      const cancelBtn = document.createElement("button");
      cancelBtn.className = "formpilot-btn formpilot-btn-secondary";
      cancelBtn.type = "button";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        closePanel();
      });

      footer.appendChild(saveBtn);
      footer.appendChild(cancelBtn);
      panel.appendChild(footer);
    };

    await renderPanel();
  }

  async function renderWidgetContent(shadow, context) {
    shadow.innerHTML = "";

    const style = document.createElement("style");
    style.textContent = cssText;
    shadow.appendChild(style);

    const widget = document.createElement("div");
    widget.className = "formpilot-widget";

    const record = await getFormRecord(context.storageKey);
    const presets = record?.presets || [];

    if (presets.length > 0) {
      for (const preset of presets) {
        const chip = document.createElement("button");
        chip.className = "formpilot-preset-chip";
        chip.type = "button";
        chip.textContent = preset.name;
        chip.title = `Fill and submit: ${preset.name}`;
        chip.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          chip.classList.add("formpilot-chip-loading");
          try {
            await handleFillPreset(context, preset, null, { autoSubmit: true });
            chip.classList.remove("formpilot-chip-loading");
            chip.classList.add("formpilot-chip-success");
            setTimeout(() => chip.classList.remove("formpilot-chip-success"), 1200);
          } catch {
            chip.classList.remove("formpilot-chip-loading");
            chip.classList.add("formpilot-chip-error");
            setTimeout(() => chip.classList.remove("formpilot-chip-error"), 1200);
          }
        });
        widget.appendChild(chip);
      }

      const addBtn = document.createElement("button");
      addBtn.className = "formpilot-chip-add";
      addBtn.type = "button";
      addBtn.title = "Save current form data";
      addBtn.textContent = "+";
      addBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = addBtn.getBoundingClientRect();
        openPanel(context, rect);
      });
      widget.appendChild(addBtn);
    } else {
      const button = document.createElement("button");
      button.className = "formpilot-button";
      button.type = "button";
      button.title = "Save form data";
      button.textContent = "FP";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = button.getBoundingClientRect();
        openPanel(context, rect);
      });
      widget.appendChild(button);
    }

    shadow.appendChild(widget);
  }

  async function refreshWidget(context) {
    const host = formButtons.get(context.form);
    if (!host) return;
    const shadow = host.shadowRoot;
    if (!shadow) return;
    await renderWidgetContent(shadow, context);
    updateButtonPosition(context.form, host);
    // Re-measure after content renders (widget may be wider than default)
    requestAnimationFrame(() => updateButtonPosition(context.form, host));
  }

  async function createButtonForForm(form) {
    await loadStyles();

    const context = getFormContext(form);
    formRegistry.set(form, context);

    if (formButtons.has(form)) {
      await refreshWidget(context);
      updateButtonPosition(form, formButtons.get(form));
      return;
    }

    const host = document.createElement("div");
    host.className = "formpilot-root formpilot-button-host";
    host.style.position = "fixed";
    host.style.zIndex = "2147483646";
    host.style.pointerEvents = "none";

    const shadow = host.attachShadow({ mode: "open" });
    await renderWidgetContent(shadow, context);

    document.body.appendChild(host);
    formButtons.set(form, host);
    trackedForms.add(form);
    requestAnimationFrame(() => updateButtonPosition(form, host));
  }

  function removeOrphanButtons(validForms) {
    for (const form of trackedForms) {
      if (!validForms.includes(form) || !document.contains(form)) {
        const host = formButtons.get(form);
        if (host) host.remove();
        formButtons.delete(form);
        formRegistry.delete(form);
        trackedForms.delete(form);
      }
    }
  }

  function scanAndAttach() {
    const validForms = FormPilotDetector.scanForms();
    removeOrphanButtons(validForms);

    for (const form of validForms) {
      createButtonForForm(form);
    }
  }

  function init() {
    if (window !== window.top) return;

    scanAndAttach();
    FormPilotDetector.observe(scanAndAttach);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.forms) return;
      for (const form of trackedForms) {
        const context = formRegistry.get(form);
        if (context) refreshWidget(context);
      }
    });

    window.addEventListener(
      "scroll",
      () => {
        for (const form of trackedForms) {
          const host = formButtons.get(form);
          if (host && document.contains(form)) {
            updateButtonPosition(form, host);
          }
        }
        if (activePanel) {
          closePanel();
        }
      },
      true
    );

    window.addEventListener(
      "resize",
      () => {
        for (const form of trackedForms) {
          const host = formButtons.get(form);
          if (host && document.contains(form)) {
            updateButtonPosition(form, host);
          }
        }
      },
      { passive: true }
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return { init };
})();
