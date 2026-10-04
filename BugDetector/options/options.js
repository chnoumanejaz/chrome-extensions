import { getSettings, updateSettings, resetSettings, onSettingsChanged } from "../lib/settings.js";
import { listReports, clearReports } from "../lib/report-store.js";
import { $, debounce, getCaptureShortcut, openShortcutSettings } from "../ui/ui.js";

const saveState = $("#save-state");
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

onSettingsChanged(render);
getCaptureShortcut().then((shortcut) => { $("#shortcut").textContent = shortcut || "Not set"; });
render(await getSettings());
renderReportCount();
