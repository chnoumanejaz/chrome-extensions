/**
 * Per-site visibility rules for FormPilot.
 * Shared by the content script, popup and options page.
 *
 * Two modes, each with its own list so switching modes never loses a list:
 *   "all"      - show everywhere except sites in `blocked`
 *   "selected" - show only on sites in `allowed`
 *
 * Rules are hostnames. A rule matches that host and all of its subdomains
 * ("example.com" covers "app.example.com"). Ports, paths and a leading
 * "www." are ignored.
 *
 * A third list controls detection of forms that have no <form> tag:
 *   formlessMode  - "auto" detects them, "paused" never does
 *   formlessSites - the only sites where detection runs (default: localhost)
 */

const FormPilotSiteRules = (() => {
  const STORAGE_KEY = "siteRules";
  const MODES = ["all", "selected"];
  const FORMLESS_MODES = ["auto", "paused"];
  const DEFAULT_FORMLESS_SITES = ["localhost"];
  const HOSTNAME_PATTERN =
    /^(\[[0-9a-f:.]+\]|[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*)$/;

  /**
   * Turns a URL, hostname or "*.host" pattern into a bare rule hostname.
   * Returns null when the input isn't a valid host.
   */
  function normalizeHost(input) {
    if (typeof input !== "string") return null;
    let value = input.trim().toLowerCase();
    if (!value) return null;

    value = value.replace(/^\*\./, "");
    if (!value.includes("://")) value = `http://${value}`;

    let hostname;
    try {
      hostname = new URL(value).hostname;
    } catch {
      return null;
    }

    hostname = hostname.replace(/\.$/, "").replace(/^www\./, "");
    return HOSTNAME_PATTERN.test(hostname) ? hostname : null;
  }

  function hostMatches(host, rule) {
    return host === rule || host.endsWith(`.${rule}`);
  }

  /** Coerces whatever is in storage into a well-formed rules object. */
  function sanitize(raw) {
    const clean = (list) => {
      if (!Array.isArray(list)) return [];
      const hosts = list.map(normalizeHost).filter(Boolean);
      return Array.from(new Set(hosts));
    };

    return {
      mode: MODES.includes(raw?.mode) ? raw.mode : "all",
      blocked: clean(raw?.blocked),
      allowed: clean(raw?.allowed),
      formlessMode: FORMLESS_MODES.includes(raw?.formlessMode) ? raw.formlessMode : "auto",
      formlessSites: Array.isArray(raw?.formlessSites)
        ? clean(raw.formlessSites)
        : [...DEFAULT_FORMLESS_SITES]
    };
  }

  /**
   * Works out whether FormPilot should show on a hostname.
   * `rule` is the entry in the active list that matched, if any - the reason
   * a site is hidden (mode "all") or shown (mode "selected").
   */
  function evaluate(hostname, rules) {
    const host = normalizeHost(hostname);
    const list = rules.mode === "selected" ? rules.allowed : rules.blocked;
    const rule = host ? list.find((entry) => hostMatches(host, entry)) || null : null;
    const enabled = rules.mode === "selected" ? rule !== null : rule === null;
    return { host, enabled, rule };
  }

  /** Whether forms without a <form> tag should be detected on a hostname. */
  function evaluateFormless(hostname, rules) {
    const host = normalizeHost(hostname);
    const rule = host ? rules.formlessSites.find((entry) => hostMatches(host, entry)) || null : null;
    return {
      host,
      enabled: rules.formlessMode === "auto" && rule !== null,
      paused: rules.formlessMode === "paused",
      rule
    };
  }

  async function get() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return sanitize(result[STORAGE_KEY]);
  }

  async function save(rules) {
    await chrome.storage.local.set({ [STORAGE_KEY]: sanitize(rules) });
  }

  async function setMode(mode) {
    const rules = await get();
    rules.mode = mode;
    await save(rules);
  }

  async function setFormlessMode(mode) {
    const rules = await get();
    rules.formlessMode = mode;
    await save(rules);
  }

  /** Adds a site to a list ("blocked", "allowed" or "formlessSites"). Returns the stored host, or null if invalid. */
  async function addSite(listKey, input) {
    const host = normalizeHost(input);
    if (!host) return null;

    const rules = await get();
    if (!rules[listKey].includes(host)) {
      rules[listKey].push(host);
      await save(rules);
    }
    return host;
  }

  async function removeSite(listKey, host) {
    const rules = await get();
    rules[listKey] = rules[listKey].filter((entry) => entry !== host);
    await save(rules);
  }

  /**
   * Makes FormPilot show (or hide) on a hostname by editing the active list.
   * Any existing rule covering the host is replaced, so enabling a subdomain
   * of a hidden domain lifts the rule for the whole domain.
   */
  async function setSiteEnabled(hostname, enabled) {
    const host = normalizeHost(hostname);
    if (!host) return;

    const rules = await get();
    const listKey = rules.mode === "selected" ? "allowed" : "blocked";
    // "selected" lists the sites to show; "all" lists the sites to hide.
    const shouldBeListed = rules.mode === "selected" ? enabled : !enabled;

    rules[listKey] = rules[listKey].filter((entry) => !hostMatches(host, entry));
    if (shouldBeListed) rules[listKey].push(host);
    await save(rules);
  }

  /** Turns formless detection on or off for one hostname (replacing any rule that covers it). */
  async function setFormlessSiteEnabled(hostname, enabled) {
    const host = normalizeHost(hostname);
    if (!host) return;

    const rules = await get();
    rules.formlessSites = rules.formlessSites.filter((entry) => !hostMatches(host, entry));
    if (enabled) rules.formlessSites.push(host);
    await save(rules);
  }

  return {
    STORAGE_KEY,
    normalizeHost,
    sanitize,
    evaluate,
    evaluateFormless,
    get,
    save,
    setMode,
    setFormlessMode,
    addSite,
    removeSite,
    setSiteEnabled,
    setFormlessSiteEnabled
  };
})();
