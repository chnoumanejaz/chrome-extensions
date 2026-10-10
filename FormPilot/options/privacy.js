/**
 * Options page: what happens to sensitive fields, and the encryption passphrase.
 */

const OptionsPrivacy = (() => {
  const ERROR_MESSAGES = {
    "wrong-passphrase": "That passphrase is wrong.",
    "weak-passphrase": `Use at least ${FormPilotCrypto.MIN_PASSPHRASE_LENGTH} characters.`,
    "already-configured": "A passphrase is already set."
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function passwordField(placeholder, autocomplete) {
    const input = el("input", "site-input");
    input.type = "password";
    input.placeholder = placeholder;
    input.autocomplete = autocomplete;
    input.spellcheck = false;
    return input;
  }

  /** A small form with one or two passphrase inputs. `submit(values)` may throw an Error with a `code`. */
  function passphraseForm({ fields, buttonLabel, submit, panel }) {
    const form = el("form", "site-form");
    form.noValidate = true;
    const inputs = fields.map(({ placeholder, autocomplete }) => passwordField(placeholder, autocomplete));
    const button = el("button", "btn btn-primary btn-small", buttonLabel);
    button.type = "submit";
    form.append(...inputs, button);

    const error = el("p", "site-error");
    error.setAttribute("role", "alert");
    error.hidden = true;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.hidden = true;
      button.disabled = true;
      try {
        await submit(inputs.map((input) => input.value));
        await render();
      } catch (failure) {
        error.textContent = ERROR_MESSAGES[failure.code] || failure.message;
        error.hidden = false;
        button.disabled = false;
      }
    });

    panel.append(form, error);
  }

  async function resetEncryption() {
    const confirmed = confirm(
      "Remove the passphrase and permanently delete every encrypted value in your saved presets? This cannot be undone."
    );
    if (!confirmed) return;

    await FormPilotCrypto.reset();
    await FormPilotStorage.removeEncryptedFields();
    await render();
  }

  async function renderEncryptionPanel(settings) {
    const panel = document.getElementById("encryption-panel");
    const status = await FormPilotCrypto.status();

    // Only relevant once encryption is wanted or already set up.
    panel.hidden = settings.sensitiveMode !== "encrypt" && !status.configured;
    panel.innerHTML = "";
    if (panel.hidden) return;

    panel.appendChild(el("h3", "list-title", "Encryption"));

    if (!status.configured) {
      panel.appendChild(
        el(
          "p",
          "site-help",
          "No passphrase yet. Choose one to start encrypting. It is never stored: if you forget it, encrypted values can't be recovered."
        )
      );
      passphraseForm({
        panel,
        buttonLabel: "Set passphrase",
        fields: [
          { placeholder: "New passphrase", autocomplete: "new-password" },
          { placeholder: "Repeat passphrase", autocomplete: "new-password" }
        ],
        submit: async ([passphrase, repeat]) => {
          if (passphrase !== repeat) throw new Error("The passphrases don't match.");
          await FormPilotCrypto.setup(passphrase);
        }
      });
      return;
    }

    if (status.unlocked) {
      const row = el("div", "site-form");
      row.appendChild(el("span", "site-name", "Unlocked until you close the browser."));
      const lockBtn = el("button", "btn btn-primary btn-small", "Lock now");
      lockBtn.type = "button";
      lockBtn.addEventListener("click", async () => {
        await FormPilotCrypto.lock();
        await render();
      });
      row.appendChild(lockBtn);
      panel.appendChild(row);
    } else {
      panel.appendChild(
        el("p", "site-help", "Locked. Enter your passphrase to edit encrypted values; filling a form will also ask for it.")
      );
      passphraseForm({
        panel,
        buttonLabel: "Unlock",
        fields: [{ placeholder: "Passphrase", autocomplete: "off" }],
        submit: ([passphrase]) => FormPilotCrypto.unlock(passphrase)
      });
    }

    const resetBtn = el("button", "btn btn-delete btn-small", "Reset encryption…");
    resetBtn.type = "button";
    resetBtn.style.marginTop = "12px";
    resetBtn.addEventListener("click", resetEncryption);
    panel.appendChild(resetBtn);
  }

  async function render() {
    const settings = await FormPilotSettings.get();
    for (const radio of document.querySelectorAll('input[name="sensitive-mode"]')) {
      radio.checked = radio.value === settings.sensitiveMode;
    }
    await renderEncryptionPanel(settings);
  }

  async function init() {
    for (const radio of document.querySelectorAll('input[name="sensitive-mode"]')) {
      radio.addEventListener("change", async () => {
        if (!radio.checked) return;
        await FormPilotSettings.update({ sensitiveMode: radio.value });
        await render();
      });
    }

    await render();
  }

  return { init };
})();
