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

// Only Lazada PRODUCT pages should ever trigger the bot. Restock embeds also
// contain my.lazada.sg (account) and filebroker-cdn.lazada.sg (image) links —
// matching those made the bot open the wrong page and cooldown-block the real
// product link.
function isLazadaProductUrl(url) {
  try {
    const u = new URL(url, window.location.href);
    const host = u.hostname.toLowerCase();
    // must be a real lazada storefront host, not the CDN or account subdomain
    if (!/\blazada\.sg$/i.test(host)) return false;
    if (host.startsWith("my.") || host.includes("filebroker") || host.includes("cdn")) {
      return false;
    }
    // product pages live under /products/...-....html  (e.g. i123-s456.html or pdp-i123-s456.html)
    return /\/products\//i.test(u.pathname) && /\.html?$/i.test(u.pathname);
  } catch (_) {
    return false;
  }
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

  // Grab only real product links (skip account / CDN / image links).
  const allLinks = node.querySelectorAll('a[href*="lazada.sg"]');
  const productLinks = [...allLinks].filter(a => isLazadaProductUrl(a.href));
  if (!productLinks.length) return;

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

  productLinks.forEach(a => {
    const href = a.href; // resolved absolute URL
    if (!href || seenLinks.has(href)) return;
    seenLinks.add(href);

    log("Detected Lazada PRODUCT link:", href);

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
