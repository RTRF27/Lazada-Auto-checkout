// Forwards alerts from the Discord tab to the local server, and keeps the
// Discord tab alive: no discarding, and a reload if it stops responding.

const SERVERS = ["http://127.0.0.1", "http://127.0.0.1:8080"];
const RELOAD_IF_SILENT_MS = 3 * 60 * 1000;
const RELOAD_COOLDOWN_MS = 5 * 60 * 1000;

async function post(path, body) {
  const { serverBase } = await chrome.storage.local.get("serverBase");
  const order = serverBase ? [serverBase, ...SERVERS.filter(s => s !== serverBase)] : SERVERS;
  for (const base of order) {
    try {
      const r = await fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
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

chrome.runtime.onMessage.addListener((msg, sender) => {
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("watchdog", { periodInMinutes: 1 });
  injectIntoOpenTabs();
});
chrome.runtime.onStartup.addListener(() => chrome.alarms.create("watchdog", { periodInMinutes: 1 }));
chrome.alarms.onAlarm.addListener(a => { if (a.name === "watchdog") watchdog(); });
