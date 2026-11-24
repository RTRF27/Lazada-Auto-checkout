# iPad Restock Screen

Your iPad shows a black "Waiting for a restock…" page. When the Discord channel
(`A's Solution` → `#lazada-sg`) posts a stock alert for a product you ticked,
the page turns green and **BUY NOW** opens that product's Lazada link.

```
Discord tab in Chrome (PC) ──► relay extension ──► server.js (PC) ──► iPad page
```

Nothing here buys or clicks anything: you tap BUY NOW yourself.

## Setup on the PC (once)

1. Install **Node.js** (LTS) from https://nodejs.org if `node -v` doesn't work.
2. **Load the relay extension:** open `chrome://extensions`, turn on
   *Developer mode*, click *Load unpacked*, choose the `relay-extension` folder.
3. In Chrome, open Discord and go to **A's Solution → #lazada-sg**. Leave that
   tab open (its own window is best). Discord only shows the channel that's open,
   so this tab must stay on #lazada-sg.
4. Chrome → Settings → Performance → *Always keep these sites active* → add
   `discord.com` (the extension also blocks discarding, this is a backup).

## Every time

1. Double-click **`start.bat`**. Allow it through Windows Firewall
   (*Private networks*) the first time. Keep the window open: it restarts the
   server by itself if it ever crashes.
2. On the iPad (same Wi-Fi) open the address the window prints, e.g.
   `http://192.172.4.214/`. Your bookmarked IP keeps working as long as the PC's
   IP hasn't changed.
3. BUY NOW sits in the same spot and size as the orange Buy Now in the Lazada
   app (measured on this iPad in portrait). After it opens the product, tap
   the same place again to hit Lazada's Buy Now.
4. On the iPad: tap once anywhere (turns on the alert sound), tap ⚙ to tick
   products, then **Send test alert** to check the screen goes green.
   Set iPad *Settings → Display & Brightness → Auto-Lock → Never*.

## Sending a test product from the PC

- **Extension popup:** click the *Discord Restock Relay* icon in Chrome (pin it
  from the puzzle-piece menu), check the link, press **Send to iPad**. The
  popup also shows whether the server is running, how many iPads are open,
  and whether Discord is being watched.
- **Right-click:** on any Lazada product page or product link (also inside
  Discord), choose **Send to iPad screen**. The icon shows *sent* or *err*.

The iPad turns green and BUY NOW opens that product, like a real restock.

## What the status line means

| iPad shows | Fix |
|---|---|
| Can't reach the PC. Reconnecting… | `start.bat` isn't running, or the iPad isn't on the same Wi-Fi |
| Discord isn't being watched yet | Open #lazada-sg in Chrome on the PC (relay extension loaded?) |
| Discord relay quiet for N min | The Discord tab was closed or moved off #lazada-sg |

The extension reloads the Discord tab automatically if it stops responding for
3 minutes.

## Notes

- If port 80 is taken on the PC, the server moves to 8080: use `http://<ip>:8080/`.
- Ticks and hidden products are saved on each iPad. The product list itself is
  in `data/products.json` and grows as the channel posts new products.
- The old **Lazada Extension** (auto-checkout bot) also reacts to Discord links.
  Turn it off in `chrome://extensions` if you only want the iPad alert.
