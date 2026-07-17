// ===========================================================
// Lazada Bot – FINAL BUILD (Buy Now + Place Order)
// ===========================================================

const SETTINGS_KEY = "lazadaBotSettings";
let lazSettings = null;

// ------------------------------
// Detection vocab (ported from lazada_bot-main / stock-utils.js)
// Kept here so restock + sold-out detection uses the same, more robust wording
// the server-side monitor relied on. Tune these if a listing uses odd copy.
// ------------------------------
const UNAVAILABLE_TEXTS = [
  "out of stock",
  "sold out",
  "currently unavailable",
  "notify me when available",
  "insufficient stock",
  "no longer available",
];

const AVAILABLE_TEXTS = ["add to cart", "buy now"];

// Anti-bot / "punish" page markers. These are SPECIFIC to the real challenge —
// deliberately NOT the bare word "captcha", because Lazada ships its anti-bot
// script (which mentions "captcha") on every normal page, which caused a false
// alert on clean product pages. Used only to alert a human; never auto-solved.
const BLOCKED_HTML_MARKERS = ["x5secdata", "/_____tmd_____/punish"];

// Alibaba/Lazada "nocaptcha" (nc) slider widget. We only treat these as a real
// challenge when the element is actually rendered and visible on the page.
const CAPTCHA_SELECTORS = [
  ".nc-container",
  ".nc_wrapper",
  "#nc_1_wrapper",
  "[class*='nocaptcha']",
  ".slidetounlock",
];

// ------------------------------
// Logging
// ------------------------------
function log(...args) {
  console.log("[LazadaBot CS]", ...args);
}

function logBG(msg) {
  try {
    chrome.runtime.sendMessage({ type: "log", message: msg });
  } catch (e) {
    console.warn("[LazadaBot CS] logBG error:", e);
  }
}

// --- Dashboard telemetry -------------------------------------------------
// Structured signals the background records into chrome.storage.local so the
// live dashboard can show task state, an activity feed, and checkout wins.
function reportStatus(state, extra = {}) {
  try {
    chrome.runtime.sendMessage({ type: "laz_status", state, url: location.href, ...extra });
  } catch (e) { /* background asleep / context gone */ }
}

function reportEvent(kind, message, extra = {}) {
  try {
    chrome.runtime.sendMessage({ type: "laz_event", kind, message, url: location.href, ts: Date.now(), ...extra });
  } catch (e) { /* ignore */ }
}


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "activate_lazada") {
        logBG("🟩 Received activation from background — starting immediately.");
        init(); // forces product/checkout flow to run
    }
});

// ------------------------------
// Helpers
// ------------------------------
function wait(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function mediumDelay() {
  return wait(randInt(200, 600));
}

function showTestBanner() {
  const div = document.createElement("div");
  div.style.position = "fixed";
  div.style.top = "0";
  div.style.left = "0";
  div.style.width = "100%";
  div.style.padding = "12px";
  div.style.background = "#ffcc00";
  div.style.zIndex = "999999";
  div.style.fontWeight = "bold";
  div.style.textAlign = "center";
  div.textContent = "TEST MODE ACTIVE — WILL NOT PLACE ORDER";
  document.body.appendChild(div);
}

// Big, blinking, hard-to-miss banner so the user solves the slider captcha fast.
function showCaptchaAlert() {
  if (document.getElementById("lazbot-captcha-alert")) return;

  const bar = document.createElement("div");
  bar.id = "lazbot-captcha-alert";
  bar.textContent = "🧩 CAPTCHA — SOLVE THE SLIDER PUZZLE NOW TO CONTINUE CHECKOUT";
  Object.assign(bar.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100%",
    padding: "16px",
    background: "#e63946",
    color: "#fff",
    zIndex: "2147483647",
    fontWeight: "800",
    fontSize: "16px",
    textAlign: "center",
    letterSpacing: "0.5px",
    boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
    animation: "lazbotBlink 1s steps(2,start) infinite"
  });

  const style = document.createElement("style");
  style.textContent = "@keyframes lazbotBlink{50%{opacity:.35}}";
  document.head.appendChild(style);
  document.body.appendChild(bar);

  // Short audible beep loop via WebAudio (no asset needed).
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let count = 0;
    const beep = () => {
      if (count++ > 12 || !document.getElementById("lazbot-captcha-alert")) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "square";
      osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.start();
      osc.stop(ctx.currentTime + 0.18);
      setTimeout(beep, 700);
    };
    beep();
  } catch (e) {
    // Autoplay may be blocked until the user interacts — banner + desktop
    // notification still cover the alert.
  }
}

async function getLazadaProductTitle() {
  // Try OG title first (usually very reliable)
  const og = document.querySelector('meta[property="og:title"]')?.content?.trim();
  if (og) return og;

  // Common: PDP has an H1
  const h1 = document.querySelector("h1")?.innerText?.trim();
  if (h1) return h1;

  // Fallback to browser title
  const t = (document.title || "").trim();
  if (t) return t;

  return "";
}

async function waitForTitle(maxMs = 8000) {
  const start = performance.now();
  while (performance.now() - start < maxMs) {
    const title = await getLazadaProductTitle();
    // avoid useless generic titles
    if (title && !/lazada/i.test(title.toLowerCase())) return title;
    await wait(200);
  }
  return await getLazadaProductTitle();
}

// ------------------------------
// Settings
// ------------------------------
async function loadSettings() {
  const saved = await chrome.storage.sync.get(SETTINGS_KEY);
  lazSettings = { ...(saved[SETTINGS_KEY] || {}) };
  log("[Settings loaded]", lazSettings);
  // Removed the logBG Settings loaded spam here
  if (lazSettings.testMode) showTestBanner();
}

// ------------------------------
// Page detection
// ------------------------------
function isPunishCaptchaPage() {
  // Normalize multiple slashes
  const path = location.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "");

  // Matches:
  // /products/pdp-.../_____tmd_____/punish
  // /products/pdp-.../tmd/punish
  const isPunishPath = /\/(?:_+tmd_+|tmd)\/punish$/i.test(path);

  // Extra safety: Lazada punish pages usually include x5secdata / x5step
  const hasPunishQuery =
    location.search.includes("x5secdata=") || location.search.includes("x5step=");

  return isPunishPath || (path.endsWith("/punish") && hasPunishQuery);
}

function isElementVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

// Complements the URL-based check above: catches a verification shown inline
// without a matching punish URL. Kept strict to avoid false positives on normal
// pages — triggers only on the specific punish markers, an actually-visible
// slider widget, or explicit challenge wording. Detection only; human solves it.
function isBlockedByHtml() {
  // Specific punish markers (not the generic word "captcha").
  const raw = (document.documentElement?.outerHTML || "").toLowerCase();
  if (BLOCKED_HTML_MARKERS.some((marker) => raw.includes(marker))) return true;

  // A slider/nocaptcha widget actually rendered and visible on the page.
  for (const sel of CAPTCHA_SELECTORS) {
    if (isElementVisible(document.querySelector(sel))) return true;
  }

  // Explicit challenge wording visible in the page body.
  const bodyText = (document.body?.innerText || "").toLowerCase();
  if (bodyText.includes("unusual traffic") || bodyText.includes("slide to verify")) {
    return true;
  }

  return false;
}

function isProductPage() {
  const ok =
    location.hostname.endsWith("lazada.sg") &&
    /\/products\//.test(location.pathname);

  if (ok) {
  waitForTitle().then(title => {
    logBG(`🧭 PRODUCT page detected: ${title}`);
  });
}
  return ok;
}

function isCheckoutPage() {
  const ok =
    location.hostname.endsWith("lazada.sg") &&
    location.href.includes("/checkout");

  if (ok) logBG(`🧭 CHECKOUT page detected: ${location.href}`);
  return ok;
}

// Order confirmation / "Thank you for your purchase!" page, e.g.
// https://checkout.lazada.sg/order-received-new?orderId=...&payStatus=success
function isOrderSuccessPage() {
  return (
    location.hostname.endsWith("lazada.sg") &&
    (/\/order-received/i.test(location.pathname) ||
      /payStatus=success/i.test(location.search))
  );
}

function handleOrderSuccess() {
  const params = new URLSearchParams(location.search);
  const orderId =
    params.get("orderId") || params.get("tradeOrderIds") || "";

  const title = (document.title || "").trim();
  const orderTxt = orderId ? ` Order #${orderId}` : "";

  logBG(`@here ✅🎉 ORDER PLACED SUCCESSFULLY!${orderTxt}`);
  log("[OrderSuccess]", { orderId, title, url: location.href });

  // Record the win for the dashboard: title, order id, and a best-effort amount
  // parsed from the confirmation page (e.g. "$8.89" / "SGD 8.89").
  const amtMatch = (document.body?.innerText || "").match(/(?:S?\$|SGD)\s?(\d+(?:\.\d{1,2})?)/i);
  const amount = amtMatch ? parseFloat(amtMatch[1]) : null;
  reportStatus("success", { title });
  try {
    chrome.runtime.sendMessage({
      type: "checkout_win",
      title,
      orderId,
      amount,
      url: location.href,
      ts: Date.now(),
    });
  } catch (e) { /* ignore */ }

  // Auto-close this tab after the order, if enabled in settings.
  if (lazSettings?.autoClose) {
    const delayMs =
      typeof lazSettings.autoCloseAfterMs === "number"
        ? lazSettings.autoCloseAfterMs
        : 10000;
    logBG(`🧹 Auto-closing this tab in ${(delayMs / 1000).toFixed(0)}s.`);
    try {
      chrome.runtime.sendMessage({ type: "request_close_tab_after", delayMs });
    } catch (e) {
      console.warn("[LazadaBot CS] auto-close request failed:", e);
    }
  }
}

// ------------------------------
// Human click (PointerEvents)
// ------------------------------
function realHumanClick(el, label = "unknown") {
  if (!el) {
    logBG(`⚠️ realHumanClick called with NULL element for ${label}`);
    return;
  }

  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  const events = ["pointerdown", "mousedown", "mouseup", "click"];

  log("[realHumanClick]", label, rect);
  logBG(`🖱 Dispatching human-like click on ${label} at (${Math.round(x)}, ${Math.round(y)})`);

  for (const type of events) {
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        view: window,
        pointerType: "mouse",
        // isTrusted is read-only; setting it here does nothing but is harmless
      })
    );
  }
}

// ===========================================================
//  PRODUCT PAGE – BUY NOW (your working logic)
// ===========================================================
function isTrulyOutOfStock() {
  const selectors = [
    'button[disabled][data-spm-anchor-id*="buy"]',
    '.pdp-button_out-of-stock',
    '.pdp-button.pdp-button_out-of-stock',
    '.out-of-stock'
  ];

  for (const sel of selectors) {
    if (document.querySelector(sel)) return true;
  }

  // Cheap, targeted text scan — only look at the action-button area instead of
  // walking every node on the page (the old version read innerText for *every*
  // element on every tick, which was slow and could false-match unrelated copy).
  const actionArea = document.querySelector(
    ".pdp-product-operation, .pdp-block, #module_add_to_cart, .pdp-cart-concern"
  ) || document.body;

  const buttons = actionArea.querySelectorAll("button, .pdp-button");
  for (const el of buttons) {
    const t = (el.innerText || el.textContent || "").trim().toLowerCase();
    if (UNAVAILABLE_TEXTS.includes(t)) {
      return true;
    }
  }

  return false;
}

// Quick synchronous Buy Now lookup (used inside the fast retry loop).
function findBuyNowButton() {
  const buttons = document.querySelectorAll("button, .pdp-button");
  for (const b of buttons) {
    const txt = (b.innerText || b.textContent || "").trim();
    if (/buy now/i.test(txt)) return b;
  }
  return null;
}

function isClickable(el) {
  if (!el) return false;
  if (el.disabled) return false;
  if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return false;
  const cls = (el.className || "").toString().toLowerCase();
  if (cls.includes("disabled") || cls.includes("out-of-stock")) return false;
  return true;
}

// ===========================================================
//  CHECKOUT PAGE – PLACE ORDER NOW (simple + debug)
// ===========================================================

function findPlaceOrderMatches() {
  const divs = Array.from(document.querySelectorAll("div"));
  const matches = [];

  for (const el of divs) {
    const raw = (el.innerText || "").trim();
    if (!raw) continue;

    if (raw.toUpperCase().includes("PLACE ORDER")) {
      matches.push({
        el,
        text: raw,
        spm: el.getAttribute("data-spm-anchor-id") || "",
        cls: el.className || "",
      });
    }
  }

  // Console-only (NOT logBG) — this runs every ~150ms while polling, so sending
  // it to the Discord webhook spammed ~200 messages per checkout and risked
  // rate-limiting the important @here success/captcha/OC3 pings.
  if (matches.length) {
    const preview = matches
      .slice(0, 5)
      .map((m, i) => `#${i + 1}: text="${m.text}" spm="${m.spm}" class="${m.cls}"`)
      .join("\n");
    log(`🔎 PLACE ORDER matches (${matches.length}):\n${preview}`);
  }

  return matches;
}

function pickPlaceOrderButton() {
  const matches = findPlaceOrderMatches();
  if (!matches.length) return null;

  // Prefer an exact text match
  const exact = matches.find(m => m.text.trim().toUpperCase() === "PLACE ORDER NOW");
  return (exact || matches[0]).el;
}

async function waitForPlaceOrder() {
  const timeout = 30000;
  const start = performance.now();
  let attempts = 0;

  while (performance.now() - start < timeout) {
    attempts++;

    const btn = pickPlaceOrderButton();
    if (btn) {
      logBG(`🟢 PLACE ORDER button chosen after ${attempts} attempts.`);
      return btn;
    }

    if (attempts % 5 === 0) {
      const elapsed = Math.round(performance.now() - start);
      //logBG(`⌛ Still searching PLACE ORDER NOW (attempt ${attempts}, elapsed ${elapsed}ms)`);
    }

    await wait(150);
  }

  return null;
}

async function waitForBuyNow() {
  const timeout = 15000;
  const start = performance.now();
  let attempts = 0;

  while (performance.now() - start < timeout) {
    attempts++;

    const btn = Array.from(document.querySelectorAll("button"))
      .find(b => /buy now/i.test(b.innerText || ""));

    if (btn) {
      //logBG(`🛒 Buy Now found after ${attempts} attempts.`);
      return btn;
    }

    if (attempts % 5 === 0) {
      //logBG(`⌛ Still searching Buy Now (attempt ${attempts})`);
    }

    await wait(150);
  }
  return null;
}

async function runProductFlow() {
  log("📄 Product page logic running");
  logBG("📄 Product page opened — watching for Buy Now / restock…");
  reportStatus("watching");
  waitForTitle().then((t) => reportStatus("watching", { title: t }));

  window.scrollTo({ top: randInt(150, 300), behavior: "smooth" });

  // Active-watch window for THIS page load. Instead of searching once and
  // giving up, we poll fast so that the instant the item restocks (button flips
  // from disabled/sold-out to clickable) we fire immediately.
  const pollMs = lazSettings?.pollIntervalMs || 200;
  const watchMs = lazSettings?.productWatchMs || 20000;
  const deadline = performance.now() + watchMs;
  let ticks = 0;

  while (performance.now() < deadline) {
    ticks++;

    // Bail out if the page navigated to a captcha/punish page mid-watch, or if
    // an inline verification appeared. A human takes over from here.
    if (isPunishCaptchaPage() || isBlockedByHtml()) {
      logBG("🧩 Captcha appeared during product watch — alerting human, stopping flow.");
      showCaptchaAlert();
      return;
    }

    const buyNowBtn = findBuyNowButton();

    if (buyNowBtn && isClickable(buyNowBtn)) {
      // Remember this product URL so checkout can return here to re-watch if the
      // item sells out at the payment page (OC3 / out of stock).
      try {
        chrome.storage.local.set({ lazLastProductUrl: location.href });
      } catch (e) {
        console.warn("[LazadaBot CS] could not save product URL:", e);
      }
      buyNowBtn.scrollIntoView({ behavior: "instant", block: "center" });
      realHumanClick(buyNowBtn, "BuyNow");
      logBG(`✅ Buy Now clicked after ${ticks} checks!`);
      logBG("@here 🛒 Buy Now clicked — checkout needs attention now!");
      reportStatus("buy_now");
      reportEvent("buy_now", "🛒 Buy Now clicked — in stock!");
      // If this was a background direct-watch tab, surface it so the human sees
      // the checkout (and any captcha) right away.
      try {
        chrome.runtime.sendMessage({ type: "request_focus" });
      } catch (e) {
        console.warn("[LazadaBot CS] request_focus failed:", e);
      }
      return;
    }

    // Only treat as sold-out (and trigger a fast reload) once we're confident:
    // a sold-out marker is present AND there's no clickable Buy Now.
    if (isTrulyOutOfStock() && !(buyNowBtn && isClickable(buyNowBtn))) {
      // ~every 5s at the default 200ms poll (kept light to avoid webhook spam).
      if (ticks % 25 === 0) {
        logBG("⏳ Still sold out — keeping watch…");
        reportStatus("sold_out");
      }
    }

    await wait(pollMs);
  }

  // Window elapsed with no clickable Buy Now → fast reload to fetch fresh stock.
  logBG("🔁 No Buy Now in watch window — reloading for fresh stock.");
  handleAutoRetry();
}

// ===========================================================
//  CHECKOUT PAGE – PLACE ORDER NOW
// ===========================================================

// Very aggressive finder based on the exact element you showed me

async function waitForCheckoutUI() {
  const timeout = 20000;
  const start = performance.now();

  // Removed the random @here spam from the loop
  while (performance.now() - start < timeout) {
    const node = document.querySelector("#container_10008, .checkout-order-total");

    if (node) {
      logBG("🟢 Checkout UI container detected (React mounted).");
      return true;
    }

    await wait(200);
  }

  logBG("❌ Checkout UI container NOT detected.");
  return false;
}

// Detect the checkout-time out-of-stock failure (Lazada reason code OC3, shown
// after Buy Now when the item sells out before Place Order completes). Returns a
// short reason string if found, else null. We prioritise the very specific OC3
// code, then explicit out-of-stock wording inside an error/toast/dialog so we
// don't false-match "out of stock" copy elsewhere on the page.
function getCheckoutStockError() {
  const bodyText = document.body?.innerText || "";

  if (/\bOC3\b/.test(bodyText)) return "OC3";

  const errorAreas = document.querySelectorAll(
    "[class*='toast'],[class*='Toast'],[class*='dialog'],[class*='Dialog']," +
    "[class*='error'],[class*='Error'],[class*='notice'],[class*='Notice'],[role='alert']"
  );
  for (const el of errorAreas) {
    const t = (el.innerText || "").toLowerCase();
    if (
      t.includes("out of stock") ||
      t.includes("sold out") ||
      t.includes("insufficient stock") ||
      t.includes("no longer available")
    ) {
      return (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 120);
    }
  }
  return null;
}

let checkoutOOSHandled = false;

async function handleCheckoutOutOfStock(reason) {
  if (checkoutOOSHandled) return;
  checkoutOOSHandled = true;

  logBG(`@here ❌ CHECKOUT OUT OF STOCK (${reason}) — item sold out at payment page.`);
  reportStatus("sold_out");
  reportEvent("oos", `❌ Out of stock at checkout (${reason})`);

  if (lazSettings?.autoRetry === false) {
    logBG("♻️ Auto-retry disabled — staying on checkout page.");
    return;
  }

  let productUrl = "";
  try {
    const saved = await chrome.storage.local.get("lazLastProductUrl");
    productUrl = saved?.lazLastProductUrl || "";
  } catch (_) {}

  if (!productUrl) {
    logBG("⚠️ No saved product URL — can't auto-rewatch. Re-open the product link to retry.");
    return;
  }

  const base = lazSettings?.retryDelayMs || 3000;
  const jitter = randInt(0, Math.min(800, Math.round(base * 0.25)));
  const delay = base + jitter;
  logBG(`↩️ Returning to product page in ~${(delay / 1000).toFixed(1)}s to re-watch for restock.`);
  setTimeout(() => { location.href = productUrl; }, delay);
}

// Poll the checkout page for an OOS/OC3 error for a few seconds. If the order
// instead succeeds, the page navigates away and this context is discarded.
async function watchForCheckoutStockError(maxMs = 8000) {
  const start = performance.now();
  while (performance.now() - start < maxMs) {
    const reason = getCheckoutStockError();
    if (reason) {
      await handleCheckoutOutOfStock(reason);
      return true;
    }
    await wait(300);
  }
  return false;
}

async function runCheckoutFlow() {
  // Added the @here ping at the start of the checkout flow
  logBG("@here 🚨 💳 CHECKOUT PAGE DETECTED! Proceeding to place order...");
  reportStatus("checkout");
  reportEvent("checkout", "💳 Checkout page reached");

  const uiReady = await waitForCheckoutUI();
  if (!uiReady) return;

  await wait(500);

  // The item may already be flagged out of stock before we even click.
  const preError = getCheckoutStockError();
  if (preError) {
    await handleCheckoutOutOfStock(preError);
    return;
  }

  logBG("🔍 Lazada UI ready — searching for PLACE ORDER NOW…");

  logBG("🔍 Searching for PLACE ORDER NOW…");
  const btn = await waitForPlaceOrder();

  if (!btn) {
    logBG("❌ PLACE ORDER NOW button NOT FOUND after timeout.");
    return;
  }

  log("[Checkout] PLACE ORDER element:", btn);
  logBG("💳 PLACE ORDER NOW button FOUND — scrolling & clicking…");

  btn.scrollIntoView({ behavior: "smooth", block: "center" });
  await wait(randInt(200, 400));

  if (lazSettings?.testMode) {
    logBG("🧪 TEST MODE — skipping PLACE ORDER click.");
    return;
  }

  realHumanClick(btn, "PlaceOrder");
  logBG("✅ PLACE ORDER click dispatched!");

  // After clicking, either the order succeeds (page navigates to the success
  // page) or Lazada blocks it with an OOS/OC3 error. Watch for the error; if it
  // appears, alert and go back to the product page to re-watch for restock.
  watchForCheckoutStockError();
}

// ===========================================================
//  SHOP PAGE – NEW RELEASE WATCHER
// ===========================================================
// Reloads a shop listing page on an interval, scrapes every product card, and
// fires the normal product flow for cards that match your keywords. Built for
// timed drops: the item usually appears on the shop grid seconds before anyone
// has the direct product URL to paste anywhere.
//
// State lives in chrome.storage.local (NOT memory) because this page reloads
// itself — module-level variables are wiped on every cycle.
const SHOP_SEEN_KEY = "lazShopSeen"; // { [shopKey]: { baseline: [ids], ts } }

function shopKeyFromUrl(url) {
  try {
    const u = new URL(url, location.href);
    return (u.hostname + u.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch (_) {
    return "";
  }
}

function isShopPage() {
  return location.hostname.endsWith("lazada.sg") && /^\/shop\//i.test(location.pathname);
}

// "…/products/pdp-i13733405534-s124676139765.html" -> "13733405534-124676139765"
function productIdFromUrl(url) {
  try {
    const u = new URL(url, location.href);
    if (!/\/products\//i.test(u.pathname)) return null;
    const m = u.pathname.match(/i(\d+)(?:-s(\d+))?\.html?$/i);
    if (!m) return null;
    return m[2] ? `${m[1]}-${m[2]}` : m[1];
  } catch (_) {
    return null;
  }
}

// Some Lazada URLs carry the product name in the slug, which is worth matching
// against as well. Note the Pokémon store does NOT: its links are bare
// "pdp-i<id>-s<sku>.html", so this returns nothing useful there and img[alt] is
// what actually carries the name. Kept as a fallback for shops that do.
function slugWordsFromUrl(url) {
  try {
    const u = new URL(url, location.href);
    const words = decodeURIComponent(u.pathname)
      .replace(/.*\/products\//i, " ")
      .replace(/-?i\d+(-s\d+)?\.html?$/i, "")
      .replace(/[-_/]+/g, " ")
      .toLowerCase()
      .trim();
    // Bare "pdp" is Lazada's page-type prefix, not part of any product name —
    // leaving it in would make "pdp" a keyword that matches every listing.
    return words === "pdp" ? "" : words.replace(/^pdp\s+/, "");
  } catch (_) {
    return "";
  }
}

// Climb from the anchor until we hit a node with enough text to be the card
// (title + price + rating). Lazada's class names are hashed and change between
// deploys, so walking up beats hard-coding a card selector.
function cardTextFor(anchor) {
  let node = anchor;
  for (let i = 0; i < 5 && node; i++) {
    const t = (node.innerText || "").trim();
    if (t.length > 15) return t;
    node = node.parentElement;
  }
  return (anchor.innerText || "").trim();
}

function productInfoFromAnchor(a) {
  const id = productIdFromUrl(a.href);
  if (!id) return null;

  // On the Pokémon store every card's name lives in img[alt] — no anchor carries
  // a title attr, and the visible text is CSS-ellipsised. alt holds the complete
  // name, so it's what keywords get compared against. The others are fallbacks
  // for differently-built shop pages.
  let title = (a.getAttribute("title") || "").trim();
  if (!title) title = (a.querySelector("img")?.getAttribute("alt") || "").trim();

  const cardText = cardTextFor(a);
  if (!title || title.length < 4) {
    title =
      cardText
        .split("\n")
        .map((s) => s.trim())
        .find((s) => s.length >= 4 && !/^(?:S?\$|SGD)/i.test(s)) || title;
  }

  // Nameless anchors are decorative shop banners that happen to link to a
  // product (image only: no alt, no title, no text). We can't keyword-match
  // them, and a banner's real listing has its own card in the grid anyway — so
  // dropping them keeps banners from eating the "max items to open" budget.
  if (title.length < 4) return null;

  const priceMatch = cardText.match(/(?:S?\$|SGD)\s?([\d,]+(?:\.\d{1,2})?)/i);

  return {
    id,
    url: a.href,
    title: title.replace(/\s+/g, " ").trim(),
    price: priceMatch ? parseFloat(priceMatch[1].replace(/,/g, "")) : null,
    haystack: `${title} ${slugWordsFromUrl(a.href)}`.toLowerCase().trim(),
  };
}

function scrapeShopProducts() {
  const byId = new Map();
  for (const a of document.querySelectorAll('a[href*="/products/"]')) {
    const info = productInfoFromAnchor(a);
    // Each card has several anchors (image, title, price) — first one wins.
    if (info && !byId.has(info.id)) byId.set(info.id, info);
  }
  return [...byId.values()];
}

// The grid renders progressively. Wait until the card count stops growing so we
// don't snapshot a half-rendered page as the baseline and then "discover" the
// rest of the shop as fake new releases.
async function waitForShopProducts(maxMs = 10000) {
  const start = performance.now();
  let list = [];
  let prevCount = -1;
  let stableTicks = 0;

  while (performance.now() - start < maxMs) {
    list = scrapeShopProducts();
    if (list.length > 0 && list.length === prevCount) {
      if (++stableTicks >= 2) return list; // held steady ~600ms
    } else {
      stableTicks = 0;
    }
    prevCount = list.length;
    await wait(300);
  }
  return list;
}

// A keyword LINE matches when every word in it appears somewhere in the product
// name (order-independent), and the product matches when ANY line does. So
// "first partner" and "mega evolution" on two lines means "either of these".
function lineMatches(line, haystack) {
  const tokens = line.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  return tokens.every((t) => haystack.includes(t));
}

function shopProductMatches(p, settings) {
  const include = (settings.shopKeywords || []).map((k) => k.trim()).filter(Boolean);
  const exclude = (settings.shopExcludeKeywords || []).map((k) => k.trim()).filter(Boolean);

  if (exclude.some((line) => lineMatches(line, p.haystack))) return false;
  // No keywords = match every new listing on the shop.
  if (!include.length) return true;
  return include.some((line) => lineMatches(line, p.haystack));
}

async function runShopFlow() {
  const key = shopKeyFromUrl(location.href);

  if (isPunishCaptchaPage() || isBlockedByHtml()) {
    logBG("@here 🧩 CAPTCHA on the shop page — solve the slider to resume the drop watch.");
    reportStatus("captcha");
    reportEvent("captcha", "🧩 CAPTCHA on shop watch page");
    showCaptchaAlert();
    try {
      chrome.runtime.sendMessage({ type: "captcha_alert", url: location.href });
    } catch (e) {
      console.warn("[LazadaBot CS] captcha_alert send failed:", e);
    }
    return; // no reload — a human has to clear this first
  }

  reportStatus("watching", { title: `🏬 Shop watch — ${key.replace(/^www\.lazada\.sg\/shop\//, "")}` });

  // Nudge lazy-rendered rows into the DOM, then return to the top so the next
  // reload starts clean.
  window.scrollTo({ top: 600, behavior: "instant" });
  await wait(250);
  window.scrollTo({ top: 0, behavior: "instant" });

  const products = await waitForShopProducts();

  if (!products.length) {
    logBG("⚠️ Shop watch: no product cards found — retrying.");
    scheduleShopReload();
    return;
  }

  const store = await chrome.storage.local.get(SHOP_SEEN_KEY);
  const seenAll = store[SHOP_SEEN_KEY] || {};
  let entry = seenAll[key];

  // First pass after arming: everything currently listed is "old". Only things
  // that show up AFTER this snapshot count as the drop.
  if (!entry) {
    entry = { baseline: products.map((p) => p.id), ts: Date.now() };
    seenAll[key] = entry;
    await chrome.storage.local.set({ [SHOP_SEEN_KEY]: seenAll });
    logBG(`📋 Shop watch armed — ${entry.baseline.length} existing listings ignored. Watching for new drops…`);
    reportEvent("info", `📋 Shop baseline set (${entry.baseline.length} listings)`);
    scheduleShopReload();
    return;
  }

  const baseline = new Set(entry.baseline || []);
  const onlyNew = lazSettings?.shopOnlyNew !== false;
  const maxPrice = Number(lazSettings?.shopMaxPrice) || 0;

  const hits = [];
  for (const p of products) {
    if (onlyNew && baseline.has(p.id)) continue;
    if (!shopProductMatches(p, lazSettings || {})) continue;
    if (maxPrice > 0 && p.price != null && p.price > maxPrice) continue;
    hits.push(p);
  }

  if (hits.length) {
    // The background owns dedupe + the open cap, so re-reporting the same hit on
    // every reload is safe — and means a hit is never lost if the cap frees up.
    for (const p of hits) {
      logBG(`@here 🎯 NEW DROP MATCH: ${p.title}${p.price != null ? ` — $${p.price}` : ""}`);
      try {
        chrome.runtime.sendMessage({
          type: "shop_hit",
          id: p.id,
          url: p.url,
          title: p.title,
          price: p.price,
        });
      } catch (e) {
        console.warn("[LazadaBot CS] shop_hit send failed:", e);
      }
    }
  }

  scheduleShopReload();
}

function scheduleShopReload() {
  // Floor the interval: hammering the shop grid is the fastest way to get the
  // whole session thrown onto a punish/captcha page mid-drop.
  const base = Math.max(1500, Number(lazSettings?.shopRefreshMs) || 4000);
  const delay = base + randInt(0, Math.round(base * 0.25)); // jitter — a fixed cadence is a bot tell
  setTimeout(() => location.reload(), delay);
}

// ===========================================================
// AUTO RETRY
// ===========================================================
function handleAutoRetry() {
  if (!lazSettings || lazSettings.autoRetry === false) {
    logBG("♻️ Auto-retry disabled.");
    return;
  }

  const base = lazSettings.retryDelayMs || 3000;

  // Add a little jitter so reloads don't land on a perfectly fixed interval
  // (a fixed cadence is one of the easiest bot tells for anti-bot systems).
  const jitter = randInt(0, Math.min(800, Math.round(base * 0.25)));
  const delay = base + jitter;

  logBG(`🔄 Auto-reload in ~${(delay / 1000).toFixed(1)}s.`);
  setTimeout(() => location.reload(), delay);
}

// ===========================================================
// INIT
// ===========================================================
// Hoisted declaration (NOT a named IIFE) so the activate_lazada message handler
// can call init(). Guarded so the auto-injection run and the activate_lazada
// trigger don't start the flow twice.
let botStarted = false;

async function init() {
  if (botStarted) {
    log("[INIT] Already started on this page — ignoring duplicate trigger.");
    return;
  }
  botStarted = true;

  await loadSettings();

  if (lazSettings.enabled === false) {
    logBG("⏹ Bot disabled — not running on this page.");
    return;
  }

  // CAPTCHA / verification page — we do NOT auto-solve the slider (that would be
  // circumventing Lazada's anti-bot control). Instead we make it impossible to
  // miss so a human can solve it in a second.
  if (isPunishCaptchaPage() || isBlockedByHtml()) {
    logBG(`@here 🧩 CAPTCHA / verification detected — SOLVE THE SLIDER NOW: ${location.href}`);
    reportStatus("captcha");
    reportEvent("captcha", "🧩 CAPTCHA — needs a human to solve the slider");
    showCaptchaAlert();
    // Bring this tab to the front + fire a desktop notification + beep.
    try {
      chrome.runtime.sendMessage({
        type: "captcha_alert",
        url: location.href
      });
    } catch (e) {
      console.warn("[LazadaBot CS] captcha_alert send failed:", e);
    }
    return; // stop automation here — human takes over
  }

  // Order confirmation page — fire SUCCESS webhook and stop. MUST be checked
  // before isCheckoutPage(), because the order-received URL is on
  // checkout.lazada.sg and would otherwise be mistaken for the checkout page.
  if (isOrderSuccessPage()) {
    logBG("🎉 Order success page detected.");
    handleOrderSuccess();
    return;
  }

  // Shop listing page — only act when this exact shop is on the watchlist, so
  // casually browsing another Lazada shop never starts a reload loop.
  if (isShopPage()) {
    const armed =
      lazSettings.shopWatchEnabled &&
      (lazSettings.shopUrls || []).some(
        (u) => shopKeyFromUrl(u) === shopKeyFromUrl(location.href)
      );

    if (!armed) {
      log("[INIT] Shop page, but not an armed watch target — doing nothing.");
      return;
    }

    logBG("🚀 Starting SHOP drop watch.");
    runShopFlow().catch((err) => {
      console.error("[LazadaBot SHOP ERROR]", err);
      logBG(`❌ Error in shop flow: ${err}`);
      scheduleShopReload(); // keep the watch alive through a transient DOM error
    });
    return;
  }

  if (isProductPage()) {
    logBG("🚀 Starting PRODUCT flow.");
    runProductFlow().catch(err => {
      console.error("[LazadaBot PRODUCT ERROR]", err);
      logBG(`❌ Error in product flow: ${err}`);
    });
  } else if (isCheckoutPage()) {
    logBG("🚀 Starting CHECKOUT flow.");
    runCheckoutFlow().catch(err => {
      console.error("[LazadaBot CHECKOUT ERROR]", err);
      logBG(`❌ Error in checkout flow: ${err}`);
    });
  } else {
    log("[INIT] Not product or checkout page, doing nothing.");
  }
}

// Run on injection. The activate_lazada message may also call init(); the
// botStarted guard makes the second call a no-op.
init();
