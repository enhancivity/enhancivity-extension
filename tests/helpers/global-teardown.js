'use strict';

const fs = require('fs');
const path = require('path');

const BG_PATH = path.resolve(__dirname, '..', '..', 'background.js');
const BACKUP_PATH = path.resolve(__dirname, '..', '.background-backup.js');
const MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'manifest.json');
const MANIFEST_BACKUP_PATH = path.resolve(__dirname, '..', '.manifest-backup.json');

module.exports = async function globalTeardown() {
  // Restore the original background.js from backup
  if (fs.existsSync(BACKUP_PATH)) {
    const original = fs.readFileSync(BACKUP_PATH, 'utf8');
    fs.writeFileSync(BG_PATH, original, 'utf8');
    fs.unlinkSync(BACKUP_PATH);
    console.log('[GlobalTeardown] Restored original background.js');
  } else {
    console.warn('[GlobalTeardown] No backup found — background.js was not restored!');
  }

  // Restore the original manifest.json from backup
  if (fs.existsSync(MANIFEST_BACKUP_PATH)) {
    const original = fs.readFileSync(MANIFEST_BACKUP_PATH, 'utf8');
    fs.writeFileSync(MANIFEST_PATH, original, 'utf8');
    fs.unlinkSync(MANIFEST_BACKUP_PATH);
    console.log('[GlobalTeardown] Restored original manifest.json');
  }
};
