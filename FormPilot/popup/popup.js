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

  openOptionsBtn.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  openTestBtn.addEventListener("click", () => {
    const testUrl = chrome.runtime.getURL("test/sample-forms.html");
    chrome.tabs.create({ url: testUrl });
  });
});
