'use strict';

const fs = require('fs');
const path = require('path');

const BG_PATH = path.resolve(__dirname, '..', '..', 'background.js');
const BACKUP_PATH = path.resolve(__dirname, '..', '.background-backup.js');
const MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'manifest.json');
const MANIFEST_BACKUP_PATH = path.resolve(__dirname, '..', '.manifest-backup.json');

module.exports = async function globalSetup() {
  // ── Patch background.js: API_BASE → localhost:3099 ──
  const original = fs.readFileSync(BG_PATH, 'utf8');

  // Guard: if already patched (file stuck from a previous run where teardown didn't execute),
  // skip both the backup write and the patch. Writing a backup of localhost:3099 would cause
  // teardown to "restore" to localhost:3099, permanently breaking the file.
  if (original.includes("const API_BASE = 'http://localhost:3099'")) {
    console.warn('[GlobalSetup] WARNING: background.js already at localhost:3099 — skipping patch. Restore to localhost:3001 before running tests.');
  } else {
    fs.writeFileSync(BACKUP_PATH, original, 'utf8');

    const patched = original.replace(
      /const API_BASE = ['"]https?:\/\/[^'"]+['"]/,
      "const API_BASE = 'http://localhost:3099'"
    );

    if (patched === original) {
      console.warn('[GlobalSetup] WARNING: API_BASE patch did not match — background.js may already be patched or format changed.');
    } else {
      console.log('[GlobalSetup] Patched API_BASE → localhost:3099');
    }

    fs.writeFileSync(BG_PATH, patched, 'utf8');
  }

  // ── Patch manifest.json: add localhost:3099 to host_permissions + bridge content_scripts ──
  const manifestOriginal = fs.readFileSync(MANIFEST_PATH, 'utf8');
  fs.writeFileSync(MANIFEST_BACKUP_PATH, manifestOriginal, 'utf8');

  const manifest = JSON.parse(manifestOriginal);
  const testOrigin = 'http://localhost:3099/*';

  if (!manifest.host_permissions.includes(testOrigin)) {
    manifest.host_permissions.push(testOrigin);
    console.log('[GlobalSetup] Patched manifest.json — added localhost:3099 to host_permissions');
  }

  // Allow dashboard_bridge.js to run on test harness pages (http://localhost:3099/*)
  // so we can test the real window.postMessage → bridge → storage delegation chain.
  const bridgeEntry = manifest.content_scripts?.find(cs => cs.js?.includes('dashboard_bridge.js'));
  if (bridgeEntry && !bridgeEntry.matches.includes(testOrigin)) {
    bridgeEntry.matches.push(testOrigin);
    console.log('[GlobalSetup] Patched manifest.json — added localhost:3099 to dashboard_bridge content_scripts');
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
};
