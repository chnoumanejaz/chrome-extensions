/**
 * FormPilot content script orchestrator.
 * Detects forms, injects floating buttons, and manages save/fill UI.
 */

const FormPilotContent = (() => {
  const formButtons = new WeakMap();
  const formRegistry = new WeakMap();
  const trackedForms = new Set();
  const formsBeingCreated = new WeakSet();
  let activePanel = null;
  let cssText = "";
  let outsideClickHandler = null;
  let siteEnabled = true;
  let formlessEnabled = false;

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

  /** Applies `changes` to one preset and saves it. Returns the preset, or null if it's gone. */
  async function updatePreset(storageKey, presetId, changes) {
    const record = await getFormRecord(storageKey);
    const preset = record?.presets?.find((item) => item.id === presetId);
    if (!preset) return null;

    const now = new Date().toISOString();
    Object.assign(preset, changes, { updatedAt: now });
    record.updatedAt = now;
    await saveFormRecord(storageKey, record);
    return preset;
  }

  function getFormContext(form) {
    const isRealForm = form.tagName === "FORM";
    const formIndex = isRealForm
      ? Array.from(document.querySelectorAll("form")).indexOf(form)
      : FormPilotDetector.getFormlessIndex(form);
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

    // A form scrolled completely out of view shouldn't leave its button pinned
    // to the edge of the screen, where it would sit on top of other widgets.
    const offscreen = rect.bottom < 0 || rect.top > window.innerHeight;
    buttonHost.style.display = offscreen ? "none" : "";
    if (offscreen) return;

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
    if (path.includes(activePanel)) return;
    // The passphrase dialog sits outside the panel but is part of the same flow.
    if (path.some((node) => node.classList?.contains("formpilot-dialog-host"))) return;
    closePanel();
  }

  function positionPanel(panelHost, anchorRect, panelHeight = 0) {
    const panelWidth = 300;
    const maxTop = window.innerHeight - panelHeight - 8;
    const top = Math.max(8, Math.min(anchorRect.bottom + 8, panelHeight ? maxTop : window.innerHeight - 20));
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

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function hasValue(value) {
    return value !== undefined && value !== null && value !== "" && value !== false;
  }

  // ---------------------------------------------------------------- encryption

  /**
   * Makes sure the encryption key is available, asking for the passphrase if not.
   * With `allowSetup`, a first-time user is walked through creating one.
   */
  async function ensureUnlocked({ allowSetup = false } = {}) {
    const status = await FormPilotCrypto.status();
    if (status.configured && status.unlocked) return true;
    if (!status.configured && !allowSetup) return false;

    await loadStyles();
    return FormPilotDialogs.askPassphrase({
      css: cssText,
      mode: status.configured ? "unlock" : "setup",
      onSubmit: (passphrase) =>
        status.configured ? FormPilotCrypto.unlock(passphrase) : FormPilotCrypto.setup(passphrase)
    });
  }

  /**
   * Splits a form's current values into what gets saved: sensitive fields are
   * dropped ("skip") or replaced with encrypted payloads ("encrypt").
   */
  async function buildPresetFields(context, sensitiveMode) {
    const fields = [];
    let skipped = 0;
    let encrypted = 0;

    for (const field of FormPilotFingerprint.collectFieldData(context.form)) {
      if (!FormPilotFieldTypes.isSensitive(field.metadata)) {
        fields.push(field);
        continue;
      }

      if (!hasValue(field.value)) continue;

      if (sensitiveMode === "encrypt") {
        const payload = await FormPilotCrypto.encrypt(JSON.stringify(field.value));
        fields.push({ ...field, value: null, enc: payload });
        encrypted += 1;
      } else {
        skipped += 1;
      }
    }

    return { fields, skipped, encrypted };
  }

  /** Decrypts a preset's encrypted fields. Fields that can't be decrypted are left out. */
  async function resolvePresetFields(preset) {
    const encryptedFields = preset.fields.filter((field) => field.enc);
    if (encryptedFields.length === 0) return { fields: preset.fields, lockedCount: 0 };

    const plainFields = preset.fields.filter((field) => !field.enc);
    const unavailable = { fields: plainFields, lockedCount: encryptedFields.length };

    if (!(await ensureUnlocked())) return unavailable;

    try {
      const values = await FormPilotCrypto.decryptMany(encryptedFields.map((field) => field.enc));
      const decrypted = new Map(encryptedFields.map((field, index) => [field, JSON.parse(values[index])]));
      const fields = preset.fields.map((field) => (field.enc ? { ...field, value: decrypted.get(field) } : field));
      return { fields, lockedCount: 0 };
    } catch {
      return unavailable;
    }
  }

  // ------------------------------------------------------------ preset actions

  function submitForm(form) {
    if (form.tagName !== "FORM") {
      const control = FormPilotDetector.findSubmitControl(form);
      if (control) {
        control.click();
        return true;
      }
      return false;
    }

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

  function describeFill(summary, { autoSubmit, submitted, lockedCount }) {
    const parts = [];
    if (autoSubmit && submitted) parts.push(`Filled and submitted (${summary.filled} field(s)).`);
    else if (autoSubmit) parts.push(`Filled ${summary.filled} field(s). No submit button found.`);
    else parts.push(`Filled ${summary.filled} field(s).`);

    if (summary.skipped > 0) parts.push(`Skipped ${summary.skipped}.`);
    if (lockedCount > 0) parts.push(`${lockedCount} encrypted field(s) left empty.`);
    return parts.join(" ");
  }

  async function handleSavePreset(context, { name, autoSubmit, sensitiveMode }, panelContainer) {
    try {
      const sensitiveCount = FormPilotFingerprint.collectFieldData(context.form).filter(
        (field) => FormPilotFieldTypes.isSensitive(field.metadata) && hasValue(field.value)
      ).length;

      if (sensitiveMode === "encrypt" && sensitiveCount > 0) {
        if (!(await ensureUnlocked({ allowSetup: true }))) {
          showStatus(panelContainer, "Not saved: encryption needs a passphrase.", true);
          return false;
        }
      }

      const { fields, skipped, encrypted } = await buildPresetFields(context, sensitiveMode);

      const now = new Date().toISOString();
      const preset = {
        id: `preset_${Date.now()}`,
        name,
        autoSubmit,
        createdAt: now,
        updatedAt: now,
        fields
      };

      let record = await getFormRecord(context.storageKey);
      if (!record) {
        record = {
          kind: context.formMeta.kind,
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
      await FormPilotSettings.update({ lastAutoSubmit: autoSubmit });

      const notes = [];
      if (encrypted > 0) notes.push(`${encrypted} sensitive field(s) encrypted`);
      if (skipped > 0) notes.push(`${skipped} sensitive field(s) not saved`);
      showStatus(panelContainer, `Saved preset "${preset.name}".${notes.length ? ` ${notes.join(", ")}.` : ""}`);

      await refreshWidget(context);
      return true;
    } catch (error) {
      showStatus(panelContainer, `Save failed: ${error.message}`, true);
      return false;
    }
  }

  async function handleFillPreset(context, preset, panelContainer) {
    const autoSubmit = preset.autoSubmit !== false;

    try {
      const { fields, lockedCount } = await resolvePresetFields(preset);
      const summary = FormPilotAutofill.fillForm(context.form, fields);

      let submitted = false;
      if (autoSubmit) {
        // Brief delay so React/Vue controlled inputs settle before submit
        await new Promise((resolve) => setTimeout(resolve, 80));
        submitted = submitForm(context.form);
      }

      const failed = summary.filled === 0 || lockedCount > 0;
      if (panelContainer) {
        showStatus(panelContainer, describeFill(summary, { autoSubmit, submitted, lockedCount }), failed);
      }

      return { summary, failed };
    } catch (error) {
      if (panelContainer) {
        showStatus(panelContainer, `Fill failed: ${error.message}`, true);
      }
      throw error;
    }
  }

  async function handleRenamePreset(context, preset, refreshPanel) {
    const name = window.prompt("Rename preset:", preset.name);
    if (!name || !name.trim() || name.trim() === preset.name) return;

    await updatePreset(context.storageKey, preset.id, { name: name.trim() });
    await refreshWidget(context);
    await refreshPanel();
  }

  async function handleToggleSubmit(context, preset, refreshPanel) {
    await updatePreset(context.storageKey, preset.id, { autoSubmit: preset.autoSubmit === false });
    await refreshWidget(context);
    await refreshPanel();
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

  // --------------------------------------------------------------------- panel

  function renderPanelHeader(title) {
    const header = h("div", "formpilot-panel-header");
    header.appendChild(h("h3", "formpilot-panel-title", title));

    const closeBtn = h("button", "formpilot-close", "×");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", closePanel);
    header.appendChild(closeBtn);
    return header;
  }

  function renderPresetRow(context, preset, panel, refreshPanel) {
    const autoSubmit = preset.autoSubmit !== false;

    const item = h("button", "formpilot-preset-item formpilot-preset-item-clickable");
    item.type = "button";
    item.title = autoSubmit ? `Fill and submit: ${preset.name}` : `Fill only: ${preset.name}`;

    const name = h("span", "formpilot-preset-name", preset.name);

    const submitToggle = h("span", `formpilot-preset-action${autoSubmit ? " formpilot-preset-action-on" : ""}`, "↵");
    submitToggle.setAttribute("role", "button");
    submitToggle.setAttribute("aria-pressed", String(autoSubmit));
    submitToggle.setAttribute("aria-label", `Submit after filling: ${autoSubmit ? "on" : "off"}`);
    submitToggle.title = autoSubmit
      ? "Submits after filling. Click to switch to fill only."
      : "Fill only. Click to submit after filling.";
    submitToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      handleToggleSubmit(context, preset, refreshPanel);
    });

    const renameBtn = h("span", "formpilot-preset-action", "✎");
    renameBtn.setAttribute("role", "button");
    renameBtn.setAttribute("aria-label", `Rename ${preset.name}`);
    renameBtn.title = "Rename";
    renameBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      handleRenamePreset(context, preset, refreshPanel);
    });

    const deleteBtn = h("span", "formpilot-preset-delete", "×");
    deleteBtn.setAttribute("role", "button");
    deleteBtn.setAttribute("aria-label", `Delete ${preset.name}`);
    deleteBtn.title = "Delete";
    deleteBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      handleDeletePreset(context, preset.id, panel, refreshPanel);
    });

    item.append(name, submitToggle, renameBtn, deleteBtn);
    item.addEventListener("click", async (event) => {
      event.stopPropagation();
      const { failed } = await handleFillPreset(context, preset, panel);
      // Keep the panel open when something went wrong, so the message can be read.
      if (!failed) closePanel();
    });
    return item;
  }

  function renderQuickFill(context, profiles, panel) {
    panel.appendChild(h("p", "formpilot-section-title", "Fill without a preset"));

    if (profiles.length > 0) {
      const row = h("div", "formpilot-row");
      const select = h("select", "formpilot-select");
      select.setAttribute("aria-label", "Profile");
      for (const profile of profiles) {
        const option = h("option", "", profile.name);
        option.value = profile.id;
        select.appendChild(option);
      }

      const fillBtn = h("button", "formpilot-btn formpilot-btn-secondary", "Fill profile");
      fillBtn.type = "button";
      fillBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const profile = profiles.find((item) => item.id === select.value);
        if (!profile) return;
        const { filled } = FormPilotAutofill.fillFromProfile(context.form, profile.values);
        showStatus(
          panel,
          filled > 0 ? `Filled ${filled} field(s) from "${profile.name}".` : `No fields matched "${profile.name}".`,
          filled === 0
        );
      });

      row.append(select, fillBtn);
      panel.appendChild(row);
    } else {
      panel.appendChild(h("p", "formpilot-empty", "No profiles yet. Create one in FormPilot settings."));
    }

    const randomBtn = h("button", "formpilot-btn formpilot-btn-secondary formpilot-btn-block", "Fill with random test data");
    randomBtn.type = "button";
    randomBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      const { filled } = FormPilotTestData.fill(context.form);
      showStatus(panel, `Filled ${filled} field(s) with random test data.`, filled === 0);
    });
    panel.appendChild(randomBtn);
  }

  async function renderMainView(context, panel, refreshPanel, showSaveView) {
    panel.appendChild(renderPanelHeader("FormPilot"));

    const [record, profiles, settings] = await Promise.all([
      getFormRecord(context.storageKey),
      FormPilotProfiles.getAll(),
      FormPilotSettings.get()
    ]);

    const warning = h(
      "div",
      "formpilot-warning",
      settings.sensitiveMode === "encrypt"
        ? "Data is stored locally in your browser. Sensitive fields (passwords, cards) are saved encrypted with your passphrase."
        : "Data is stored locally in your browser. Passwords, cards and other sensitive fields are not saved unless you choose to encrypt them."
    );
    panel.appendChild(warning);
    panel.appendChild(h("div", "formpilot-privacy", "All saved data stays locally in your browser."));

    const presets = record?.presets || [];

    if (presets.length > 0) {
      panel.appendChild(h("p", "formpilot-section-title", "Saved presets (click to fill)"));

      const list = h("div", "formpilot-preset-list");
      for (const preset of presets) {
        list.appendChild(renderPresetRow(context, preset, panel, refreshPanel));
      }
      panel.appendChild(list);
    } else {
      panel.appendChild(h("p", "formpilot-empty", "No saved presets for this form yet."));
    }

    panel.appendChild(h("div", "formpilot-divider"));
    renderQuickFill(context, profiles, panel);

    const footer = h("div", "formpilot-footer");
    footer.style.marginTop = "12px";

    const saveBtn = h("button", "formpilot-btn formpilot-btn-primary", "Save Current Form Data");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      showSaveView();
    });

    const cancelBtn = h("button", "formpilot-btn formpilot-btn-secondary", "Cancel");
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      closePanel();
    });

    footer.append(saveBtn, cancelBtn);
    panel.appendChild(footer);
  }

  async function renderSaveView(context, panel, showMainView) {
    panel.appendChild(renderPanelHeader("Save form data"));

    const settings = await FormPilotSettings.get();
    const sensitiveFields = FormPilotFingerprint.collectFieldData(context.form).filter(
      (field) => FormPilotFieldTypes.isSensitive(field.metadata) && hasValue(field.value)
    );

    const form = h("form");
    form.noValidate = true;

    const nameField = h("label", "formpilot-field");
    nameField.appendChild(h("span", "formpilot-field-label", "Preset name"));
    const nameInput = h("input", "formpilot-input");
    nameInput.type = "text";
    nameInput.placeholder = "e.g. Admin login";
    nameInput.maxLength = 60;
    nameInput.autocomplete = "off";
    nameField.appendChild(nameInput);
    form.appendChild(nameField);

    const submitLabel = h("label", "formpilot-check");
    const submitCheck = h("input");
    submitCheck.type = "checkbox";
    submitCheck.checked = settings.lastAutoSubmit;
    submitLabel.append(submitCheck, h("span", "", "Submit the form after filling"));
    form.append(submitLabel, h("p", "formpilot-hint", "Leave off to only fill the fields. You can change this later."));

    let sensitiveSelect = null;
    if (sensitiveFields.length > 0) {
      const names = sensitiveFields.map((field) => field.metadata.label || field.metadata.name || field.fieldKey);
      const sensitiveField = h("label", "formpilot-field");
      sensitiveField.appendChild(
        h("span", "formpilot-field-label", `Sensitive fields found (${sensitiveFields.length}): ${names.join(", ")}`)
      );

      sensitiveSelect = h("select", "formpilot-select");
      for (const [value, label] of [
        ["skip", "Don't save them"],
        ["encrypt", "Save them encrypted (passphrase)"]
      ]) {
        const option = h("option", "", label);
        option.value = value;
        sensitiveSelect.appendChild(option);
      }
      sensitiveSelect.value = settings.sensitiveMode;
      sensitiveField.appendChild(sensitiveSelect);
      form.appendChild(sensitiveField);
    }

    const footer = h("div", "formpilot-footer");
    const saveBtn = h("button", "formpilot-btn formpilot-btn-primary", "Save preset");
    saveBtn.type = "submit";
    const backBtn = h("button", "formpilot-btn formpilot-btn-secondary", "Back");
    backBtn.type = "button";
    backBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      showMainView();
    });
    footer.append(saveBtn, backBtn);
    form.appendChild(footer);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const name = nameInput.value.trim();
      if (!name) {
        showStatus(panel, "Enter a name for this preset.", true);
        nameInput.focus();
        return;
      }

      saveBtn.disabled = true;
      const saved = await handleSavePreset(
        context,
        {
          name,
          autoSubmit: submitCheck.checked,
          sensitiveMode: sensitiveSelect ? sensitiveSelect.value : settings.sensitiveMode
        },
        panel
      );
      saveBtn.disabled = false;

      if (saved) setTimeout(closePanel, 900);
    });

    panel.appendChild(form);
    nameInput.focus();
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

    // Typing in the panel must not trigger the site's own keyboard shortcuts.
    for (const type of ["keydown", "keyup", "keypress"]) {
      panelHost.addEventListener(type, (event) => {
        event.stopPropagation();
        if (type === "keydown" && event.key === "Escape") closePanel();
      });
    }

    document.body.appendChild(panelHost);
    activePanel = panelHost;
    positionPanel(panelHost, anchorRect);

    document.addEventListener("keydown", onEscapeKey);
    outsideClickHandler = onOutsideClick;
    setTimeout(() => {
      document.addEventListener("click", outsideClickHandler, true);
    }, 0);

    let view = "main";

    const render = async () => {
      panel.innerHTML = "";
      if (view === "save") {
        await renderSaveView(context, panel, showMainView);
      } else {
        await renderMainView(context, panel, render, showSaveView);
      }
      // The panel's height changes between views; keep it on screen.
      if (activePanel === panelHost) positionPanel(panelHost, anchorRect, panel.offsetHeight);
    };

    const showMainView = () => {
      view = "main";
      return render();
    };

    const showSaveView = () => {
      view = "save";
      return render();
    };

    await render();
  }

  // -------------------------------------------------------------------- widget

  async function renderWidgetContent(shadow, context) {
    // Read first and swap the content in one step at the end, so two renders
    // running at once can't leave a doubled-up widget behind.
    const record = await getFormRecord(context.storageKey);
    const presets = record?.presets || [];

    const style = document.createElement("style");
    style.textContent = cssText;

    const widget = document.createElement("div");
    widget.className = "formpilot-widget";

    if (presets.length > 0) {
      for (const preset of presets) {
        const autoSubmit = preset.autoSubmit !== false;

        const chip = document.createElement("button");
        chip.className = "formpilot-preset-chip";
        chip.type = "button";
        chip.textContent = autoSubmit ? `↵ ${preset.name}` : preset.name;
        chip.title = autoSubmit ? `Fill and submit: ${preset.name}` : `Fill only: ${preset.name}`;
        chip.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          chip.classList.add("formpilot-chip-loading");
          try {
            const { failed } = await handleFillPreset(context, preset, null);
            chip.classList.remove("formpilot-chip-loading");
            chip.classList.add(failed ? "formpilot-chip-error" : "formpilot-chip-success");
            setTimeout(() => chip.classList.remove("formpilot-chip-success", "formpilot-chip-error"), 1200);
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
      addBtn.title = "Save form data, use a profile or fill test data";
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
      button.title = "FormPilot: save form data, use a profile or fill test data";
      button.textContent = "FP";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = button.getBoundingClientRect();
        openPanel(context, rect);
      });
      widget.appendChild(button);
    }

    shadow.replaceChildren(style, widget);
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
    // A rescan can start while this form's widget is still being built; one is enough.
    if (formsBeingCreated.has(form)) return;
    formsBeingCreated.add(form);

    try {
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

      // The site may have been switched off while the widget was rendering.
      if (!siteEnabled) return;

      document.body.appendChild(host);
      formButtons.set(form, host);
      trackedForms.add(form);
      requestAnimationFrame(() => updateButtonPosition(form, host));
    } finally {
      formsBeingCreated.delete(form);
    }
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
    if (!siteEnabled) {
      removeOrphanButtons([]);
      closePanel();
      return;
    }

    const validForms = FormPilotDetector.scanForms();
    if (formlessEnabled) validForms.push(...FormPilotDetector.scanFormless());
    removeOrphanButtons(validForms);

    for (const form of validForms) {
      createButtonForForm(form);
    }
  }

  function applyRules(rules) {
    siteEnabled = FormPilotSiteRules.evaluate(location.hostname, rules).enabled;
    formlessEnabled = siteEnabled && FormPilotSiteRules.evaluateFormless(location.hostname, rules).enabled;
  }

  /** Starts watching the page when FormPilot is on for this site, and stops entirely when it isn't. */
  function applyScanState() {
    if (!siteEnabled) {
      FormPilotDetector.disconnect();
      scanAndAttach();
      return;
    }

    FormPilotDetector.observe(scanAndAttach);
    scanAndAttach();
  }

  async function init() {
    if (window !== window.top) return;

    // Listen before reading, so a rule change during startup can't slip between the two.
    let rulesChangedDuringStartup = false;

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;

      const ruleChange = changes[FormPilotSiteRules.STORAGE_KEY];
      if (ruleChange) {
        rulesChangedDuringStartup = true;
        applyRules(FormPilotSiteRules.sanitize(ruleChange.newValue));
        applyScanState();
      }

      if (changes.forms) {
        for (const form of trackedForms) {
          const context = formRegistry.get(form);
          if (context) refreshWidget(context);
        }
      }
    });

    // Resolve site rules before the first scan so hidden sites never flash a button.
    const rules = await FormPilotSiteRules.get();
    if (!rulesChangedDuringStartup) applyRules(rules);
    applyScanState();

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
