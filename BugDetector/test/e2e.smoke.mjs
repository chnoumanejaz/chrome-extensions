/**
 * End-to-end smoke test: loads the unpacked extension into Chromium, triggers
 * every kind of bug on the playground, captures a report and checks its
 * content (including redaction).
 *
 *   node test/e2e.smoke.mjs [--screenshots <dir>]
 *
 * Needs Playwright (local or global install) and a Chromium build that can
 * load extensions (set CHROMIUM_PATH to use a specific binary).
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.mjs";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const globalRoot = execSync("npm root -g").toString().trim();
    return createRequire(`${globalRoot}/`)("playwright");
  }
}

const args = process.argv.slice(2);
const shotsDir = args.includes("--screenshots") ? resolve(args[args.indexOf("--screenshots") + 1]) : null;
if (shotsDir) await mkdir(shotsDir, { recursive: true });

const { chromium } = await loadPlaywright();
const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const userDataDir = await mkdtemp(join(tmpdir(), "bugdetector-e2e-"));
const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}/`;

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 860 },
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✖ ${name}\n    ${String(error.message).split("\n").join("\n    ")}`);
  }
}

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  console.log(`Extension ${extensionId} loaded; playground at ${base}`);

  const page = await context.newPage();
  await page.goto(base);
  const toast = page.locator("bug-detector-ui[data-open]");

  await check("no toast before anything breaks", async () => {
    await page.click("#fetch-ok");
    await page.waitForTimeout(500);
    assert.equal(await toast.count(), 0);
  });

  await check("toast appears on a failed API call", async () => {
    await page.click("#fetch-500");
    await toast.waitFor({ state: "attached", timeout: 5000 });
  });
  if (shotsDir) await page.screenshot({ path: join(shotsDir, "1-toast.png") });

  for (const id of ["#throw-error", "#reject-promise", "#console-error", "#fetch-404", "#fetch-network", "#xhr-500", "#broken-image", "#spa-navigate"]) {
    await page.click(id);
    await page.waitForTimeout(150);
  }
  await page.fill("input[name=email]", "ada@example.com");
  await page.fill("input[name=coupon]", "SAVE10");
  await page.click("#checkout button[type=submit]");
  await page.waitForTimeout(1200);

  async function findTab() {
    return worker.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => tab.url?.startsWith(url));
    }, base);
  }

  await check("toolbar badge counts detected issues", async () => {
    const tab = await findTab();
    const badge = await worker.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tab.id);
    assert.ok(Number(badge) >= 8, `badge was "${badge}"`);
  });

  await page.bringToFront();
  const reportPagePromise = context.waitForEvent("page");
  const tab = await findTab();
  const result = await worker.evaluate((t) => globalThis.BugDetector.captureTab(t), tab);

  await check("capture succeeds", async () => {
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  const reportPage = await reportPagePromise;
  await reportPage.waitForSelector("#layout:not([hidden])", { timeout: 10000 });
  await reportPage.setViewportSize({ width: 1400, height: 1000 });
  const preview = await reportPage.textContent("#preview");
  if (shotsDir) {
    await reportPage.screenshot({ path: join(shotsDir, "2-report.png"), fullPage: true });
    await writeFile(join(shotsDir, "report.md"), preview);
  }

  await check("toast was not visible in the screenshot flow and is gone after capture", async () => {
    assert.equal(await toast.count(), 0);
  });

  await check("report lists failed API calls with bodies", async () => {
    assert.match(preview, /POST 500 Internal Server Error/);
    assert.match(preview, /coupon_not_found/);
    assert.match(preview, /GET 404 Not Found/);
    assert.match(preview, /\/api\/users\/42/);
    assert.match(preview, /PUT 500/);
    assert.match(preview, /db_timeout/);
    assert.match(preview, /x-request-id: req_/);
    assert.match(preview, /127\.0\.0\.1:59999\/unreachable/);
    assert.match(preview, /missing-\d+\.png/);
  });

  await check("browser noise is filtered out", async () => {
    assert.doesNotMatch(preview, /favicon\.ico/);
    assert.doesNotMatch(preview, /`http[^`]*\/api\/ok`/, "successful requests are not listed");
  });

  await check("report lists console errors with stacks", async () => {
    assert.match(preview, /TypeError: Cannot read properties of undefined \(reading 'total'\)/);
    assert.match(preview, /Unhandled promise rejection: Error: Payment provider timeout/);
    assert.match(preview, /Failed to render <PriceTag>: \{"sku":"SKU-123","price":null\}/);
    assert.match(preview, /at .*bug-playground|at .*127\.0\.0\.1/);
  });

  await check("report lists the steps before the bug", async () => {
    assert.match(preview, /Opened http:\/\/127\.0\.0\.1/);
    assert.match(preview, /Clicked "POST \/api\/orders → 500" \(button#fetch-500\)/);
    assert.match(preview, /Changed "Email" \(input\[name="email"\]\)/);
    assert.match(preview, /Navigated to .*\?step=/);
    assert.match(preview, /Submitted form#checkout/);
  });

  await check("secrets are redacted", async () => {
    for (const secret of ["secret-token-123", "hunter2", "tok_live_abc", "api_key=abc123", "should-be-redacted"]) {
      assert.ok(!preview.includes(secret), `leaked: ${secret}`);
    }
    assert.match(preview, /authorization: \[REDACTED\]/);
  });

  await check("screenshot is stored and displayed", async () => {
    const width = await reportPage.evaluate(() => document.querySelector("#screenshot").width);
    assert.ok(width > 0);
  });

  await check("AI prompt and JSON formats render", async () => {
    await reportPage.selectOption("#format", "ai");
    assert.match(await reportPage.textContent("#preview"), /^You are a senior web engineer/);
    await reportPage.selectOption("#format", "json");
    const data = JSON.parse(await reportPage.textContent("#preview"));
    assert.ok(data.network.length >= 5);
    await reportPage.selectOption("#format", "markdown");
  });

  await check("edits to title and description persist", async () => {
    await reportPage.fill("#title", "Checkout broken after applying coupon");
    await reportPage.fill("#actual", "Spinner forever");
    await reportPage.waitForTimeout(700);
    await reportPage.reload();
    await reportPage.waitForSelector("#layout:not([hidden])");
    assert.equal(await reportPage.inputValue("#title"), "Checkout broken after applying coupon");
    assert.match(await reportPage.textContent("#preview"), /\*\*What happened:\*\* Spinner forever/);
  });

  await check("popup shows the recent report", async () => {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 340, height: 600 });
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popup.waitForSelector("#recent-list li button");
    assert.match(await popup.textContent("#recent-list"), /Checkout broken after applying coupon/);
    if (shotsDir) await popup.screenshot({ path: join(shotsDir, "3-popup.png") });
    await popup.close();
  });

  await check("options page saves settings and the page reacts", async () => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options/options.html`);
    await options.waitForFunction(() => document.querySelector("#autoDetect").checked === true);
    if (shotsDir) await options.screenshot({ path: join(shotsDir, "4-options.png"), fullPage: true });
    await options.click("label.switch:has(#autoDetect)");
    await options.waitForTimeout(800);
    const stored = await worker.evaluate(() => chrome.storage.sync.get("settings"));
    assert.equal(stored.settings.autoDetect, false);
    await options.close();

    await page.bringToFront();
    await page.waitForTimeout(300);
    await page.click("#fetch-404");
    await page.waitForTimeout(800);
    assert.equal(await toast.count(), 0, "toast shown although auto-detect is off");
  });
  // ------------------------------------------------------------- v1.1 features

  const reportStore = `chrome-extension://${extensionId}/lib/report-store.js`;
  const annotationsLib = `chrome-extension://${extensionId}/lib/annotations.js`;
  const readStored = (target, id) => target.evaluate(async ([url, reportId]) => {
    const { getReport } = await import(url);
    const { screenshot, ...rest } = await getReport(reportId);
    return { ...rest, hasBlob: Boolean(screenshot) };
  }, [reportStore, id]);

  let pickedPage = null;
  let pickedId = null;

  await check("element picker selects a covered button and diagnoses it", async () => {
    await page.bringToFront();
    const pickedPromise = context.waitForEvent("page");
    const tab = await findTab();
    const started = await worker.evaluate((tabId) => globalThis.BugDetector.startPicker(tabId), tab.id);
    assert.equal(started.ok, true, JSON.stringify(started));
    await page.locator("bug-detector-picker").waitFor({ state: "attached" });

    const box = await page.locator("#pay-now").boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.waitForTimeout(100);
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "5-picker.png") });
    await page.keyboard.press("ArrowDown"); // overlay → the button underneath
    await page.mouse.click(x, y);

    pickedPage = await pickedPromise;
    await pickedPage.waitForSelector("#layout:not([hidden])", { timeout: 10000 });
    await pickedPage.setViewportSize({ width: 1400, height: 1000 });
    pickedId = new URL(pickedPage.url()).searchParams.get("id");
    const text = await pickedPage.textContent("#preview");

    assert.match(text, /### Selected element\n\n`#pay-now` "Pay now"/);
    assert.match(text, /Covered by \[data-testid="ghost-overlay"\] \(z-index 10, opacity 0, invisible\)/);
    assert.match(text, /Marked "Pay now" \(button#pay-now\) as the broken element/);
    assert.match(text, /```html\n<button id="pay-now" type="button">Pay now<\/button>/);
    assert.equal(await page.locator("bug-detector-picker").count(), 0, "picker removed after picking");
    assert.doesNotMatch(await page.textContent("#log"), /Paid!/, "page click was swallowed");

    const stored = await readStored(pickedPage, pickedId);
    assert.equal(stored.annotations.length, 1, "auto box around the element");
    assert.equal(stored.annotations[0].type, "box");
  });

  await check("annotations: box, arrow and blur persist and the blur hides pixels", async () => {
    const p = pickedPage;
    await p.click("#annotate");
    await p.locator("#annotate-toolbar").waitFor({ state: "visible" });
    const canvas = await p.locator("#screenshot").boundingBox();
    const at = (fx, fy) => [canvas.x + canvas.width * fx, canvas.y + canvas.height * fy];
    async function drag(from, to) {
      await p.mouse.move(...from);
      await p.mouse.down();
      await p.mouse.move(...to, { steps: 5 });
      await p.mouse.up();
    }
    await p.click("#annotate-toolbar button:has-text('Box')");
    await drag(at(0.55, 0.3), at(0.8, 0.45));
    await p.click("#annotate-toolbar button:has-text('Arrow')");
    await drag(at(0.9, 0.7), at(0.7, 0.5));
    await p.click("#annotate-toolbar button:has-text('Blur')");
    await drag(at(0.15, 0.02), at(0.6, 0.09));
    if (shotsDir) await p.screenshot({ path: join(shotsDir, "6-annotate.png") });
    await p.click("#annotate");
    await p.waitForTimeout(500);

    await p.reload();
    await p.waitForSelector("#layout:not([hidden])");
    const stored = await readStored(p, pickedId);
    assert.deepEqual(stored.annotations.map((a) => a.type), ["box", "box", "arrow", "blur"]);

    const result = await p.evaluate(async ([storeUrl, libUrl, id]) => {
      const { getReport } = await import(storeUrl);
      const { renderComposite } = await import(libUrl);
      const { screenshot, annotations } = await getReport(id);
      const blur = annotations.find((a) => a.type === "blur");
      const read = async (blob) => {
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(Math.min(blur.x1, blur.x2), Math.min(blur.y1, blur.y2), 40, 12).data;
      };
      const original = await read(screenshot);
      const composite = await read(await renderComposite(screenshot, annotations));
      let differs = 0;
      for (let i = 0; i < original.length; i += 4) if (original[i] !== composite[i]) differs += 1;
      const uniformRow = composite[0] === composite[4] && composite[4] === composite[8];
      return { differs, uniformRow };
    }, [reportStore, annotationsLib, pickedId]);
    assert.ok(result.differs > 0, "blurred pixels changed");
    assert.ok(result.uniformRow, "blurred area is pixelated into blocks");
  });

  await check("AI triage: setup hint without a key", async () => {
    assert.equal(await pickedPage.isVisible("#triage-setup"), true);
    assert.equal(await pickedPage.isVisible("#triage-run"), false);
  });

  const apiCalls = [];
  let apiMode = "unauthorized";
  await context.route("https://api.anthropic.com/**", async (route) => {
    const request = route.request();
    apiCalls.push({ headers: request.headers(), body: request.postDataJSON() });
    const headers = { "content-type": "application/json", "access-control-allow-origin": "*", "request-id": "req_test" };
    if (apiMode === "unauthorized") {
      await route.fulfill({ status: 401, headers, body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) });
      return;
    }
    const triage = {
      title: "Pay now is unclickable: invisible overlay covers it",
      summary: "Clicks on Pay now hit a transparent overlay, and checkout also fails with a 500.",
      severity: "high",
      severity_reason: "Payment is a core flow and there is no workaround.",
      likely_root_cause: "A leftover .ghost-overlay (z-index 10, opacity 0) sits on top of #pay-now.",
      area: "frontend",
      evidence: ["Covered by [data-testid=\"ghost-overlay\"]", "POST /api/orders → 500"],
      suggested_fix: "Remove the overlay when the modal closes, or give it pointer-events: none.",
      next_steps: ["Click Pay now after the fix", "Check modal close handlers"]
    };
    await route.fulfill({
      status: 200,
      headers,
      body: JSON.stringify({
        id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5",
        content: [{ type: "text", text: JSON.stringify(triage) }],
        stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 }
      })
    });
  });

  await check("AI triage: rejected key shows a clear error", async () => {
    await worker.evaluate(() => chrome.storage.local.set({ anthropicApiKey: "sk-ant-test-key" }));
    await pickedPage.reload();
    await pickedPage.waitForSelector("#layout:not([hidden])");
    await pickedPage.click("#triage-run");
    await pickedPage.locator("#triage-error").waitFor({ state: "visible", timeout: 15000 });
    assert.match(await pickedPage.textContent("#triage-error"), /API key was rejected/);
  });

  await check("AI triage: structured request and rendered result", async () => {
    apiMode = "ok";
    apiCalls.length = 0;
    await pickedPage.click("#triage-run");
    await pickedPage.locator("#triage-result").waitFor({ state: "visible", timeout: 15000 });

    assert.equal(apiCalls.length, 1);
    const { headers, body } = apiCalls[0];
    assert.equal(headers["x-api-key"], "sk-ant-test-key");
    assert.match(headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
    assert.equal(body.model, "claude-opus-5-5");
    assert.equal(body.fallbacks, "default");
    assert.equal(body.output_config.format.type, "json_schema");
    assert.equal(body.messages[0].content[0].type, "image");
    assert.ok(body.messages[0].content[0].source.data.length > 1000);
    assert.match(body.messages[0].content[1].text, /Covered by/);
    assert.doesNotMatch(JSON.stringify(body), /secret-token-123|hunter2/);

    const result = await pickedPage.textContent("#triage-result");
    assert.match(result, /High severity/);
    assert.match(result, /leftover \.ghost-overlay/);
    await pickedPage.click("#triage-result button:has-text('Use this title')");
    assert.equal(await pickedPage.inputValue("#title"), "Pay now is unclickable: invisible overlay covers it");
    const text = await pickedPage.textContent("#preview");
    assert.match(text, /^## 🐞 Pay now is unclickable/);
    assert.match(text, /### AI triage \(Claude Opus 5\.5\)\n\n\*\*Severity:\*\* High/);
    if (shotsDir) await pickedPage.screenshot({ path: join(shotsDir, "7-triage.png"), fullPage: true });

    await pickedPage.reload();
    await pickedPage.waitForSelector("#triage-result:not([hidden])");
    assert.match(await pickedPage.textContent("#triage-meta"), /Claude Opus 5\.5/);
  });

  await check("AI triage: screenshot can be left out", async () => {
    apiCalls.length = 0;
    await pickedPage.uncheck("#triage-include-shot");
    await pickedPage.click("#triage-run");
    await pickedPage.waitForFunction(() => !document.querySelector("#triage-run").disabled);
    assert.equal(apiCalls.length, 1);
    assert.deepEqual(apiCalls[0].body.messages[0].content.map((c) => c.type), ["text"]);
    const stored = await worker.evaluate(() => chrome.storage.sync.get("settings"));
    assert.equal(stored.settings.aiIncludeScreenshot, false, "choice remembered");
  });

  await check("options page lists models and shows the saved key state", async () => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options/options.html`);
    await options.waitForFunction(() => document.querySelector("#aiModel").options.length === 2);
    assert.equal(await options.inputValue("#aiModel"), "claude-opus-5-5");
    assert.match(await options.textContent("#api-key-status"), /Key saved/);
    if (shotsDir) await options.screenshot({ path: join(shotsDir, "8-options-ai.png"), fullPage: true });
    await options.close();
  });

  // ------------------------------------------- nothing detected: ask before capturing

  /**
   * The toast lives in a closed shadow root, which Playwright can't see into;
   * the DevTools protocol can. Hands `fn` the toast's text and a click helper.
   */
  async function useToast(target, fn) {
    const cdp = await context.newCDPSession(target);
    try {
      const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
      const kids = (node) => [...(node.children || []), ...(node.shadowRoots || [])];
      const walk = (node, visit) => { visit(node); kids(node).forEach((kid) => walk(kid, visit)); };
      const text = (node) => (node.nodeType === 3 ? node.nodeValue : kids(node).map(text).join(""));
      const attrs = (node) => node.attributes || [];
      const hasClass = (node, name) => (attrs(node)[attrs(node).indexOf("class") + 1] || "").split(" ").includes(name);

      let host = null;
      walk(root, (node) => { if (node.localName === "bug-detector-ui") host = node; });
      assert.ok(host, "toast host not found");

      let title = "";
      let detail = "";
      const buttons = [];
      walk(host, (node) => {
        if (node.nodeType !== 1) return;
        if (hasClass(node, "title")) title = text(node);
        if (hasClass(node, "detail")) detail = text(node);
        if (node.localName === "button" && !attrs(node).includes("hidden")) buttons.push(node);
      });

      return await fn({
        title,
        detail,
        buttons: buttons.map(text),
        async click(label) {
          const button = buttons.find((node) => text(node) === label);
          assert.ok(button, `no "${label}" button in [${buttons.map(text)}]`);
          const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: button.backendNodeId });
          await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function () { this.click(); }" });
        }
      });
    } finally {
      await cdp.detach();
    }
  }

  const cleanUrl = `${base}?clean`;
  const cleanPage = await context.newPage();
  await cleanPage.goto(cleanUrl);
  const asking = cleanPage.locator("bug-detector-ui[data-open]");
  const cleanTab = () => worker.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url), cleanUrl);
  const captureClean = async () => {
    await cleanPage.bringToFront();
    return worker.evaluate((t) => globalThis.BugDetector.captureTab(t), await cleanTab());
  };

  const storePage = await context.newPage();
  await storePage.goto(`chrome-extension://${extensionId}/options/options.html`);
  const savedReports = () => storePage.evaluate(async (url) => (await import(url)).listReports(), reportStore);
  const reportsBefore = (await savedReports()).length;

  await check("nothing detected: capture asks first instead of saving a report", async () => {
    assert.deepEqual(await captureClean(), { ok: false, reason: "no-issues" });
    await asking.waitFor({ state: "attached" });
    await useToast(cleanPage, (toast) => {
      assert.equal(toast.title, "No issues detected");
      assert.match(toast.detail, /No errors or failed requests were found on this page\./);
      assert.match(toast.detail, /continue and describe it yourself/);
      assert.match(toast.detail, /only a screenshot and your environment details/);
      assert.deepEqual(toast.buttons, ["×", "Continue anyway", "Cancel"]);
    });
    if (shotsDir) {
      await cleanPage.waitForTimeout(300);
      await cleanPage.screenshot({ path: join(shotsDir, "9-no-issues.png") });
    }
    assert.equal((await savedReports()).length, reportsBefore, "nothing saved yet");
  });

  await check("nothing detected: a lone console warning is below the alert bar, so it still asks", async () => {
    await useToast(cleanPage, (toast) => toast.click("Cancel"));
    await asking.waitFor({ state: "detached" });
    await cleanPage.click("#console-warn");
    await cleanPage.waitForTimeout(200);
    assert.deepEqual(await captureClean(), { ok: false, reason: "no-issues" });
    await asking.waitFor({ state: "attached" });
  });

  await check("nothing detected: Cancel closes the question and still saves nothing", async () => {
    await useToast(cleanPage, (toast) => toast.click("Cancel"));
    await asking.waitFor({ state: "detached" });
    assert.equal((await savedReports()).length, reportsBefore);
  });

  await check("nothing detected: Continue anyway files a manual report with just the environment", async () => {
    assert.equal((await captureClean()).reason, "no-issues");
    await asking.waitFor({ state: "attached" });
    const opened = context.waitForEvent("page");
    await useToast(cleanPage, (toast) => toast.click("Continue anyway"));
    const manualPage = await opened;
    await manualPage.waitForSelector("#layout:not([hidden])", { timeout: 10000 });
    await manualPage.setViewportSize({ width: 1400, height: 1000 });

    const text = await manualPage.textContent("#preview");
    assert.match(text, /\*\*Issues detected:\*\* 0 \(nothing was found automatically/);
    assert.match(text, /### Environment\n\n- Browser: .+ on /);
    assert.doesNotMatch(text, /Failed requests|Console errors|Steps before the bug|None captured|Selected element/);
    assert.match(await manualPage.textContent("#summary"), /0\s*issues detected/);
    assert.deepEqual(await manualPage.locator("#section-toggles label:not([hidden])").allTextContents(), ["Description", "Environment"]);
    assert.equal(await manualPage.evaluate(() => document.activeElement?.id), "actual", "cursor is ready for the description");
    if (shotsDir) await manualPage.screenshot({ path: join(shotsDir, "10-manual-report.png"), fullPage: true });

    await manualPage.fill("#actual", "Save button does nothing");
    assert.match(await manualPage.textContent("#preview"), /\*\*What happened:\*\* Save button does nothing/);

    const [saved] = await savedReports();
    assert.equal(saved.manual, true);
    assert.deepEqual([saved.console.length, saved.network.length, saved.breadcrumbs.length], [0, 0, 0]);
    assert.equal(saved.hasScreenshot, true);
    await manualPage.close();
  });

  await check("nothing detected: a healthy picked element is mentioned and kept in the manual report", async () => {
    await cleanPage.bringToFront();
    const started = await worker.evaluate((tabId) => globalThis.BugDetector.startPicker(tabId), (await cleanTab()).id);
    assert.equal(started.ok, true);
    await cleanPage.locator("bug-detector-picker").waitFor({ state: "attached" });
    const box = await cleanPage.locator("#fetch-ok").boundingBox();
    await cleanPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await cleanPage.waitForTimeout(100);
    await cleanPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await asking.waitFor({ state: "attached" });
    await useToast(cleanPage, (toast) => {
      assert.match(toast.detail, /the element you selected \(<button> "GET \/api\/ok.*"\) is visible, enabled and not covered/);
      assert.match(toast.detail, /only a screenshot, the element and your environment details/);
    });

    const opened = context.waitForEvent("page");
    await useToast(cleanPage, (toast) => toast.click("Continue anyway"));
    const manualPage = await opened;
    await manualPage.waitForSelector("#layout:not([hidden])", { timeout: 10000 });
    const text = await manualPage.textContent("#preview");
    assert.match(text, /\*\*Issues detected:\*\* 0/);
    assert.match(text, /### Selected element\n\n`#fetch-ok`/);
    assert.match(text, /No obvious problems detected/);
    assert.doesNotMatch(text, /Failed requests|Console errors|Steps before the bug/);
    const [saved] = await savedReports();
    assert.equal(saved.annotations.length, 1, "the element is boxed in the screenshot");
    await manualPage.close();
  });

  await check("nothing detected but the picked element is broken: no question, normal report", async () => {
    await cleanPage.bringToFront();
    const started = await worker.evaluate((tabId) => globalThis.BugDetector.startPicker(tabId), (await cleanTab()).id);
    assert.equal(started.ok, true);
    await cleanPage.locator("bug-detector-picker").waitFor({ state: "attached" });
    const box = await cleanPage.locator("#pay-now").boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await cleanPage.mouse.move(x, y);
    await cleanPage.waitForTimeout(100);
    await cleanPage.keyboard.press("ArrowDown");
    const opened = context.waitForEvent("page");
    await cleanPage.mouse.click(x, y);

    const reportPage = await opened;
    await reportPage.waitForSelector("#layout:not([hidden])", { timeout: 10000 });
    const text = await reportPage.textContent("#preview");
    assert.match(text, /Covered by \[data-testid="ghost-overlay"\]/);
    assert.doesNotMatch(text, /Issues detected/);
    assert.match(text, /Steps before the bug/);
    assert.equal(await asking.count(), 0);
    await reportPage.close();
  });

  await check("nothing detected but the page can't show the question (older script): capture goes ahead", async () => {
    // Simulates a tab whose content script predates the question and never answers it.
    await worker.evaluate(() => {
      const original = chrome.tabs.sendMessage.bind(chrome.tabs);
      globalThis.__originalSendMessage = chrome.tabs.sendMessage;
      chrome.tabs.sendMessage = (tabId, message, ...rest) =>
        message?.type === "bd/no-issues" ? Promise.resolve(undefined) : original(tabId, message, ...rest);
    });
    try {
      const opened = context.waitForEvent("page");
      const result = await captureClean();
      assert.equal(result.ok, true, JSON.stringify(result));
      const reportPage = await opened;
      await reportPage.waitForSelector("#layout:not([hidden])", { timeout: 10000 });
      await reportPage.close();
    } finally {
      await worker.evaluate(() => { chrome.tabs.sendMessage = globalThis.__originalSendMessage; });
    }
    await useToast(cleanPage, (toast) => toast.click("Cancel")).catch(() => {});
  });

  await check("site switched off: capture still asks, says so honestly, and the report says 'not checked'", async () => {
    const setBlocked = (blocked) => worker.evaluate(async ([host, on]) => {
      const { settings } = await chrome.storage.sync.get("settings");
      await chrome.storage.sync.set({ settings: { ...settings, blocklist: on ? [host] : [] } });
    }, [new URL(cleanUrl).hostname, blocked]);

    await setBlocked(true);
    try {
      await cleanPage.waitForTimeout(500); // the page picks up the new setting
      assert.deepEqual(await captureClean(), { ok: false, reason: "no-issues" });
      await asking.waitFor({ state: "attached" });
      await useToast(cleanPage, (toast) => {
        assert.equal(toast.title, "BugDetector is off on this site");
        assert.match(toast.detail, /isn't checking this site for errors or failed requests, so it can't tell whether anything is wrong/);
        assert.match(toast.detail, /only a screenshot and your environment details/);
        assert.deepEqual(toast.buttons, ["×", "Continue anyway", "Cancel"]);
      });
      if (shotsDir) {
        await cleanPage.waitForTimeout(300);
        await cleanPage.screenshot({ path: join(shotsDir, "11-site-off.png") });
      }

      const opened = context.waitForEvent("page");
      await useToast(cleanPage, (toast) => toast.click("Continue anyway"));
      const reportPage = await opened;
      await reportPage.waitForSelector("#layout:not([hidden])", { timeout: 10000 });
      const text = await reportPage.textContent("#preview");
      assert.match(text, /\*\*Issues detected:\*\* not checked \(BugDetector is turned off on this site\)/);
      assert.doesNotMatch(text, /Issues detected:\*\* 0|Failed requests|Console errors|Steps before the bug|disabled on this site/);
      assert.match(text, /### Environment/);
      assert.match(await reportPage.textContent("#summary"), /Not checked/);
      await reportPage.close();
    } finally {
      await setBlocked(false);
      await cleanPage.waitForTimeout(300);
    }
  });

  await check("an error that happens while the question is open makes it a normal report", async () => {
    assert.equal((await captureClean()).reason, "no-issues");
    await asking.waitFor({ state: "attached" });
    await cleanPage.click("#throw-error");
    await cleanPage.waitForTimeout(200);

    const opened = context.waitForEvent("page");
    await useToast(cleanPage, (toast) => toast.click("Continue anyway"));
    const reportPage = await opened;
    await reportPage.waitForSelector("#layout:not([hidden])", { timeout: 10000 });
    const text = await reportPage.textContent("#preview");
    assert.match(text, /TypeError: Cannot read properties of undefined \(reading 'total'\)/);
    assert.doesNotMatch(text, /Issues detected/);
    await reportPage.close();
  });
} finally {
  await context.close();
  server.close();
  await rm(userDataDir, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll e2e checks passed");
