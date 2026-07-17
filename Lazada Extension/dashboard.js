// ===========================================================
// Lazada AutoCheckout — live dashboard
// Reads chrome.storage.local (stats) + chrome.storage.sync (settings) and
// re-renders on any change. No polling of Lazada here — pure read model.
// ===========================================================

const STATS_KEY = "lazadaBotStats";
const SETTINGS_KEY = "lazadaBotSettings";

let stats = { checkouts: [], events: [], tasks: {} };
let settings = {};
let period = "today";

const $ = (id) => document.getElementById(id);

// ---- helpers ----
function periodStart(p) {
  const now = new Date();
  if (p === "today") { now.setHours(0, 0, 0, 0); return now.getTime(); }
  if (p === "week") return Date.now() - 7 * 864e5;
  if (p === "month") return Date.now() - 30 * 864e5;
  return 0; // all
}

function ago(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

function hhmmss(ts) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}

function esc(str) {
  return (str || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function itemId(url) {
  try { const m = new URL(url).pathname.match(/i(\d+)/i); return m ? m[1] : null; } catch (_) { return null; }
}

function labelFor(url) {
  const id = itemId(url);
  return id ? "Item " + id : "Lazada item";
}

const STATE_LABEL = {
  watching: "WATCHING", sold_out: "SOLD OUT", buy_now: "IN STOCK",
  checkout: "CHECKOUT", captcha: "CAPTCHA", success: "CHECKED OUT",
  queued: "QUEUED", idle: "IDLE",
};

// ---- render ----
function render() {
  const enabled = settings.enabled !== false && !!settings.enabled;
  $("pill-bot").textContent = enabled ? "● ARMED" : "● DISARMED";
  $("pill-bot").className = "pill " + (enabled ? "pill-on" : "pill-off");

  $("pill-test").className = "pill " + (settings.testMode ? "pill-live" : "pill-mute");
  $("pill-test").textContent = settings.testMode ? "TEST MODE" : "LIVE FIRE";

  $("pill-watch").className = "pill " + (settings.watchEnabled ? "pill-on" : "pill-mute");
  $("pill-watch").textContent = settings.watchEnabled ? "WATCH ON" : "WATCH OFF";

  const start = periodStart(period);
  const wins = (stats.checkouts || []).filter((c) => c.ts >= start);
  const spend = wins.reduce((sum, c) => sum + (typeof c.amount === "number" ? c.amount : 0), 0);

  const tasks = Object.values(stats.tasks || {});
  const watchingCount = tasks.filter((t) => t.state === "watching" || t.state === "sold_out").length;

  $("s-checkouts").textContent = wins.length;
  $("s-spend").textContent = "$" + spend.toFixed(2);
  $("s-live").textContent = tasks.length;
  $("s-watching").textContent = watchingCount;

  renderTasks(tasks);
  renderWins();
  renderLog();
}

function renderTasks(tasks) {
  // Merge configured watch URLs that have no live tab as QUEUED rows.
  const liveIds = new Set(tasks.map((t) => itemId(t.url)).filter(Boolean));
  const queued = (settings.watchUrls || [])
    .filter((u) => { const id = itemId(u); return id && !liveIds.has(id); })
    .map((u) => ({ site: "Lazada SG", url: u, title: labelFor(u), state: "queued", updatedAt: Date.now() }));

  const rows = [...tasks, ...queued].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  $("tasks-count").textContent = rows.length;

  const el = $("tasks");
  if (!rows.length) { el.innerHTML = '<div class="empty">No active tasks. Arm the bot and add a watch URL.</div>'; return; }

  el.innerHTML = rows.map((t) => {
    const st = t.state || "idle";
    return `<div class="task-row">
      <span class="t-site">${esc(t.site || "Lazada SG")}</span>
      <span class="t-prod" title="${esc(t.title || t.url)}">${esc(t.title || labelFor(t.url))}</span>
      <span><span class="badge b-${st}">${STATE_LABEL[st] || st.toUpperCase()}</span></span>
      <span class="t-time">${st === "queued" ? "—" : ago(t.updatedAt) + " ago"}</span>
    </div>`;
  }).join("");
}

function renderWins() {
  const start = periodStart(period);
  const wins = (stats.checkouts || []).filter((c) => c.ts >= start);
  $("wins-count").textContent = wins.length;

  const el = $("wins");
  if (!wins.length) { el.innerHTML = '<div class="empty">No checkouts yet.</div>'; return; }

  el.innerHTML = wins.map((c) => `
    <div class="feed-row">
      <div class="feed-dot">✔</div>
      <div class="feed-main">
        <div class="feed-title" title="${esc(c.title)}">${esc(c.title || "Order")}</div>
        <div class="feed-meta">${c.orderId ? "#" + esc(c.orderId) + " · " : ""}${hhmmss(c.ts)} · ${ago(c.ts)} ago</div>
      </div>
      <div class="feed-amt">${typeof c.amount === "number" ? "$" + c.amount.toFixed(2) : ""}</div>
    </div>`).join("");
}

function renderLog() {
  const events = stats.events || [];
  const el = $("log");
  if (!events.length) { el.innerHTML = '<div class="empty">Waiting for events…</div>'; return; }

  el.innerHTML = events.map((e) => `
    <div class="log-row k-${esc(e.kind || "info")}">
      <span class="log-time">${hhmmss(e.ts)}</span>
      <span class="log-msg">${esc(e.message)}</span>
    </div>`).join("");
}

// ---- data load + live refresh ----
async function loadAll() {
  const [loc, syn] = await Promise.all([
    chrome.storage.local.get(STATS_KEY),
    chrome.storage.sync.get(SETTINGS_KEY),
  ]);
  stats = { checkouts: [], events: [], tasks: {}, ...(loc[STATS_KEY] || {}) };
  settings = syn[SETTINGS_KEY] || {};
  render();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STATS_KEY]) { stats = { checkouts: [], events: [], tasks: {}, ...changes[STATS_KEY].newValue }; render(); }
  if (area === "sync" && changes[SETTINGS_KEY]) { settings = changes[SETTINGS_KEY].newValue || {}; render(); }
});

// Period switcher
document.querySelectorAll("#period button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("#period button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    period = b.dataset.p;
    render();
  });
});

// Clear log
$("clear").addEventListener("click", async () => {
  const loc = await chrome.storage.local.get(STATS_KEY);
  const s = loc[STATS_KEY] || {};
  s.events = [];
  await chrome.storage.local.set({ [STATS_KEY]: s });
});

// Clock + relative-time aging tick
setInterval(() => {
  $("clock").textContent = new Date().toTimeString().slice(0, 8);
  // Re-render lightly so "Xs ago" stays fresh (cheap; data is in memory).
  renderTasks(Object.values(stats.tasks || {}));
  renderWins();
}, 1000);

// Safety fallback: re-pull every 4s in case a storage event was missed.
setInterval(loadAll, 4000);

loadAll();
