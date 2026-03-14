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

  // ─── Helper: ensure side panel is open & listener ready ──
  async function ensureSidePanelOpen() {
    console.log('[Bridge] Requesting side panel open from background...');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'inject_panel_here' });
      console.log('[Bridge] Side panel open response:', response);
      if (!response?.success) return false;

      // Poll until side panel's message listener is alive (up to 3s)
      for (let attempt = 0; attempt < 6; attempt++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const ping = await chrome.runtime.sendMessage({ type: 'enh_sidepanel_ping' });
          if (ping?.alive) {
            console.log('[Bridge] Side panel confirmed alive after', (attempt + 1) * 500, 'ms');
            return true;
          }
        } catch { /* not ready yet */ }
      }

      // Fallback: panel opened but ping never answered — proceed anyway
      console.warn('[Bridge] Side panel opened but ping not answered — proceeding with delay');
      return true;
    } catch (err) {
      console.error('[Bridge] Side panel open failed:', err.message);
      return false;
    }
  }

  // ─── Helper: show toast notification on dashboard page ──
  function showDashboardToast(message, type = 'error') {
    const existing = document.getElementById('enh-bridge-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'enh-bridge-toast';
    toast.textContent = message;
    const bgColor = type === 'error' ? 'rgba(239, 68, 68, 0.9)' : 'rgba(99, 102, 241, 0.9)';
    toast.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:99999;padding:12px 20px;border-radius:10px;background:${bgColor};color:#fff;font-size:13px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;backdrop-filter:blur(8px);box-shadow:0 4px 12px rgba(0,0,0,0.3);transition:opacity 0.3s;`;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 4000);
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
        showDashboardToast('Could not open Enhancivity panel. Make sure the extension is installed and try again.');
        return;
      }

      // Send auto-fill to side panel via chrome.runtime.sendMessage
      console.log('[Bridge] Sending auto-fill to side panel via runtime message');
      try {
        const fillRes = await chrome.runtime.sendMessage({
          type: 'enh_delegate_autofill',
          payload,
        });
        if (fillRes?.ok) {
          showDashboardToast('Task sent to Enhancivity — check the side panel', 'info');
        } else {
          showDashboardToast('Side panel is open but could not auto-fill. Try typing the task manually.');
        }
      } catch (err) {
        console.error('[Bridge] Auto-fill send failed:', err.message);
        showDashboardToast('Could not send task to side panel. Try again.');
      }
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
        showDashboardToast('Could not open Enhancivity panel. Make sure the extension is installed and try again.');
        return;
      }

      // Send briefing action to side panel via chrome.runtime.sendMessage
      console.log('[Bridge] Sending briefing action to side panel via runtime message');
      try {
        const actionRes = await chrome.runtime.sendMessage({
          type: 'ENHANCIVITY_BRIEFING_ACTION',
          source: BRIDGE_SOURCE,
          payload,
        });
        if (!actionRes?.ok) {
          showDashboardToast('Side panel is open but action could not be sent. Try again.');
        }
      } catch (err) {
        console.error('[Bridge] Briefing action send failed:', err.message);
        showDashboardToast('Could not send action to side panel. Try again.');
      }
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
