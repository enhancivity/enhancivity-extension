'use strict';

const fs = require('fs');
const path = require('path');

const BG_PATH = path.resolve(__dirname, '..', '..', 'background.js');
const BACKUP_PATH = path.resolve(__dirname, '..', '.background-backup.js');

module.exports = async function globalSetup() {
  // Read the original background.js
  const original = fs.readFileSync(BG_PATH, 'utf8');

  // Save backup for teardown
  fs.writeFileSync(BACKUP_PATH, original, 'utf8');

  // Patch API_BASE from localhost:3001 to localhost:3099 (mock server)
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
};
