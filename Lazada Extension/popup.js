document.addEventListener("DOMContentLoaded", async () => {

    const els = {
        enabled: document.getElementById("enabled"),
        testMode: document.getElementById("testMode"),
        autoRetry: document.getElementById("autoRetry"),
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
        els.autoRetry.checked = s.autoRetry ?? true;
        els.autoClose.checked = s.autoClose ?? false;

        els.keywords.value = (s.keywords || []).join("\n");
        els.channels.value = (s.channels || []).join("\n");

        // Convert ms to seconds for the UI, default to 3s
        els.retryDelay.value = (s.retryDelayMs ? s.retryDelayMs / 1000 : 3);

        els.webhook.value = s.logWebhook ?? "";
        els.alertWebhook.value = s.alertWebhook ?? "";

        els.cooldown.value = s.globalCooldownMs ?? 3000;
        els.autoCloseAfter.value = (s.autoCloseAfterMs ? s.autoCloseAfterMs / 1000 : 10);
    });

    els.saveBtn.addEventListener("click", () => {
        const settings = {
            enabled: els.enabled.checked,
            testMode: els.testMode.checked,
            autoRetry: els.autoRetry.checked,
            autoClose: els.autoClose.checked,
            keywords: els.keywords.value.split("\n").map(x => x.trim()).filter(Boolean),
            channels: els.channels.value.split("\n").map(x => x.trim()).filter(Boolean),
            retryDelayMs: Math.max(1, parseInt(els.retryDelay.value) || 3) * 1000,
            logWebhook: els.webhook.value.trim(),
            alertWebhook: els.alertWebhook.value.trim(),
            globalCooldownMs: parseInt(els.cooldown.value) || 0,
            autoCloseAfterMs: Math.max(1, parseInt(els.autoCloseAfter.value) || 10) * 1000
        };

        chrome.storage.sync.set({ [KEY]: settings }, () => {
            // Trigger a single Discord ping when settings are updated
            chrome.runtime.sendMessage({
                type: "log",
                message: `⚙️ Settings saved! Auto-retry: ${settings.autoRetry ? "on" : "off"}, delay ${settings.retryDelayMs / 1000}s.`
            });

            els.status.textContent = "✓ Saved!";
            els.status.style.color = "#3ba55d";
            setTimeout(() => els.status.textContent = "", 1500);
        });
    });

    els.runTestBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "trigger_test" });
    });
});
