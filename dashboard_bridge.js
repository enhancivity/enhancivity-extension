// ============================================================
// Enhancivity Dashboard Bridge — Content Script
// Runs on enhancivity.com/* pages
// Bridges window.postMessage ↔ chrome.runtime.sendMessage
// ============================================================

(() => {
  'use strict';

  const DASHBOARD_SOURCE = 'enhancivity-dashboard';
  const BRIDGE_SOURCE    = 'enhancivity-bridge';

  console.log('[Bridge] Dashboard bridge loading on:', window.location.href);

  // ─── Helper: ensure side panel is open ──
  async function ensureSidePanelOpen() {
    console.log('[Bridge] Requesting side panel open from background...');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'inject_panel_here' });
      console.log('[Bridge] Side panel open response:', response);
      if (!response?.success) return false;

      // Wait for side panel to initialize
      await new Promise(r => setTimeout(r, 600));
      return true;
    } catch (err) {
      console.error('[Bridge] Side panel open failed:', err.message);
      return false;
    }
  }

  // ─── Dashboard → Extension ──────────────────────────────
  window.addEventListener('message', async (event) => {
    // Only accept messages from the same window (dashboard page)
    if (event.source !== window) return;
    if (!event.data?.type || event.data?.source !== DASHBOARD_SOURCE) return;

    console.log('[Bridge] Received message from dashboard:', event.data.type);

    if (event.data.type === 'GHOST_DRIVE_TASK') {
      console.log('[Bridge] Relaying GHOST_DRIVE_TASK to background:', event.data.payload?.taskTitle);

      chrome.runtime.sendMessage({
        type: 'ghost_drive_task',
        payload: event.data.payload,
      }).catch((err) => {
        console.error('[Bridge] Failed to relay to background:', err.message);
      });
    }

    // ── DELEGATE_TASK: Dashboard "Delegate" button ──
    // 1. Ensure the side panel is open
    // 2. Send auto-fill payload via chrome.runtime.sendMessage (side panel listens)
    if (event.data.type === 'DELEGATE_TASK') {
      const payload = event.data.payload;
      console.log('[Bridge] Handling DELEGATE_TASK:', payload?.taskTitle);

      let panelReady = false;
      try {
        panelReady = await ensureSidePanelOpen();
      } catch (err) {
        if (err.message?.includes('Extension context invalidated')) {
          console.warn('[Bridge] Extension was reloaded — page needs refresh');
          alert('Enhancivity extension was updated. Please refresh this page (Ctrl+R) and try again.');
          return;
        }
        console.error('[Bridge] Side panel open error:', err.message);
      }

      if (!panelReady) {
        console.error('[Bridge] Could not open side panel — delegation aborted');
        return;
      }

      // Send auto-fill to side panel via chrome.runtime.sendMessage
      console.log('[Bridge] Sending auto-fill to side panel via runtime message');
      chrome.runtime.sendMessage({
        type: 'enh_delegate_autofill',
        payload,
      }).catch(err => console.error('[Bridge] Auto-fill send failed:', err.message));
    }

    // ── BRIEFING_ACTION: Briefing dynamic action button ──
    // 1. Ensure the side panel is open
    // 2. Send the actionIntent via chrome.runtime.sendMessage (side panel listens)
    if (event.data.type === 'BRIEFING_ACTION') {
      const payload = event.data.payload;
      console.log('[Bridge] Handling BRIEFING_ACTION:', payload?.buttonText, '| Intent:', payload?.actionIntent);

      let panelReady = false;
      try {
        panelReady = await ensureSidePanelOpen();
      } catch (err) {
        if (err.message?.includes('Extension context invalidated')) {
          console.warn('[Bridge] Extension was reloaded — page needs refresh');
          alert('Enhancivity extension was updated. Please refresh this page (Ctrl+R) and try again.');
          return;
        }
        console.error('[Bridge] Side panel open error:', err.message);
      }

      if (!panelReady) {
        console.error('[Bridge] Could not open side panel — briefing action aborted');
        return;
      }

      // Send briefing action to side panel via chrome.runtime.sendMessage
      console.log('[Bridge] Sending briefing action to side panel via runtime message');
      chrome.runtime.sendMessage({
        type: 'ENHANCIVITY_BRIEFING_ACTION',
        source: BRIDGE_SOURCE,
        payload,
      }).catch(err => console.error('[Bridge] Briefing action send failed:', err.message));
    }
  });

  // ─── Extension → Dashboard ──────────────────────────────
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
