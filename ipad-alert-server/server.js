// iPad restock screen server.
//
// The "Discord Restock Relay" Chrome extension (relay-extension/) watches the
// #lazada-sg channel in your logged-in Discord tab and POSTs every new stock
// alert here. This server pushes it live to the page the iPad has open
// (http://<this PC's IP>/), which turns green for the products you ticked.
//
// No dependencies. Run:  node server.js   (or double-click start.bat)

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORTS = process.env.PORT ? [Number(process.env.PORT)] : [80, 8080];
const DATA_DIR = path.join(__dirname, "data");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const INDEX_FILE = path.join(__dirname, "public", "index.html");
const HEARTBEAT_MS = 10000;
// Product the "Send test alert" button uses unless the iPad sends another link.
const DEFAULT_TEST_URL = "https://www.lazada.sg/products/pdp-i14029408090-s125116592243.html?spm=a2o42.10453684.0.0.31a45edfJFVQkK&search=store";

// Starting list. Anything the channel posts that isn't here gets added.
const SEED_PRODUCTS = [
  "30th Booster Bundle - Bulk",
  "30th Celebration 2-Pack Blister",
  "30th Celebration Binder Collection",
  "30th Celebration Ditto Premium Collection",
  "30th Celebration ex Box (Greninja Ex)",
  "30th Celebration ex Box (Sylveon Ex)",
  "30th Celebration ex Tin (Standard) (Greninja Ex)",
  "30th Celebration ex Tin (Standard) (Sylveon Ex)",
  "30th Celebration Figure Collection - Day",
  "30th Celebration Figure Collection - Night",
  "30th Celebration Knock Out Collection",
  "Mega Evolution - Delta Reign 36 CT Booster Display Box",
];

// ---------- helpers ----------

function log(...args) {
  const t = new Date().toLocaleTimeString();
  console.log(`[${t}]`, ...args);
}

// "Pokémon Trading Card Game: Mega Evolution - X [Limit 1 per person]"
//   -> "Mega Evolution - X"
function cleanName(raw) {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/^pok[eé]mon\s+(trading card game|tcg)\s*[:\-–]\s*/i, "")
    .replace(/\s*[\[(]\s*(limit|max)[^\])]*[\])]\s*$/i, "")
    .trim()
    .slice(0, 200);
}

function isLazadaProductUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (!/(^|\.)lazada\.sg$/.test(host)) return false;
    if (host.startsWith("my.") || host.includes("filebroker") || host.includes("cdn")) return false;
    return /\/products\//i.test(u.pathname);
  } catch (_) {
    return false;
  }
}

function isSafeImageUrl(url) {
  try {
    return new URL(url).protocol === "https:";
  } catch (_) {
    return false;
  }
}

function isInStock(stock) {
  if (!stock) return true; // a "Stock Alert" with no stock field = restock
  return !/out of stock|sold out|unavailable|\(0\)/i.test(stock);
}

function isLoopback(req) {
  const a = req.socket.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === "IPv4" && !i.internal) out.push(i.address);
    }
  }
  return out;
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(obj));
}

// ---------- state ----------

let products = loadProducts();
let lastAlert = null;
let relay = { lastSeen: 0, title: "" };
const seenAlertKeys = new Set();
const clients = new Set();

function loadProducts() {
  try {
    const list = JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8"));
    if (Array.isArray(list)) return list.map(cleanName).filter(Boolean);
  } catch (_) {}
  return [...SEED_PRODUCTS];
}

function saveProducts() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
  } catch (e) {
    log("Could not save products.json:", e.message);
  }
}

function relayStatus() {
  return {
    relayAgeMs: relay.lastSeen ? Date.now() - relay.lastSeen : null,
    relayTitle: relay.title,
  };
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

function publishAlert(alert) {
  if (!alert.test && !products.includes(alert.name)) {
    products.push(alert.name);
    saveProducts();
    log("New product added to list:", alert.name);
  }
  lastAlert = alert;
  broadcast("alert", alert);
  log(
    `${alert.test ? "TEST " : ""}ALERT -> ${clients.size} screen(s):`,
    alert.name,
    "|",
    alert.stock || "",
    "|",
    alert.price || ""
  );
}

// ---------- routes ----------

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const route = `${req.method} ${url.pathname}`;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  if (route === "GET /" || route === "GET /index.html") {
    fs.readFile(INDEX_FILE, (err, buf) => {
      if (err) return sendJson(res, 500, { error: "index.html missing" });
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(buf);
    });
    return;
  }

  // Live stream for the iPad page.
  if (route === "GET /events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    res.write(
      `event: state\ndata: ${JSON.stringify({ products, lastAlert, ...relayStatus() })}\n\n`
    );
    clients.add(res);
    log(`Screen connected (${req.socket.remoteAddress}). ${clients.size} open.`);
    req.on("close", () => {
      clients.delete(res);
      log(`Screen disconnected. ${clients.size} open.`);
    });
    return;
  }

  // From the relay extension (same PC only).
  if (route === "POST /alert") {
    if (!isLoopback(req)) return sendJson(res, 403, { error: "local relay only" });
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    if (!isLazadaProductUrl(body.url)) return sendJson(res, 400, { error: "not a lazada.sg product url" });
    const name = cleanName(body.name) || "Unknown product";
    const key = String(body.key || `${body.url}|${body.postedAt || ""}`).slice(0, 300);
    if (seenAlertKeys.has(key)) return sendJson(res, 200, { ok: true, duplicate: true });
    seenAlertKeys.add(key);
    if (seenAlertKeys.size > 2000) seenAlertKeys.delete(seenAlertKeys.values().next().value);

    relay.lastSeen = Date.now();
    publishAlert({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      url: body.url,
      price: String(body.price || "").slice(0, 40),
      stock: String(body.stock || "").slice(0, 60),
      inStock: isInStock(body.stock),
      image: isSafeImageUrl(body.image) ? body.image : "",
      postedAt: body.postedAt || null,
      receivedAt: new Date().toISOString(),
      test: false,
    });
    return sendJson(res, 200, { ok: true, screens: clients.size });
  }

  // Relay heartbeat so the iPad can warn when Discord isn't being watched.
  if (route === "POST /relay-ping") {
    if (!isLoopback(req)) return sendJson(res, 403, { error: "local relay only" });
    let body = {};
    try {
      body = await readBody(req, 4096);
    } catch (_) {}
    const firstPing = !relay.lastSeen || Date.now() - relay.lastSeen > 120000;
    relay = { lastSeen: Date.now(), title: String(body.title || "").slice(0, 120) };
    if (firstPing) log("Discord relay online:", relay.title || "(no title)");
    return sendJson(res, 200, { ok: true, screens: clients.size });
  }

  // "Send test alert" button on the iPad.
  if (route === "POST /test") {
    let body = {};
    try {
      body = await readBody(req, 8192);
    } catch (_) {}
    const testUrl = String(body.url || "").trim();
    if (testUrl && !isLazadaProductUrl(testUrl)) {
      return sendJson(res, 400, { error: "That isn't a lazada.sg product link" });
    }
    publishAlert({
      id: `${Date.now()}-test`,
      name: "Test product",
      url: testUrl || DEFAULT_TEST_URL,
      price: "$0.00",
      stock: "In Stock (test)",
      inStock: true,
      image: "",
      postedAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      test: true,
    });
    return sendJson(res, 200, { ok: true, screens: clients.size });
  }

  if (route === "GET /status") {
    return sendJson(res, 200, { ok: true, screens: clients.size, products: products.length, ...relayStatus() });
  }

  sendJson(res, 404, { error: "not found" });
}

// Keep the iPad connection warm and tell it about the relay.
setInterval(() => broadcast("ping", relayStatus()), HEARTBEAT_MS);

function start(i) {
  const port = PORTS[i];
  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      log("Error:", err);
      if (!res.headersSent) sendJson(res, 500, { error: "server error" });
    });
  });
  server.on("error", err => {
    if ((err.code === "EADDRINUSE" || err.code === "EACCES") && i + 1 < PORTS.length) {
      log(`Port ${port} is busy or blocked (${err.code}), trying ${PORTS[i + 1]}...`);
      start(i + 1);
    } else {
      log(`Could not start on port ${port}: ${err.message}`);
      process.exit(1);
    }
  });
  server.listen(port, "0.0.0.0", () => {
    const suffix = port === 80 ? "" : `:${port}`;
    console.log("");
    console.log("  iPad restock screen is running. Keep this window open.");
    console.log("");
    console.log("  Open one of these on the iPad (same Wi-Fi):");
    for (const ip of lanAddresses()) console.log(`    http://${ip}${suffix}/`);
    console.log("");
    console.log("  Waiting for the Discord relay extension in Chrome...");
    console.log("");
  });
}

start(0);
