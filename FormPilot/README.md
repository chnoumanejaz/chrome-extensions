# FormPilot

FormPilot is a Chrome extension that helps you save and refill form data on any website. It runs entirely in your browser — no backend, no analytics, no external API calls.

## Features

- Detects visible forms on any HTTP/HTTPS page (including localhost)
- Shows a floating **FP** button on new forms, or **preset chips** when saved data exists
- **One-click fill:** click a preset chip to fill and auto-submit
- Supports React/Vue-style controlled inputs via native value setters and event dispatch
- Stores everything locally in `chrome.storage.local`

## Project Structure

```
FormPilot/
├── manifest.json
├── background.js
├── content/
│   ├── content.js          # Orchestrator, floating UI, save/fill logic
│   ├── detector.js         # Form visibility detection + MutationObserver
│   ├── fingerprint.js      # Form fingerprinting and selector generation
│   ├── autofill.js         # Field matching and value filling
│   └── floating-button.css
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── options/
│   ├── options.html
│   ├── options.js
│   └── options.css
├── shared/
│   └── storage.js
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── test/
    └── sample-forms.html
```

## Setup — Load Unpacked in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `FormPilot` folder (the one containing `manifest.json`)
5. Pin the FormPilot extension from the toolbar if desired

## How to Test

### Option A: Use the built-in test page

1. Click the FormPilot extension icon in the toolbar
2. Click **Open test page**
3. You should see three forms, each with a blue **FP** button in the top-right corner

### Option B: Open the test file directly

Open `test/sample-forms.html` in Chrome (via the extension popup or as a file URL).

### Test workflow

1. Fill in fields on the **Login** form
2. Click **FP** → **Save Current Form Data** and name the preset (e.g. "Admin Login")
3. The FP button becomes a **preset chip** showing your saved name
4. Clear the form fields manually
5. Click the **Admin Login** chip — fields fill and the form auto-submits
6. Repeat for the Contact and Survey forms — each form gets its own preset chips

### Verify storage

- Open the extension popup to see form/preset counts
- Click **Manage saved data** to view or delete saved presets

## How Form Fingerprinting Works

FormPilot does **not** identify forms by URL alone. The same page can have multiple forms, and the same form layout can appear on different pages.

Each form gets a stable fingerprint built from:

| Component | Example |
|-----------|---------|
| Page origin | `https://example.com` |
| Pathname | `/login` |
| Form index | `0`, `1`, `2` (position among all `<form>` elements) |
| Form attributes | `id`, `name`, `class`, `action`, `method` |
| Context | Nearby heading text, submit button text |
| Field metadata | For each field: tag, type, name, id, class, placeholder, label, aria-label, autocomplete, index |

These values are normalized, serialized to JSON, and hashed into a short base-36 string (e.g. `a83kd92k`).

**Storage key format:**

```
{origin}{pathname}::{fingerprint}
```

Example: `https://example.com/login::a83kd92k`

This means:

- Two different forms on the same page get different fingerprints (different index and field metadata)
- The same form on the same URL gets the same fingerprint across visits (as long as the DOM structure stays the same)
- A form that changes significantly (fields added/removed/reordered) will get a new fingerprint

## Field Matching When Filling

When filling a saved preset, FormPilot tries to find each field in this order:

1. Saved CSS selector
2. Fallback selectors saved with the preset
3. `#id`
4. `[name="..."]`
5. `[aria-label="..."]`
6. `[placeholder="..."]`
7. Associated label text
8. `[autocomplete="..."]`
9. Tag + type + index fallback

Missing fields are skipped gracefully — the extension will not crash.

## Privacy

- **All saved data stays locally in your browser**
- No backend server
- No analytics or tracking
- No external API calls
- Avoid saving sensitive passwords, payment cards, or private personal data

## Known Limitations

1. **Requires `<form>` elements** — div-based forms without a `<form>` tag (some SPAs) are not detected
2. **Fingerprint stability** — adding, removing, or reordering fields changes the fingerprint; existing presets won't auto-migrate
3. **File inputs** — not supported (browser security restriction)
4. **Shadow DOM** — fields inside closed shadow roots may not be accessible
5. **Cross-origin iframes** — not scanned (`all_frames: false`)
6. **Auto-submit** — clicking a preset chip fills the form and clicks the submit button if one exists; forms without a submit button are filled only
7. **Sensitive data** — stored locally but unencrypted; user is responsible for what they save
8. **Duplicate forms** — forms with identical structure and index may collide; nearby heading and submit text help differentiate them

## Supported Field Types

- Text, email, password, number, tel, url inputs
- Textarea
- Select dropdowns
- Checkboxes
- Radio button groups

## Development Notes

- Manifest V3 with plain JavaScript — no build step required
- Content scripts load in order: `fingerprint.js` → `detector.js` → `autofill.js` → `content.js`
- Floating UI uses Shadow DOM to avoid CSS conflicts with host pages
- `MutationObserver` detects dynamically added forms (React, Vue, Next.js, etc.)

## License

MIT — use freely for personal or commercial projects.
