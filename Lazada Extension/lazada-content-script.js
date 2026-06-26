// ===========================================================
// Lazada Bot – FINAL BUILD (Buy Now + Place Order)
// ===========================================================

const SETTINGS_KEY = "lazadaBotSettings";
let lazSettings = null;

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
    if (
      t === "out of stock" ||
      t === "sold out" ||
      t === "currently unavailable" ||
      t === "notify me when available"
    ) {
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

  // Log first few matches to Discord so we can see what the page looks like
  if (matches.length) {
    const preview = matches
      .slice(0, 5)
      .map((m, i) =>
        `#${i + 1}: text="${m.text}" spm="${m.spm}" class="${m.cls}"`
      )
      .join("\n");
    logBG(`🔎 PLACE ORDER matches (${matches.length}):\n${preview}`);
  } else {
    logBG("🔎 PLACE ORDER matches: none this tick.");
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

    // Bail out if the page navigated to a captcha/punish page mid-watch.
    if (isPunishCaptchaPage()) {
      logBG("🧩 Captcha appeared during product watch — stopping flow.");
      return;
    }

    const buyNowBtn = findBuyNowButton();

    if (buyNowBtn && isClickable(buyNowBtn)) {
      buyNowBtn.scrollIntoView({ behavior: "instant", block: "center" });
      realHumanClick(buyNowBtn, "BuyNow");
      logBG(`✅ Buy Now clicked after ${ticks} checks!`);
      logBG("@here 🛒 Buy Now clicked — checkout needs attention now!");
      return;
    }

    // Only treat as sold-out (and trigger a fast reload) once we're confident:
    // a sold-out marker is present AND there's no clickable Buy Now.
    if (isTrulyOutOfStock() && !(buyNowBtn && isClickable(buyNowBtn))) {
      if (ticks % 10 === 0) logBG("⏳ Still sold out — keeping watch…");
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

async function runCheckoutFlow() {
  // Added the @here ping at the start of the checkout flow
  logBG("@here 🚨 💳 CHECKOUT PAGE DETECTED! Proceeding to place order...");

  const uiReady = await waitForCheckoutUI();
  if (!uiReady) return;

  await wait(500);
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
  if (isPunishCaptchaPage()) {
    logBG(`@here 🧩 CAPTCHA / verification page detected — SOLVE THE SLIDER NOW: ${location.href}`);
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
