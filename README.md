🛒 Lazada Product Monitor + Discord Alert Bot
A lightweight automation tool that monitors Lazada product pages and sends real-time Discord notifications when product status changes (e.g. checkout available, delay changes, captcha/punish page triggered).
Built to avoid excessive refreshes while still detecting important page state changes.

🚀 Features
✅ Monitor Lazada product pages
✅ Detect checkout availability
✅ Detect /tmd/punish (captcha page)
✅ Sends Discord alerts with:
Product title (instead of raw URL)
@here ping for urgent events
✅ Only notifies when changes are detected
✅ Adjustable refresh interval
✅ Avoids aggressive reload to reduce account punishment

📦 Use Cases
Monitoring limited-stock items
Auto-alert when checkout page appears
Notifying when captcha/punish page appears
Tracking UI delay changes

🛠 Tech Stack
Python
Selenium (Browser Automation)
Discord Webhook API
ChromeDriver

📁 Project Structure
lazada-monitor/
│
├── main.py              # Main monitoring logic
├── config.py            # Settings (URL, delay, webhook)
├── requirements.txt     # Python dependencies
└── README.md

⚙️ Installation
1️⃣ Clone the repository
git clone https://github.com/yourusername/lazada-monitor.git
cd lazada-monitor

2️⃣ Install dependencies
pip install -r requirements.txt

3️⃣ Install ChromeDriver
Download ChromeDriver that matches your Chrome version:
https://chromedriver.chromium.org/downloads

Place it in your project folder or add it to PATH.

🔧 Configuration

Update config.py:
PRODUCT_URL = "https://www.lazada.sg/your-product-link"
DISCORD_WEBHOOK = "your_webhook_url"
REFRESH_DELAY = 8  # seconds

You can adjust:
Refresh delay
Discord ping type (@here / @yourname)
Target page patterns (checkout / punish)

🔔 Notification Logic
The bot only sends alerts when:
Product page state changes
Checkout page appears
/tmd/punish page appears (captcha required)
It avoids sending repeated duplicate notifications.

🧠 How It Works
Launches headless Chrome
Loads product page
Extracts product title
Checks:
URL changes
DOM changes
Delay indicators
Compares with previous state
Sends Discord notification if changed

⚠️ Important Notes
Do NOT set refresh delay too low (recommended: 5–10 seconds minimum)
Excessive refresh may trigger Lazada anti-bot protection
If /punish page appears, manual captcha is required

