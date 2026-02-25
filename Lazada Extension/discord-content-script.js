const SETTINGS_KEY = "lazadaBotSettings";

let settings = null;
let seenLinks = new Set();

function log(...args) {
  console.log("[LazadaBot Discord CS]", ...args);
}

async function loadSettings() {
  const saved = await chrome.storage.sync.get(SETTINGS_KEY);
  settings = { ...(saved[SETTINGS_KEY] || {}) };
}

function getChannelIdFromUrl() {
  // URL format: https://discord.com/channels/<guild>/<channel>
  try {
    const parts = window.location.pathname.split("/").filter(Boolean);
    if (parts.length >= 3 && parts[0] === "channels") {
      return parts[2]; // channel id
    }
  } catch (_) {}
  return null;
}

function getKeywords() {
  if (!settings || !Array.isArray(settings.keywords)) return [];
  return settings.keywords.map(k => k.toLowerCase());
}

function messageMatchesKeywords(text) {
  const kws = getKeywords();
  if (kws.length === 0) return true; // no filter
  const lower = text.toLowerCase();
  return kws.some(k => lower.includes(k));
}

function extractTitle(node, linkEl) {
  // 1) If the link has visible text, use that
  const linkText = (linkEl?.textContent || "").trim();
  if (linkText && !/^https?:\/\//i.test(linkText)) return linkText;

  // 2) Discord embeds often have headings / titles
  const h3 = (node.querySelector("h3")?.innerText || "").trim();
  if (h3) return h3;

  // 3) Fallback: first non-empty line of the message
  const msg = (node.innerText || "").split("\n").map(s => s.trim()).filter(Boolean);
  if (msg.length) return msg[0];

  return "";
}

function handleNode(node) {
  if (!(node instanceof HTMLElement)) return;

  const links = node.querySelectorAll('a[href*="lazada.sg"]');
  if (!links.length) return;

  const channelId = getChannelIdFromUrl();
  const messageText = node.innerText || "";

  // NEW: If no settings yet, ignore until settings loaded
if (!settings) return;

// NEW: If channels list is not empty, must match
if (settings.channels && settings.channels.length > 0) {
  if (!settings.channels.includes(channelId)) {
     return; // wrong channel → ignore
  }
}

  if (!messageMatchesKeywords(messageText)) {
    return;
  }

  links.forEach(a => {
    const href = a.getAttribute("href");
    if (!href || seenLinks.has(href)) return;
    seenLinks.add(href);

    log("Detected Lazada link:", href);

    chrome.runtime.sendMessage({
      type: "restock_link",
      url: href,
      keyword: null, // optional; using full text instead
      channelId,
      title: extractTitle(node, a),
      content: messageText
    });
  });
}

function setupObserver() {
  const root = document.body;
  const observer = new MutationObserver(muts => {
    for (const mut of muts) {
      mut.addedNodes.forEach(handleNode);
    }
  });
  observer.observe(root, { childList: true, subtree: true });

  // Also scan existing messages once
  document.querySelectorAll("div").forEach(handleNode);

  log("MutationObserver attached");
}

(async function init() {
  await loadSettings();
  log("Discord content script initialized");
  setupObserver();
})();
