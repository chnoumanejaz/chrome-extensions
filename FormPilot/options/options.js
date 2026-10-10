function formatDate(isoDate) {
  if (!isoDate) return "Unknown date";
  try {
    return new Date(isoDate).toLocaleString();
  } catch {
    return isoDate;
  }
}

function renderEmptyState(message) {
  const container = document.getElementById("forms-container");
  container.innerHTML = `<p class="empty-state">${message}</p>`;
}

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function deletePreset(storageKey, presetId) {
  const record = await FormPilotStorage.getFormRecord(storageKey);
  if (!record) return;

  record.presets = (record.presets || []).filter((preset) => preset.id !== presetId);
  record.updatedAt = new Date().toISOString();

  if (record.presets.length === 0) {
    await FormPilotStorage.deleteFormRecord(storageKey);
  } else {
    await FormPilotStorage.saveFormRecord(storageKey, record);
  }
}

function describeSavedField(field) {
  const meta = field.metadata || {};
  return meta.label || meta.placeholder || meta.name || meta.id || field.fieldKey || "Field";
}

function toBoolean(value) {
  return value === true || value === "true" || value === "on" || value === "1";
}

/** One editable row for a saved field: its label, a value control, and a remove button. */
function createFieldEditorRow(field) {
  const type = field.metadata?.type || "text";
  const row = createElement("div", "field-row");

  const labelWrap = createElement("div", "field-row-label");
  labelWrap.appendChild(createElement("span", "field-row-name", describeSavedField(field)));
  labelWrap.appendChild(createElement("span", "field-row-type", field.enc ? `${type} · encrypted` : type));
  row.appendChild(labelWrap);

  let input;
  if (field.enc) {
    input = createElement("input", "site-input");
    input.type = "password";
    input.placeholder = "Encrypted. Type to replace";
    input.autocomplete = "new-password";
  } else if (type === "checkbox") {
    input = createElement("input");
    input.type = "checkbox";
    input.checked = toBoolean(field.value);
  } else if (type === "textarea" || String(field.value ?? "").includes("\n")) {
    input = createElement("textarea", "site-input");
    input.rows = 3;
    input.value = String(field.value ?? "");
  } else {
    input = createElement("input", "site-input");
    input.type = "text";
    input.value = String(field.value ?? "");
  }
  input.setAttribute("aria-label", `Value for ${describeSavedField(field)}`);

  const removeBtn = createElement("button", "btn btn-delete btn-small", "Remove");
  removeBtn.type = "button";

  const state = { field, input, removed: false };
  removeBtn.addEventListener("click", () => {
    state.removed = !state.removed;
    row.classList.toggle("field-row-removed", state.removed);
    input.disabled = state.removed;
    removeBtn.textContent = state.removed ? "Undo" : "Remove";
  });

  row.append(input, removeBtn);
  return { row, state };
}

/** Builds the inline editor for one preset. */
function createPresetEditor(storageKey, preset) {
  const editor = createElement("form", "preset-editor");
  editor.noValidate = true;

  const nameLabel = createElement("label", "profile-name-field");
  nameLabel.appendChild(createElement("span", "field-label", "Preset name"));
  const nameInput = createElement("input", "site-input");
  nameInput.type = "text";
  nameInput.maxLength = 60;
  nameInput.value = preset.name;
  nameLabel.appendChild(nameInput);
  editor.appendChild(nameLabel);

  const submitLabel = createElement("label", "check-row");
  const submitCheck = createElement("input");
  submitCheck.type = "checkbox";
  submitCheck.checked = preset.autoSubmit !== false;
  submitLabel.append(submitCheck, createElement("span", "", "Submit the form after filling"));
  editor.appendChild(submitLabel);

  editor.appendChild(createElement("h4", "field-section-title", "Saved values"));
  const fieldList = createElement("div", "field-list");
  const rows = (preset.fields || []).map(createFieldEditorRow);
  if (rows.length === 0) {
    fieldList.appendChild(createElement("p", "empty-state", "This preset has no saved values."));
  }
  for (const { row } of rows) fieldList.appendChild(row);
  editor.appendChild(fieldList);

  const error = createElement("p", "site-error");
  error.setAttribute("role", "alert");
  error.hidden = true;

  const actions = createElement("div", "editor-actions");
  const saveBtn = createElement("button", "btn btn-primary btn-small", "Save changes");
  saveBtn.type = "submit";
  const cancelBtn = createElement("button", "btn btn-secondary btn-small", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", () => renderForms());
  actions.append(saveBtn, cancelBtn);
  editor.append(error, actions);

  const fail = (message) => {
    error.textContent = message;
    error.hidden = false;
    saveBtn.disabled = false;
  };

  editor.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;

    const name = nameInput.value.trim();
    if (!name) return fail("Give the preset a name.");

    saveBtn.disabled = true;
    try {
      const needsKey = rows.some(({ state }) => !state.removed && state.field.enc && state.input.value);
      if (needsKey && !(await FormPilotCrypto.status()).unlocked) {
        return fail('Unlock encryption first (see "Sensitive fields" above) to replace an encrypted value.');
      }

      const fields = [];
      for (const { state } of rows) {
        if (state.removed) continue;

        const updated = { ...state.field };
        if (updated.enc) {
          if (state.input.value) updated.enc = await FormPilotCrypto.encrypt(JSON.stringify(state.input.value));
        } else if (state.input.type === "checkbox") {
          updated.value = state.input.checked;
        } else {
          updated.value = state.input.value;
        }
        fields.push(updated);
      }

      await FormPilotStorage.updatePreset(storageKey, preset.id, {
        name,
        autoSubmit: submitCheck.checked,
        fields
      });
      await renderForms();
    } catch (failure) {
      fail(`Couldn't save: ${failure.message}`);
    }
  });

  return editor;
}

function renderPresetItem(storageKey, preset) {
  const wrap = createElement("div", "preset-wrap");

  const item = createElement("div", "preset-item");
  const info = createElement("div", "preset-info");
  info.appendChild(createElement("div", "preset-name", preset.name));

  const mode = preset.autoSubmit !== false ? "Submits after filling" : "Fill only";
  info.appendChild(
    createElement(
      "div",
      "preset-date",
      `Saved ${formatDate(preset.createdAt)} · ${(preset.fields || []).length} field(s) · ${mode}`
    )
  );

  const actions = createElement("div", "preset-actions");

  const editBtn = createElement("button", "btn btn-secondary btn-small", "Edit");
  editBtn.type = "button";
  editBtn.setAttribute("aria-label", `Edit ${preset.name}`);
  editBtn.addEventListener("click", () => {
    item.remove();
    wrap.appendChild(createPresetEditor(storageKey, preset));
    wrap.querySelector("input").focus();
  });

  const deleteBtn = createElement("button", "btn btn-delete btn-small", "Delete");
  deleteBtn.type = "button";
  deleteBtn.addEventListener("click", async () => {
    const confirmed = confirm(`Delete preset "${preset.name}"?`);
    if (!confirmed) return;
    await deletePreset(storageKey, preset.id);
    await renderForms();
  });

  actions.append(editBtn, deleteBtn);
  item.append(info, actions);
  wrap.appendChild(item);
  return wrap;
}

async function renderForms() {
  const container = document.getElementById("forms-container");
  const forms = await FormPilotStorage.getAllForms();
  const entries = Object.entries(forms);

  if (entries.length === 0) {
    renderEmptyState("No saved forms yet. Visit a page with a form and click the FP button to save a preset.");
    return;
  }

  container.innerHTML = "";

  for (const [storageKey, record] of entries) {
    const card = document.createElement("article");
    card.className = "form-card";

    const header = document.createElement("div");
    header.className = "form-card-header";

    const info = document.createElement("div");
    const title = document.createElement("h2");
    title.className = "form-title";
    title.textContent = record.formTitle || "Untitled form";

    const meta = document.createElement("p");
    meta.className = "form-meta";
    const kind = record.kind === "container" ? " · no <form> tag" : "";
    meta.textContent = `${record.pageUrl || storageKey} · fingerprint: ${record.formFingerprint || "n/a"}${kind}`;

    info.appendChild(title);
    info.appendChild(meta);

    const deleteFormBtn = document.createElement("button");
    deleteFormBtn.className = "btn btn-delete-form btn-small";
    deleteFormBtn.type = "button";
    deleteFormBtn.textContent = "Delete form";
    deleteFormBtn.addEventListener("click", async () => {
      const confirmed = confirm("Delete all presets for this form?");
      if (!confirmed) return;
      await FormPilotStorage.deleteFormRecord(storageKey);
      await renderForms();
    });

    header.appendChild(info);
    header.appendChild(deleteFormBtn);
    card.appendChild(header);

    const presetList = document.createElement("div");
    presetList.className = "preset-list";

    const presets = record.presets || [];
    if (presets.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No presets for this form.";
      presetList.appendChild(empty);
    } else {
      for (const preset of presets) {
        presetList.appendChild(renderPresetItem(storageKey, preset));
      }
    }

    card.appendChild(presetList);
    container.appendChild(card);
  }
}

/** Runs one section's setup so a failure in it can't take the rest of the page down. */
async function initSection(name, setup) {
  try {
    await setup();
  } catch (error) {
    console.error(`FormPilot options (${name}) error:`, error);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const clearAllBtn = document.getElementById("clear-all");

  clearAllBtn.addEventListener("click", async () => {
    const confirmed = confirm("Delete ALL saved presets and profiles? Your settings are kept. This cannot be undone.");
    if (!confirmed) return;
    await FormPilotStorage.clearAll();
    await Promise.all([renderForms(), OptionsProfiles.render()]);
  });

  // Saved from a page while this tab is open: show it, unless an edit is in progress.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.forms) return;
    if (document.querySelector(".preset-editor")) return;
    renderForms();
  });

  await initSection("sites", OptionsSites.init);
  await initSection("privacy", OptionsPrivacy.init);
  await initSection("profiles", OptionsProfiles.init);

  try {
    await renderForms();
  } catch (error) {
    renderEmptyState(`Failed to load saved forms: ${error.message}`);
    console.error("FormPilot options error:", error);
  }
});
