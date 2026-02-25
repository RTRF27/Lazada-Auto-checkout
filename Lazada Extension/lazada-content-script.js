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

  return Array.from(document.querySelectorAll("*"))
    .some(el => {
      const t = (el.innerText || "").trim().toLowerCase();
      return (
        t === "out of stock" ||
        t === "sold out" ||
        t === "currently unavailable"
      );
    });
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
  logBG("📄 Product page opened.");
  logBG("🔍 Searching for Buy Now…");

  window.scrollTo({ top: randInt(150, 300), behavior: "smooth" });
  await mediumDelay();

  if (isTrulyOutOfStock()) {
    logBG("❌ TRUE OUT OF STOCK detected on product page.");
    handleAutoRetry();
    return;
  }

  const buyNowBtn = await waitForBuyNow();

  if (!buyNowBtn) {
    logBG("❌ Buy Now NOT FOUND after timeout.");
    handleAutoRetry();
    return;
  }

  buyNowBtn.scrollIntoView({ behavior: "smooth", block: "center" });
  await wait(150);

  realHumanClick(buyNowBtn, "BuyNow");
  logBG("✅ Buy Now clicked successfully!");
  logBG("@here Checkout need attention now!");
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

  // Uses the exact delay specified in your UI
  const delay = lazSettings.retryDelayMs || 5000;

  logBG(`Exact auto-reload scheduled in ${delay / 1000}s.`);
  setTimeout(() => location.reload(), delay);
}

// ===========================================================
// INIT
// ===========================================================
(async function init() {
  await loadSettings();

  if (lazSettings.enabled === false) {
    logBG("⏹ Bot disabled — not running on this page.");
    return;
  }

  // CAPTCHA / verification page alert
  if (isPunishCaptchaPage()) {
    logBG(`@here 🧩 CAPTCHA page detected: ${location.pathname} — please click the captcha to continue.`);
    return; // stop automation here
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
})();
