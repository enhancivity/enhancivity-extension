# Enhancivity Memory Layer Extension

Open-source Chrome extension for using Enhancivity project memory from the browser.

The extension lets users sign in, choose a project memory space, review prepared context, insert context into AI/work tools, and capture useful project knowledge for later review.

## Supervised Capture 2.0.6

This early-user release supports complete, self-contained short-text highlights. Capture proposes editable memories; you must open and review the complete original, approve the current edited memory, and then save. Editing a proposal invalidates its previous approval. Capture never saves these proposals unattended.

Use a verified Enhancivity account that has been enabled for the supervised beta. New accounts must complete normal email verification and be enrolled before using this beta build. For an unpacked installation, use email/password sign-in. Long or fragmented sources and connected-source ingestion are outside this release.

If you already use an unpacked installation, replace its files from this repository and press **Reload** on its card at `chrome://extensions/`. Keep the same folder to retain the extension identity and stored login.

## What Is Open Source

This repository contains only the browser extension code.

The Enhancivity backend, memory engine, hosted API, database, and production infrastructure are proprietary and are not included in this repository.

## Install From GitHub

1. Open this repository on GitHub.
2. Click **Code** and then **Download ZIP**.
3. Extract the ZIP on your computer.
4. Open Chrome and go to `chrome://extensions/`.
5. Turn on **Developer mode**.
6. Click **Load unpacked**.
7. Select the extracted extension folder that contains `manifest.json`.

The Enhancivity icon should appear in Chrome. Pin it from the extensions menu if you want it visible all the time.

## Build A Minimal Unpacked Folder

The repository root can be loaded directly as an unpacked extension. To create a smaller release folder with only runtime files:

```bash
npm install
npm run build:memory-layer
```

Then load this folder in Chrome:

```text
dist/memory-layer-extension
```

## Features

- Sign in with an Enhancivity account.
- Select a project or local memory space.
- Review prepared project context before inserting it.
- Insert approved context into supported browser surfaces.
- Capture candidate memory from the current page for review.
- Save provider keys through the hosted Enhancivity API when enabled for the account.

## Privacy

- The extension stores the signed-in session token in Chrome extension storage.
- Project memory requests are sent to the hosted Enhancivity API.
- The backend API and memory engine are closed source.
- Users should only install the extension from a repository or release they trust.

## Development

```bash
npm install
npm run build:memory-layer
```

Optional smoke tests require local services and Playwright setup:

```bash
npm test
```

## License

MIT. See [LICENSE](LICENSE).
