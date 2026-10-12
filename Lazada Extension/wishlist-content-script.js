// Wishlist monitor — content script (read-only).
//
// Runs on the Lazada SG wishlist page, reads the items on screen (title, price,
// in/out of stock) and hands a snapshot to the background script, which diffs it
// against the previous one. It never clicks anything and never touches the
// anti-bot challenge: if Lazada shows a captcha / punish page it just reports
// "blocked" so the monitor backs off and a human can deal with it.
(() => {
  if (window.__lazWishlistMonitor) return;
  window.__lazWishlistMonitor = true;

  const PRODUCT_RE = /\/products\/[^?#]*-i(\d+)(?:-s\d+)?\.html/i;
  const SOLD_OUT_RE = /sold out|out of stock|unavailable|no longer available/i;
  const PRICE_RE = /S?\$\s*([\d,]+(?:\.\d{1,2})?)/;

  // Same specific markers the main content script uses — not the bare word
  // "captcha", which Lazada ships in its anti-bot script on every page.
  const BLOCKED_HTML_MARKERS = ["x5secdata", "/_____tmd_____/punish"];
  const BLOCKED_SELECTORS = ["#nc_1_wrapper", ".nc-container", ".slidetounlock"];

  function isWishlistPage() {
    const { hostname, pathname } = location;
    return /^wishlist\./i.test(hostname) || /\/wishlist/i.test(pathname);
  }

  function isBlocked() {
    if (/\/(?:_+tmd_+|tmd)\/punish/i.test(location.pathname)) return true;
    if (BLOCKED_SELECTORS.some((s) => document.querySelector(s))) return true;
    const html = document.documentElement ? document.documentElement.innerHTML : "";
    return location.search.includes("x5secdata") ||
      (html.length < 20000 && BLOCKED_HTML_MARKERS.some((m) => html.includes(m)));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Smallest ancestor of the link that also contains a price — that's the item card.
  function cardFor(anchor) {
    let node = anchor;
    for (let i = 0; i < 8 && node.parentElement; i++) {
      node = node.parentElement;
      if (PRICE_RE.test(node.innerText || "")) return node;
    }
    return anchor;
  }

  function scrape() {
    const items = new Map();
    for (const a of document.querySelectorAll("a[href*='/products/']")) {
      const m = PRODUCT_RE.exec(a.getAttribute("href") || "");
      if (!m) continue;
      const id = m[1];

      const card = cardFor(a);
      const text = (card.innerText || "").replace(/\s+/g, " ");
      const price = PRICE_RE.exec(text);

      const prev = items.get(id);
      const title =
        (a.getAttribute("title") || "").trim() ||
        (a.querySelector("img[alt]") && a.querySelector("img[alt]").alt.trim()) ||
        (a.innerText || "").trim().split("\n")[0] ||
        (prev && prev.title) ||
        "";

      items.set(id, {
        id,
        title: title.slice(0, 160) || (prev && prev.title) || `Item ${id}`,
        url: new URL(a.getAttribute("href"), location.href).href.split("?")[0],
        price: price ? parseFloat(price[1].replace(/,/g, "")) : (prev ? prev.price : null),
        inStock: !SOLD_OUT_RE.test(text),
      });
    }
    return [...items.values()];
  }

  // The wishlist is an SPA that lazy-loads rows: wait for items, then scroll to
  // the bottom a few times until the count stops growing.
  async function collect() {
    for (let i = 0; i < 20 && !document.querySelector("a[href*='/products/']"); i++) {
      if (isBlocked()) return null;
      await sleep(500);
    }
    let last = -1;
    for (let i = 0; i < 8; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(900);
      const n = document.querySelectorAll("a[href*='/products/']").length;
      if (n === last) break;
      last = n;
    }
    window.scrollTo(0, 0);
    return isBlocked() ? null : scrape();
  }

  async function run() {
    if (!isWishlistPage()) return;
    if (isBlocked()) {
      chrome.runtime.sendMessage({ type: "wishlist_blocked", url: location.href });
      return;
    }
    const items = await collect();
    if (items === null) {
      chrome.runtime.sendMessage({ type: "wishlist_blocked", url: location.href });
    } else {
      chrome.runtime.sendMessage({ type: "wishlist_snapshot", url: location.href, items });
    }
  }

  run().catch((e) => console.warn("[LazadaBot wishlist]", e));
})();
