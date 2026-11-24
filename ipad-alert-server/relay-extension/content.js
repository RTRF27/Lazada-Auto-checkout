// Runs inside the Discord tab. Reads new messages in the open channel and
// forwards Lazada SG stock alerts to background.js -> local server -> iPad.
(() => {
  if (window.__restockRelayLoaded) return;
  window.__restockRelayLoaded = true;

  const MAX_AGE_MS = 10 * 60 * 1000; // ignore history loaded by scrolling up
  const seen = new Set();
  let ready = false;

  const log = (...a) => console.log("[Restock Relay]", ...a);

  function isLazadaProductUrl(href) {
    try {
      const u = new URL(href, location.href);
      const host = u.hostname.toLowerCase();
      if (!/(^|\.)lazada\.sg$/.test(host)) return false;
      if (host.startsWith("my.") || host.includes("filebroker") || host.includes("cdn")) return false;
      return /\/products\//i.test(u.pathname);
    } catch (_) {
      return false;
    }
  }

  const text = el => (el ? (el.innerText || el.textContent || "").trim() : "");

  function readEmbed(root) {
    const links = [...root.querySelectorAll("a[href]")].filter(a => isLazadaProductUrl(a.href));
    if (!links.length) return null;

    const fields = {};
    root.querySelectorAll('[class*="embedField_"], [class*="embedField-"]').forEach(f => {
      const k = text(f.querySelector('[class*="embedFieldName"]')).toLowerCase();
      const v = text(f.querySelector('[class*="embedFieldValue"]'));
      if (k) fields[k] = v;
    });

    const title = text(root.querySelector('[class*="embedTitle"]'));
    const linkText = text(links[0]);
    let name = fields.product || fields.name || fields.item || "";
    if (!name && title && !/stock alert|restock/i.test(title)) name = title;
    if (!name && linkText && !/^https?:/i.test(linkText)) name = linkText;

    const img = root.querySelector('[class*="embedThumbnail"] img, img[class*="embedThumbnail"], [class*="embedImage"] img');
    return {
      url: links[0].href,
      name: name || "Unknown product",
      price: fields.price || "",
      stock: fields.stock || fields.status || "",
      image: img ? img.src : "",
    };
  }

  function processMessage(li, alertNew) {
    const msgId = li.id || "";
    const timeEl = li.querySelector("time[datetime]");
    const postedAt = timeEl ? timeEl.getAttribute("datetime") : null;
    const tooOld = postedAt && Date.now() - new Date(postedAt).getTime() > MAX_AGE_MS;

    let embeds = [...li.querySelectorAll('article[class*="embed"], [class*="embedWrapper"]')];
    // keep only outermost embed roots
    embeds = embeds.filter(e => !embeds.some(o => o !== e && o.contains(e)));
    if (!embeds.length) embeds = [li];

    embeds.forEach((root, i) => {
      const data = readEmbed(root);
      if (!data) return;
      const key = `${msgId}|${i}|${data.url}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (!alertNew || tooOld) return;
      log("Stock alert:", data.name, data.stock, data.url);
      chrome.runtime.sendMessage({ type: "alert", alert: { ...data, key, postedAt } }).catch(() => {});
    });
  }

  function scan(node, alertNew) {
    if (!(node instanceof Element)) return;
    const own = node.closest('li[id^="chat-messages-"]');
    if (own) return processMessage(own, alertNew);
    node.querySelectorAll('li[id^="chat-messages-"]').forEach(li => processMessage(li, alertNew));
  }

  // Everything already on screen when we start is history: remember it, don't alert.
  scan(document.body, false);
  setTimeout(() => { scan(document.body, false); ready = true; log("Watching", document.title); }, 3000);

  new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === "childList") m.addedNodes.forEach(n => scan(n, ready));
      else if (m.target) scan(m.target.parentElement || m.target, ready);
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Heartbeat so the iPad can show the Discord tab is alive.
  const ping = () => {
    const onChannel = /^\/channels\/[^/]+\/[^/]+/.test(location.pathname);
    chrome.runtime.sendMessage({ type: "ping", title: document.title, onChannel }).catch(() => {});
  };
  ping();
  setInterval(ping, 20000);
})();
