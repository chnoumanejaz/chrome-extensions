# FormPilot

FormPilot is a Chrome extension that helps you save and refill form data on any website. It runs entirely in your browser — no backend, no analytics, no external API calls.

## Features

- Detects visible forms on any HTTP/HTTPS page (including localhost), and optionally forms **without a `<form>` tag**
- Shows a floating **FP** button on new forms, or **preset chips** when saved data exists
- **Fill-only or fill-and-submit**, chosen per preset when you save it and changeable later
- **Edit and rename presets** from the form's panel or the options page
- **Sensitive fields** (passwords, cards, tokens) are **skipped by default**, or saved **encrypted** with a passphrase
- **Global profiles** (name, email, address…) that fill any form by matching fields to what they ask for
- **Random test-data generator** for QA: a consistent fake person per fill
- **Per-site control:** hide FormPilot on specific websites, or show it only on the sites you pick
- Supports React/Vue-style controlled inputs via native value setters and event dispatch
- Stores everything locally in `chrome.storage.local`

## Presets: fill-only vs. submit

When you click **Save Current Form Data**, the save form asks for a name and whether the preset should **submit the form after filling**. It remembers your last choice as the next default (off the first time).

- A chip marked **↵** (for example `↵ Admin login`) fills **and submits**. A chip without it only fills.
- In the form's panel, each preset has a **↵** toggle to flip the mode, a **✎** to rename, and **×** to delete.
- The options page has a full editor per preset: rename, the submit setting, and every saved value (edit or remove fields).
- Presets saved before this feature existed keep their old behavior (fill and submit) until you change them.

## Sensitive fields and encryption

FormPilot treats these as sensitive: password fields, card numbers and security codes, one-time codes, and fields that look like API keys or tokens.

Choose the default under **Sensitive fields** in settings. You can also override it for any single save:

| Option | What happens |
|--------|--------------|
| **Don't save them** (default) | Sensitive fields never reach storage. Fill them yourself. |
| **Save them encrypted** | Values are encrypted with AES-256-GCM using a key derived from your passphrase (PBKDF2-SHA256, 600,000 iterations). |

Encryption details:

- **The passphrase is never stored.** If you forget it, encrypted values can't be recovered. **Reset encryption** deletes the passphrase and all encrypted values.
- You unlock once per browser session (from a form's panel, when filling an encrypted preset, or in settings). The derived key is held in memory only and is cleared when the browser closes or you press **Lock now**.
- The crypto runs in the extension's background service worker, so page scripts and content scripts never hold the key (and it works on plain-`http` pages, where page contexts have no WebCrypto).
- If you cancel the unlock prompt while filling, everything except the encrypted fields is still filled.
- Field names and labels are saved unencrypted so FormPilot can find the fields again. Only the values are encrypted.

## Global profiles

A profile is a named set of details: full/first/last name, email, phone, website, username, company, job title, address lines, city, state, postal code, country, and birthday.

1. Create profiles under **Profiles** in settings.
2. On any form, open the FormPilot panel (**FP** or **+**), pick a profile, and click **Fill profile**.

Fields are matched by what they are, not by where they sit: the HTML `autocomplete` attribute first, then the input type, then the name, id, placeholder and label. "Project name" or "Unit price" are deliberately left alone. Selects match by value or visible text ("United States" fills `US`). A profile fill never submits and never touches passwords.

## Random test data

**Fill with random test data** in the panel fills every visible field with believable fake data. One fake person is generated per fill, so first name, last name, email and username agree, and password and confirm-password match. Dates and numbers respect `min`, `max`, `step` and `maxlength`. Terms/consent checkboxes are ticked. Hidden fields are left alone, and card numbers and tokens are never invented.

Emails use `example.com` and phone numbers use the reserved `555-01xx` range, so nothing generated belongs to a real person.

## Forms without a `<form>` tag

Many modern sites build forms out of plain `div`s. FormPilot can detect those, but it has to guess, so this feature is separate from normal detection and **only runs on the sites you choose (by default, just `localhost`)**.

- Under **Forms without a `<form>` tag** in settings, choose **Auto-detect** or **Pause detection**, and manage the list of sites it runs on.
- The popup has a **Detect div-based forms** switch for the current site.
- A group of fields counts as a form only if it has **at least two distinct visible fields**, **at least one text-like field** (not just checkboxes), and a **submit-style button** (`type="submit"`, or a button saying sign in, log in, sign up, register, save, send, continue, next, checkout, and similar). It also can't contain a real `<form>`, and groups of more than 40 fields are treated as a whole page, not a form.
- So a lone search box, or a few checkboxes with an "Apply" button, never get a button.
- Presets, profiles, test data, encryption and fill-only/submit all work the same on these groups. Submitting clicks the group's submit button.
- Sites must also be allowed under **Where to show FormPilot**.

## Choosing Where FormPilot Shows

There are two modes, set on the options page (**Settings & saved data**):

| Mode | Behavior |
|------|----------|
| **Show on all sites** (default) | FormPilot appears everywhere except the sites on your *hidden* list |
| **Show only on selected sites** | FormPilot appears only on the sites on your *selected* list |

Each mode keeps its own list, so switching modes never loses the other list.

- **Quick toggle:** open the toolbar popup and flip **Show on this site**. It edits the list for the active mode and takes effect immediately, with no page reload.
- **Manage lists:** add or remove sites on the options page.
- **Matching:** a site covers its subdomains (`example.com` includes `app.example.com`). Ports, paths and a leading `www.` are ignored, so `localhost` covers every local port.
- Where FormPilot is off, the content script does no scanning at all.
- Saved presets are never deleted when a site is hidden, and **Clear all data** removes presets and profiles but leaves your settings and site lists alone.

## Project Structure

```
FormPilot/
├── manifest.json
├── background.js            # Service worker: encryption service (message handler)
├── background/
│   └── crypto-core.js       # PBKDF2 + AES-GCM, session key cache
├── content/
│   ├── content.js          # Orchestrator, floating UI, panel, save/fill logic
│   ├── detector.js         # Form + formless-group detection, MutationObserver
│   ├── fingerprint.js      # Form fingerprinting and selector generation
│   ├── autofill.js         # Field matching, value filling, profile fill
│   ├── test-data.js        # Random test-data generator
│   ├── dialogs.js          # In-page passphrase dialog (Shadow DOM)
│   └── floating-button.css
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── options/
│   ├── options.html
│   ├── options.js          # Saved forms + preset editor
│   ├── site-settings.js    # Site lists and formless detection settings
│   ├── privacy.js          # Sensitive-field mode and encryption panel
│   ├── profiles.js         # Profile editor
│   └── options.css
├── shared/
│   ├── storage.js          # Forms storage helpers (popup/options)
│   ├── site-rules.js       # Hidden/selected/formless site lists + host matching
│   ├── field-types.js      # Field classification + sensitive-field detection
│   ├── settings.js         # General settings
│   ├── profiles.js         # Profile storage
│   └── crypto.js           # Client for the encryption service
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

Content scripts run on `http`/`https` pages only, so serve the test page over HTTP rather than opening it from the extension:

```
cd FormPilot/test && python3 -m http.server 8000
# then open http://localhost:8000/sample-forms.html
```

The page has three normal forms, two div-based groups (a login and a sign-up) and a "Not forms" block that should never get a button. A log at the top records every submit.

### Test workflow

1. Fill in the **Login** form (email and password)
2. Click **FP** → **Save Current Form Data**, name the preset, leave **Submit the form after filling** off, and keep "Don't save them" for the password
3. The FP button becomes a **preset chip**. Clear the fields and click it: the fields fill and the log stays empty
4. Open the panel (**+**) and click **↵** on the preset. The chip now reads `↵ …` and clicking it fills and submits
5. On the **div-based sign-up** group: pick **Fill with random test data**, or create a profile in settings and use **Fill profile**
6. Switch **Sensitive fields** to **Save them encrypted** in settings, save the sign-up group again, then lock encryption and click its chip to see the passphrase prompt
7. In the popup, flip **Detect div-based forms** off and the div-based widgets disappear without a reload

### Verify storage

- Open the extension popup to see form/preset counts
- Click **Settings & saved data** to view, edit or delete saved presets

## How Form Fingerprinting Works

FormPilot does **not** identify forms by URL alone. The same page can have multiple forms, and the same form layout can appear on different pages.

Each form gets a stable fingerprint built from:

| Component | Example |
|-----------|---------|
| Page origin | `https://example.com` |
| Pathname | `/login` |
| Form index | `0`, `1`, `2` (position among all `<form>` elements, or among detected div-based groups) |
| Form attributes | `id`, `name`, `class`, `action`, `method` |
| Context | Nearby heading text, submit button text |
| Field metadata | For each field: tag, type, name, id, class, placeholder, label, aria-label, autocomplete, index |

These values are normalized, serialized to JSON, and hashed into a short base-36 string (e.g. `a83kd92k`). Div-based groups add a marker to the hash, so they never collide with real forms, and fingerprints of real forms are unchanged.

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
- Sensitive fields are not saved unless you choose to encrypt them
- Non-sensitive values (names, emails, addresses) are stored unencrypted in `chrome.storage.local`

## Known Limitations

1. **Div-based forms are heuristic** — the detector only recognizes groups with a clear submit-style button, and only on sites you enable. A form with an unlabeled icon button, or fields spread across far-apart parts of the page, may not be found
2. **Fingerprint stability** — adding, removing, or reordering fields changes the fingerprint; existing presets won't auto-migrate
3. **File inputs** — not supported (browser security restriction)
4. **Shadow DOM** — fields inside closed shadow roots may not be accessible
5. **Cross-origin iframes** — not scanned (`all_frames: false`)
6. **Auto-submit** — a preset marked to submit clicks the form's submit button if one exists; forms without one are filled only
7. **Encryption** — a forgotten passphrase can't be recovered, and the key stays in memory for the browser session unless you lock it. Field labels and names are not encrypted
8. **Duplicate forms** — forms with identical structure and index may collide; nearby heading and submit text help differentiate them
9. **Profile matching is by guess** — unusual field names may not match; check the result before submitting

## Supported Field Types

- Text, email, password, number, tel, url inputs
- Textarea
- Select dropdowns
- Checkboxes
- Radio button groups
- Date, time, month and color inputs (random test data)

## Development Notes

- Manifest V3 with plain JavaScript — no build step required
- Content scripts load in order: `site-rules.js` → `field-types.js` → `settings.js` → `profiles.js` → `crypto.js` → `fingerprint.js` → `detector.js` → `autofill.js` → `test-data.js` → `dialogs.js` → `content.js`
- Floating UI and dialogs use Shadow DOM to avoid CSS conflicts with host pages, and stop key events at the shadow host so typing doesn't trigger a site's shortcuts
- `MutationObserver` detects dynamically added forms (React, Vue, Next.js, etc.). It only runs where FormPilot is enabled
- Encryption is requested from content scripts and extension pages by message (`formpilot:crypto:*`); only the extension's own contexts are served

## License

MIT — use freely for personal or commercial projects.
