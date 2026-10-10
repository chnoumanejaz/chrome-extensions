/**
 * Options page: global profiles (name, email, address... that can fill any form).
 */

const OptionsProfiles = (() => {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function summarize(values) {
    const labels = FormPilotFieldTypes.PROFILE_FIELDS.filter(({ key }) => values[key]).map(({ label }) => label);
    if (labels.length === 0) return "No values yet";
    const shown = labels.slice(0, 4).join(", ");
    return labels.length > 4 ? `${shown} +${labels.length - 4} more` : shown;
  }

  /** Builds the inline editor for a new profile (profile = null) or an existing one. */
  function renderEditor(profile) {
    const editor = el("form", "profile-form");
    editor.noValidate = true;

    const nameLabel = el("label", "profile-name-field");
    nameLabel.appendChild(el("span", "field-label", "Profile name"));
    const nameInput = el("input", "site-input");
    nameInput.type = "text";
    nameInput.placeholder = "e.g. Personal, Work, Test user";
    nameInput.maxLength = 60;
    nameInput.value = profile?.name || "";
    nameLabel.appendChild(nameInput);
    editor.appendChild(nameLabel);

    const inputs = new Map();
    const groups = new Map();
    for (const field of FormPilotFieldTypes.PROFILE_FIELDS) {
      if (!groups.has(field.group)) groups.set(field.group, []);
      groups.get(field.group).push(field);
    }

    for (const [groupName, fields] of groups) {
      const fieldset = el("fieldset", "profile-group");
      fieldset.appendChild(el("legend", "profile-group-title", groupName));
      const grid = el("div", "profile-grid");

      for (const field of fields) {
        const label = el("label", "profile-field");
        label.appendChild(el("span", "field-label", field.label));
        const input = el("input", "site-input");
        input.type = field.inputType || "text";
        input.value = profile?.values?.[field.key] || "";
        input.autocomplete = "off";
        label.appendChild(input);
        inputs.set(field.key, input);
        grid.appendChild(label);
      }

      fieldset.appendChild(grid);
      editor.appendChild(fieldset);
    }

    const error = el("p", "site-error");
    error.setAttribute("role", "alert");
    error.hidden = true;

    const actions = el("div", "editor-actions");
    const saveBtn = el("button", "btn btn-primary btn-small", profile ? "Save changes" : "Create profile");
    saveBtn.type = "submit";
    const cancelBtn = el("button", "btn btn-secondary btn-small", "Cancel");
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", () => closeEditor());
    actions.append(saveBtn, cancelBtn);
    editor.append(error, actions);

    editor.addEventListener("submit", async (event) => {
      event.preventDefault();

      const name = nameInput.value.trim();
      if (!name) {
        error.textContent = "Give the profile a name.";
        error.hidden = false;
        nameInput.focus();
        return;
      }

      const values = {};
      for (const [key, input] of inputs) values[key] = input.value;

      await FormPilotProfiles.upsert({ id: profile?.id, name, values });
      closeEditor();
      await render();
    });

    return editor;
  }

  function openEditor(profile) {
    const container = document.getElementById("profile-editor");
    container.innerHTML = "";
    const editor = renderEditor(profile);
    container.appendChild(editor);
    editor.querySelector("input").focus();
  }

  function closeEditor() {
    document.getElementById("profile-editor").innerHTML = "";
  }

  async function render() {
    const list = document.getElementById("profile-list");
    const profiles = await FormPilotProfiles.getAll();
    list.innerHTML = "";

    if (profiles.length === 0) {
      list.appendChild(el("li", "empty-state", "No profiles yet. Create one to fill forms in a single click."));
      return;
    }

    for (const profile of profiles) {
      const item = el("li", "site-item");

      const info = el("div", "preset-info");
      info.appendChild(el("div", "preset-name", profile.name));
      info.appendChild(el("div", "preset-date", summarize(profile.values)));

      const actions = el("div", "preset-actions");

      const editBtn = el("button", "btn btn-secondary btn-small", "Edit");
      editBtn.type = "button";
      editBtn.setAttribute("aria-label", `Edit ${profile.name}`);
      editBtn.addEventListener("click", () => openEditor(profile));

      const deleteBtn = el("button", "btn btn-delete btn-small", "Delete");
      deleteBtn.type = "button";
      deleteBtn.setAttribute("aria-label", `Delete ${profile.name}`);
      deleteBtn.addEventListener("click", async () => {
        if (!confirm(`Delete profile "${profile.name}"?`)) return;
        await FormPilotProfiles.remove(profile.id);
        await render();
      });

      actions.append(editBtn, deleteBtn);
      item.append(info, actions);
      list.appendChild(item);
    }
  }

  async function init() {
    document.getElementById("new-profile").addEventListener("click", () => openEditor(null));
    await render();
  }

  return { init, render };
})();
