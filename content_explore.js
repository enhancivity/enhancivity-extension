// ============================================================
// Enhancivity Exploration Agent — Content Script
//
// Injected on-demand via chrome.scripting.executeScript()
// Provides DOM actions for the EXPLORE agentic loop:
//   click_by_sid, read_by_sid, scroll_to_sid, scroll_page,
//   extract_visible_text, take_snapshot
//
// Security guards (inherited from content_actions.js):
//   - Refuses to click dangerous buttons (Send, Pay, Submit)
//   - Refuses to interact with sensitive fields (passwords, CC)
//   - No file uploads, no form submissions
// ============================================================

(() => {
  'use strict';

  // Prevent double-injection
  if (window.__enhExploreInjected) return;
  window.__enhExploreInjected = true;

  // ── Safety Guards ───────────────────────────────────────────

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

  const DANGEROUS_BUTTON_TEXT = [
    'send', 'submit', 'pay', 'purchase', 'buy now',
    'place order', 'confirm order', 'complete purchase',
    'checkout', 'place your order', 'delete', 'remove',
  ];

  function isSensitiveElement(el) {
    if (!el) return false;
    for (const sel of SENSITIVE_SELECTORS) {
      try { if (el.matches(sel)) return true; } catch {}
    }
    return false;
  }

  function isDangerousClick(el) {
    const text = (el.innerText || el.value || el.textContent || '').toLowerCase().trim();
    return DANGEROUS_BUTTON_TEXT.some(d => text.includes(d));
  }

  // ── Helper: Find element by semantic ID ─────────────────────

  function findBySid(sid) {
    return document.querySelector(`[data-enh-sid="${sid}"]`);
  }

  // ── Recovery Helper: Quick snapshot of available elements ───
  // Called when an action fails due to missing element, so the AI
  // knows what IS available and can self-correct on the next step.

  function getRecoverySnapshot() {
    const MAX_RECOVERY = 20; // Keep compact — just enough for alternatives
    const elements = [];
    let counter = 0;

    function classify(node) {
      const tag = node.tagName;
      if (tag === 'BUTTON' || node.getAttribute('role') === 'button') return 'button';
      if (tag === 'A') return 'link';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return 'input';
      return null;
    }

    function getText(node) {
      return (node.innerText || node.textContent || node.value ||
              node.getAttribute('aria-label') || node.getAttribute('title') ||
              node.getAttribute('placeholder') || '').trim().slice(0, 80);
    }

    function walk(node) {
      if (elements.length >= MAX_RECOVERY || !node || !node.tagName) return;
      const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','IFRAME','CANVAS','TEMPLATE']);
      if (SKIP.has(node.tagName)) return;

      const type = classify(node);
      const text = getText(node);
      if (type && text) {
        const sid = node.getAttribute('data-enh-sid') || `${type.slice(0,4)}-${counter++}`;
        try { node.setAttribute('data-enh-sid', sid); } catch {}
        elements.push(`[${sid}] ${type}: "${text}"`);
      }
      for (const child of node.children) walk(child);
    }

    walk(document.body);
    return elements.length
      ? `\nAVAILABLE ELEMENTS ON PAGE:\n${elements.join('\n')}`
      : '\nNo interactable elements found on this page.';
  }

  // ── Exploration Actions ─────────────────────────────────────

  const EXPLORE_ACTIONS = {

    click_by_sid({ target }) {
      if (!target) return { success: false, error: 'No semantic ID provided for click' };

      const el = findBySid(target);
      if (!el) {
        return {
          success: false,
          error: `Element not found: ${target}. The element may have been removed or the page changed.${getRecoverySnapshot()}`,
        };
      }

      if (isSensitiveElement(el)) {
        return { success: false, error: 'BLOCKED: Sensitive field — cannot interact', blocked: true };
      }
      if (isDangerousClick(el)) {
        return { success: false, error: 'BLOCKED: Dangerous button — cannot click', blocked: true };
      }

      // Refuse file upload inputs
      if (el.tagName === 'INPUT' && el.type === 'file') {
        return { success: false, error: 'BLOCKED: File upload — cannot interact', blocked: true };
      }

      // Scroll into view first
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Brief highlight before click
      const origOutline = el.style.outline;
      el.style.outline = '2px solid #6366f1';
      setTimeout(() => { el.style.outline = origOutline; }, 1500);

      el.click();

      // Read what's nearby after click for observation
      const parentText = (el.parentElement?.innerText || '').trim().slice(0, 300);
      return {
        success: true,
        observation: `Clicked "${(el.innerText || el.textContent || '').trim().slice(0, 100)}". Nearby text: ${parentText}`,
      };
    },

    read_by_sid({ target }) {
      if (!target) return { success: false, error: 'No semantic ID provided for read' };

      const el = findBySid(target);
      if (!el) {
        return {
          success: false,
          error: `Element not found: ${target}. Cannot read — element may have been removed or page changed.${getRecoverySnapshot()}`,
        };
      }

      const text = (el.innerText || el.textContent || '').trim().slice(0, 3000);
      return { success: true, observation: text || '(empty element)' };
    },

    type_text({ target, value }) {
      if (!target) return { success: false, error: 'No semantic ID provided for type_text' };
      if (!value) return { success: false, error: 'No text value provided to type' };

      const el = findBySid(target);
      if (!el) {
        return {
          success: false,
          error: `Element not found: ${target}. Cannot type — element may have been removed or the page changed.${getRecoverySnapshot()}`,
        };
      }

      if (isSensitiveElement(el)) {
        return { success: false, error: 'BLOCKED: Sensitive field — cannot type into password/payment fields', blocked: true };
      }

      // Focus and clear existing value
      el.focus();
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));

      // Type the text
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      // Highlight briefly
      const origOutline = el.style.outline;
      el.style.outline = '2px solid #6366f1';
      setTimeout(() => { el.style.outline = origOutline; }, 1500);

      return {
        success: true,
        observation: `Typed "${value.slice(0, 80)}" into ${el.tagName.toLowerCase()}${el.placeholder ? ` (placeholder: "${el.placeholder}")` : ''}`,
      };
    },

    scroll_to_sid({ target }) {
      if (!target) return { success: false, error: 'No semantic ID provided for scroll' };

      const el = findBySid(target);
      if (!el) {
        return {
          success: false,
          error: `Element not found: ${target}. Cannot scroll to it — element may have been removed.${getRecoverySnapshot()}`,
        };
      }

      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return { success: true, observation: `Scrolled to element "${(el.innerText || '').trim().slice(0, 80)}"` };
    },

    scroll_page({ target }) {
      const direction = (target || 'down').toLowerCase();
      const amount = direction === 'up' ? -window.innerHeight * 0.8 : window.innerHeight * 0.8;
      window.scrollBy({ top: amount, behavior: 'smooth' });

      const scrollPos = Math.round(window.scrollY);
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      const pct = maxScroll > 0 ? Math.round((scrollPos / maxScroll) * 100) : 100;
      return {
        success: true,
        observation: `Scrolled ${direction}. Position: ${pct}% of page.`,
      };
    },

    extract_visible_text({ value }) {
      const maxChars = parseInt(value) || 2000;

      // Skip non-content elements
      const SKIP_TAGS = new Set([
        'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IFRAME', 'CANVAS',
        'VIDEO', 'AUDIO', 'IMG', 'PICTURE', 'SOURCE', 'TEMPLATE',
        'BR', 'HR', 'META', 'LINK', 'NAV', 'FOOTER', 'HEADER',
      ]);

      const parts = [];
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
            if (parent.offsetWidth === 0 && parent.offsetHeight === 0) return NodeFilter.FILTER_REJECT;
            const text = node.textContent.trim();
            if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          },
        }
      );

      let totalLen = 0;
      while (walker.nextNode() && totalLen < maxChars) {
        const text = walker.currentNode.textContent.trim();
        parts.push(text);
        totalLen += text.length;
      }

      const content = parts.join(' ').slice(0, maxChars);
      return {
        success: true,
        observation: content || '(no visible text found)',
      };
    },

    take_snapshot() {
      // Build a compact semantic map (top 50 elements)
      const MAX_ELEMENTS = 50;
      const elements = [];
      let counter = 0;

      function classifyElement(node) {
        const tag = node.tagName;
        if (tag === 'BUTTON' || node.getAttribute('role') === 'button') return 'button';
        if (tag === 'A') return 'link';
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return 'input';
        return null;
      }

      function getElementText(node) {
        return (node.innerText || node.textContent || node.value ||
                node.getAttribute('aria-label') || node.getAttribute('title') ||
                node.getAttribute('placeholder') || '').trim().slice(0, 120);
      }

      function walk(node) {
        if (elements.length >= MAX_ELEMENTS) return;
        if (!node || !node.tagName) return;

        const tag = node.tagName;
        const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','IFRAME','CANVAS','TEMPLATE']);
        if (SKIP.has(tag)) return;

        const type = classifyElement(node);
        const text = getElementText(node);

        if (type && text) {
          const sid = `${type.slice(0, 4)}-${counter++}`;
          try { node.setAttribute('data-enh-sid', sid); } catch {}

          const attrs = {};
          if (node.href) attrs.href = node.href.slice(0, 200);
          if (node.name) attrs.name = node.name;
          if (node.type) attrs.type = node.type;
          if (node.getAttribute('aria-label')) attrs.ariaLabel = node.getAttribute('aria-label');

          // Get context from parent
          const parentText = node.parentElement
            ? (node.parentElement.innerText || '').trim().slice(0, 80)
            : '';

          elements.push({ sid, type, text, attrs, context: parentText });
        }

        for (const child of node.children) {
          walk(child);
        }
      }

      walk(document.body);

      // Also extract visible text (compact)
      const visibleText = EXPLORE_ACTIONS.extract_visible_text({ value: '2000' });

      // Login page detection — requires 2+ signals to avoid false positives
      function detectLoginPage() {
        const hasPasswordField = !!document.querySelector('input[type="password"]');

        const LOGIN_PATTERNS = [
          'sign in', 'log in', 'login', 'signin', 'log on',
          'create account', 'register', 'join now', 'get started',
        ];
        const buttons = document.querySelectorAll(
          'button, input[type="submit"], a[role="button"], [role="button"]'
        );
        let hasLoginButton = false;
        for (const btn of buttons) {
          const text = (btn.innerText || btn.value || btn.textContent || '').toLowerCase().trim();
          if (LOGIN_PATTERNS.some(p => text.includes(p))) {
            hasLoginButton = true;
            break;
          }
        }

        const hasLoginForm = hasPasswordField &&
          !!document.querySelector('input[type="email"], input[type="text"], input[name*="user"], input[name*="email"]');

        return (hasPasswordField && hasLoginButton) || hasLoginForm;
      }

      return {
        success: true,
        observation: 'Page snapshot taken.',
        snapshot: {
          url: location.href,
          title: document.title || '',
          mainContent: visibleText.observation || '',
          semanticElements: elements,
          isLoginPage: detectLoginPage(),
        },
      };
    },

    wait({ value }) {
      const ms = Math.min(parseInt(value) || 1000, 3000);
      return new Promise(resolve =>
        setTimeout(() => resolve({ success: true, observation: `Waited ${ms}ms.` }), ms)
      );
    },
  };

  // ── Message Listener ────────────────────────────────────────

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.type !== 'explore_action') return;

    const { actionType, target, value } = request;

    // Map action types to handlers
    const handlerMap = {
      'click_element': 'click_by_sid',
      'read_element':  'read_by_sid',
      'type_text':     'type_text',
      'scroll':        'scroll_page',
      'scroll_to':     'scroll_to_sid',
      'scrape_page':   'extract_visible_text',
      'wait':          'wait',
      'take_snapshot': 'take_snapshot',
    };

    const handlerName = handlerMap[actionType] || actionType;
    const handler = EXPLORE_ACTIONS[handlerName];

    if (!handler) {
      sendResponse({ success: false, error: `Unknown explore action: ${actionType}` });
      return true;
    }

    const result = handler({ target, value });

    // Handle async actions (wait)
    if (result instanceof Promise) {
      result.then(sendResponse);
      return true;
    }

    sendResponse(result);
    return true;
  });
})();
