// === SETTINGS ===
const SETTINGS_KEY = "lazadaBotSettings";

const defaultSettings = {
  enabled: true,
  // lowercased keywords; if empty, all Lazada links are accepted
  keywords: [],
  // global cooldown between opening tabs from Discord (ms)
  globalCooldownMs: 3000,          // ~3s (medium anti-bot)
  // lazada auto-retry when out of stock
  autoRetry: true,
  retryDelayMs: 5000,
  // auto-close checkout tab after placing order
  autoClose: true,
  autoCloseAfterMs: 10000,          // 10s after click Place Order
  logWebhook: "",
  alertWebhook: ""
};

let lastTabOpenTs = 0;

// Helpers
async function getSettings() {
  const saved = await chrome.storage.sync.get(SETTINGS_KEY);
  return { ...defaultSettings, ...(saved[SETTINGS_KEY] || {}) };
}

async function saveSettings(settings) {
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
}

function log(...args) {
  console.log("[LazadaBot BG]", ...args);
}

async function sendLog(message) {
  const settings = await getSettings();

  const isHerePing = typeof message === "string" && message.includes("@here");

  // If it's an @here message and alertWebhook exists, send there.
  // Otherwise, send to main logWebhook.
  const webhookUrl = (isHerePing && settings.alertWebhook)
    ? settings.alertWebhook
    : settings.logWebhook;

  if (!webhookUrl) return;

  fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message })
  }).catch(err => console.warn("Webhook error:", err));
}

// === MESSAGE HANDLER ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "get_settings") {
    getSettings().then(settings => sendResponse({ settings }));
    return true; // async
  }

  if (msg.type === "log") {
  sendLog(msg.message);
  return false;
  }

  if (msg.type === "trigger_test") {
  runTestMode();
  sendResponse({ ok: true });
  return true;
  } 

  if (msg.type === "save_settings") {
    saveSettings(msg.settings).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "restock_link") {
    // From discord-content-script
    handleRestockLink(msg, sender);
    // no response needed
  }

  if (msg.type === "request_close_tab_after") {
    // From lazada-content-script, sender.tab.id is available
    if (sender.tab && sender.tab.id != null) {
      const delay = typeof msg.delayMs === "number" ? msg.delayMs : defaultSettings.autoCloseAfterMs;
      setTimeout(() => {
        chrome.tabs.remove(sender.tab.id).catch?.(() => {});
      }, delay);
    }
  }

  return false;
});

  async function runTestMode() {
    const settings = await getSettings();

    // Dummy Lazada item (safe testing, no risk)
    const testUrl = "www.lazada.sg/products/pdp-i3541051724-s23362206779.html?c=&channelLpJumpArgs=&clickTrackInfo=query%253A%253Bnid%253A3541051724%253Bsrc%253AlazadaInShopSrp%253Brn%253Ac9ec75709d580e2d383427254abeba88%253Bregion%253Asg%253Bsku%253A3541051724_SGAMZ%253Bprice%253A18%253Bclient%253Adesktop%253Bsupplier_id%253A1628720011%253Bbiz_source%253Astore_sections%253Bslot%253A17%253Butlog_bucket_id%253A470687%253Basc_category_id%253A9341%253Bitem_id%253A3541051724%253Bsku_id%253A23362206779%253Bshop_id%253A2056827%253BtemplateInfo%253A-1_A3_C%2523107878_E%2523&freeshipping=1&fs_ab=2&fuse_fs=&lang=en&location=Singapore&price=18&priceCompare=skuId%3A23362206779%3Bsource%3Alazada-search-voucher-in-shop%3Bsn%3Ac9ec75709d580e2d383427254abeba88%3BoriginPrice%3A1800%3BdisplayPrice%3A1800%3BsinglePromotionId%3A-1%3BsingleToolCode%3A-1%3BvoucherPricePlugin%3A0%3Btimestamp%3A1771922123312&ratingscore=&request_id=c9ec75709d580e2d383427254abeba88&review=&sale=3&search=1&spm=a2o42.store_product.list.17&stock=1";

    chrome.tabs.create({ url: testUrl, active: true }, tab => {
      if (chrome.runtime.lastError) {
        console.error("[TestMode] Error opening tab:", chrome.runtime.lastError.message);
      } else {
        console.log("[TestMode] Test Mode – Opened:", testUrl);
      }
    });
  }

  setInterval(() => {
    sendLog("🟢 LazadaBot: Standing by… waiting for restocks.");
  }, 30000);

// === RESTOCK HANDLER ===
async function handleRestockLink(msg, sender) {
  const { url, keyword, channelId } = msg;
  const now = Date.now();
  const settings = await getSettings();

  if (settings.channels && settings.channels.length > 0) {
  if (!settings.channels.includes(String(channelId))) {
    log(`Ignoring link (channelId ${channelId} is not allowed)`);
    return;
  }
}

  if (!settings.enabled) {
    log("Ignoring restock (bot disabled)", url);
    return;
  }

  if (!url || !url.includes("lazada.sg")) {
    log("Ignoring non-Lazada URL", url);
    return;
  }

  const displayTitle = (msg.title || "").trim();  
  await sendLog(`📩 Detected restock: ${displayTitle || url}`);

  // keyword filter
  const kws = (settings.keywords || []).map(k => k.trim()).filter(Boolean);
  if (kws.length > 0) {
    const combinedText = `${msg.title || ""} ${msg.content || ""}`.toLowerCase();
    const match = kws.some(k => combinedText.includes(k.toLowerCase()));
    if (!match) {
      log("Ignoring link (no keyword match)", url);
      return;
    }
  }

  // global cooldown
  const diff = now - lastTabOpenTs;
  if (diff < settings.globalCooldownMs) {
    log(`Skipping tab open due to cooldown (${diff}ms < ${settings.globalCooldownMs}ms)`);
    return;
  }

  lastTabOpenTs = now;

  log("Opening Lazada URL from Discord:", { url, keyword, channelId });
  await sendLog(`🟦 Opening Lazada product page for checkout.`);
  chrome.tabs.create({ url, active: true }, tab => {
  if (chrome.runtime.lastError) {
    console.error("[LazadaBot BG] tab.create error:", chrome.runtime.lastError.message);
  } else {
    log("Created tab", tab.id, "for URL", url);

    // ⭐ NEW — Wait for the tab to fully load then activate Lazada automation
    chrome.tabs.onUpdated.addListener(function listener(tabId, changeInfo) {
      if (tabId === tab.id && changeInfo.status === "complete") {

        chrome.tabs.sendMessage(tabId, {
          type: "activate_lazada"
        });

        log("[LazadaBot BG] Sent activate_lazada to content script");

        chrome.tabs.onUpdated.removeListener(listener);
      }
    });
  }
});

}
