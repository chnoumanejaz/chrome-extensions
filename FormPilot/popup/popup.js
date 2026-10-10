async function getActiveSiteHost() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;

  try {
    const url = new URL(tab.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return FormPilotSiteRules.normalizeHost(url.hostname);
  } catch {
    return null;
  }
}

function describeSiteStatus(mode, status) {
  if (mode === "selected") {
    return status.enabled
      ? `Shown because ${status.rule} is on your selected sites.`
      : "Hidden: this site isn't on your selected sites.";
  }
  return status.enabled
    ? "Shown on every site except the ones you hide."
    : `Hidden because ${status.rule} is on your hidden sites.`;
}

function describeFormlessStatus(rules, host) {
  if (rules.formlessMode === "paused") {
    return { checked: false, disabled: true, hint: "Paused in settings. Resume it there to use this." };
  }
  if (!FormPilotSiteRules.evaluate(host, rules).enabled) {
    return { checked: false, disabled: true, hint: "Turn on FormPilot for this site first." };
  }

  const status = FormPilotSiteRules.evaluateFormless(host, rules);
  return status.enabled
    ? { checked: true, disabled: false, hint: "Also looking for forms without a <form> tag here." }
    : { checked: false, disabled: false, hint: "Off here. Only forms with a <form> tag are detected." };
}

async function setupToggles() {
  const siteHostEl = document.getElementById("site-host");
  const siteToggle = document.getElementById("site-toggle");
  const siteHintEl = document.getElementById("site-hint");
  const formlessHostEl = document.getElementById("formless-host");
  const formlessToggle = document.getElementById("formless-toggle");
  const formlessHintEl = document.getElementById("formless-hint");

  const host = await getActiveSiteHost();
  if (!host) {
    siteHostEl.textContent = "Not available on this page";
    formlessHostEl.textContent = "Not available on this page";
    return;
  }

  siteHostEl.textContent = host;
  formlessHostEl.textContent = host;

  const render = async () => {
    const rules = await FormPilotSiteRules.get();

    const siteStatus = FormPilotSiteRules.evaluate(host, rules);
    siteToggle.checked = siteStatus.enabled;
    siteHintEl.textContent = describeSiteStatus(rules.mode, siteStatus);

    const formless = describeFormlessStatus(rules, host);
    formlessToggle.checked = formless.checked;
    formlessToggle.disabled = formless.disabled;
    formlessHintEl.textContent = formless.hint;
  };

  const onToggle = (toggle, save) => async () => {
    siteToggle.disabled = true;
    formlessToggle.disabled = true;
    try {
      await save(toggle.checked);
    } catch (error) {
      console.error("FormPilot site toggle error:", error);
    }
    await render();
    siteToggle.disabled = false;
  };

  siteToggle.addEventListener("change", onToggle(siteToggle, (on) => FormPilotSiteRules.setSiteEnabled(host, on)));
  formlessToggle.addEventListener(
    "change",
    onToggle(formlessToggle, (on) => FormPilotSiteRules.setFormlessSiteEnabled(host, on))
  );

  await render();
  siteToggle.disabled = false;
  setTimeout(() => document.body.classList.add("popup-ready"), 50);
}

document.addEventListener("DOMContentLoaded", async () => {
  const formCountEl = document.getElementById("form-count");
  const presetCountEl = document.getElementById("preset-count");
  const openOptionsBtn = document.getElementById("open-options");
  const openTestBtn = document.getElementById("open-test");

  try {
    const stats = await FormPilotStorage.getStats();
    formCountEl.textContent = String(stats.formCount);
    presetCountEl.textContent = String(stats.presetCount);
  } catch (error) {
    formCountEl.textContent = "-";
    presetCountEl.textContent = "-";
    console.error("FormPilot popup stats error:", error);
  }

  try {
    await setupToggles();
  } catch (error) {
    document.getElementById("site-host").textContent = "Unavailable";
    document.getElementById("formless-host").textContent = "Unavailable";
    console.error("FormPilot popup site rules error:", error);
  }

  openOptionsBtn.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  openTestBtn.addEventListener("click", () => {
    const testUrl = chrome.runtime.getURL("test/sample-forms.html");
    chrome.tabs.create({ url: testUrl });
  });
});
