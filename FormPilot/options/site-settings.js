/**
 * Options page: "Where to show FormPilot" and "Forms without a <form> tag".
 * Both are a mode (radio buttons) plus a list of sites.
 */

const OptionsSites = (() => {
  // The visibility list depends on the mode: hidden sites in "all", selected sites in "selected".
  const VISIBILITY_LISTS = {
    all: {
      key: "blocked",
      title: "Hidden sites",
      empty: "No hidden sites. FormPilot shows on every site."
    },
    selected: {
      key: "allowed",
      title: "Selected sites",
      empty: "No sites selected yet, so FormPilot is hidden everywhere. Add a site above."
    }
  };

  const FORMLESS_LIST = {
    key: "formlessSites",
    empty: "No sites listed, so forms without a <form> tag are never detected."
  };

  function setError(errorEl, message) {
    errorEl.textContent = message;
    errorEl.hidden = !message;
  }

  function syncRadios(name, value) {
    for (const radio of document.querySelectorAll(`input[name="${name}"]`)) {
      radio.checked = radio.value === value;
    }
  }

  function onRadioChange(name, apply) {
    for (const radio of document.querySelectorAll(`input[name="${name}"]`)) {
      radio.addEventListener("change", async () => {
        if (radio.checked) await apply(radio.value);
      });
    }
  }

  /**
   * Wires up an add-form and a list. `resolve(rules)` says which list to show
   * ({ key, empty }). Returns a function that re-renders the list.
   */
  function bindSiteList({ formEl, inputEl, errorEl, listEl, resolve, refresh }) {
    async function render() {
      const rules = await FormPilotSiteRules.get();
      const { key, empty } = resolve(rules);

      listEl.innerHTML = "";
      const sites = rules[key];

      if (sites.length === 0) {
        const emptyItem = document.createElement("li");
        emptyItem.className = "empty-state";
        emptyItem.textContent = empty;
        listEl.appendChild(emptyItem);
        return;
      }

      for (const site of sites) {
        const item = document.createElement("li");
        item.className = "site-item";

        const name = document.createElement("span");
        name.className = "site-name";
        name.textContent = site;

        const removeBtn = document.createElement("button");
        removeBtn.className = "btn btn-delete btn-small";
        removeBtn.type = "button";
        removeBtn.textContent = "Remove";
        removeBtn.setAttribute("aria-label", `Remove ${site}`);
        removeBtn.addEventListener("click", async () => {
          await FormPilotSiteRules.removeSite(key, site);
          await refresh();
        });

        item.append(name, removeBtn);
        listEl.appendChild(item);
      }
    }

    formEl.addEventListener("submit", async (event) => {
      event.preventDefault();

      const { key } = resolve(await FormPilotSiteRules.get());
      const host = await FormPilotSiteRules.addSite(key, inputEl.value);
      if (!host) {
        setError(errorEl, "Enter a valid site, like example.com");
        inputEl.focus();
        return;
      }

      setError(errorEl, "");
      inputEl.value = "";
      await refresh();
    });

    return render;
  }

  async function init() {
    const visibilityError = document.getElementById("site-error");
    const formlessError = document.getElementById("formless-error");
    const visibilityTitle = document.getElementById("site-list-title");

    let renderVisibilityList;
    let renderFormlessList;

    async function refresh() {
      const rules = await FormPilotSiteRules.get();
      syncRadios("site-mode", rules.mode);
      syncRadios("formless-mode", rules.formlessMode);
      visibilityTitle.textContent = VISIBILITY_LISTS[rules.mode].title;
      await Promise.all([renderVisibilityList(), renderFormlessList()]);
    }

    renderVisibilityList = bindSiteList({
      formEl: document.getElementById("site-form"),
      inputEl: document.getElementById("site-input"),
      errorEl: visibilityError,
      listEl: document.getElementById("site-list"),
      resolve: (rules) => VISIBILITY_LISTS[rules.mode],
      refresh
    });

    renderFormlessList = bindSiteList({
      formEl: document.getElementById("formless-form"),
      inputEl: document.getElementById("formless-input"),
      errorEl: formlessError,
      listEl: document.getElementById("formless-list"),
      resolve: () => FORMLESS_LIST,
      refresh
    });

    onRadioChange("site-mode", async (mode) => {
      setError(visibilityError, "");
      await FormPilotSiteRules.setMode(mode);
      await refresh();
    });

    onRadioChange("formless-mode", async (mode) => {
      setError(formlessError, "");
      await FormPilotSiteRules.setFormlessMode(mode);
      await refresh();
    });

    // Keep the page in sync when the popup toggles the current site.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[FormPilotSiteRules.STORAGE_KEY]) refresh();
    });

    await refresh();
  }

  return { init };
})();
