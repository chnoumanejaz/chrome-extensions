# BugDetector 🐞

A Chrome extension that turns "something broke" into a **ready-to-paste bug report** with one shortcut.

When a bug happens, BugDetector collects:

- a **screenshot** of the page
- **console errors**: uncaught errors, unhandled promise rejections, `console.error` (and optionally warnings), with stack traces
- **failed API calls**: method, URL, status, timing, request headers and body, response body and useful response headers (request IDs, trace IDs)
- **failed resources** (images, scripts, stylesheets, fonts) and network errors (`net::ERR_CONNECTION_REFUSED`, CORS, DNS…)
- the **steps before the bug**: clicks, form changes, submits and SPA navigations (input values are never recorded)
- the **environment**: browser, OS, viewport, language, timezone, page load time
- optionally, the **broken element** you click on, with a diagnosis of why it might not work (covered by another element, disabled, `pointer-events: none`, hidden, off-screen)

On the report page you can **draw boxes and arrows** on the screenshot, **blur** private areas, and ask Claude for an **AI triage** (suggested title, severity, likely root cause and fix) using your own API key.

Everything is formatted as Markdown, Slack, plain text, JSON or an **AI prompt** that you can paste into Claude or ChatGPT to debug the problem.

No backend, no account, no analytics. Everything stays in your browser unless you press **Analyze with Claude**. Secrets are redacted before a report is saved.

## Install (load unpacked)

1. Open `chrome://extensions` and turn on **Developer mode** (top-right).
2. Click **Load unpacked** and select this `BugDetector` folder (the one containing `manifest.json`).
3. Pin BugDetector from the puzzle-piece menu so the badge is visible.
4. Optional: check the shortcuts at `chrome://extensions/shortcuts`. The defaults are **Alt+Shift+D** (capture) and **Alt+Shift+E** (select the broken element). Chrome leaves a shortcut unset if something else already uses it.

Pages that were already open when you installed the extension are injected automatically. Reload a page if it still shows "not running".

## How to use

| Mode | What happens |
|---|---|
| **Auto-detect** (default on) | When an error or failed request happens, a small **"Bug detected"** popup appears in the bottom-right corner. Click **Capture bug**. The toolbar badge counts the issues on the current tab. |
| **Shortcut** | Press **Alt+Shift+D** at any time to capture the current tab. |
| **Select broken element** | Press **Alt+Shift+E**, click **Pick element** on the "Bug detected" popup, or use the toolbar popup. Hover to highlight, then click the element that's broken. **↑** selects the parent, **↓** the element underneath (useful when an invisible overlay is in the way), and **Esc** cancels. The page doesn't react to these clicks. The element gets a red box in the screenshot and a "Selected element" section in the report. |
| **Toolbar popup** | Click the extension icon, then **Capture bug** or **Select broken element**. The popup also shows the issues on this page, recent reports, and quick toggles. |

The capture opens a **report page** next to the tab. On that page you can:

- edit the title and add "What happened / What I expected"
- **annotate the screenshot**: click **Annotate**, then drag to draw a **Box**, an **Arrow** or a **Blur** (pixelates private info so it can't be read). It has 4 colours, **Undo** (Ctrl/Cmd+Z) and **Clear**.
  - Edits are saved. The original screenshot is kept, so you can change your mind later.
  - Everything that leaves the page (copy, download, open, AI triage) uses the annotated, blurred version.
- run **AI triage** (see below) and click **Use this title** to adopt Claude's suggestion
- choose the format: Markdown, Slack/Teams, plain text, AI prompt, or JSON
- include or exclude sections: description, AI triage, selected element, failed requests, console errors, steps, environment
- **Copy report**, then **Copy screenshot** and paste again to attach the image
- download the report (`.md` / `.txt` / `.json`) or the screenshot (`.png`)

### AI triage (bring your own Claude key)

1. Create an API key at [console.anthropic.com](https://console.anthropic.com/settings/keys).
2. Paste it in **Settings → AI triage**, then click **Save key** and **Test**.
3. On a report, press **Analyze with Claude**.

Claude returns a **suggested title**, the **severity** (critical / high / medium / low) with a reason, the likely **area** (frontend, backend, network, configuration), the **likely root cause** with supporting evidence, a **suggested fix** and **next steps**. The result is saved with the report and can be included in what you copy.

- **What's sent:** the redacted report text, plus the annotated and blurred screenshot when "Send the screenshot" is checked. Nothing is sent until you press the button.
- **Model:** Claude Opus 5.5 by default; you can switch to Claude Sonnet 5.5 (faster, cheaper) in Settings. The request uses structured outputs (a JSON schema) so the answer always has the same shape. It also enables server-side `fallbacks: "default"`, so a request that trips a safety classifier is retried on another model instead of failing.
- **Your key:** it is stored only on this device (`chrome.storage.local`, never synced) and sent only to `api.anthropic.com`. Usage is billed to your Anthropic account.

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
- **AI triage**: API key (save, test, remove), model, and whether to send the screenshot by default

## Privacy and redaction

Redaction runs in the service worker **before** a report is stored, so secrets never reach storage or the clipboard.

- Headers such as `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key` and CSRF tokens become `[REDACTED]`.
- JSON keys, form fields and query parameters containing `password`, `secret`, `token`, `api_key`, `cvv`… are masked, even in truncated JSON.
- `Bearer …` / `Basic …` credentials and JWTs are masked anywhere they appear.
- Input values are never recorded in the steps, and the selected element's HTML has form values removed.
- Blurred areas are pixelated in every exported image and in what is sent to Claude.

Redaction is pattern-based. Review a report before sharing it outside your team.

## Architecture

```
BugDetector/
├── manifest.json            MV3 · module service worker · Alt+Shift+D / Alt+Shift+E commands
├── background/
│   ├── service-worker.js    wires commands, messages, badge, injection into open tabs
│   ├── capture.js           snapshot → screenshot → build → redact → store → open report
│   └── network-monitor.js   chrome.webRequest failures per tab (chrome.storage.session)
├── content/
│   ├── page-hook.js         MAIN world: wraps fetch/XHR/console, listens to error events
│   ├── collector.js         isolated world: ring buffers, breadcrumbs, toast logic, snapshot
│   ├── toast.js             closed shadow-DOM toast with adoptedStyleSheets
│   ├── picker.js            "select the broken element" overlay (↑ parent, ↓ underneath)
│   └── element-inspector.js unique selector, safe HTML, styles, "covered by…" diagnostics
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
│   ├── report-store.js      IndexedDB (reports + screenshot Blobs)
│   ├── annotations.js       box / arrow / pixel-blur geometry and compositing
│   ├── ai-triage.js         triage request (structured output) + response validation
│   └── claude-client.js     the only importer of the vendored Anthropic SDK
├── ui/                      theme.css + DOM helpers for the extension pages
├── popup/  options/
├── report/                  report page, annotator.js, triage.js
├── vendor/anthropic-sdk.js  @anthropic-ai/sdk bundled by scripts/build-vendor.mjs (committed)
└── test/                    unit tests, e2e smoke test, playground + dev server
```

**Data flow.** `page-hook.js` runs in the page's own JavaScript world at `document_start`, so it can see `fetch`, XHR and console calls. It sends each observation to `collector.js` as a `CustomEvent` with a JSON-string payload. The collector keeps the last 50 console entries, 50 failed requests and 30 steps in memory. On capture, the service worker asks the collector for a snapshot, hides the toast, takes the screenshot and merges in failures seen by `chrome.webRequest`. Those include requests the page can't observe: CSS and fonts, the document itself, and the real network error behind a "Failed to fetch". It then redacts the report, saves it and opens the report page.

**Why these permissions?**

- `<all_urls>`: content scripts everywhere, and `captureVisibleTab` when you click the in-page popup
- `webRequest`: failed requests the page can't see
- `scripting`: inject into tabs that were open before install
- `storage` / `unlimitedStorage`: settings and screenshots

## Development and tests

No build step: edit the files, then click ↻ on `chrome://extensions`. The only generated file is `vendor/anthropic-sdk.js`. It is committed, so "Load unpacked" works without npm. Rebuild it after bumping the SDK version:

```bash
cd BugDetector
npm install         # dev tools only: @anthropic-ai/sdk + esbuild
npm run vendor      # re-bundle vendor/anthropic-sdk.js
npm test            # unit tests (node --test)
npm run serve       # bug playground at http://127.0.0.1:5179/
npm run test:e2e    # loads the extension in Chromium via Playwright and checks a full capture
```

The e2e test needs Playwright (`npm i -D playwright`, or a global install). Set `CHROMIUM_PATH` to use a specific Chromium build. Pass `--screenshots <dir>` to save screenshots of the toast, report, popup, picker, annotator, triage card and options page. The Claude API is mocked in the e2e test (Playwright `context.route`), so no key or cost is involved.

The **playground** (`test/bug-playground.html`) has buttons for every kind of bug: uncaught errors, rejections, `console.error`, 404/500 fetches, XHR failures, network failures, broken images, SPA navigation, a checkout form that fails realistically, and a "Pay now" button covered by an invisible overlay for the element picker.

## Roadmap ideas

Done in v1.1: screenshot annotation and blur, the element picker, and AI triage.

1. **Short replay**: the last ~30 s of DOM changes (rrweb), or a tab video clip.
2. **One-click send**: create a GitHub issue, Jira or Linear ticket, or post to a Slack webhook (tokens stored locally).
3. **AI follow-ups**: ask Claude follow-up questions about a report, or have it draft a fix from a pasted code snippet.
4. **HAR export** of the full network log for backend developers.
5. **Performance bugs**: flag slow requests (over 3 s), long tasks and big layout shifts as "soft bugs".
6. **App context**: read the app version, git SHA and environment from meta tags or `window.__APP_VERSION__`.
7. **Error grouping and history**: group repeated errors and add a per-site dashboard.
8. **Deep-capture mode** (opt-in): `chrome.debugger` for the full DevTools network and console data, at the cost of Chrome's "being debugged" banner.
9. **Iframes**: collect from same-origin iframes (`all_frames`).
10. **Text annotations** on the screenshot, plus moving or resizing shapes after drawing.
