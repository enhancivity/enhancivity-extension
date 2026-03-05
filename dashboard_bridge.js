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

  // ─── Helper: ensure floating panel is injected on this page ──
  async function ensurePanelInjected() {
    if (window.__enhPanelLoaded) {
      console.log('[Bridge] Panel already loaded on this page');
      return true;
    }

    // Ask background to inject panel CSS + JS into this tab
    console.log('[Bridge] Requesting panel injection from background...');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'inject_panel_here' });
      console.log('[Bridge] Injection response:', response);
      if (!response?.success) return false;

      // Wait for panel to initialize
      await new Promise(r => setTimeout(r, 800));
      console.log('[Bridge] Panel injection wait complete, __enhPanelLoaded:', !!window.__enhPanelLoaded);
      return !!window.__enhPanelLoaded;
    } catch (err) {
      console.error('[Bridge] Panel injection failed:', err.message);
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
    // 1. Ensure the floating panel is injected on this page
    // 2. Send auto-fill payload directly via window.postMessage (same page)
    if (event.data.type === 'DELEGATE_TASK') {
      const payload = event.data.payload;
      console.log('[Bridge] Handling DELEGATE_TASK:', payload?.taskTitle);

      // Ensure panel is on the page
      let panelReady = false;
      try {
        panelReady = await ensurePanelInjected();
      } catch (err) {
        if (err.message?.includes('Extension context invalidated')) {
          console.warn('[Bridge] Extension was reloaded — page needs refresh');
          alert('Enhancivity extension was updated. Please refresh this page (Ctrl+R) and try again.');
          return;
        }
        console.error('[Bridge] Panel injection error:', err.message);
      }

      if (!panelReady) {
        console.error('[Bridge] Could not inject panel — delegation aborted');
        return;
      }

      // Send auto-fill directly to panel via window.postMessage
      // (both bridge and panel are content scripts on the same page)
      console.log('[Bridge] Sending auto-fill to panel via window.postMessage');
      window.postMessage({
        type: 'ENHANCIVITY_DELEGATE_AUTOFILL',
        source: BRIDGE_SOURCE,
        payload,
      }, '*');
    }

    // ── BRIEFING_ACTION: Briefing dynamic action button ──
    // 1. Ensure the floating panel is injected on this page
    // 2. Send the actionIntent as an auto-fill prompt to the panel
    if (event.data.type === 'BRIEFING_ACTION') {
      const payload = event.data.payload;
      console.log('[Bridge] Handling BRIEFING_ACTION:', payload?.buttonText, '| Intent:', payload?.actionIntent);

      let panelReady = false;
      try {
        panelReady = await ensurePanelInjected();
      } catch (err) {
        if (err.message?.includes('Extension context invalidated')) {
          console.warn('[Bridge] Extension was reloaded — page needs refresh');
          alert('Enhancivity extension was updated. Please refresh this page (Ctrl+R) and try again.');
          return;
        }
        console.error('[Bridge] Panel injection error:', err.message);
      }

      if (!panelReady) {
        console.error('[Bridge] Could not inject panel — briefing action aborted');
        return;
      }

      // Send briefing action to panel via window.postMessage
      console.log('[Bridge] Sending briefing action to panel via window.postMessage');
      window.postMessage({
        type: 'ENHANCIVITY_BRIEFING_ACTION',
        source: BRIDGE_SOURCE,
        payload,
      }, '*');
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
