// ============================================================
// Enhancivity Dashboard Bridge — Content Script
// Runs on enhancivity.com/* pages
// Bridges window.postMessage ↔ chrome.runtime.sendMessage
// ============================================================

(() => {
  'use strict';

  const DASHBOARD_SOURCE = 'enhancivity-dashboard';
  const BRIDGE_SOURCE    = 'enhancivity-bridge';

  // ─── Dashboard → Extension ──────────────────────────────
  // The dashboard fires GHOST_DRIVE_TASK via window.postMessage.
  // This bridge relays it to the background service worker.

  window.addEventListener('message', (event) => {
    // Only accept messages from the same window (dashboard page)
    if (event.source !== window) return;
    if (!event.data?.type || event.data?.source !== DASHBOARD_SOURCE) return;

    if (event.data.type === 'GHOST_DRIVE_TASK') {
      console.log('[Bridge] Relaying GHOST_DRIVE_TASK to background:', event.data.payload?.taskTitle);

      chrome.runtime.sendMessage({
        type: 'ghost_drive_task',
        payload: event.data.payload,
      }).catch((err) => {
        console.error('[Bridge] Failed to relay to background:', err.message);
      });
    }
  });

  // ─── Extension → Dashboard ──────────────────────────────
  // Background sends TASK_COMPLETE or TASK_FAILED via chrome.tabs.sendMessage.
  // This bridge relays them to the dashboard page via window.postMessage.

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'TASK_COMPLETE') {
      console.log('[Bridge] Relaying TASK_COMPLETE to dashboard:', message.payload?.taskId);

      window.postMessage({
        type: 'TASK_COMPLETE',
        source: BRIDGE_SOURCE,
        payload: message.payload,
      }, '*');

      sendResponse({ received: true });
    }

    if (message.type === 'TASK_FAILED') {
      console.log('[Bridge] Relaying TASK_FAILED to dashboard:', message.payload?.taskId);

      window.postMessage({
        type: 'TASK_FAILED',
        source: BRIDGE_SOURCE,
        payload: message.payload,
      }, '*');

      sendResponse({ received: true });
    }
  });

  console.log('[Enhancivity] Dashboard bridge loaded.');
})();
