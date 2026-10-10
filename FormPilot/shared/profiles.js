/**
 * Global profiles: named sets of personal details (name, email, address...)
 * that can fill any form, matched to fields by FormPilotFieldTypes.classify.
 *
 * Stored as an array under the "profiles" key in chrome.storage.local:
 *   [{ id, name, createdAt, updatedAt, values: { firstName: "Ada", ... } }]
 */

const FormPilotProfiles = (() => {
  const STORAGE_KEY = "profiles";

  function cleanValues(values) {
    const cleaned = {};
    for (const { key } of FormPilotFieldTypes.PROFILE_FIELDS) {
      const value = typeof values?.[key] === "string" ? values[key].trim() : "";
      if (value) cleaned[key] = value;
    }
    return cleaned;
  }

  function sanitize(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((profile) => profile && typeof profile.id === "string" && typeof profile.name === "string")
      .map((profile) => ({
        id: profile.id,
        name: profile.name.trim() || "Untitled profile",
        createdAt: profile.createdAt || null,
        updatedAt: profile.updatedAt || profile.createdAt || null,
        values: cleanValues(profile.values)
      }));
  }

  async function getAll() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return sanitize(result[STORAGE_KEY]);
  }

  async function saveAll(profiles) {
    await chrome.storage.local.set({ [STORAGE_KEY]: sanitize(profiles) });
  }

  /** Creates a profile, or updates the one with `id` when given. Returns the stored profile. */
  async function upsert({ id, name, values }) {
    const profiles = await getAll();
    const now = new Date().toISOString();
    const existing = id ? profiles.find((profile) => profile.id === id) : null;

    if (existing) {
      existing.name = name.trim() || existing.name;
      existing.values = cleanValues(values);
      existing.updatedAt = now;
      await saveAll(profiles);
      return existing;
    }

    const profile = {
      id: `profile_${Date.now()}`,
      name: name.trim() || "Untitled profile",
      createdAt: now,
      updatedAt: now,
      values: cleanValues(values)
    };
    profiles.push(profile);
    await saveAll(profiles);
    return profile;
  }

  async function remove(id) {
    const profiles = await getAll();
    await saveAll(profiles.filter((profile) => profile.id !== id));
  }

  return { STORAGE_KEY, sanitize, getAll, upsert, remove };
})();
