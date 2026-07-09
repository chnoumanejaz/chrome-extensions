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

  async clearAll() {
    await chrome.storage.local.set({ forms: {} });
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
