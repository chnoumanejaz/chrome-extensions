/**
 * Passphrase encryption for sensitive preset values.
 * Runs only in the background service worker: WebCrypto is unavailable to
 * content scripts on plain-http pages, and keeping the key here means page
 * contexts never hold it.
 *
 * - Key: PBKDF2-SHA256 (600k iterations) over the passphrase -> AES-GCM 256.
 * - The passphrase itself is never stored. A small encrypted "verifier" lets
 *   us tell a wrong passphrase from a right one.
 * - After unlocking, the derived key lives in chrome.storage.session, which is
 *   memory-only and cleared when the browser closes.
 */

const FormPilotCryptoCore = (() => {
  const CONFIG_KEY = "crypto";
  const SESSION_KEY = "cryptoKey";
  const ITERATIONS = 600000;
  const VERIFIER_TEXT = "formpilot-verifier-v1";
  const MIN_PASSPHRASE_LENGTH = 8;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function fail(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function toBase64(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function fromBase64(text) {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  }

  async function deriveKey(passphrase, salt, iterations) {
    const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, [
      "deriveKey"
    ]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptWith(key, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));
    return { iv: toBase64(iv), ct: toBase64(new Uint8Array(data)) };
  }

  async function decryptWith(key, payload) {
    const data = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(payload.iv) },
      key,
      fromBase64(payload.ct)
    );
    return decoder.decode(data);
  }

  async function getConfig() {
    const result = await chrome.storage.local.get(CONFIG_KEY);
    return result[CONFIG_KEY] || null;
  }

  async function getCachedKey() {
    const result = await chrome.storage.session.get(SESSION_KEY);
    if (!result[SESSION_KEY]) return null;
    return crypto.subtle.importKey("raw", fromBase64(result[SESSION_KEY]), "AES-GCM", true, [
      "encrypt",
      "decrypt"
    ]);
  }

  async function cacheKey(key) {
    const raw = await crypto.subtle.exportKey("raw", key);
    await chrome.storage.session.set({ [SESSION_KEY]: toBase64(new Uint8Array(raw)) });
  }

  async function requireKey() {
    if (!(await getConfig())) throw fail("not-configured");
    const key = await getCachedKey();
    if (!key) throw fail("locked");
    return key;
  }

  async function status() {
    const configured = (await getConfig()) !== null;
    const unlocked = configured && (await getCachedKey()) !== null;
    return { configured, unlocked };
  }

  async function setup(passphrase) {
    if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH) {
      throw fail("weak-passphrase");
    }
    if (await getConfig()) throw fail("already-configured");

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(passphrase, salt, ITERATIONS);
    const verifier = await encryptWith(key, VERIFIER_TEXT);

    await chrome.storage.local.set({
      [CONFIG_KEY]: { version: 1, iterations: ITERATIONS, salt: toBase64(salt), verifier }
    });
    await cacheKey(key);
  }

  async function unlock(passphrase) {
    const config = await getConfig();
    if (!config) throw fail("not-configured");

    const key = await deriveKey(String(passphrase ?? ""), fromBase64(config.salt), config.iterations);
    let verified = false;
    try {
      verified = (await decryptWith(key, config.verifier)) === VERIFIER_TEXT;
    } catch {
      verified = false;
    }
    if (!verified) throw fail("wrong-passphrase");

    await cacheKey(key);
  }

  async function lock() {
    await chrome.storage.session.remove(SESSION_KEY);
  }

  /** Forgets the passphrase. Anything encrypted with it can no longer be read. */
  async function reset() {
    await chrome.storage.session.remove(SESSION_KEY);
    await chrome.storage.local.remove(CONFIG_KEY);
  }

  async function encrypt(plaintexts) {
    const key = await requireKey();
    return Promise.all(plaintexts.map((text) => encryptWith(key, String(text))));
  }

  async function decrypt(payloads) {
    const key = await requireKey();
    try {
      return await Promise.all(payloads.map((payload) => decryptWith(key, payload)));
    } catch {
      throw fail("decrypt-failed");
    }
  }

  return { MIN_PASSPHRASE_LENGTH, status, setup, unlock, lock, reset, encrypt, decrypt };
})();
