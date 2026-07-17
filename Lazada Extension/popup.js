document.addEventListener("DOMContentLoaded", async () => {

    const els = {
        enabled: document.getElementById("enabled"),
        testMode: document.getElementById("testMode"),
        autoRetry: document.getElementById("autoRetry"),
        autoClose: document.getElementById("autoClose"),
        keywords: document.getElementById("keywords"),
        channels: document.getElementById("channels"),
        retryDelay: document.getElementById("retryDelay"),
        productWatch: document.getElementById("productWatch"),
        webhook: document.getElementById("logWebhook"),
        alertWebhook: document.getElementById("alertWebhook"),
        cooldown: document.getElementById("cooldown"),
        autoCloseAfter: document.getElementById("autoCloseAfter"),
        watchEnabled: document.getElementById("watchEnabled"),
        watchUrls: document.getElementById("watchUrls"),
        watchHeartbeat: document.getElementById("watchHeartbeat"),
        shopWatchEnabled: document.getElementById("shopWatchEnabled"),
        shopUrls: document.getElementById("shopUrls"),
        shopKeywords: document.getElementById("shopKeywords"),
        shopExcludeKeywords: document.getElementById("shopExcludeKeywords"),
        shopMaxPrice: document.getElementById("shopMaxPrice"),
        shopRefresh: document.getElementById("shopRefresh"),
        shopMaxOpen: document.getElementById("shopMaxOpen"),
        shopOnlyNew: document.getElementById("shopOnlyNew"),
        rearmShopBtn: document.getElementById("rearmShopBtn"),
        saveBtn: document.getElementById("saveBtn"),
        status: document.getElementById("status"),
        runTestBtn: document.getElementById("runTestBtn"),
        dashboardBtn: document.getElementById("dashboardBtn"),
    };

    // Keep the query string — the bare shop URL renders a curated view that
    // leaves new-release items out of the grid entirely.
    const DEFAULT_SHOP = "https://www.lazada.sg/shop/pokemon-store-online-singapore/?spm=a2o42.pdp_revamp.seller.1.2fb15eb1lXbKbw&itemId=13664788472&channelSource=pdp";

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
        els.productWatch.value = (s.productWatchMs ? s.productWatchMs / 1000 : 8);

        els.webhook.value = s.logWebhook ?? "";
        els.alertWebhook.value = s.alertWebhook ?? "";

        els.cooldown.value = s.globalCooldownMs ?? 3000;
        els.autoCloseAfter.value = (s.autoCloseAfterMs ? s.autoCloseAfterMs / 1000 : 10);

        els.watchEnabled.checked = s.watchEnabled ?? false;
        els.watchUrls.value = (s.watchUrls || []).join("\n");
        els.watchHeartbeat.value = s.watchHeartbeatSec ?? 45;

        els.shopWatchEnabled.checked = s.shopWatchEnabled ?? false;
        els.shopUrls.value = (s.shopUrls || [DEFAULT_SHOP]).join("\n");
        els.shopKeywords.value = (s.shopKeywords || []).join("\n");
        els.shopExcludeKeywords.value = (s.shopExcludeKeywords || []).join("\n");
        els.shopMaxPrice.value = s.shopMaxPrice ?? 0;
        els.shopRefresh.value = (s.shopRefreshMs ? s.shopRefreshMs / 1000 : 4);
        els.shopMaxOpen.value = s.shopMaxOpen ?? 3;
        els.shopOnlyNew.checked = s.shopOnlyNew ?? true;
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
            productWatchMs: Math.max(2, parseInt(els.productWatch.value) || 8) * 1000,
            logWebhook: els.webhook.value.trim(),
            alertWebhook: els.alertWebhook.value.trim(),
            globalCooldownMs: parseInt(els.cooldown.value) || 0,
            autoCloseAfterMs: Math.max(1, parseInt(els.autoCloseAfter.value) || 10) * 1000,
            watchEnabled: els.watchEnabled.checked,
            watchUrls: els.watchUrls.value.split("\n").map(x => x.trim()).filter(Boolean),
            watchHeartbeatSec: Math.max(1, parseInt(els.watchHeartbeat.value) || 45),

            shopWatchEnabled: els.shopWatchEnabled.checked,
            shopUrls: els.shopUrls.value.split("\n").map(x => x.trim()).filter(Boolean),
            shopKeywords: els.shopKeywords.value.split("\n").map(x => x.trim()).filter(Boolean),
            shopExcludeKeywords: els.shopExcludeKeywords.value.split("\n").map(x => x.trim()).filter(Boolean),
            shopMaxPrice: Math.max(0, parseFloat(els.shopMaxPrice.value) || 0),
            // Floored at 1.5s — faster just trades a better shot at the drop for a
            // much better shot at a captcha that stops the whole run.
            shopRefreshMs: Math.max(1.5, parseFloat(els.shopRefresh.value) || 4) * 1000,
            shopMaxOpen: Math.max(1, parseInt(els.shopMaxOpen.value) || 3),
            shopOnlyNew: els.shopOnlyNew.checked
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

    els.rearmShopBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "reset_shop_memory" }, () => {
            els.status.textContent = "🎯 Re-armed — baseline resets on next shop refresh.";
            els.status.style.color = "#3ba55d";
            setTimeout(() => els.status.textContent = "", 2500);
        });
    });

    els.dashboardBtn.addEventListener("click", () => {
        chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    });
});
