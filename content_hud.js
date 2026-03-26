// ============================================================
// Enhancivity Progress HUD & Consent Overlay
//
// Injected on-demand via chrome.scripting.executeScript()
// Provides:
//   1. Progress HUD — vertical step tracker with status animations
//   2. Trust Section — shows domain trustBadge + trustScore
//   3. Consent Modal — pauses Ghost-Driver until user approves
//   4. Indigo Glow — highlights target element during consent
//
// Communication:
//   background.js → chrome.tabs.sendMessage → this script
//   Message types: hud_show, hud_update, hud_trust, hud_consent, hud_hide
// ============================================================

(() => {
  'use strict';

  // Prevent double-injection
  if (window.__enhHudLoaded) return;
  window.__enhHudLoaded = true;

  // ─── CSS Injection ──────────────────────────────────────

  const STYLES = `
    #enh-agent-hud {
      position: fixed;
      top: 16px;
      right: 16px;
      width: 320px;
      max-height: 90vh;
      background: #1a1a2e;
      border: 1px solid #2a2a45;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(99, 102, 241, 0.1);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #e8e8f0;
      z-index: 2147483647;
      overflow: hidden;
      transition: opacity 0.3s ease, transform 0.3s ease;
      opacity: 0;
      transform: translateY(-8px);
    }
    #enh-agent-hud.enh-visible {
      opacity: 1;
      transform: translateY(0);
    }

    /* Header */
    .enh-hud-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 16px;
      background: #1e1e32;
      border-bottom: 1px solid #2a2a45;
    }
    .enh-hud-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #6366f1;
      animation: enh-pulse 1.5s ease-in-out infinite;
    }
    .enh-hud-dot.enh-dot-success { background: #22c55e; animation: none; }
    .enh-hud-dot.enh-dot-error { background: #ef4444; animation: none; }
    @keyframes enh-pulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.5); }
      50% { opacity: 0.7; box-shadow: 0 0 0 6px rgba(99, 102, 241, 0); }
    }
    .enh-hud-title {
      font-size: 13px;
      font-weight: 600;
      flex: 1;
    }
    .enh-hud-close {
      background: none;
      border: none;
      color: #6a6a85;
      cursor: pointer;
      font-size: 16px;
      padding: 0 4px;
      line-height: 1;
    }
    .enh-hud-close:hover { color: #e8e8f0; }

    /* Steps */
    .enh-hud-steps {
      padding: 12px 16px;
      max-height: 300px;
      overflow-y: auto;
    }
    .enh-hud-step {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 8px 0;
      position: relative;
    }
    .enh-hud-step:not(:last-child)::after {
      content: '';
      position: absolute;
      left: 9px;
      top: 28px;
      bottom: -4px;
      width: 2px;
      background: #2a2a45;
    }
    .enh-hud-step.enh-step-success:not(:last-child)::after { background: #22c55e; }
    .enh-hud-step.enh-step-processing:not(:last-child)::after { background: #6366f1; }

    .enh-step-icon {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 10px;
      font-weight: 700;
      background: #2a2a45;
      color: #6a6a85;
      transition: all 0.3s ease;
    }
    .enh-step-processing .enh-step-icon {
      background: #6366f1;
      color: white;
      animation: enh-pulse 1.5s ease-in-out infinite;
    }
    .enh-step-success .enh-step-icon {
      background: #22c55e;
      color: white;
    }
    .enh-step-error .enh-step-icon {
      background: #ef4444;
      color: white;
    }

    .enh-step-content {
      flex: 1;
      min-width: 0;
    }
    .enh-step-label {
      font-size: 12px;
      font-weight: 500;
      color: #9595b0;
      transition: color 0.3s ease;
    }
    .enh-step-processing .enh-step-label { color: #e8e8f0; }
    .enh-step-success .enh-step-label { color: #9595b0; }
    .enh-step-error .enh-step-label { color: #ef4444; }

    .enh-step-detail {
      font-size: 11px;
      color: #6a6a85;
      margin-top: 2px;
    }

    /* Trust Section */
    .enh-hud-trust {
      display: none;
      padding: 10px 16px;
      border-top: 1px solid #2a2a45;
      background: #1e1e32;
    }
    .enh-hud-trust.enh-trust-visible { display: flex; align-items: center; gap: 10px; }

    .enh-trust-badge {
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
    }
    .enh-trust-verified   { background: rgba(34, 197, 94, 0.12); color: #22c55e; }
    .enh-trust-aggregator { background: rgba(99, 102, 241, 0.12); color: #818cf8; }
    .enh-trust-caution    { background: rgba(245, 158, 11, 0.12); color: #f59e0b; }
    .enh-trust-rejected   { background: rgba(239, 68, 68, 0.12); color: #ef4444; }

    .enh-trust-score {
      font-size: 12px;
      color: #9595b0;
      margin-left: auto;
    }
    .enh-trust-label {
      font-size: 11px;
      color: #6a6a85;
    }

    /* Footer */
    .enh-hud-footer {
      display: none;
      padding: 12px 16px;
      border-top: 1px solid #2a2a45;
      gap: 8px;
    }
    .enh-hud-footer.enh-footer-visible { display: flex; }

    .enh-hud-btn {
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: all 0.15s ease;
    }
    .enh-btn-approve {
      background: #6366f1;
      color: white;
      flex: 1;
    }
    .enh-btn-approve:hover { background: #818cf8; }
    .enh-btn-cancel {
      background: transparent;
      color: #9595b0;
      border: 1px solid #2a2a45;
    }
    .enh-btn-cancel:hover { color: #e8e8f0; border-color: #3a3a55; }

    /* Consent Overlay */
    #enh-consent-overlay {
      position: fixed;
      inset: 0;
      background: rgba(15, 15, 26, 0.6);
      z-index: 2147483646;
      display: none;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(2px);
    }
    #enh-consent-overlay.enh-overlay-visible { display: flex; }

    .enh-consent-card {
      background: #1a1a2e;
      border: 1px solid #6366f1;
      border-radius: 12px;
      padding: 24px;
      max-width: 400px;
      width: 90%;
      box-shadow: 0 8px 32px rgba(99, 102, 241, 0.2);
      text-align: center;
    }
    .enh-consent-icon {
      font-size: 32px;
      margin-bottom: 12px;
    }
    .enh-consent-title {
      font-size: 16px;
      font-weight: 600;
      color: #e8e8f0;
      margin-bottom: 8px;
    }
    .enh-consent-message {
      font-size: 13px;
      color: #9595b0;
      line-height: 1.5;
      margin-bottom: 20px;
    }
    .enh-consent-actions {
      display: flex;
      gap: 10px;
      justify-content: center;
    }
    .enh-consent-actions .enh-hud-btn { min-width: 100px; }

    /* Indigo Glow (applied to target elements during consent) */
    .enh-indigo-glow {
      outline: 3px solid #6366f1 !important;
      outline-offset: 3px !important;
      box-shadow: 0 0 20px rgba(99, 102, 241, 0.5), 0 0 40px rgba(99, 102, 241, 0.2) !important;
      transition: outline 0.3s ease, box-shadow 0.3s ease !important;
    }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = STYLES;
  document.head.appendChild(styleEl);

  // ─── HUD DOM Construction ───────────────────────────────

  const hud = document.createElement('div');
  hud.id = 'enh-agent-hud';
  hud.innerHTML = `
    <div class="enh-hud-header">
      <div class="enh-hud-dot" id="enh-hud-dot"></div>
      <span class="enh-hud-title">Enhancivity Agent</span>
      <button class="enh-hud-close" id="enh-hud-close">&times;</button>
    </div>
    <div class="enh-hud-steps" id="enh-hud-steps"></div>
    <div class="enh-hud-trust" id="enh-hud-trust">
      <span class="enh-trust-badge" id="enh-trust-badge"></span>
      <span class="enh-trust-label" id="enh-trust-label"></span>
      <span class="enh-trust-score" id="enh-trust-score"></span>
    </div>
    <div class="enh-hud-footer" id="enh-hud-footer">
      <button class="enh-hud-btn enh-btn-approve" id="enh-btn-approve">Approve &amp; Execute</button>
      <button class="enh-hud-btn enh-btn-cancel" id="enh-btn-cancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(hud);

  // Consent Overlay
  const overlay = document.createElement('div');
  overlay.id = 'enh-consent-overlay';
  overlay.innerHTML = `
    <div class="enh-consent-card">
      <div class="enh-consent-icon" id="enh-consent-icon"></div>
      <div class="enh-consent-title" id="enh-consent-title">Agent Confirmation</div>
      <div class="enh-consent-message" id="enh-consent-message"></div>
      <div class="enh-consent-actions">
        <button class="enh-hud-btn enh-btn-approve" id="enh-consent-approve">Approve &amp; Execute</button>
        <button class="enh-hud-btn enh-btn-cancel" id="enh-consent-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // ─── State ──────────────────────────────────────────────

  const steps = [];          // [{id, label, status, detail}]
  let consentResolver = null; // Promise resolver for consent modal
  let glowingElements = [];   // Elements currently glowing

  // ─── Close Button ───────────────────────────────────────

  document.getElementById('enh-hud-close').addEventListener('click', () => {
    hideHud();
    // If consent is pending, treat close as cancel
    if (consentResolver) {
      consentResolver({ approved: false, reason: 'closed' });
      consentResolver = null;
      hideConsentOverlay();
    }
  });

  // ─── Footer Buttons (alternative approve/cancel) ────────

  document.getElementById('enh-btn-approve').addEventListener('click', () => {
    if (consentResolver) {
      consentResolver({ approved: true });
      consentResolver = null;
      hideConsentOverlay();
      hideFooter();
    }
  });

  document.getElementById('enh-btn-cancel').addEventListener('click', () => {
    if (consentResolver) {
      consentResolver({ approved: false, reason: 'cancelled' });
      consentResolver = null;
      hideConsentOverlay();
      hideFooter();
    }
  });

  // ─── Consent Overlay Buttons ────────────────────────────

  document.getElementById('enh-consent-approve').addEventListener('click', () => {
    if (consentResolver) {
      consentResolver({ approved: true });
      consentResolver = null;
      hideConsentOverlay();
      hideFooter();
    }
  });

  document.getElementById('enh-consent-cancel').addEventListener('click', () => {
    if (consentResolver) {
      consentResolver({ approved: false, reason: 'cancelled' });
      consentResolver = null;
      hideConsentOverlay();
      hideFooter();
    }
  });

  // ─── HUD Functions ─────────────────────────────────────

  function showHud(taskTitle) {
    steps.length = 0;
    document.getElementById('enh-hud-steps').innerHTML = '';
    document.getElementById('enh-hud-trust').classList.remove('enh-trust-visible');
    hideFooter();

    const dot = document.getElementById('enh-hud-dot');
    dot.className = 'enh-hud-dot';

    if (taskTitle) {
      document.querySelector('.enh-hud-title').textContent = taskTitle;
    }

    hud.classList.add('enh-visible');
  }

  function hideHud() {
    hud.classList.remove('enh-visible');
    clearGlow();
  }

  function addStep(id, label) {
    const existing = steps.find(s => s.id === id);
    if (existing) return; // Already exists

    const step = { id, label, status: 'pending', detail: '' };
    steps.push(step);
    renderSteps();
  }

  function updateStep(id, status, detail) {
    const step = steps.find(s => s.id === id);
    if (!step) {
      // Auto-add if not yet registered
      steps.push({ id, label: id, status, detail: detail || '' });
    } else {
      step.status = status;
      if (detail) step.detail = detail;
    }
    renderSteps();
    updateHeaderDot();
  }

  function renderSteps() {
    const container = document.getElementById('enh-hud-steps');
    container.innerHTML = '';

    steps.forEach((step, i) => {
      const el = document.createElement('div');
      el.className = `enh-hud-step enh-step-${step.status}`;

      const iconText = step.status === 'success' ? '\u2713'
                     : step.status === 'error'   ? '!'
                     : step.status === 'processing' ? '\u25B6'
                     : (i + 1);

      el.innerHTML = `
        <div class="enh-step-icon">${iconText}</div>
        <div class="enh-step-content">
          <div class="enh-step-label">${escHtml(step.label)}</div>
          ${step.detail ? `<div class="enh-step-detail">${escHtml(step.detail)}</div>` : ''}
        </div>
      `;
      container.appendChild(el);
    });
  }

  function updateHeaderDot() {
    const dot = document.getElementById('enh-hud-dot');
    const hasError = steps.some(s => s.status === 'error');
    const allDone = steps.every(s => s.status === 'success');

    if (hasError) {
      dot.className = 'enh-hud-dot enh-dot-error';
    } else if (allDone && steps.length > 0) {
      dot.className = 'enh-hud-dot enh-dot-success';
    } else {
      dot.className = 'enh-hud-dot';
    }
  }

  // ─── Trust Section ──────────────────────────────────────

  function showTrust(trustBadge, trustScore, siteName) {
    const trustEl = document.getElementById('enh-hud-trust');
    const badgeEl = document.getElementById('enh-trust-badge');
    const labelEl = document.getElementById('enh-trust-label');
    const scoreEl = document.getElementById('enh-trust-score');

    const badgeLabels = {
      verified: 'Verified',
      aggregator: 'Aggregator',
      caution: 'Caution',
      rejected: 'Rejected',
    };

    badgeEl.textContent = badgeLabels[trustBadge] || trustBadge;
    badgeEl.className = `enh-trust-badge enh-trust-${trustBadge}`;
    labelEl.textContent = siteName || '';
    scoreEl.textContent = trustScore ? `Trust: ${trustScore}/10` : '';

    trustEl.classList.add('enh-trust-visible');
  }

  // ─── Footer ─────────────────────────────────────────────

  function showFooter() {
    document.getElementById('enh-hud-footer').classList.add('enh-footer-visible');
  }

  function hideFooter() {
    document.getElementById('enh-hud-footer').classList.remove('enh-footer-visible');
  }

  // ─── Consent Overlay ───────────────────────────────────

  function showConsentOverlay(message, targetSelector, requestId = null) {
    const msgEl = document.getElementById('enh-consent-message');
    const iconEl = document.getElementById('enh-consent-icon');
    const titleEl = document.getElementById('enh-consent-title');

    msgEl.textContent = message || 'The agent wants to perform an action on this page.';
    iconEl.textContent = '\u26A1'; // lightning bolt
    titleEl.textContent = 'Agent Confirmation';

    overlay.classList.add('enh-overlay-visible');

    // Show the footer approve/cancel in the HUD as well
    showFooter();

    // Apply indigo glow to target element
    if (targetSelector) {
      applyGlow(targetSelector);
    }

    // Return a promise that resolves when user approves or cancels.
    // The resolver is wrapped so it also writes to chrome.storage.session when
    // requestId is provided — this is how the background SW (which may have been
    // suspended while waiting) gets woken up via storage.onChanged.
    return new Promise((resolve) => {
      consentResolver = (result) => {
        if (requestId) {
          chrome.storage.session.set({ [`hudConsentResult_${requestId}`]: result }).catch(() => {});
          chrome.storage.session.remove(['hudConsentPending']).catch(() => {});
        }
        resolve(result);
      };
    });
  }

  function hideConsentOverlay() {
    overlay.classList.remove('enh-overlay-visible');
    clearGlow();
  }

  // ─── Indigo Glow ───────────────────────────────────────

  function applyGlow(selector) {
    clearGlow();
    try {
      const el = document.querySelector(selector);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('enh-indigo-glow');
        glowingElements.push(el);
      }
    } catch {
      // Invalid selector — skip
    }
  }

  function clearGlow() {
    glowingElements.forEach(el => {
      el.classList.remove('enh-indigo-glow');
    });
    glowingElements = [];
  }

  // ─── Helpers ────────────────────────────────────────────

  function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ─── Message Listener ──────────────────────────────────

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (!request.type?.startsWith('hud_')) return;

    switch (request.type) {

      case 'hud_show': {
        // Show the HUD with optional task title and initial steps
        const { taskTitle, initialSteps } = request;
        showHud(taskTitle || 'Enhancivity Agent');
        if (Array.isArray(initialSteps)) {
          initialSteps.forEach(s => addStep(s.id, s.label));
        }
        sendResponse({ success: true });
        break;
      }

      case 'hud_update': {
        // Update a step's status: pending → processing → success/error
        const { stepId, status, label, detail } = request;
        if (label) addStep(stepId, label);
        updateStep(stepId, status, detail);
        sendResponse({ success: true });
        break;
      }

      case 'hud_trust': {
        // Show trust information for the current site
        const { trustBadge, trustScore, siteName } = request;
        showTrust(trustBadge, trustScore, siteName);
        sendResponse({ success: true });
        break;
      }

      case 'hud_consent': {
        // Result delivered via chrome.storage.session — no sendResponse needed
        const { message, targetSelector, requestId } = request;
        showConsentOverlay(message, targetSelector, requestId);
        break;  // NOT return true
      }

      case 'hud_hide': {
        hideHud();
        sendResponse({ success: true });
        break;
      }

      default:
        sendResponse({ success: false, error: `Unknown HUD message: ${request.type}` });
    }

    return true;
  });

  console.log('[Enhancivity] Progress HUD loaded.');
})();
