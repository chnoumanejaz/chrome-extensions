/**
 * Client for FormPilot's encryption service.
 * The crypto itself runs in the background service worker (see
 * background/crypto-core.js); this wrapper talks to it by message, so it works
 * the same from content scripts and extension pages.
 *
 * Failures throw an Error whose `code` is one of: "locked", "not-configured",
 * "already-configured", "wrong-passphrase", "weak-passphrase", "decrypt-failed".
 */

const FormPilotCrypto = (() => {
  const MIN_PASSPHRASE_LENGTH = 8;

  async function call(operation, payload = {}) {
    const response = await chrome.runtime.sendMessage({
      type: `formpilot:crypto:${operation}`,
      ...payload
    });

    if (!response?.ok) {
      const error = new Error(response?.error || "crypto-failed");
      error.code = response?.error || "crypto-failed";
      throw error;
    }
    return response;
  }

  return {
    MIN_PASSPHRASE_LENGTH,

    /** { configured, unlocked } */
    async status() {
      const { configured, unlocked } = await call("status");
      return { configured, unlocked };
    },

    async setup(passphrase) {
      await call("setup", { passphrase });
    },

    async unlock(passphrase) {
      await call("unlock", { passphrase });
    },

    async lock() {
      await call("lock");
    },

    async reset() {
      await call("reset");
    },

    /** Encrypts one string and returns { iv, ct }. */
    async encrypt(plaintext) {
      const { payloads } = await call("encrypt", { plaintexts: [plaintext] });
      return payloads[0];
    },

    /** Decrypts a list of { iv, ct } payloads into strings, in order. */
    async decryptMany(payloads) {
      if (payloads.length === 0) return [];
      const { values } = await call("decrypt", { payloads });
      return values;
    }
  };
})();
