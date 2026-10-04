# BugDetector 🐞

A Chrome extension that turns "something broke" into a **ready-to-paste bug report** with one shortcut.

When a bug happens, BugDetector collects:

- a **screenshot** of the page
- **console errors**: uncaught errors, unhandled promise rejections, `console.error` (and optionally warnings), with stack traces
- **failed API calls**: method, URL, status, timing, request headers and body, response body and useful response headers (request IDs, trace IDs)
- **failed resources** (images, scripts, stylesheets, fonts) and network errors (`net::ERR_CONNECTION_REFUSED`, CORS, DNS…)
- the **steps before the bug**: clicks, form changes, submits and SPA navigations (input values are never recorded)
- the **environment**: browser, OS, viewport, language, timezone, page load time

Everything is formatted as Markdown, Slack, plain text, JSON or an **AI prompt** that you can paste into Claude or ChatGPT to debug the problem.

Everything stays local: no backend, no account, no analytics. Secrets are redacted before a report is saved.

## Install (load unpacked)

1. Open `chrome://extensions` and turn on **Developer mode** (top-right).
2. Click **Load unpacked** and select this `BugDetector` folder (the one containing `manifest.json`).
3. Pin BugDetector from the puzzle-piece menu so the badge is visible.
4. Optional: check the shortcut at `chrome://extensions/shortcuts`. The default is **Alt+Shift+B**. Chrome leaves it unset if another extension already uses it.

Pages that were already open when you installed the extension are injected automatically. Reload a page if it still shows "not running".

## How to use

| Mode | What happens |
|---|---|
| **Auto-detect** (default on) | When an error or failed request happens, a small **"Bug detected"** popup appears in the bottom-right corner. Click **Capture bug**. The toolbar badge counts the issues on the current tab. |
| **Shortcut** | Press **Alt+Shift+B** at any time to capture the current tab. |
| **Toolbar popup** | Click the extension icon, then **Capture bug**. The popup also shows the issues on this page, recent reports, and quick toggles. |

The capture opens a **report page** next to the tab. On that page you can:

- edit the title and add "What happened / What I expected"
- choose the format: Markdown, Slack/Teams, plain text, AI prompt, or JSON
- include or exclude sections: description, failed requests, console errors, steps, environment
- **Copy report**, then **Copy screenshot** and paste again to attach the image
- download the report (`.md` / `.txt` / `.json`) or the screenshot (`.png`)

Reports (with screenshots) are kept in IndexedDB. The last 20 are kept by default, and you can change that in settings.

### Example output

````markdown
## 🐞 500 on POST /api/orders

**Page:** [Checkout](https://shop.example.com/checkout)
**Captured:** 2026-10-04 14:32:32 (Europe/Berlin)
**Browser:** Chrome 141 on macOS · 1440×900 @2x

### Failed requests (1)

**1. POST 500 Internal Server Error** `https://shop.example.com/api/orders` · 812 ms · 3s before

Request body:
```json
{ "cartId": "c_12", "coupon": "SAVE10", "password": "[REDACTED]" }
```

Response body:
```json
{ "error": "coupon_not_found" }
```

### Console errors (1)

**1. Uncaught TypeError: Cannot read properties of undefined (reading 'total')** · 2s before
```
at placeOrder (checkout.js:88:12)
```

### Steps before the bug

1. Opened https://shop.example.com/checkout `20s before`
2. Changed "Coupon" (input[name="coupon"]) `6s before`
3. Clicked "Place order" (button.btn-primary) `4s before`
````

## Settings

Open the settings page from the gear icon in the popup, or from **Details → Extension options**.

- **Auto-detection**: on/off, what triggers the popup (errors only, plus failed requests, plus warnings), quiet period after dismissing, and patterns for messages and URLs to ignore (analytics and trackers are ignored by default)
- **Sites**: run everywhere except a blocklist, or only on an allowlist (for example `localhost`, `staging.myapp.com`). You can also **mute** sites, so data is still collected but the popup never shows. The toast's "Mute site" button does this in one click.
- **Privacy**: headers to redact, JSON keys and query params to mask, optional email masking, and the body size limit
- **Saved reports**: how many to keep, and a button to delete them all

## Privacy and redaction

Redaction runs in the service worker **before** a report is stored, so secrets never reach storage or the clipboard.

- Headers such as `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key` and CSRF tokens become `[REDACTED]`.
- JSON keys, form fields and query parameters containing `password`, `secret`, `token`, `api_key`, `cvv`… are masked, even in truncated JSON.
- `Bearer …` / `Basic …` credentials and JWTs are masked anywhere they appear.
- Input values are never recorded in the steps.

Redaction is pattern-based. Review a report before sharing it outside your team.

## Architecture

```
BugDetector/
├── manifest.json            MV3 · module service worker · Alt+Shift+B command
├── background/
│   ├── service-worker.js    wires commands, messages, badge, injection into open tabs
│   ├── capture.js           snapshot → screenshot → build → redact → store → open report
│   └── network-monitor.js   chrome.webRequest failures per tab (chrome.storage.session)
├── content/
│   ├── page-hook.js         MAIN world: wraps fetch/XHR/console, listens to error events
│   ├── collector.js         isolated world: ring buffers, breadcrumbs, toast logic, snapshot
│   └── toast.js             closed shadow-DOM toast with adoptedStyleSheets
├── shared/                  "universal" scripts: content scripts AND side-effect ES modules
│   ├── protocol.js          message types (single source of truth)
│   ├── settings-schema.js   defaults + normalize()
│   ├── site-match.js        allow/block/mute host patterns
│   └── ring-buffer.js
├── lib/                     pure ES modules (unit-tested)
│   ├── messages.js          typed message protocol (JSDoc)
│   ├── settings.js          chrome.storage.sync get/update/subscribe
│   ├── redact.js            secret & PII redaction
│   ├── report-model.js      report building, network merge, titles
│   ├── report-format.js     Markdown / Slack / text / AI / JSON renderers
│   └── report-store.js      IndexedDB (reports + screenshot Blobs)
├── ui/                      theme.css + DOM helpers for the extension pages
├── popup/  options/  report/
└── test/                    unit tests, e2e smoke test, playground + dev server
```

**Data flow.** `page-hook.js` runs in the page's own JavaScript world at `document_start`, so it can see `fetch`, XHR and console calls. It sends each observation to `collector.js` as a `CustomEvent` with a JSON-string payload. The collector keeps the last 50 console entries, 50 failed requests and 30 steps in memory. On capture, the service worker asks the collector for a snapshot, hides the toast, takes the screenshot and merges in failures seen by `chrome.webRequest`. Those include requests the page can't observe: CSS and fonts, the document itself, and the real network error behind a "Failed to fetch". It then redacts the report, saves it and opens the report page.

**Why these permissions?**

- `<all_urls>`: content scripts everywhere, and `captureVisibleTab` when you click the in-page popup
- `webRequest`: failed requests the page can't see
- `scripting`: inject into tabs that were open before install
- `storage` / `unlimitedStorage`: settings and screenshots

## Development and tests

No build step: edit the files, then click ↻ on `chrome://extensions`.

```bash
cd BugDetector
npm test            # unit tests (node --test, no dependencies)
npm run serve       # bug playground at http://127.0.0.1:5179/
npm run test:e2e    # loads the extension in Chromium via Playwright and checks a full capture
```

The e2e test needs Playwright (`npm i -D playwright`, or a global install). Set `CHROMIUM_PATH` to use a specific Chromium build. Pass `--screenshots <dir>` to save screenshots of the toast, report, popup and options page.

The **playground** (`test/bug-playground.html`) has buttons for every kind of bug: uncaught errors, rejections, `console.error`, 404/500 fetches, XHR failures, network failures, broken images, SPA navigation, and a checkout form that fails realistically.

## Roadmap ideas

1. **Screenshot annotation**: arrows, boxes and blur for sensitive areas, on the report page.
2. **Element picker**: click the broken element to include its selector, DOM snippet and computed state.
3. **Short replay**: the last ~30 s of DOM changes (rrweb), or a tab video clip.
4. **One-click send**: create a GitHub issue, Jira or Linear ticket, or post to a Slack webhook (tokens stored locally).
5. **Built-in AI triage**: with your own Claude API key, generate a title, summary, likely root cause and severity.
6. **HAR export** of the full network log for backend developers.
7. **Performance bugs**: flag slow requests (over 3 s), long tasks and big layout shifts as "soft bugs".
8. **App context**: read the app version, git SHA and environment from meta tags or `window.__APP_VERSION__`.
9. **Error grouping and history**: group repeated errors and add a per-site dashboard.
10. **Deep-capture mode** (opt-in): `chrome.debugger` for the full DevTools network and console data, at the cost of Chrome's "being debugged" banner.
11. **Iframes**: collect from same-origin iframes (`all_frames`).
