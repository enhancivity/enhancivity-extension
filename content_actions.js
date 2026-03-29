// ============================================================
// Enhancivity DOM Action Executor
//
// Injected on-demand via chrome.scripting.executeScript()
// Receives action steps from background.js and executes DOM
// operations (fill fields, click elements, read text).
//
// Security guards:
//   - Refuses to interact with sensitive fields (passwords, CC)
//   - Refuses to click dangerous buttons (Send, Pay, Submit)
//   - Max 5-second wait cap
// ============================================================

(() => {
  'use strict';

  // ── HTML Sanitization ─────────────────────────────────────

  function escapeHtml(str) {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ── Sensitive Field Detection ──────────────────────────────

  const SENSITIVE_SELECTORS = [
    'input[type="password"]',
    'input[autocomplete*="cc-"]',
    'input[autocomplete*="credit"]',
    'input[autocomplete="current-password"]',
    'input[autocomplete="new-password"]',
    'input[name*="cardnumber"]',
    'input[name*="card-number"]',
    'input[name*="card_number"]',
    'input[name*="cvv"]',
    'input[name*="cvc"]',
    'input[name*="ssn"]',
    'input[name*="social-security"]',
    'input[name*="routing"]',
    'input[name*="account-number"]',
  ];

  function isSensitiveField(selector) {
    try {
      const el = document.querySelector(selector);
      if (!el) return false;
      for (const sens of SENSITIVE_SELECTORS) {
        if (el.matches(sens)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ── Dangerous Click Detection ──────────────────────────────

  const DANGEROUS_BUTTON_TEXT = [
    'send', 'submit', 'pay', 'purchase', 'buy now',
    'place order', 'confirm order', 'complete purchase',
    'checkout', 'place your order',
  ];

  function isDangerousClick(el) {
    const text = (el.innerText || el.value || el.textContent || '').toLowerCase().trim();
    return DANGEROUS_BUTTON_TEXT.some(d => text.includes(d));
  }

  // ── Action Executors ───────────────────────────────────────

  const EXECUTORS = {

    async fill_field(step) {
      if (!step.selector) {
        return { success: false, error: 'No selector provided for fill_field' };
      }
      if (isSensitiveField(step.selector)) {
        return { success: false, error: 'BLOCKED_SENSITIVE', blocked: true };
      }

      const el = document.querySelector(step.selector);
      if (!el) {
        return { success: false, error: `Element not found: ${step.selector}` };
      }

      const value = step.value != null ? String(step.value) : '';

      // ── INTERACTION ENGINE (if loaded) ──
      // The Universal Interaction Engine handles React, custom dropdowns, autocomplete,
      // masked inputs, and contenteditable with better strategies than legacy fill.
      // If available, use it and return early. Falls through to legacy code if not loaded.
      if (window.__enhInteractionEngine && typeof window.__enhInteractionEngine.fillField === 'function') {
        try {
          const engineResult = await window.__enhInteractionEngine.fillField(el, value);
          return { success: engineResult.success, error: engineResult.success ? undefined : engineResult.reason };
        } catch (engineErr) {
          console.debug('[fill_field] InteractionEngine threw:', engineErr.message, '— falling through to legacy');
        }
      }

      el.focus();

      // ── Checkbox / Radio ────────────────────────────────────────────────────
      if (el.type === 'checkbox' || el.type === 'radio') {
        el.checked = /^(true|yes|on|1|checked)$/i.test(value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };
      }

      // ── Select ──────────────────────────────────────────────────────────────
      if (el.tagName === 'SELECT') {
        el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };
      }

      // ── ContentEditable (ProseMirror, Lexical, Slate, rich editors) ─────────
      // Rich editors intercept `beforeinput` to apply changes to their internal
      // document model — the event must fire BEFORE the DOM mutates.
      // Tier 1: execCommand('insertText') fires the native sequence in real browsers.
      // Tier 2: synthetic InputEvent sequence — deterministic fallback when
      //         execCommand is unavailable (MV3 sandbox, DevTools, headless contexts).
      if (el.isContentEditable) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        const inserted = document.execCommand('insertText', false, value);
        if (!inserted) {
          // Synthetic beforeinput → DOM mutation → input sequence
          const beforeEv = new InputEvent('beforeinput', {
            bubbles: true, cancelable: true,
            inputType: 'insertText', data: value,
          });
          el.dispatchEvent(beforeEv);
          if (!beforeEv.defaultPrevented) {
            el.textContent = value;
          }
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        }
        return { success: true };
      }

      // ── Standard Input / Textarea — nativeSetter path ───────────────────────
      // React / Vue 3 / Angular override the element's own `value` property with
      // a controlled setter that records the value in framework state but does NOT
      // write it to the DOM (deferred until re-render). The native setter on the
      // prototype always writes directly to the DOM.
      // Step 1: native setter → DOM reflects the new value.
      // Step 2: InputEvent with inputType:'insertText' → framework event listener
      //         syncs internal state from the now-updated DOM value.
      const proto = el.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const nativeDescriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (nativeDescriptor && nativeDescriptor.set) {
        nativeDescriptor.set.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      return { success: true };
    },

    click(step) {
      if (!step.selector) {
        return { success: false, error: 'No selector provided for click' };
      }

      const el = document.querySelector(step.selector);
      if (!el) {
        return { success: false, error: `Element not found: ${step.selector}` };
      }

      if (isDangerousClick(el)) {
        return { success: false, error: 'BLOCKED_DANGEROUS_CLICK', blocked: true };
      }

      el.click();
      return { success: true };
    },

    read_element(step) {
      if (!step.selector) {
        return { success: false, error: 'No selector provided for read_element' };
      }

      const el = document.querySelector(step.selector);
      if (!el) {
        return { success: true, value: '' };
      }

      return { success: true, value: (el.innerText || '').trim().slice(0, 3000) };
    },

    highlight(step) {
      if (!step.selector) {
        return { success: false, error: 'No selector provided for highlight' };
      }

      const el = document.querySelector(step.selector);
      if (!el) {
        return { success: false, error: `Element not found: ${step.selector}` };
      }

      // Scroll into view
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Add glowing outline (preserve originals for cleanup)
      const origOutline    = el.style.outline;
      const origOffset     = el.style.outlineOffset;
      const origTransition = el.style.transition;
      const origBoxShadow  = el.style.boxShadow;

      el.style.transition    = 'outline 0.3s ease, box-shadow 0.3s ease';
      el.style.outline       = '3px solid #6366f1';
      el.style.outlineOffset = '3px';
      el.style.boxShadow     = '0 0 12px rgba(99, 102, 241, 0.4)';

      // Auto-remove after 4 seconds
      setTimeout(() => {
        el.style.outline       = origOutline;
        el.style.outlineOffset = origOffset;
        el.style.transition    = origTransition;
        el.style.boxShadow     = origBoxShadow;
      }, 4000);

      return { success: true };
    },

    wait(step) {
      const ms = Math.min(parseInt(step.value) || 1000, 5000);
      return new Promise(resolve =>
        setTimeout(() => resolve({ success: true }), ms)
      );
    },
  };

  // ── Message Listener ───────────────────────────────────────

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.type !== 'execute_dom_action') return;

    const step = request.step;
    if (!step || !step.action) {
      sendResponse({ success: false, error: 'Invalid action step' });
      return true;
    }

    const executor = EXECUTORS[step.action];
    if (!executor) {
      sendResponse({ success: false, error: `Unknown action: ${step.action}` });
      return true;
    }

    const result = executor(step);

    // Handle async actions (wait)
    if (result instanceof Promise) {
      result.then(sendResponse);
      return true;
    }

    sendResponse(result);
    return true;
  });
})();
