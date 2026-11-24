// Forwards alerts from the Discord tab to the local server, and keeps the
// Discord tab alive: no discarding, and a reload if it stops responding.

const SERVERS = ["http://127.0.0.1", "http://127.0.0.1:8080"];
const RELOAD_IF_SILENT_MS = 3 * 60 * 1000;
const RELOAD_COOLDOWN_MS = 5 * 60 * 1000;

async function post(path, body) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function request(path, init) {
  const { serverBase } = await chrome.storage.local.get("serverBase");
  const order = serverBase ? [serverBase, ...SERVERS.filter(s => s !== serverBase)] : SERVERS;
  for (const base of order) {
    try {
      const r = await fetch(base + path, init);
      if (r.ok || r.status === 400) {
        if (base !== serverBase) chrome.storage.local.set({ serverBase: base });
        return r.json().catch(() => ({}));
      }
    } catch (_) {
      // server not on this port, try the next
    }
  }
  console.warn("[Restock Relay] Server not reachable. Is start.bat running?");
  return null;
}

const DEFAULT_TEST_URL = "https://www.lazada.sg/products/pdp-i14029408090-s125116592243.html?spm=a2o42.10453684.0.0.31a45edfJFVQkK&search=store";

function isLazadaProductUrl(href) {
  try {
    const u = new URL(href);
    const host = u.hostname.toLowerCase();
    if (!/(^|\.)lazada\.sg$/.test(host)) return false;
    if (host.startsWith("my.") || host.includes("filebroker") || host.includes("cdn")) return false;
    return /\/products\//i.test(u.pathname);
  } catch (_) {
    return false;
  }
}

// Same path the iPad's own test uses: the iPad goes green and BUY NOW opens this link.
function sendTest(url, name) {
  return post("/test", { url, name });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // From the popup
  if (msg.type === "send_test") {
    sendTest(msg.url, msg.name).then(r => sendResponse(r));
    return true;
  }
  if (msg.type === "status") {
    request("/status", { method: "GET" }).then(r => sendResponse(r));
    return true;
  }
  if (!sender.tab) return;
  if (msg.type === "alert") {
    post("/alert", msg.alert).then(r => console.log("[Restock Relay] alert sent", r));
  } else if (msg.type === "ping") {
    chrome.storage.session.set({ [`ping_${sender.tab.id}`]: Date.now() });
    if (msg.onChannel) post("/relay-ping", { title: msg.title });
    // Never let Chrome's Memory Saver throw the Discord tab away.
    if (sender.tab.autoDiscardable !== false) chrome.tabs.update(sender.tab.id, { autoDiscardable: false }).catch(() => {});
  }
});

// Content scripts in already-open tabs die when the extension is (re)loaded.
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: "https://discord.com/*" });
  for (const t of tabs) {
    chrome.scripting?.executeScript?.({ target: { tabId: t.id }, files: ["content.js"] }).catch(() => {});
  }
}

// Watchdog: a Discord tab that stopped pinging (crashed, frozen, logged out
// of the websocket) gets reloaded so the relay keeps running unattended.
async function watchdog() {
  const tabs = await chrome.tabs.query({ url: "https://discord.com/channels/*" });
  const store = await chrome.storage.session.get(null);
  const now = Date.now();
  for (const t of tabs) {
    const last = store[`ping_${t.id}`] || 0;
    const lastReload = store[`reload_${t.id}`] || 0;
    if (t.discarded || (now - last > RELOAD_IF_SILENT_MS && now - lastReload > RELOAD_COOLDOWN_MS)) {
      console.warn("[Restock Relay] Discord tab silent, reloading", t.id);
      await chrome.storage.session.set({ [`reload_${t.id}`]: now, [`ping_${t.id}`]: now });
      chrome.tabs.reload(t.id).catch(() => {});
    }
  }
}

// Right-click a Lazada product page or link -> "Send to iPad screen".
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "send-to-ipad") return;
  const url = [info.linkUrl, info.pageUrl].find(u => u && isLazadaProductUrl(u));
  if (!url) return;
  const name = info.linkUrl ? (info.selectionText || "") : (tab?.title || "").replace(/\s*\|\s*Lazada.*$/i, "");
  sendTest(url, name).then(r => {
    chrome.action.setBadgeBackgroundColor({ color: r && r.ok ? "#16a34a" : "#dc2626" });
    chrome.action.setBadgeText({ text: r && r.ok ? "sent" : "err" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3000);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "send-to-ipad",
      title: "Send to iPad screen",
      contexts: ["page", "link"],
      documentUrlPatterns: ["https://*.lazada.sg/*", "https://discord.com/*"],
      targetUrlPatterns: ["https://*.lazada.sg/products/*"],
    });
  });
  chrome.alarms.create("watchdog", { periodInMinutes: 1 });
  injectIntoOpenTabs();
});
chrome.runtime.onStartup.addListener(() => chrome.alarms.create("watchdog", { periodInMinutes: 1 }));
chrome.alarms.onAlarm.addListener(a => { if (a.name === "watchdog") watchdog(); });
