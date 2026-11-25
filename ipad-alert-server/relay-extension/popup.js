const DEFAULT_TEST_URL = "https://www.lazada.sg/products/pdp-i14029408090-s125116592243.html?spm=a2o42.10453684.0.0.31a45edfJFVQkK&search=store";
const $ = id => document.getElementById(id);

function isLazadaProductUrl(href) {
  try {
    const u = new URL(href);
    return /(^|\.)lazada\.sg$/i.test(u.hostname) && /\/products\//i.test(u.pathname);
  } catch (_) {
    return false;
  }
}

function setDot(id, cls) { $(id).className = "dot " + cls; }

async function init() {
  // Prefill: the Lazada product tab you're on, else the last link you sent, else the default.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { lastTestUrl, lastTestName } = await chrome.storage.local.get(["lastTestUrl", "lastTestName"]);
  if (tab && isLazadaProductUrl(tab.url)) {
    $("url").value = tab.url;
    $("name").value = (tab.title || "").replace(/\s*\|\s*Lazada.*$/i, "");
  } else {
    $("url").value = lastTestUrl || DEFAULT_TEST_URL;
    $("name").value = lastTestName || "";
  }

  const s = await chrome.runtime.sendMessage({ type: "status" });
  if (!s || !s.ok) {
    setDot("dServer", "bad");
    $("tServer").textContent = "Server not running: start start.bat";
  } else {
    setDot("dServer", s.screens ? "ok" : "warn");
    $("tServer").textContent = `Server running · ${s.screens} iPad screen(s) open`;
    const fresh = s.relayAgeMs != null && s.relayAgeMs < 150000;
    setDot("dDiscord", fresh ? "ok" : "warn");
    $("tDiscord").textContent = fresh ? "Discord channel is being watched" : "Discord not watched: open #lazada-sg";
  }
}

$("send").addEventListener("click", async () => {
  const url = $("url").value.trim();
  const name = $("name").value.trim();
  if (!isLazadaProductUrl(url)) {
    $("msg").className = "msg bad";
    $("msg").textContent = "That isn't a lazada.sg product link.";
    return;
  }
  $("send").disabled = true;
  $("msg").className = "msg";
  $("msg").textContent = "Sending…";
  const r = await chrome.runtime.sendMessage({ type: "send_test", url, name });
  $("send").disabled = false;
  if (r && r.ok) {
    chrome.storage.local.set({ lastTestUrl: url, lastTestName: name });
    $("msg").className = "msg ok";
    $("msg").textContent = r.screens ? `Sent to ${r.screens} iPad screen(s). It should be green now.` : "Sent, but no iPad screen is open.";
  } else {
    $("msg").className = "msg bad";
    $("msg").textContent = (r && r.error) || "Couldn't reach the server. Is start.bat running?";
  }
});

init();
