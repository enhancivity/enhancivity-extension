# Enhancivity Chrome Extension

## Project Overview

This is a Chrome Extension (Manifest V3) for **Enhancivity**. It integrates with the Enhancivity platform to allow users to quickly create tasks from any webpage.

**Key Features:**
*   **Contextual Task Creation:** Select text on any webpage (20+ words) to reveal a floating icon. Clicking it opens a form to create a new task using the selected text as the description and the page title as the task title.
*   **Authentication:** Synchronizes with the Enhancivity web session (checks for session cookies on `enhancivity.com` or `localhost`).
*   **Popup Interface:** A simple popup to view connection status and initiate login.

## Architecture

*   **Manifest:** `manifest.json` (V3)
*   **Background Service Worker:** `background.js` - Handles API requests (`login`, `create_todo`) and session cookie checks to keep the extension authenticated.
*   **Content Script:** `content.js` - Injected into all pages. Handles text selection detection, floating icon rendering, and the "Create New Task" form UI.
*   **Popup:** `popup/` - HTML/JS/CSS for the extension popup menu.

## Building and Running

This project uses vanilla JavaScript and does not require a build process.

1.  **Load in Chrome:**
    *   Open Chrome and navigate to `chrome://extensions/`.
    *   Enable **Developer mode** (top right).
    *   Click **Load unpacked**.
    *   Select the root directory of this project (`/Volumes/jonaed/enhancivity-corp/extension`).

2.  **Testing:**
    *   **Login:** Ensure you are logged in at `https://enhancivity.com` (or `localhost:3000` for dev). Open the extension popup to verify the "Connected" status.
    *   **Create Task:** Go to any webpage, select a block of text (at least 20 words). A floating icon should appear. Click it to test the task creation form.

## Development Conventions

*   **Style:** Vanilla JavaScript (ES6+). No external frameworks (React/Vue/etc.) are currently used.
*   **Styling:**
    *   `popup.css` for the popup.
    *   Inline styles are currently used within `content.js` for the injected form and icon to ensure isolation and ease of injection.
*   **Communication:** Uses `chrome.runtime.sendMessage` to communicate between the content script/popup and the background worker (which handles the actual API calls).
*   **API:**
    *   Production: `https://api.enhancivity.com`
    *   Localhost fallback: `http://localhost:3000`

## Key Files

*   `manifest.json`: Extension configuration.
*   `background.js`: Central logic for API communication and auth.
*   `content.js`: UI injection and text selection logic.
*   `popup/popup.js`: Logic for the popup UI.
