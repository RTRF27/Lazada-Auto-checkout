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

  // How long a product page watches the live DOM before reloading for fresh
  // stock, and how often it checks within that window. A pre-drop listing shows
  // "Add to Wishlist" and only flips to Buy Now on a fresh load, so this window
  // + retryDelayMs IS the worst-case detection lag when an item goes live.
  productWatchMs: 8000,
  pollIntervalMs: 200,
  // auto-close checkout tab after placing order
  autoClose: true,
  autoCloseAfterMs: 10000,          // 10s after click Place Order
  logWebhook: "",
  alertWebhook: "",

  // --- Direct Lazada watch (no Discord needed) ---
  // Poll the Lazada product pages themselves instead of waiting for a Discord
  // monitor bot to post a link. Each watched URL is kept open in a background
  // tab; the content script's runProductFlow() watches ~20s then auto-reloads,
  // and fires Buy Now the instant stock appears.
  watchEnabled: false,
  watchUrls: [],                    // product page URLs to watch directly
  watchHeartbeatSec: 45,            // how often to re-open any watch tab that closed

  // --- Shop drop watch ---
  // For timed drops: instead of watching a product URL you already know, keep a
  // shop LISTING page reloading and pounce on new cards whose name matches your
  // keywords. The listing shows the item seconds before its URL is public.
  shopWatchEnabled: false,
  // NOTE: the bare /shop/pokemon-store-online-singapore URL renders a curated
  // 25-item "shop home" view that omits new-release items entirely. The query
  // string is what makes it render the full catalog — keep it.
  shopUrls: [
    "https://www.lazada.sg/shop/pokemon-store-online-singapore/?spm=a2o42.pdp_revamp.seller.1.2fb15eb1lXbKbw&itemId=13664788472&channelSource=pdp"
  ],
  shopKeywords: [],                 // any line matches = go (all words in a line must appear)
  shopExcludeKeywords: [],          // any line matches = never
  shopMaxPrice: 0,                  // 0 = no cap
  shopRefreshMs: 4000,              // shop listing reload interval
  shopOnlyNew: true,                // ignore listings present when the watch was armed
  shopMaxOpen: 3                    // safety cap on product tabs opened per drop
};

let lastTabOpenTs = 0;

// url -> tabId for the direct-watch tabs we own, so the heartbeat can tell which
// are alive and reopen only the ones that closed.
const watchTabs = new Map();
const shopTabs = new Map();
const WATCH_ALARM = "laz-direct-watch";

// Which drop items we've already opened a tab for. Persisted (not in-memory)
// because the service worker is evicted between events and would otherwise
// forget mid-drop and re-open the same item on the next shop reload.
const SHOP_OPENED_KEY = "lazShopOpened";
const SHOP_SEEN_KEY = "lazShopSeen";

// === AUTO RE-INJECT CONTENT SCRIPTS ON RELOAD ===
// When the extension is reloaded/updated, content scripts already running in
// open tabs become orphaned (their chrome.* calls fail). Without this, the bot
// silently stops detecting restocks until you manually refresh each Discord/
// Lazada tab. This re-injects fresh content scripts into matching open tabs.
async function reinjectContentScripts() {
  try {
    const manifest = chrome.runtime.getManifest();
    for (const cs of manifest.content_scripts || []) {
      if (!cs.js || !cs.matches) continue;
      let tabs = [];
      try {
        tabs = await chrome.tabs.query({ url: cs.matches });
      } catch (_) {
        continue;
      }
      for (const tab of tabs) {
        if (!tab.id) continue;
        if (tab.url && /^(chrome|edge|about|chrome-extension):/i.test(tab.url)) continue;
        chrome.scripting
          .executeScript({ target: { tabId: tab.id }, files: cs.js })
          .then(() => console.log("[LazadaBot BG] Re-injected into tab", tab.id, tab.url))
          .catch((e) => console.warn("[LazadaBot BG] Re-inject failed for tab", tab.id, e?.message));
      }
    }
  } catch (e) {
    console.warn("[LazadaBot BG] reinjectContentScripts error:", e);
  }
}

chrome.runtime.onInstalled.addListener(reinjectContentScripts);

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

// Force a window to the foreground so a freshly-opened restock/checkout tab is
// never stuck minimized or behind other windows. Restores minimized windows but
// preserves a maximized window (only normalizes when it was minimized).
function bringWindowToFront(windowId) {
  if (windowId == null) return;
  chrome.windows.get(windowId, (win) => {
    if (chrome.runtime.lastError || !win) return;
    const update = { focused: true, drawAttention: true };
    if (win.state === "minimized") update.state = "normal";
    chrome.windows.update(windowId, update, () => {
      if (chrome.runtime.lastError) {
        console.warn("[LazadaBot BG] bringWindowToFront error:", chrome.runtime.lastError.message);
      }
    });
  });
}

// Only open Lazada PRODUCT pages — never account (my.lazada.sg) or CDN/image URLs.
function isLazadaProductUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (!/\blazada\.sg$/i.test(host)) return false;
    if (host.startsWith("my.") || host.includes("filebroker") || host.includes("cdn")) {
      return false;
    }
    return /\/products\//i.test(u.pathname) && /\.html?$/i.test(u.pathname);
  } catch (_) {
    return false;
  }
}

// Shop LISTING page, e.g. https://www.lazada.sg/shop/pokemon-store-online-singapore
function isLazadaShopUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (!/\blazada\.sg$/i.test(host)) return false;
    if (host.startsWith("my.") || host.includes("filebroker") || host.includes("cdn")) {
      return false;
    }
    return /^\/shop\//i.test(u.pathname);
  } catch (_) {
    return false;
  }
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

// === DIRECT LAZADA WATCH ===
// Keeps a background tab open on each watched product URL. The Lazada content
// script auto-runs runProductFlow() on load, which watches for stock and
// auto-reloads on its own — so once a watch tab is open it is self-sustaining.
// The heartbeat only has to reopen a watch tab if it was closed or navigated
// away (e.g. after a completed/auto-closed order).
async function ensureWatchTabs() {
  const settings = await getSettings();

  if (!settings.enabled || !settings.watchEnabled) {
    return;
  }

  const urls = (settings.watchUrls || [])
    .map((u) => (u || "").trim())
    .filter(Boolean)
    .filter(isLazadaProductUrl);

  if (!urls.length) return;

  // Prune map entries whose tab no longer exists so we reopen them below.
  for (const [url, tabId] of [...watchTabs.entries()]) {
    const stillOpen = await tabExists(tabId);
    if (!stillOpen) watchTabs.delete(url);
  }

  for (const url of urls) {
    if (watchTabs.has(url)) continue; // already watching

    // Open in the background (active:false) so a watch tab never steals focus
    // while merely polling. The content script raises the tab itself when it
    // clicks Buy Now or hits a captcha.
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        console.warn("[LazadaBot BG] watch tab open failed:", chrome.runtime.lastError?.message);
        return;
      }
      watchTabs.set(url, tab.id);
      log("Opened direct-watch tab", tab.id, "for", url);
    });
  }
}

function tabExists(tabId) {
  return new Promise((resolve) => {
    if (tabId == null) return resolve(false);
    chrome.tabs.get(tabId, () => resolve(!chrome.runtime.lastError));
  });
}

// === SHOP DROP WATCH ===
// Keeps one background tab per watched shop listing. The content script reloads
// that tab itself and reports matching new cards back via "shop_hit"; this side
// only has to keep the tab alive and decide what to open.
async function ensureShopTabs() {
  const settings = await getSettings();

  if (!settings.enabled || !settings.shopWatchEnabled) return;

  const urls = (settings.shopUrls || [])
    .map((u) => (u || "").trim())
    .filter(Boolean)
    .filter(isLazadaShopUrl);

  if (!urls.length) return;

  for (const [url, tabId] of [...shopTabs.entries()]) {
    const stillOpen = await tabExists(tabId);
    if (!stillOpen) shopTabs.delete(url);
  }

  for (const url of urls) {
    if (shopTabs.has(url)) continue;

    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        console.warn("[LazadaBot BG] shop tab open failed:", chrome.runtime.lastError?.message);
        return;
      }
      shopTabs.set(url, tab.id);
      log("Opened shop-watch tab", tab.id, "for", url);
    });
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [url, id] of shopTabs.entries()) {
    if (id === tabId) {
      shopTabs.delete(url);
      log("Shop watch tab closed, will reopen on next heartbeat:", url);
    }
  }
});

// Clears the "what was already listed" baseline and the opened-item memory, so
// the next shop page load re-snapshots and the watch is live again. Runs when
// the watch is switched on or the shop list changes.
async function resetShopMemory() {
  await chrome.storage.local.remove([SHOP_OPENED_KEY, SHOP_SEEN_KEY]);
  log("Shop watch memory reset — baseline will be re-captured on next load.");
}

// Serialise hit handling: the content script can report several matches in the
// same tick, and concurrent read-modify-write of the opened map would let them
// all pass the cap check against the same stale snapshot.
let shopHitChain = Promise.resolve();

function handleShopHit(msg) {
  shopHitChain = shopHitChain.then(() => processShopHit(msg)).catch((e) => {
    console.warn("[LazadaBot BG] shop hit error:", e);
  });
  return shopHitChain;
}

async function processShopHit(msg) {
  const settings = await getSettings();

  if (!settings.enabled || !settings.shopWatchEnabled) return;

  if (!isLazadaProductUrl(msg.url)) {
    log("Ignoring shop hit (not a product URL)", msg.url);
    return;
  }

  const store = await chrome.storage.local.get(SHOP_OPENED_KEY);
  const opened = store[SHOP_OPENED_KEY] || {};

  if (opened[msg.id]) return; // already went for this one

  const cap = Math.max(1, settings.shopMaxOpen || 3);
  if (Object.keys(opened).length >= cap) {
    log(`Shop hit ignored — already opened ${Object.keys(opened).length} tabs (cap ${cap})`);
    return;
  }

  opened[msg.id] = { ts: Date.now(), url: msg.url, title: msg.title || "" };
  await chrome.storage.local.set({ [SHOP_OPENED_KEY]: opened });

  lastTabOpenTs = Date.now();

  const label = msg.title || shortLabelFromUrl(msg.url);
  log("Opening drop item from shop watch:", { id: msg.id, url: msg.url });
  await sendLog(`@here 🎯 DROP MATCH — opening ${label}${msg.price != null ? ` ($${msg.price})` : ""}`);
  recordEvent({
    kind: "buy_now",
    message: `🎯 Drop match — opening ${label}`,
    url: msg.url,
  });

  chrome.tabs.create({ url: msg.url, active: true }, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      console.error("[LazadaBot BG] drop tab create error:", chrome.runtime.lastError?.message);
      return;
    }
    bringWindowToFront(tab.windowId);
    log("Created drop tab", tab.id, "for", msg.url);
  });
}

// When a watch tab is closed (e.g. auto-closed after an order), forget it so the
// heartbeat can decide whether to reopen a fresh watcher for that URL.
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [url, id] of watchTabs.entries()) {
    if (id === tabId) {
      watchTabs.delete(url);
      log("Watch tab closed, will reopen on next heartbeat:", url);
    }
  }
});

// Heartbeat: chrome.alarms survives service-worker suspension, unlike setInterval.
async function setupWatchAlarm() {
  const settings = await getSettings();
  const mins = Math.max(0.5, (settings.watchHeartbeatSec || 45) / 60);
  chrome.alarms.create(WATCH_ALARM, { periodInMinutes: mins });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCH_ALARM) {
    ensureWatchTabs();
    ensureShopTabs();
  }
});

// The popup saves settings straight to storage.sync, so react to any change to
// our settings key — this is what makes toggling the watchlist take effect
// immediately (opening/refreshing watch tabs) no matter who wrote the settings.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes[SETTINGS_KEY]) return;

  const oldV = changes[SETTINGS_KEY].oldValue || {};
  const newV = changes[SETTINGS_KEY].newValue || {};

  // Switching the shop watch on (or pointing it at a different shop) is the
  // "arm it now" moment: forget the old baseline so the listing as it stands
  // right now becomes the before-picture, and everything after it is the drop.
  const armed = !oldV.shopWatchEnabled && newV.shopWatchEnabled;
  const shopsChanged =
    JSON.stringify(oldV.shopUrls || []) !== JSON.stringify(newV.shopUrls || []);

  const ready = armed || shopsChanged ? resetShopMemory() : Promise.resolve();

  ready.then(() => {
    setupWatchAlarm();
    ensureWatchTabs();
    ensureShopTabs();
  });
});

chrome.runtime.onStartup.addListener(() => {
  setupWatchAlarm();
  ensureWatchTabs();
  ensureShopTabs();
});
chrome.runtime.onInstalled.addListener(() => {
  setupWatchAlarm();
  ensureWatchTabs();
  ensureShopTabs();
});

// === DASHBOARD STATS ===
// Structured, persisted telemetry for the live dashboard. Kept in
// chrome.storage.local (bigger quota than sync, and device-local). Writes are
// serialised through a promise chain so rapid messages don't clobber each other.
const STATS_KEY = "lazadaBotStats";
const MAX_EVENTS = 120;
const MAX_CHECKOUTS = 300;

function emptyStats() {
  return { checkouts: [], events: [], tasks: {}, updatedAt: Date.now() };
}

async function readStats() {
  const s = await chrome.storage.local.get(STATS_KEY);
  return { ...emptyStats(), ...(s[STATS_KEY] || {}) };
}

let statsChain = Promise.resolve();
function withStats(mutator) {
  statsChain = statsChain
    .then(async () => {
      const stats = await readStats();
      mutator(stats);
      stats.updatedAt = Date.now();
      await chrome.storage.local.set({ [STATS_KEY]: stats });
    })
    .catch((e) => console.warn("[LazadaBot BG] stats write error:", e));
  return statsChain;
}

function shortLabelFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/i(\d+)(?:-s(\d+))?/i);
    if (m) return `Item ${m[1]}`;
    return u.hostname.replace(/^www\./, "");
  } catch (_) {
    return "Lazada item";
  }
}

function recordStatus(tabId, msg) {
  if (tabId == null) return;
  withStats((stats) => {
    const prev = stats.tasks[tabId] || {};
    stats.tasks[tabId] = {
      tabId,
      site: "Lazada SG",
      url: msg.url || prev.url || "",
      title: (msg.title && msg.title.trim()) || prev.title || shortLabelFromUrl(msg.url || prev.url || ""),
      state: msg.state || prev.state || "idle",
      updatedAt: Date.now(),
    };
  });
}

function recordEvent(ev) {
  withStats((stats) => {
    stats.events.unshift({
      kind: ev.kind || "info",
      message: ev.message || "",
      url: ev.url || "",
      ts: ev.ts || Date.now(),
    });
    stats.events = stats.events.slice(0, MAX_EVENTS);
  });
}

function recordWin(win) {
  withStats((stats) => {
    stats.checkouts.unshift({
      title: (win.title || "").trim() || shortLabelFromUrl(win.url || ""),
      orderId: win.orderId || "",
      amount: typeof win.amount === "number" ? win.amount : null,
      url: win.url || "",
      ts: win.ts || Date.now(),
    });
    stats.checkouts = stats.checkouts.slice(0, MAX_CHECKOUTS);
    stats.events.unshift({
      kind: "win",
      message: `✅ CHECKOUT — ${(win.title || win.orderId || "order").toString().slice(0, 80)}`,
      url: win.url || "",
      ts: win.ts || Date.now(),
    });
    stats.events = stats.events.slice(0, MAX_EVENTS);
  });
}

// Drop a task row when its tab closes so the dashboard reflects only live tabs.
chrome.tabs.onRemoved.addListener((tabId) => {
  withStats((stats) => {
    if (stats.tasks[tabId]) delete stats.tasks[tabId];
  });
});

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

  if (msg.type === "captcha_alert") {
    handleCaptchaAlert(sender);
    return false;
  }

  if (msg.type === "trigger_test") {
  runTestMode();
  sendResponse({ ok: true });
  return true;
  } 

  if (msg.type === "save_settings") {
    saveSettings(msg.settings).then(() => {
      // Apply watchlist changes immediately instead of waiting a heartbeat.
      // (storage.onChanged also fires and handles shop arming/reset.)
      setupWatchAlarm();
      ensureWatchTabs();
      ensureShopTabs();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "shop_hit") {
    handleShopHit(msg);
    return false;
  }

  if (msg.type === "reset_shop_memory") {
    resetShopMemory().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "laz_status") {
    recordStatus(sender.tab?.id, msg);
    return false;
  }

  if (msg.type === "laz_event") {
    recordEvent(msg);
    return false;
  }

  if (msg.type === "checkout_win") {
    recordWin(msg);
    return false;
  }

  if (msg.type === "request_focus") {
    // A background watch tab found stock / reached checkout — bring it forward.
    if (sender.tab && sender.tab.id != null) {
      chrome.tabs.update(sender.tab.id, { active: true });
      bringWindowToFront(sender.tab.windowId);
    }
    return false;
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
    const testUrl = "https://www.lazada.sg/products/pdp-i13733405534-s124676139765.html?c=&channelLpJumpArgs=&clickTrackInfo=query%253Apokemon%252Bcenter%253Bnid%253A13733405534%253Bsrc%253ALazadaMainSrp%253Brn%253A8bdeb2544ca919aff0fb6d5a9fdacef0%253Bregion%253Asg%253Bsku%253A13733405534_SGAMZ%253Bprice%253A20%253Bclient%253Adesktop%253Bsupplier_id%253A1628720011%253Bsession_id%253A%253Bbiz_source%253Ah5_hp%253Bslot%253A5%253Butlog_bucket_id%253A470687%253Basc_category_id%253A9341%253Bitem_id%253A13733405534%253Bsku_id%253A124676139765%253Bshop_id%253A2056827%253BtemplateInfo%253A-1_A3_C%2523107878_E%2523&freeshipping=1&fs_ab=2&fuse_fs=&lang=en&location=Singapore&price=2E%201&priceCompare=skuId%3A124676139765%3Bsource%3Alazada-search-voucher%3Bsn%3A8bdeb2544ca919aff0fb6d5a9fdacef0%3BoriginPrice%3A2000%3BdisplayPrice%3A2000%3BisGray%3Afalse%3BsinglePromotionId%3A-1%3BsingleToolCode%3A-1%3BvoucherPricePlugin%3A0%3Btimestamp%3A1782893738780&qSellingPoint=p--center___b--pokemon&ratingscore=&request_id=8bdeb2544ca919aff0fb6d5a9fdacef0&review=&sale=4&search=1&source=search&spm=a2o42.searchlist.list.5&stock=1";

    chrome.tabs.create({ url: testUrl, active: true }, tab => {
      if (chrome.runtime.lastError) {
        console.error("[TestMode] Error opening tab:", chrome.runtime.lastError.message);
      } else {
        console.log("[TestMode] Test Mode – Opened:", testUrl);
        bringWindowToFront(tab.windowId);
      }
    });
  }

  setInterval(() => {
    sendLog("🟢 LazadaBot: Standing by… waiting for restocks.");
  }, 30000);

// === CAPTCHA ALERT ===
// We never auto-solve the slider (that would defeat Lazada's anti-bot control).
// We just make sure the human notices instantly: raise the tab/window and pop a
// desktop notification.
function handleCaptchaAlert(sender) {
  try {
    if (sender.tab && sender.tab.id != null) {
      chrome.tabs.update(sender.tab.id, { active: true });
      bringWindowToFront(sender.tab.windowId);
    }
  } catch (e) {
    console.warn("[LazadaBot BG] tab focus error:", e);
  }

  try {
    chrome.notifications.create("lazbot-captcha-" + Date.now(), {
      type: "basic",
      iconUrl: "icon128.png",
      title: "🧩 Lazada CAPTCHA — action needed",
      message: "Solve the slider puzzle now to continue checkout.",
      priority: 2,
      requireInteraction: true
    });
  } catch (e) {
    console.warn("[LazadaBot BG] notification error:", e);
  }
}

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

  if (!isLazadaProductUrl(url)) {
    log("Ignoring non-product Lazada URL", url);
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

    // Make sure the new tab is visible: focus + un-minimize its window.
    bringWindowToFront(tab.windowId);

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
