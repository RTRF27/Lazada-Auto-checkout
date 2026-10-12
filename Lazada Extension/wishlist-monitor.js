// Wishlist monitor — background side (loaded into background.js via importScripts).
//
// On a slow timer it reloads your Lazada SG wishlist in a background tab, diffs the
// scraped snapshot against the last one and alerts you (desktop notification +
// Discord webhook) on: price drop, back in stock, new item. It is alert-only — no
// auto-buy — and it backs off for good when Lazada shows a captcha instead of
// trying to get around it.

const WISHLIST_ALARM = "laz-wishlist-monitor";
const WISHLIST_SNAPSHOT_KEY = "lazWishlistSnapshot";
const WISHLIST_STATE_KEY = "lazWishlistState"; // { tabId, paused }
const WISHLIST_MIN_INTERVAL_MIN = 1;

async function wishlistState() {
  const s = await chrome.storage.local.get(WISHLIST_STATE_KEY);
  return s[WISHLIST_STATE_KEY] || {};
}

async function setWishlistState(patch) {
  const next = { ...(await wishlistState()), ...patch };
  await chrome.storage.local.set({ [WISHLIST_STATE_KEY]: next });
  return next;
}

async function setupWishlistAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(WISHLIST_ALARM);
  if (!settings.enabled || !settings.wishlistEnabled) return;
  const mins = Math.max(WISHLIST_MIN_INTERVAL_MIN, settings.wishlistIntervalMin || 5);
  chrome.alarms.create(WISHLIST_ALARM, { delayInMinutes: 0.1, periodInMinutes: mins });
}

async function pollWishlist() {
  const settings = await getSettings();
  if (!settings.enabled || !settings.wishlistEnabled) return;
  const state = await wishlistState();
  if (state.paused) return; // blocked earlier; waits for the user

  const url = (settings.wishlistUrl || "").trim();
  if (!url) return;

  // Reuse our tab if it's still open (reload → content script re-scrapes),
  // otherwise open a fresh background one.
  if (state.tabId != null) {
    try {
      await chrome.tabs.get(state.tabId);
      await chrome.tabs.reload(state.tabId);
      return;
    } catch (_) { /* tab was closed */ }
  }
  const tab = await chrome.tabs.create({ url, active: false });
  await setWishlistState({ tabId: tab.id });
}

function fmtPrice(p) {
  return p == null ? "?" : `$${p.toFixed(2)}`;
}

function diffWishlist(prev, items, settings) {
  const events = [];
  const minDrop = Math.max(0, settings.wishlistMinDropPct || 0);
  for (const it of items) {
    const old = prev[it.id];
    if (!old) {
      events.push({ kind: "new", item: it, text: `🆕 Added to wishlist: ${it.title} (${fmtPrice(it.price)})` });
      continue;
    }
    if (settings.wishlistNotifyStock !== false && !old.inStock && it.inStock) {
      events.push({ kind: "restock", item: it, text: `🟢 Back in stock: ${it.title} (${fmtPrice(it.price)})` });
    }
    if (settings.wishlistNotifyDrop !== false && old.price != null && it.price != null && it.price < old.price) {
      const pct = ((old.price - it.price) / old.price) * 100;
      if (pct >= minDrop) {
        events.push({
          kind: "drop", item: it,
          text: `💸 Price drop (-${pct.toFixed(0)}%): ${it.title} ${fmtPrice(old.price)} → ${fmtPrice(it.price)}`,
        });
      }
    }
  }
  return events;
}

async function handleWishlistSnapshot(msg, sender) {
  const settings = await getSettings();
  if (!settings.wishlistEnabled || !Array.isArray(msg.items)) return;

  const stored = await chrome.storage.local.get(WISHLIST_SNAPSHOT_KEY);
  const prev = stored[WISHLIST_SNAPSHOT_KEY];
  const next = {};
  for (const it of msg.items) next[it.id] = it;
  await chrome.storage.local.set({ [WISHLIST_SNAPSHOT_KEY]: next });

  // A scrape that finds nothing is more likely a layout/loading problem than an
  // emptied wishlist — keep the old baseline rather than alerting on it.
  if (!msg.items.length) {
    if (prev) await chrome.storage.local.set({ [WISHLIST_SNAPSHOT_KEY]: prev });
    recordEvent({ kind: "info", message: "Wishlist scrape found 0 items (page not loaded or layout changed)", url: msg.url });
    return;
  }

  if (!prev) {
    recordEvent({ kind: "info", message: `Wishlist baseline saved (${msg.items.length} items)`, url: msg.url });
    await sendLog(`📋 Wishlist monitor armed — tracking ${msg.items.length} items.`);
    return;
  }

  for (const ev of diffWishlist(prev, msg.items, settings)) {
    recordEvent({ kind: "info", message: ev.text, url: ev.item.url });
    await sendLog(`${ev.kind === "restock" ? "@here " : ""}${ev.text}\n${ev.item.url}`);
    try {
      chrome.notifications.create(`lazbot-wl-${ev.item.id}-${Date.now()}`, {
        type: "basic",
        iconUrl: "icon128.png",
        title: "Lazada wishlist",
        message: ev.text.slice(0, 200),
        priority: 1,
      });
    } catch (e) {
      console.warn("[LazadaBot BG] wishlist notification error:", e);
    }
  }

  if (settings.wishlistCloseTab !== false && sender.tab && sender.tab.id != null) {
    chrome.tabs.remove(sender.tab.id).catch(() => {});
    await setWishlistState({ tabId: null });
  }
}

// Lazada served a captcha / punish page. Don't retry and don't try to clear it:
// stop polling and tell the user, who can solve it by hand in that tab and then
// press "Resume" (or re-save settings).
async function handleWishlistBlocked(msg, sender) {
  await setWishlistState({ paused: true });
  recordEvent({ kind: "captcha", message: "Wishlist monitor paused — Lazada showed a captcha", url: msg.url });
  await sendLog("@here 🧩 Wishlist monitor paused: Lazada showed a captcha. Solve it by hand, then resume the monitor.");
  try {
    if (sender.tab && sender.tab.id != null) {
      chrome.tabs.update(sender.tab.id, { active: true });
      bringWindowToFront(sender.tab.windowId);
    }
    chrome.notifications.create("lazbot-wl-blocked-" + Date.now(), {
      type: "basic",
      iconUrl: "icon128.png",
      title: "🧩 Wishlist monitor paused",
      message: "Lazada showed a captcha. Solve it, then resume the monitor from the popup.",
      priority: 2,
      requireInteraction: true,
    });
  } catch (e) {
    console.warn("[LazadaBot BG] wishlist blocked notify error:", e);
  }
}

async function resumeWishlistMonitor() {
  await setWishlistState({ paused: false, tabId: null });
  await setupWishlistAlarm();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WISHLIST_ALARM) pollWishlist();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const st = await wishlistState();
  if (st.tabId === tabId) await setWishlistState({ tabId: null });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "wishlist_snapshot") handleWishlistSnapshot(msg, sender);
  else if (msg.type === "wishlist_blocked") handleWishlistBlocked(msg, sender);
  else if (msg.type === "wishlist_resume") resumeWishlistMonitor();
  else if (msg.type === "wishlist_reset") chrome.storage.local.remove(WISHLIST_SNAPSHOT_KEY);
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes[SETTINGS_KEY]) return;
  const o = changes[SETTINGS_KEY].oldValue || {};
  const n = changes[SETTINGS_KEY].newValue || {};
  if (o.wishlistEnabled !== n.wishlistEnabled || o.wishlistIntervalMin !== n.wishlistIntervalMin ||
      o.enabled !== n.enabled || o.wishlistUrl !== n.wishlistUrl) {
    setupWishlistAlarm();
  }
});

chrome.runtime.onStartup.addListener(setupWishlistAlarm);
chrome.runtime.onInstalled.addListener(setupWishlistAlarm);
