/**
 * FormPilot background service worker.
 * Local-only — no network calls, no analytics.
 * Hosts the encryption service so keys never reach page contexts.
 */

importScripts("background/crypto-core.js");

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    console.log("FormPilot installed. All data stays locally in your browser.");
  }
});

const CRYPTO_PREFIX = "formpilot:crypto:";

const cryptoHandlers = {
  status: () => FormPilotCryptoCore.status(),
  setup: ({ passphrase }) => FormPilotCryptoCore.setup(passphrase),
  unlock: ({ passphrase }) => FormPilotCryptoCore.unlock(passphrase),
  lock: () => FormPilotCryptoCore.lock(),
  reset: () => FormPilotCryptoCore.reset(),
  encrypt: async ({ plaintexts }) => ({ payloads: await FormPilotCryptoCore.encrypt(plaintexts) }),
  decrypt: async ({ payloads }) => ({ values: await FormPilotCryptoCore.decrypt(payloads) })
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension's own scripts and pages may use the encryption service.
  if (sender.id !== chrome.runtime.id) return false;
  if (typeof message?.type !== "string" || !message.type.startsWith(CRYPTO_PREFIX)) return false;

  const handler = cryptoHandlers[message.type.slice(CRYPTO_PREFIX.length)];
  if (!handler) return false;

  handler(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.code || "crypto-failed" }));

  return true;
});
