/**
 * BugDetector collector — isolated content-script world, document_start.
 *
 * Receives observations from content/page-hook.js, keeps the most recent
 * ones in ring buffers, records user breadcrumbs, decides when to show the
 * "Bug detected" toast and answers snapshot requests from the service worker.
 * No processing beyond filtering happens here; reports are built in the SW.
 */
(() => {
  if (globalThis.__bugDetectorCollector) return;
  globalThis.__bugDetectorCollector = true;

  const { HOOK_EVENT, Msg } = globalThis.BugDetectorProtocol;
  const Settings = globalThis.BugDetectorSettings;
  const Sites = globalThis.BugDetectorSites;
  const RingBuffer = globalThis.BugDetectorRingBuffer;
  const Toast = globalThis.BugDetectorToast;

  const consoleLog = new RingBuffer(50);
  const networkLog = new RingBuffer(50);
  const breadcrumbs = new RingBuffer(30);
  const stats = { errors: 0, warnings: 0, failedRequests: 0 };

  let settings = Settings.normalize();
  let site = Sites.siteState(location.host, settings);
  let signalCount = 0;
  let unseenSignals = 0;
  let quietUntil = 0;
  let capturing = false;
  let badgeTimer = 0;

  // ------------------------------------------------------------- lifecycle

  /** False once the extension was reloaded/removed and this script is orphaned. */
  function extensionAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function send(message) {
    if (!extensionAlive()) return Promise.resolve(null);
    return chrome.runtime.sendMessage(message).catch(() => null);
  }

  function applySettings(next) {
    settings = next;
    const wasEnabled = site.enabled;
    site = Sites.siteState(location.host, settings);
    if (!site.enabled) {
      if (wasEnabled) resetBuffers();
      Toast.hide();
    } else if (site.muted || !settings.autoDetect) {
      Toast.hide();
    }
  }

  function resetBuffers() {
    consoleLog.clear();
    networkLog.clear();
    breadcrumbs.clear();
    stats.errors = stats.warnings = stats.failedRequests = 0;
    signalCount = 0;
    unseenSignals = 0;
    updateBadge();
  }

  chrome.storage.sync.get(Settings.STORAGE_KEY).then((stored) => {
    applySettings(Settings.normalize(stored[Settings.STORAGE_KEY]));
  }).catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[Settings.STORAGE_KEY]) {
      applySettings(Settings.normalize(changes[Settings.STORAGE_KEY].newValue));
    }
  });

  // -------------------------------------------------------------- helpers

  function containsAny(text, patterns) {
    const haystack = String(text || "").toLowerCase();
    return patterns.some((pattern) => haystack.includes(pattern.toLowerCase()));
  }

  function shortUrl(url) {
    try {
      const parsed = new URL(url);
      const sameOrigin = parsed.origin === location.origin;
      const path = `${parsed.pathname}${parsed.search}`;
      const text = sameOrigin ? path : `${parsed.host}${path}`;
      return text.length > 70 ? `${text.slice(0, 67)}…` : text;
    } catch {
      return String(url).slice(0, 70);
    }
  }

  function firstLine(text) {
    const line = String(text || "").split("\n")[0].trim();
    return line.length > 120 ? `${line.slice(0, 117)}…` : line;
  }

  function cleanText(text, max = 40) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  function selectorFor(el) {
    let selector = el.tagName.toLowerCase();
    if (el.id) return `${selector}#${el.id}`;
    const classes = [...el.classList].filter((name) => !/^\d|[:[\]]/.test(name)).slice(0, 2);
    if (classes.length) selector += `.${classes.join(".")}`;
    const name = el.getAttribute("name");
    if (name) selector += `[name="${name}"]`;
    return selector;
  }

  /** Human label for an element; never reads the value of text inputs. */
  function labelFor(el) {
    const aria = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt");
    if (aria) return cleanText(aria);

    if (el instanceof HTMLInputElement) {
      if (["button", "submit", "reset"].includes(el.type)) return cleanText(el.value);
      if (el.labels?.[0]) return cleanText(el.labels[0].innerText);
      return cleanText(el.placeholder || el.name);
    }
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      return cleanText(el.labels?.[0]?.innerText || el.getAttribute("placeholder") || el.name);
    }
    return cleanText(el.innerText);
  }

  function describeElement(el) {
    const label = labelFor(el);
    const selector = selectorFor(el);
    return label ? `"${label}" (${selector})` : selector;
  }

  // ------------------------------------------------------------ breadcrumbs

  function crumb(kind, text) {
    if (!site.enabled) return;
    breadcrumbs.push({ ts: Date.now(), kind, text });
  }

  crumb("load", `Opened ${location.href}`);

  const INTERACTIVE = "a, button, input, select, textarea, label, summary, [role='button'], [role='link'], [role='tab'], [role='menuitem'], [onclick]";

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element) || Toast.isOwnElement(target)) return;
    const el = target.closest(INTERACTIVE) || target;
    crumb("click", `Clicked ${describeElement(el)}`);
  }, true);

  document.addEventListener("change", (event) => {
    const el = event.target;
    if (!(el instanceof Element)) return;
    const isToggle = el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type);
    const verb = isToggle ? (el.checked ? "Checked" : "Unchecked") : "Changed";
    crumb("input", `${verb} ${describeElement(el)}`);
  }, true);

  document.addEventListener("submit", (event) => {
    if (event.target instanceof HTMLFormElement) crumb("submit", `Submitted ${selectorFor(event.target)}`);
  }, true);

  window.addEventListener("popstate", () => crumb("navigation", `Navigated back/forward to ${location.href}`));
  window.addEventListener("hashchange", () => crumb("navigation", `Hash changed to ${location.hash}`));

  // ------------------------------------------------------- hook observations

  /** @returns {"error"|"warning"|"network"|null} */
  function categoryOf(kind, data) {
    switch (kind) {
      case "console": return data.level === "error" ? "error" : "warning";
      case "error":
      case "rejection": return "error";
      case "network":
      case "resource": return "network";
      default: return null;
    }
  }

  function isSignal(category) {
    if (category === "error") return true;
    if (category === "network") return settings.sensitivity !== "errors";
    return category === "warning" && settings.sensitivity === "all";
  }

  function pushConsole(kind, ts, data) {
    const entry = {
      ts,
      type: kind,
      level: kind === "console" ? data.level : "error",
      message: data.message || "",
      stack: data.stack || null,
      source: data.source ? `${data.source}:${data.line ?? "?"}:${data.column ?? "?"}` : null,
      count: 1
    };
    const last = consoleLog.last();
    if (last && last.message === entry.message && last.level === entry.level && last.type === entry.type) {
      last.count += 1;
      last.ts = ts;
      return last;
    }
    return consoleLog.push(entry);
  }

  function pushNetwork(kind, ts, data) {
    if (kind === "resource") {
      return networkLog.push({
        ts,
        initiator: "resource",
        resourceType: data.tag,
        method: "GET",
        url: data.url,
        status: 0,
        error: `Failed to load <${data.tag}>`
      });
    }
    return networkLog.push({ ts, ...data });
  }

  function summarize(kind, data) {
    if (kind === "network") {
      const status = data.status ? `${data.status}${data.statusText ? ` ${data.statusText}` : ""}` : (data.error || "Network error");
      return `${status} · ${data.method} ${shortUrl(data.url)}`;
    }
    if (kind === "resource") return `Failed to load <${data.tag}> ${shortUrl(data.url)}`;
    return firstLine(data.message);
  }

  function ingest(event) {
    const { kind, ts, data } = event;
    if (!site.enabled || !data || typeof data !== "object") return;

    if (kind === "navigation") {
      crumb("navigation", `Navigated to ${data.url}`);
      return;
    }

    const category = categoryOf(kind, data);
    if (!category) return;

    if (category === "network") {
      if (containsAny(data.url, settings.ignoreUrlPatterns)) return;
      pushNetwork(kind, ts, data);
      stats.failedRequests += 1;
    } else {
      if (containsAny(data.message, settings.ignoreMessagePatterns)) return;
      pushConsole(kind, ts, data);
      if (category === "error") stats.errors += 1;
      else stats.warnings += 1;
    }

    if (isSignal(category)) onSignal(summarize(kind, data));
  }

  document.addEventListener(HOOK_EVENT, (event) => {
    if (!extensionAlive() || typeof event.detail !== "string") return;
    try {
      ingest(JSON.parse(event.detail));
    } catch {
      // malformed event — ignore
    }
  });

  // ------------------------------------------------------------ toast/badge

  function updateBadge() {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => send({ type: Msg.BADGE_UPDATE, count: signalCount }), 300);
  }

  function onSignal(summary) {
    signalCount += 1;
    updateBadge();

    if (!settings.autoDetect || site.muted || capturing) return;
    if (!Toast.isOpen() && Date.now() < quietUntil) return;

    unseenSignals += 1;
    Toast.show({
      detail: summary,
      count: unseenSignals,
      onCapture: requestCapture,
      onDismiss: () => {
        unseenSignals = 0;
        quietUntil = Date.now() + settings.cooldownSeconds * 1000;
      },
      onMute: muteSite
    });
  }

  async function requestCapture() {
    Toast.setBusy("Capturing…");
    const result = await send({ type: Msg.CAPTURE_REQUEST });
    if (!result?.ok) {
      Toast.setBusy("Capture failed");
      setTimeout(() => Toast.hide(), 2000);
    }
  }

  async function muteSite() {
    Toast.hide();
    const stored = await chrome.storage.sync.get(Settings.STORAGE_KEY);
    const current = Settings.normalize(stored[Settings.STORAGE_KEY]);
    const next = Settings.normalize({
      ...current,
      mutedSites: [...current.mutedSites, location.hostname]
    });
    await chrome.storage.sync.set({ [Settings.STORAGE_KEY]: next });
  }

  // -------------------------------------------------------------- snapshot

  function nextFrame() {
    return new Promise((resolve) => {
      const done = () => resolve();
      requestAnimationFrame(() => requestAnimationFrame(done));
      setTimeout(done, 100); // rAF doesn't fire in some hidden/headless states
    });
  }

  function snapshot() {
    const nav = performance.getEntriesByType("navigation")[0];
    const uaData = navigator.userAgentData;
    return {
      siteEnabled: site.enabled,
      page: {
        url: location.href,
        title: document.title,
        referrer: document.referrer || null,
        timeOrigin: Math.round(performance.timeOrigin),
        loadTimeMs: nav && nav.loadEventEnd > 0 ? Math.round(nav.loadEventEnd) : null
      },
      env: {
        userAgent: navigator.userAgent,
        uaBrands: uaData?.brands?.map((b) => ({ brand: b.brand, version: b.version })) ?? null,
        uaPlatform: uaData?.platform ?? null,
        uaMobile: uaData?.mobile ?? null,
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        screen: { width: screen.width, height: screen.height },
        devicePixelRatio: window.devicePixelRatio,
        online: navigator.onLine,
        colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
      },
      stats: { ...stats },
      console: site.enabled ? consoleLog.toArray() : [],
      network: site.enabled ? networkLog.toArray() : [],
      breadcrumbs: site.enabled ? breadcrumbs.toArray() : []
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message?.type) {
      case Msg.PREPARE_CAPTURE:
        capturing = true;
        // Failsafe in case CAPTURE_FINISHED never arrives (e.g. the worker died).
        setTimeout(() => { capturing = false; }, 15000);
        Toast.detach();
        nextFrame().then(() => sendResponse(snapshot()));
        return true;

      case Msg.CAPTURE_FINISHED:
        capturing = false;
        unseenSignals = 0;
        quietUntil = Date.now() + settings.cooldownSeconds * 1000;
        sendResponse(true);
        return false;

      case Msg.GET_STATS:
        sendResponse({
          host: location.host,
          hostname: location.hostname,
          enabled: site.enabled,
          muted: site.muted,
          stats: { ...stats }
        });
        return false;

      default:
        return false;
    }
  });
})();
