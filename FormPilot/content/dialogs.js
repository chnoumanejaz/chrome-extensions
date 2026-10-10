/**
 * FormPilot in-page dialogs.
 * Rendered in a Shadow DOM so site CSS can't touch them and they can't touch the site.
 */

const FormPilotDialogs = (() => {
  const ERROR_MESSAGES = {
    "wrong-passphrase": "That passphrase is wrong.",
    "weak-passphrase": `Use at least ${FormPilotCrypto.MIN_PASSPHRASE_LENGTH} characters.`,
    "decrypt-failed": "Couldn't decrypt the saved data with this passphrase."
  };

  function describeError(error) {
    return ERROR_MESSAGES[error?.code] || "Something went wrong. Please try again.";
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function passwordInput(placeholder, autocomplete) {
    const input = el("input", "formpilot-input");
    input.type = "password";
    input.placeholder = placeholder;
    input.autocomplete = autocomplete;
    input.spellcheck = false;
    return input;
  }

  /**
   * Asks for the encryption passphrase.
   *   mode "unlock" - ask once; "setup" - ask twice to create it
   *   onSubmit(passphrase) - does the unlock/setup and throws on failure, which
   *                          keeps the dialog open with an error message
   * Resolves true once onSubmit succeeded, false if the user cancelled.
   */
  function askPassphrase({ css, mode, onSubmit }) {
    return new Promise((resolve) => {
      const isSetup = mode === "setup";

      const host = el("div", "formpilot-root formpilot-dialog-host");
      host.style.position = "fixed";
      host.style.inset = "0";
      host.style.zIndex = "2147483647";
      const shadow = host.attachShadow({ mode: "open" });

      const style = document.createElement("style");
      style.textContent = css;
      shadow.appendChild(style);

      const backdrop = el("div", "formpilot-dialog-backdrop");
      const dialog = el("form", "formpilot-dialog");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-label", isSetup ? "Create a passphrase" : "Unlock FormPilot");
      dialog.noValidate = true;

      const title = el("h3", "formpilot-dialog-title", isSetup ? "Create a passphrase" : "Unlock FormPilot");
      const text = el(
        "p",
        "formpilot-dialog-text",
        isSetup
          ? "Sensitive fields are encrypted with this passphrase. It is never stored, so if you forget it those values can't be recovered."
          : "Enter your passphrase to use encrypted values. It stays unlocked until you close the browser."
      );

      const input = passwordInput("Passphrase", isSetup ? "new-password" : "off");
      const confirmInput = isSetup ? passwordInput("Repeat passphrase", "new-password") : null;

      const error = el("p", "formpilot-dialog-error");
      error.setAttribute("role", "alert");
      error.hidden = true;

      const actions = el("div", "formpilot-dialog-actions");
      const cancelBtn = el("button", "formpilot-btn formpilot-btn-secondary", "Cancel");
      cancelBtn.type = "button";
      const submitBtn = el("button", "formpilot-btn formpilot-btn-primary", isSetup ? "Set passphrase" : "Unlock");
      submitBtn.type = "submit";
      actions.append(cancelBtn, submitBtn);

      dialog.append(title, text, input);
      if (confirmInput) dialog.appendChild(confirmInput);
      dialog.append(error, actions);
      backdrop.appendChild(dialog);
      shadow.appendChild(backdrop);

      function close(result) {
        host.remove();
        resolve(result);
      }

      function showError(message) {
        error.textContent = message;
        error.hidden = false;
      }

      cancelBtn.addEventListener("click", () => close(false));
      backdrop.addEventListener("mousedown", (event) => {
        if (event.target === backdrop) close(false);
      });

      // Keep keystrokes away from the page's own shortcuts; handle Escape and Tab ourselves.
      for (const type of ["keydown", "keyup", "keypress"]) {
        host.addEventListener(type, (event) => {
          event.stopPropagation();
          if (type !== "keydown") return;

          if (event.key === "Escape") {
            close(false);
          } else if (event.key === "Tab") {
            const order = [input, confirmInput, cancelBtn, submitBtn].filter(Boolean);
            const index = order.indexOf(shadow.activeElement);
            const next = order[(index + (event.shiftKey ? order.length - 1 : 1)) % order.length];
            event.preventDefault();
            next.focus();
          }
        });
      }

      dialog.addEventListener("submit", async (event) => {
        event.preventDefault();
        error.hidden = true;

        if (!input.value) {
          showError("Enter a passphrase.");
          return;
        }
        if (isSetup && input.value.length < FormPilotCrypto.MIN_PASSPHRASE_LENGTH) {
          showError(ERROR_MESSAGES["weak-passphrase"]);
          return;
        }
        if (isSetup && input.value !== confirmInput.value) {
          showError("The passphrases don't match.");
          return;
        }

        submitBtn.disabled = true;
        cancelBtn.disabled = true;
        try {
          await onSubmit(input.value);
          close(true);
        } catch (failure) {
          showError(describeError(failure));
          submitBtn.disabled = false;
          cancelBtn.disabled = false;
          input.focus();
          input.select();
        }
      });

      document.documentElement.appendChild(host);
      input.focus();
    });
  }

  return { askPassphrase };
})();
