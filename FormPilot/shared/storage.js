/**
 * Shared storage helpers for chrome.storage.local.
 * Used by popup and options pages.
 */

const FormPilotStorage = {
  async getAllForms() {
    const result = await chrome.storage.local.get("forms");
    return result.forms || {};
  },

  async getFormRecord(storageKey) {
    const forms = await this.getAllForms();
    return forms[storageKey] || null;
  },

  async saveFormRecord(storageKey, record) {
    const forms = await this.getAllForms();
    forms[storageKey] = record;
    await chrome.storage.local.set({ forms });
    return record;
  },

  async deleteFormRecord(storageKey) {
    const forms = await this.getAllForms();
    delete forms[storageKey];
    await chrome.storage.local.set({ forms });
  },

  /** Applies `changes` to one preset (name, autoSubmit, fields...) and saves it. */
  async updatePreset(storageKey, presetId, changes) {
    const record = await this.getFormRecord(storageKey);
    const preset = record?.presets?.find((item) => item.id === presetId);
    if (!preset) return null;

    const now = new Date().toISOString();
    Object.assign(preset, changes, { updatedAt: now });
    record.updatedAt = now;
    await this.saveFormRecord(storageKey, record);
    return preset;
  },

  /** Drops every encrypted field from every preset (used when the passphrase is reset). */
  async removeEncryptedFields() {
    const forms = await this.getAllForms();
    for (const record of Object.values(forms)) {
      for (const preset of record.presets || []) {
        preset.fields = (preset.fields || []).filter((field) => !field.enc);
      }
    }
    await chrome.storage.local.set({ forms });
  },

  /** Clears saved presets and profiles. Settings and site rules are kept. */
  async clearAll() {
    await chrome.storage.local.set({ forms: {}, profiles: [] });
  },

  async getStats() {
    const forms = await this.getAllForms();
    const formKeys = Object.keys(forms);
    let presetCount = 0;
    for (const key of formKeys) {
      presetCount += (forms[key].presets || []).length;
    }
    return { formCount: formKeys.length, presetCount };
  }
};
