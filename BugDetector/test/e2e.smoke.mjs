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
    const width = await reportPage.evaluate(() => document.querySelector("#screenshot").naturalWidth);
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
