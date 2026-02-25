document.addEventListener("DOMContentLoaded", async () => {

    const els = {
        enabled: document.getElementById("enabled"),
        testMode: document.getElementById("testMode"),
        autoClose: document.getElementById("autoClose"),
        keywords: document.getElementById("keywords"),
        channels: document.getElementById("channels"),
        retryDelay: document.getElementById("retryDelay"),
        webhook: document.getElementById("logWebhook"),
        alertWebhook: document.getElementById("alertWebhook"),
        cooldown: document.getElementById("cooldown"),
        autoCloseAfter: document.getElementById("autoCloseAfter"),
        saveBtn: document.getElementById("saveBtn"),
        status: document.getElementById("status"),
        runTestBtn: document.getElementById("runTestBtn"),

    };

    const KEY = "lazadaBotSettings";

    chrome.storage.sync.get(KEY, (saved) => {
        const s = saved[KEY] || {};

        els.enabled.checked = s.enabled ?? false;
        els.testMode.checked = s.testMode ?? false;
        els.autoClose.checked = s.autoClose ?? false;

        els.keywords.value = (s.keywords || []).join("\n");
        els.channels.value = (s.channels || []).join("\n");

        // Convert ms to seconds for the UI, default to 5s
        els.retryDelay.value = (s.retryDelayMs ? s.retryDelayMs / 1000 : 5);

        els.webhook.value = s.logWebhook ?? "";
        els.alertWebhook.value = s.alertWebhook ?? "";

        els.cooldown.value = s.globalCooldownMs ?? 3000;
        els.autoCloseAfter.value = s.autoCloseAfterMs ?? 10000;
    });

    els.saveBtn.addEventListener("click", () => {
        const settings = {
            enabled: els.enabled.checked,
            testMode: els.testMode.checked,
            autoClose: els.autoClose.checked,
            keywords: els.keywords.value.split("\n").map(x => x.trim()).filter(Boolean),
            channels: els.channels.value.split("\n").map(x => x.trim()).filter(Boolean),
            retryDelayMs: parseInt(els.retryDelay.value) * 1000,
            logWebhook: els.webhook.value.trim(),
            globalCooldownMs: parseInt(els.cooldown.value),
            autoCloseAfterMs: parseInt(els.autoCloseAfter.value)
        };

        chrome.storage.sync.set({ [KEY]: settings }, () => {
            // Trigger a single Discord ping when settings are updated
            chrome.runtime.sendMessage({ type: "log", message: `⚙️ Settings updated and saved! Exact Auto-retry delay set to: ${settings.retryDelayMs / 1000}s.` });
            
            els.status.textContent = "Saved!";
            els.status.style.color = "green";
            setTimeout(() => els.status.textContent = "", 1500);
        });
    });

    els.runTestBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "trigger_test" });
    });
});