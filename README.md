# Enhancivity - AI Productivity Chrome Extension

Your AI-powered productivity companion that lives in your browser. Enhancivity acts as your personal AI Chief of Staff — it reads, navigates, searches, fills forms, and executes tasks across any website, so you only handle the final click.

## Features

- **AI Chat Panel** — Talk to your AI assistant from any webpage via a floating panel or side panel
- **3-Tier Memory** — The AI remembers your facts, goals, and behavioral preferences across sessions
- **Ghost-Driver** — AI-driven browser automation: searches, form filling, and multi-site orchestration
- **EXPLORE Mode** — Multi-step agentic browsing: the AI clicks, scrolls, reads, and navigates for you
- **Smart Tab Awareness** — AI scans your open tabs to find information before opening new ones
- **Recipe System** — Learns and replays your workflows automatically
- **Task Delegation** — Delegate tasks from your dashboard and let the AI execute them in-browser
- **Universal DOM Interaction** — Works on any website, no site-specific configuration needed

## Installation

Since this extension is not yet on the Chrome Web Store, you can install it manually:

### Step 1: Download

Click the green **Code** button above, then **Download ZIP**. Extract the ZIP to a folder on your computer.

Or clone with git:
```bash
git clone https://github.com/enhancivity/enhancivity-extension.git
```

### Step 2: Load in Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the folder where you extracted/cloned the extension
5. The Enhancivity icon should appear in your Chrome toolbar

### Step 3: Pin the Extension

Click the puzzle piece icon in Chrome's toolbar, then click the pin icon next to **Enhancivity** so it's always visible.

### Step 4: Sign Up

1. Click the Enhancivity icon in your toolbar
2. The floating panel will appear — click **Create Account**
3. Enter your name, email, and password
4. Start chatting with your AI assistant!

## How It Works

1. **Click the extension icon** on any webpage to open the AI panel
2. **Type a request** — e.g., "Find me flights to Berlin under $300", "Reply to that email", "Fill out this form with my details"
3. **The AI acts** — it navigates, searches, reads pages, and pre-fills forms for you
4. **You approve** — for actions with real consequences (sending emails, making purchases), the AI asks for your confirmation first

## Privacy & Consent

- The AI **never** sends emails, makes purchases, or submits forms without your explicit approval
- Non-consequential actions (reading, searching, navigating, drafting) happen automatically
- Tab scanning permission is requested once per session
- Your data is processed by our secure backend — we never share it with third parties

## Tech Stack

- Chrome Extension Manifest V3
- Vanilla JavaScript (no framework dependencies)
- Service Worker architecture for background processing
- Side Panel + Floating Panel dual UI
- Content scripts for universal DOM interaction

## Requirements

- Google Chrome (version 116 or later)
- An Enhancivity account (free to create)

## Support

- Report bugs or request features: [GitHub Issues](https://github.com/enhancivity/enhancivity-extension/issues)
- Website: [enhancivity.com](https://enhancivity.com)

## License

This extension is open source. The backend API that powers the AI features is proprietary.

MIT License - see [LICENSE](LICENSE) for details.
