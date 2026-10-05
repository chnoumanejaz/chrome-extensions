import { getSettings, updateSettings, resetSettings, onSettingsChanged, getApiKey, setApiKey } from "../lib/settings.js";
import { AI_MODELS, testApiKey } from "../lib/ai-triage.js";
import { listReports, clearReports } from "../lib/report-store.js";
import { $, debounce, getShortcut, openShortcutSettings } from "../ui/ui.js";

const saveState = $("#save-state");

// Options are generated from the schema so the list can't drift.
for (const model of AI_MODELS) {
  $("#aiModel").append(new Option(`${model.name} (${model.hint})`, model.id));
}

const fields = [...document.querySelectorAll("[data-setting]")];

function readField(el) {
  if (el.type === "checkbox") return el.checked;
  if (el.type === "number") return el.value;
  if (el.hasAttribute("data-list")) return el.value.split("\n");
  return el.value;
}

function writeField(el, value) {
  if (el.type === "checkbox") el.checked = value;
  else if (el.type === "radio") el.checked = el.value === value;
  else if (el.hasAttribute("data-list")) el.value = value.join("\n");
  else el.value = value;
}

function render(settings) {
  for (const el of fields) {
    // Don't overwrite what the user is typing.
    if (el === document.activeElement && el.type !== "checkbox" && el.type !== "radio") continue;
    writeField(el, settings[el.dataset.setting]);
  }
  $("#allowlist-field").classList.toggle("dimmed", settings.siteMode !== "allowlist");
  $("#blocklist-field").classList.toggle("dimmed", settings.siteMode !== "all");
  $("#sensitivity").disabled = !settings.autoDetect;
}

function flash(text) {
  saveState.textContent = text;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => { saveState.textContent = ""; }, 1500);
}

const pending = {};
const save = debounce(async () => {
  const patch = { ...pending };
  for (const key of Object.keys(pending)) delete pending[key];
  const next = await updateSettings(patch);
  render(next);
  flash("Saved");
}, 350);

for (const el of fields) {
  const event = el.tagName === "TEXTAREA" || el.type === "number" ? "input" : "change";
  el.addEventListener(event, () => {
    if (el.type === "radio" && !el.checked) return;
    pending[el.dataset.setting] = readField(el);
    save();
  });
  // Normalise the displayed value (trimmed lists, clamped numbers) after editing.
  el.addEventListener("blur", async () => {
    if (Object.keys(pending).length) save.flush();
    else render(await getSettings());
  });
}

$("#change-shortcut").addEventListener("click", openShortcutSettings);

$("#reset").addEventListener("click", async () => {
  if (!confirm("Reset all BugDetector settings to their defaults?")) return;
  render(await resetSettings());
  flash("Defaults restored");
});

async function renderReportCount() {
  const reports = await listReports(1000).catch(() => []);
  $("#report-count").textContent = reports.length
    ? `${reports.length} saved ${reports.length === 1 ? "report" : "reports"}, stored only in this browser.`
    : "No saved reports. Reports are stored only in this browser.";
  $("#clear-reports").disabled = !reports.length;
}

$("#clear-reports").addEventListener("click", async () => {
  if (!confirm("Delete all saved bug reports and screenshots?")) return;
  await clearReports();
  renderReportCount();
  flash("Reports deleted");
});

// ----------------------------------------------------------- API key

const apiKeyInput = $("#api-key");
const apiKeyStatus = $("#api-key-status");

function keyStatus(text, tone = "") {
  apiKeyStatus.textContent = text;
  apiKeyStatus.className = `small ${tone}`;
}

async function renderApiKey() {
  const key = await getApiKey();
  apiKeyInput.value = key;
  $("#api-key-remove").disabled = !key;
  $("#api-key-test").disabled = !key;
  keyStatus(key ? "Key saved." : "No key saved.");
}

$("#api-key-toggle").addEventListener("click", (event) => {
  const show = apiKeyInput.type === "password";
  apiKeyInput.type = show ? "text" : "password";
  event.currentTarget.textContent = show ? "Hide" : "Show";
  event.currentTarget.setAttribute("aria-pressed", String(show));
});

$("#api-key-save").addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (key && !key.startsWith("sk-ant-")) {
    keyStatus("That doesn't look like a Claude API key (they start with sk-ant-).", "bad");
    return;
  }
  await setApiKey(key);
  await renderApiKey();
  if (key) keyStatus("Key saved.", "ok");
});

$("#api-key-remove").addEventListener("click", async () => {
  await setApiKey("");
  await renderApiKey();
});

$("#api-key-test").addEventListener("click", async () => {
  const key = await getApiKey();
  if (!key) return;
  keyStatus("Testing…");
  const { createClaudeClient, describeClaudeError } = await import("../lib/claude-client.js");
  try {
    const { aiModel } = await getSettings();
    const servedBy = await testApiKey(createClaudeClient(key), aiModel);
    keyStatus(`Key works (${servedBy}).`, "ok");
  } catch (error) {
    keyStatus(describeClaudeError(error), "bad");
  }
});

renderApiKey();
onSettingsChanged(render);
getShortcut("capture-bug").then((shortcut) => { $("#shortcut").textContent = shortcut || "Not set"; });
getShortcut("pick-element").then((shortcut) => { $("#pick-shortcut").textContent = shortcut || "Not set"; });
render(await getSettings());
renderReportCount();
