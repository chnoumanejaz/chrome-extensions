/**
 * BugDetector page hook — runs in the page's MAIN world at document_start.
 *
 * Observes console errors/warnings, uncaught errors, unhandled rejections,
 * failed resource loads, failed fetch/XHR calls (with bodies) and SPA route
 * changes. Every observation is sent to the isolated-world collector as a
 * CustomEvent whose detail is a JSON string (strings cross worlds safely).
 *
 * This file shares the page's globals, so it defines nothing global and
 * never throws into page code. Redaction happens later in the service worker.
 */
(() => {
  const HOOKED = Symbol.for("bugdetector.hooked");
  if (window[HOOKED]) return;
  Object.defineProperty(window, HOOKED, { value: true });

  // Must match BugDetectorProtocol.HOOK_EVENT in shared/protocol.js.
  const EVENT_NAME = "bugdetector:event";
  const MAX_TEXT = 20000;
  const MAX_EVENTS_PER_SECOND = 60;
  const BODY_READ_TIMEOUT_MS = 3000;

  // Keep native references so later page code that overrides them can't break the hook.
  const dispatch = EventTarget.prototype.dispatchEvent.bind(document);
  const NativeCustomEvent = CustomEvent;
  const nativeStringify = JSON.stringify;
  let windowStart = 0;
  let windowCount = 0;

  function emit(kind, data) {
    const now = Date.now();
    if (now - windowStart > 1000) {
      windowStart = now;
      windowCount = 0;
    }
    if (++windowCount > MAX_EVENTS_PER_SECOND) return;

    try {
      const detail = nativeStringify({ kind, ts: now, data });
      dispatch(new NativeCustomEvent(EVENT_NAME, { detail }));
    } catch {
      // Never break the page because of the hook.
    }
  }

  function clip(text, max = MAX_TEXT) {
    const value = String(text ?? "");
    return value.length > max ? `${value.slice(0, max)}… [truncated]` : value;
  }

  function describeElement(el) {
    let out = `<${el.tagName.toLowerCase()}`;
    if (el.id) out += ` id="${el.id}"`;
    if (typeof el.className === "string" && el.className.trim()) {
      out += ` class="${el.className.trim()}"`;
    }
    return `${out}>`;
  }

  function safeJson(value) {
    const seen = new WeakSet();
    return nativeStringify(value, (key, val) => {
      if (typeof val === "bigint") return `${val}n`;
      if (typeof val === "function") return `[Function ${val.name || "anonymous"}]`;
      if (val instanceof Element) return describeElement(val);
      if (val && typeof val === "object") {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    });
  }

  /** Converts any console argument / rejection reason into readable text. */
  function describe(value) {
    try {
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      if (typeof value === "string") return value;
      if (value === undefined) return "undefined";
      if (value instanceof Element) return describeElement(value);
      if (typeof value === "object" && value !== null) {
        return clip(safeJson(value) ?? String(value), 2000);
      }
      return String(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }

  function stackOf(value) {
    return value instanceof Error && typeof value.stack === "string" ? clip(value.stack, 4000) : null;
  }

  /** Stack of the caller, without the hook's own frames. */
  function callerStack() {
    const stack = new Error().stack || "";
    return stack.split("\n").slice(3).join("\n") || null;
  }

  function resolveUrl(url) {
    try {
      return new URL(String(url), location.href).href;
    } catch {
      return String(url);
    }
  }

  function headersToObject(headers) {
    const out = {};
    if (!headers) return out;
    try {
      if (headers instanceof Headers) {
        headers.forEach((value, key) => { out[key] = value; });
      } else if (Array.isArray(headers)) {
        for (const [key, value] of headers) out[String(key).toLowerCase()] = String(value);
      } else if (typeof headers === "object") {
        for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = String(value);
      }
    } catch {
      // ignore unreadable headers
    }
    return out;
  }

  function parseRawHeaders(raw) {
    const out = {};
    for (const line of String(raw || "").trim().split(/[\r\n]+/)) {
      const index = line.indexOf(":");
      if (index > 0) out[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }
    return out;
  }

  function describeBody(body) {
    try {
      if (body == null) return null;
      if (typeof body === "string") return clip(body);
      if (body instanceof URLSearchParams) return clip(body.toString());
      if (body instanceof FormData) {
        const parts = [];
        for (const [key, value] of body.entries()) {
          parts.push(typeof value === "string"
            ? `${key}=${value}`
            : `${key}=[File ${value.name}, ${value.size} bytes]`);
        }
        return clip(`[FormData] ${parts.join("&")}`);
      }
      if (body instanceof Blob) return `[Blob ${body.type || "unknown type"}, ${body.size} bytes]`;
      if (body instanceof ArrayBuffer) return `[Binary, ${body.byteLength} bytes]`;
      if (ArrayBuffer.isView(body)) return `[Binary, ${body.byteLength} bytes]`;
      if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return "[Stream]";
      return clip(String(body));
    } catch {
      return "[Unreadable body]";
    }
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve("[Body not available: read timed out]"), ms))
    ]);
  }

  // ---------------------------------------------------------------- console

  for (const level of ["error", "warn"]) {
    const original = console[level];
    if (typeof original !== "function") continue;

    console[level] = function bugDetectorConsole(...args) {
      try {
        const errorArg = args.find((arg) => arg instanceof Error);
        emit("console", {
          level,
          message: clip(args.map(describe).join(" "), 4000),
          stack: stackOf(errorArg) || callerStack()
        });
      } catch {
        // ignore
      }
      return original.apply(this, args);
    };
  }

  // ------------------------------------------------- errors & failed loads

  window.addEventListener("error", (event) => {
    const target = event.target;
    if (target && target !== window && target instanceof Element) {
      const url = target.currentSrc || target.src || target.href || "";
      if (url) emit("resource", { tag: target.tagName.toLowerCase(), url: resolveUrl(url) });
      return;
    }
    emit("error", {
      message: clip(event.message || describe(event.error), 4000),
      source: event.filename || null,
      line: event.lineno || null,
      column: event.colno || null,
      stack: stackOf(event.error)
    });
  }, true);

  window.addEventListener("unhandledrejection", (event) => {
    emit("rejection", {
      message: `Unhandled promise rejection: ${clip(describe(event.reason), 4000)}`,
      stack: stackOf(event.reason)
    });
  });

  // ------------------------------------------------------------------ fetch

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function bugDetectorFetch(input, init) {
      const started = performance.now();
      const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
      const meta = { initiator: "fetch", method: "GET", url: "", requestHeaders: {}, requestBody: null };

      try {
        meta.method = String(init?.method || request?.method || "GET").toUpperCase();
        meta.url = resolveUrl(request ? request.url : input);
        meta.requestHeaders = { ...headersToObject(request?.headers), ...headersToObject(init?.headers) };
        meta.requestBody = describeBody(init?.body);
      } catch {
        // keep defaults
      }

      const promise = originalFetch.apply(this, arguments);

      promise.then(
        (response) => {
          if (response.ok || response.type === "opaque" || response.type === "opaqueredirect") return;
          const durationMs = Math.round(performance.now() - started);
          let bodyPromise;
          try {
            bodyPromise = withTimeout(response.clone().text(), BODY_READ_TIMEOUT_MS);
          } catch {
            bodyPromise = Promise.resolve("[Body not available]");
          }
          bodyPromise
            .catch(() => "[Body not available]")
            .then((body) => {
              emit("network", {
                ...meta,
                status: response.status,
                statusText: response.statusText,
                durationMs,
                responseHeaders: headersToObject(response.headers),
                responseBody: clip(body)
              });
            });
        },
        (error) => {
          if (error?.name === "AbortError") return;
          emit("network", {
            ...meta,
            status: 0,
            error: describe(error),
            durationMs: Math.round(performance.now() - started)
          });
        }
      );

      return promise;
    };
  }

  // -------------------------------------------------------------------- XHR

  if (typeof XMLHttpRequest !== "undefined") {
    const META = Symbol("bugdetector.xhr");
    const proto = XMLHttpRequest.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    const originalSetHeader = proto.setRequestHeader;

    proto.open = function bugDetectorOpen(method, url) {
      try {
        this[META] = {
          initiator: "xhr",
          method: String(method || "GET").toUpperCase(),
          url: resolveUrl(url),
          requestHeaders: {},
          outcome: null
        };
      } catch {
        // ignore
      }
      return originalOpen.apply(this, arguments);
    };

    proto.setRequestHeader = function bugDetectorSetHeader(name, value) {
      try {
        if (this[META]) this[META].requestHeaders[String(name).toLowerCase()] = String(value);
      } catch {
        // ignore
      }
      return originalSetHeader.apply(this, arguments);
    };

    proto.send = function bugDetectorSend(body) {
      const meta = this[META];
      if (meta) {
        const xhr = this;
        const started = performance.now();
        meta.requestBody = describeBody(body);
        xhr.addEventListener("abort", () => { meta.outcome = "abort"; });
        xhr.addEventListener("timeout", () => { meta.outcome = "timeout"; });
        xhr.addEventListener("loadend", () => {
          if (meta.outcome === "abort") return;
          const status = xhr.status;
          if (status > 0 && status < 400) return;

          let responseBody = null;
          try {
            if (xhr.responseType === "" || xhr.responseType === "text") responseBody = xhr.responseText;
            else if (xhr.responseType === "json") responseBody = safeJson(xhr.response);
            else responseBody = `[${xhr.responseType} response]`;
          } catch {
            responseBody = "[Body not available]";
          }

          const { outcome, ...rest } = meta;
          emit("network", {
            ...rest,
            status,
            statusText: xhr.statusText,
            error: status === 0 ? (outcome === "timeout" ? "Request timed out" : "Network error") : null,
            durationMs: Math.round(performance.now() - started),
            responseHeaders: parseRawHeaders(xhr.getAllResponseHeaders()),
            responseBody: responseBody == null ? null : clip(responseBody)
          });
        });
      }
      return originalSend.apply(this, arguments);
    };
  }

  // ------------------------------------------------------------ SPA routing

  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    if (typeof original !== "function") continue;
    history[method] = function bugDetectorHistory(state, title, url) {
      const result = original.apply(this, arguments);
      if (url != null) emit("navigation", { url: location.href, via: method });
      return result;
    };
  }
})();
