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
    meta.textContent = `${record.pageUrl || storageKey} · fingerprint: ${record.formFingerprint || "n/a"}`;

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
        const item = document.createElement("div");
        item.className = "preset-item";

        const presetInfo = document.createElement("div");
        presetInfo.className = "preset-info";

        const name = document.createElement("div");
        name.className = "preset-name";
        name.textContent = preset.name;

        const date = document.createElement("div");
        date.className = "preset-date";
        date.textContent = `Saved ${formatDate(preset.createdAt)} · ${(preset.fields || []).length} field(s)`;

        presetInfo.appendChild(name);
        presetInfo.appendChild(date);

        const actions = document.createElement("div");
        actions.className = "preset-actions";

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "btn btn-delete btn-small";
        deleteBtn.type = "button";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", async () => {
          const confirmed = confirm(`Delete preset "${preset.name}"?`);
          if (!confirmed) return;
          await deletePreset(storageKey, preset.id);
          await renderForms();
        });

        actions.appendChild(deleteBtn);
        item.appendChild(presetInfo);
        item.appendChild(actions);
        presetList.appendChild(item);
      }
    }

    card.appendChild(presetList);
    container.appendChild(card);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const clearAllBtn = document.getElementById("clear-all");

  clearAllBtn.addEventListener("click", async () => {
    const confirmed = confirm("Clear ALL FormPilot data? This cannot be undone.");
    if (!confirmed) return;
    await FormPilotStorage.clearAll();
    await renderForms();
  });

  try {
    await renderForms();
  } catch (error) {
    renderEmptyState(`Failed to load saved forms: ${error.message}`);
    console.error("FormPilot options error:", error);
  }
});
