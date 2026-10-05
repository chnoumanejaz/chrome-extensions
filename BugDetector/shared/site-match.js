/**
 * Hostname pattern matching for the site allow/block/mute lists.
 * Universal file (see shared/protocol.js).
 *
 * Pattern rules:
 *   "example.com"       → example.com and any subdomain
 *   "*.example.com"     → subdomains only
 *   "localhost:3000"    → that host on that port only
 *   "https://x.com/a"   → full URLs are reduced to their host[:port]
 */
(() => {
  if (globalThis.BugDetectorSites) return;

  function normalizePattern(pattern) {
    let value = String(pattern || "").trim().toLowerCase();
    if (!value) return "";
    if (value.includes("://")) {
      try {
        value = new URL(value).host;
      } catch {
        return "";
      }
    }
    return value.split("/")[0];
  }

  /** @param {string} host  location.host (hostname[:port]) */
  function matchesHost(host, pattern) {
    const target = String(host || "").toLowerCase();
    let rule = normalizePattern(pattern);
    if (!target || !rule) return false;

    const ruleHasPort = /:\d+$/.test(rule);
    const hostname = ruleHasPort ? target : target.replace(/:\d+$/, "");

    if (rule.startsWith("*.")) {
      rule = rule.slice(2);
      return hostname.endsWith(`.${rule}`);
    }
    return hostname === rule || hostname.endsWith(`.${rule}`);
  }

  function matchesAny(host, patterns) {
    return (patterns || []).some((pattern) => matchesHost(host, pattern));
  }

  /**
   * @returns {{ enabled: boolean, muted: boolean }}
   * enabled: collect data on this site at all. muted: never show the toast.
   */
  function siteState(host, settings) {
    const enabled = settings.siteMode === "allowlist"
      ? matchesAny(host, settings.allowlist)
      : !matchesAny(host, settings.blocklist);
    return { enabled, muted: matchesAny(host, settings.mutedSites) };
  }

  globalThis.BugDetectorSites = Object.freeze({
    normalizePattern,
    matchesHost,
    matchesAny,
    siteState
  });
})();
