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
  fs.writeFileSync(BACKUP_PATH, original, 'utf8');

  const patched = original.replace(
    /const API_BASE = ['"]http:\/\/localhost:3001['"]/,
    "const API_BASE = 'http://localhost:3099'"
  );

  if (patched === original) {
    console.warn('[GlobalSetup] WARNING: API_BASE patch did not match — background.js may already be patched or format changed.');
  } else {
    console.log('[GlobalSetup] Patched API_BASE → localhost:3099');
  }

  fs.writeFileSync(BG_PATH, patched, 'utf8');

  // ── Patch manifest.json: add localhost:3099 to host_permissions ──
  const manifestOriginal = fs.readFileSync(MANIFEST_PATH, 'utf8');
  fs.writeFileSync(MANIFEST_BACKUP_PATH, manifestOriginal, 'utf8');

  const manifest = JSON.parse(manifestOriginal);
  const testOrigin = 'http://localhost:3099/*';
  if (!manifest.host_permissions.includes(testOrigin)) {
    manifest.host_permissions.push(testOrigin);
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
    console.log('[GlobalSetup] Patched manifest.json — added localhost:3099 to host_permissions');
  }
};
