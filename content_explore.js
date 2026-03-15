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

  // Extended sensitive field patterns — checked against name, id, placeholder, aria-label
  const SENSITIVE_FIELD_PATTERNS = [
    'password', 'passwd', 'secret', 'credential',
    'ssn', 'cvv', 'cvc', 'card-number', 'credit-card',
    'cardnumber', 'securitycode', 'security-code',
  ];
  // NOTE: 'pass' removed — too broad, matches "passport", "bypass", "payment_pass", etc.
  // NOTE: 'pin' removed — too broad, matches "pinned", "opinion", "shopping", etc.
  // 'password' and 'passwd' still catch actual password fields.

  // Auth form action URL patterns — inputs inside these forms are sensitive
  const AUTH_FORM_ACTION_PATTERNS = [
    'signin', 'login', 'auth', 'authenticate', 'oauth',
  ];

  // Login/auth URL patterns — if the page URL matches ANY of these,
  // ALL type_text and fill_field actions are blocked on the entire page.
  const LOGIN_URL_PATTERNS = [
    'signin', 'sign-in', 'login', 'log-in', '/auth/', '/oauth', '/sso',
    '/ap/signin', '/accounts/login', '/servicelogin', '/session/new',
    '/users/sign_in', '/account/login', '/authenticate',
    '/uc/login', '/id/signin', '/idp/login',
  ];

  // Known auth provider domains — these are ALWAYS auth pages
  const AUTH_PROVIDER_DOMAINS = [
    'accounts.google.com', 'login.microsoftonline.com', 'login.live.com',
    'auth0.com', 'okta.com', 'login.yahoo.com', 'appleid.apple.com',
    'id.atlassian.com', 'login.salesforce.com', 'sso.godaddy.com',
  ];

  function isLoginPage() {
    const url = window.location.href.toLowerCase();
    const hasLoginURL = LOGIN_URL_PATTERNS.some(p => url.includes(p));
    const hasPasswordField = document.querySelector('input[type="password"]') !== null;
    return hasLoginURL || hasPasswordField;
  }

  // ── AuthGateDetector ─────────────────────────────────────────
  // Comprehensive auth page detection using DOM, URL, and text signals.
  // Returns { isAuthPage, signals, authType } where authType is one of:
  //   'login', 'two_factor', 'oauth', 'captcha', 'account_creation'
  // A page must match 2+ signals to be classified as an auth page
  // (prevents false positives on pages that merely have a "Sign in" link).

  const AuthGateDetector = {
    detect() {
      const signals = [];
      let authType = null;

      // ── DOM Signals ──────────────────────────────────────────
      const hasPasswordField = !!document.querySelector('input[type="password"]');
      if (hasPasswordField) signals.push('password_field');

      // Login form: both email/username AND password fields in same form or page
      const hasEmailOrUsername = !!document.querySelector(
        'input[type="email"], input[autocomplete="username"], input[autocomplete="email"], ' +
        'input[name*="user"], input[name*="email"], input[name*="login"], input[id*="email"], input[id*="user"]'
      );
      if (hasPasswordField && hasEmailOrUsername) {
        signals.push('login_form');
        authType = 'login';
      }

      // OAuth buttons
      const oauthPatterns = [
        'sign in with google', 'continue with google', 'log in with google',
        'sign in with facebook', 'continue with facebook', 'log in with facebook',
        'sign in with apple', 'continue with apple', 'log in with apple',
        'sign in with microsoft', 'continue with microsoft',
        'sign in with github', 'continue with github',
        'sign in with twitter', 'sign in with sso', 'single sign-on',
      ];
      const allButtons = document.querySelectorAll('button, a[role="button"], [role="button"], a');
      for (const btn of allButtons) {
        const text = (btn.innerText || btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase().trim();
        if (oauthPatterns.some(p => text.includes(p))) {
          signals.push('oauth_button');
          if (!authType) authType = 'oauth';
          break;
        }
      }

      // CAPTCHA detection
      const hasCaptcha = !!(
        document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[title*="recaptcha"]') ||
        document.querySelector('[class*="captcha"], [id*="captcha"], [class*="recaptcha"], [class*="hcaptcha"]') ||
        document.querySelector('[data-sitekey]')
      );
      if (hasCaptcha) {
        signals.push('captcha');
        if (!authType) authType = 'captcha';
      }

      // Two-factor / verification prompts
      const twoFactorPatterns = [
        'verification code', 'enter the code', 'authenticator app',
        '2-step verification', 'two-factor', 'two-step', 'verify your identity',
        'security code', 'confirm your identity', 'enter the 6-digit',
        'we sent a code', 'check your email for a code', 'sms code',
      ];
      const bodyText = (document.body?.innerText || '').toLowerCase().slice(0, 5000);
      for (const pattern of twoFactorPatterns) {
        if (bodyText.includes(pattern)) {
          signals.push('two_factor_prompt');
          authType = 'two_factor';
          break;
        }
      }

      // "Create account" / "Sign up" near login form (reinforces that this is an auth page)
      const signupPatterns = ['create account', 'sign up', 'register', 'join now', 'get started', 'new to'];
      for (const btn of allButtons) {
        const text = (btn.innerText || btn.textContent || '').toLowerCase().trim();
        if (signupPatterns.some(p => text.includes(p))) {
          // Only count as signal if there's also a password field or login form
          if (hasPasswordField || hasEmailOrUsername) {
            signals.push('signup_link_near_login');
          }
          break;
        }
      }

      // ── URL Signals ──────────────────────────────────────────
      const url = window.location.href.toLowerCase();
      const hostname = window.location.hostname.toLowerCase();

      if (LOGIN_URL_PATTERNS.some(p => url.includes(p))) {
        signals.push('login_url_pattern');
        if (!authType) authType = 'login';
      }

      if (AUTH_PROVIDER_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) {
        signals.push('auth_provider_domain');
        if (!authType) authType = 'login';
      }

      // Query params with auth indicators
      const searchParams = window.location.search.toLowerCase();
      if (/[?&](login|signin|auth|redirect|return_to|next=)/.test(searchParams)) {
        signals.push('auth_query_params');
      }

      // ── Text/Title Signals ───────────────────────────────────
      const titlePatterns = ['sign in', 'log in', 'login', 'signin', 'welcome back',
        'enter your password', 'verify your identity', 'authentication required'];
      const pageTitle = (document.title || '').toLowerCase();
      if (titlePatterns.some(p => pageTitle.includes(p))) {
        signals.push('auth_page_title');
        if (!authType) authType = 'login';
      }

      // Check H1/H2 headings (primary purpose of the page)
      const headings = document.querySelectorAll('h1, h2');
      for (const h of headings) {
        const text = (h.innerText || h.textContent || '').toLowerCase().trim();
        if (titlePatterns.some(p => text.includes(p))) {
          signals.push('auth_heading');
          if (!authType) authType = 'login';
          break;
        }
      }

      // ── Decision: require 2+ signals to avoid false positives ──
      const isAuthPage = signals.length >= 2;
      return {
        isAuthPage,
        signals,
        authType: isAuthPage ? (authType || 'login') : null,
        signalCount: signals.length,
      };
    },
  };

  // ── SessionContextValidator ──────────────────────────────────
  // Detects the active account on multi-account platforms.
  // Returns { platform, activeAccount, accountIndex, allAccounts, canAutoSwitch }

  const SessionContextValidator = {
    detectActiveAccount() {
      const url = window.location.href;
      const hostname = window.location.hostname.toLowerCase();

      // ── Google Products (Gmail, Drive, Ads, Calendar, YouTube) ──
      if (hostname.includes('google.com') || hostname.includes('gmail.com') || hostname.includes('youtube.com')) {
        return this._detectGoogle(url, hostname);
      }

      // ── Facebook / Meta ──
      if (hostname.includes('facebook.com') || hostname.includes('meta.com')) {
        return this._detectFacebook();
      }

      // ── AWS Console ──
      if (hostname.includes('aws.amazon.com') || hostname.includes('console.aws')) {
        return this._detectAWS();
      }

      // ── Microsoft / Outlook / Office 365 ──
      if (hostname.includes('live.com') || hostname.includes('office.com') || hostname.includes('microsoft.com')) {
        return this._detectMicrosoft();
      }

      // ── Generic: look for common account indicators ──
      return this._detectGeneric();
    },

    _detectGoogle(url, hostname) {
      const result = { platform: 'google', activeAccount: null, accountIndex: null, allAccounts: [], canAutoSwitch: true };

      // Extract account index from URL: /u/0/, /u/1/, etc.
      const indexMatch = url.match(/\/u\/(\d+)\//);
      result.accountIndex = indexMatch ? parseInt(indexMatch[1]) : 0;

      // Try reading the profile email from the page
      // Google products show the account email in the profile button or account switcher
      const profileSelectors = [
        'a[aria-label*="Google Account"]',          // Gmail, Drive
        '[data-identifier]',                         // Google account switcher
        'header [data-email]',                       // Some Google products
        '.gb_A .gb_F',                              // Google bar email
      ];

      for (const sel of profileSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el) {
            const email = el.getAttribute('data-identifier') || el.getAttribute('data-email') ||
              el.getAttribute('aria-label')?.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0];
            if (email) {
              result.activeAccount = email.toLowerCase();
              break;
            }
          }
        } catch {}
      }

      // Try to find all accounts from the account switcher
      try {
        const accountItems = document.querySelectorAll('[data-identifier]');
        for (const item of accountItems) {
          const email = item.getAttribute('data-identifier');
          if (email && !result.allAccounts.includes(email.toLowerCase())) {
            result.allAccounts.push(email.toLowerCase());
          }
        }
      } catch {}

      // Gmail-specific: check the "From" field in compose window
      if (hostname.includes('mail.google.com')) {
        try {
          const fromField = document.querySelector('[name="from"], [aria-label*="From"]');
          if (fromField) {
            const fromEmail = (fromField.value || fromField.textContent || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            if (fromEmail) result.composingAs = fromEmail[0].toLowerCase();
          }
        } catch {}
      }

      return result;
    },

    _detectFacebook() {
      const result = { platform: 'facebook', activeAccount: null, accountIndex: null, allAccounts: [], canAutoSwitch: false };

      // Profile name from navigation
      try {
        const profileLink = document.querySelector('[aria-label="Your profile"], [data-pagelet="ProfileTileNav"] a, a[href*="/me"]');
        if (profileLink) {
          result.activeAccount = (profileLink.textContent || profileLink.getAttribute('aria-label') || '').trim();
        }
      } catch {}

      // Business Manager: check for account ID in URL or account selector
      try {
        const urlMatch = window.location.href.match(/act=(\d+)|business_id=(\d+)/);
        if (urlMatch) {
          result.businessAccountId = urlMatch[1] || urlMatch[2];
        }
        const accountSelector = document.querySelector('[data-testid="account-selector"], [aria-label*="Ad Account"]');
        if (accountSelector) {
          result.businessAccount = (accountSelector.textContent || '').trim().slice(0, 100);
        }
      } catch {}

      return result;
    },

    _detectAWS() {
      const result = { platform: 'aws', activeAccount: null, accountIndex: null, allAccounts: [], canAutoSwitch: false };

      try {
        // AWS shows account ID and IAM user in the top nav
        const accountMenu = document.querySelector('[data-testid="aws-nav-account-menu"], #nav-usernameMenu, [data-analytics-selector="account-menu"]');
        if (accountMenu) {
          const text = (accountMenu.textContent || '').trim();
          result.activeAccount = text.slice(0, 100);
          // Extract account ID (12-digit number)
          const accountIdMatch = text.match(/\d{4}-?\d{4}-?\d{4}/);
          if (accountIdMatch) result.awsAccountId = accountIdMatch[0];
        }
      } catch {}

      return result;
    },

    _detectMicrosoft() {
      const result = { platform: 'microsoft', activeAccount: null, accountIndex: null, allAccounts: [], canAutoSwitch: false };

      try {
        const profileBtn = document.querySelector('#mectrl_headerPicture, [data-signedinuser], #O365_HeaderRightRegion .o365cs-me');
        if (profileBtn) {
          const email = profileBtn.getAttribute('data-signedinuser') ||
            profileBtn.getAttribute('aria-label')?.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0];
          if (email) result.activeAccount = email.toLowerCase();
        }
      } catch {}

      return result;
    },

    _detectGeneric() {
      const result = { platform: 'unknown', activeAccount: null, accountIndex: null, allAccounts: [], canAutoSwitch: false };

      // Look for common profile/account indicators in navigation
      const profileSelectors = [
        'nav [class*="profile"], nav [class*="user"], header [class*="profile"], header [class*="user"]',
        '[class*="avatar"], [class*="Avatar"]',
        '[aria-label*="account" i], [aria-label*="profile" i]',
      ];

      for (const sel of profileSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el) {
            // Try extracting email
            const emailMatch = (el.textContent || el.getAttribute('aria-label') || '')
              .match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            if (emailMatch) {
              result.activeAccount = emailMatch[0].toLowerCase();
              break;
            }
            // Fall back to profile name
            const name = (el.textContent || el.getAttribute('aria-label') || '').trim();
            if (name && name.length > 1 && name.length < 60) {
              result.activeAccount = name;
              break;
            }
          }
        } catch {}
      }

      return result;
    },
  };

  function isSensitiveElement(el) {
    if (!el) return false;
    // Check CSS selectors
    for (const sel of SENSITIVE_SELECTORS) {
      try { if (el.matches(sel)) return true; } catch {}
    }
    // Check name/id/placeholder/aria-label against patterns
    const fieldAttrs = [
      (el.name || '').toLowerCase(),
      (el.id || '').toLowerCase(),
      (el.placeholder || '').toLowerCase(),
      (el.getAttribute('aria-label') || '').toLowerCase(),
    ].join(' ');
    if (SENSITIVE_FIELD_PATTERNS.some(p => fieldAttrs.includes(p))) return true;
    // Check if inside an auth form
    const form = el.closest('form');
    if (form) {
      const action = (form.action || '').toLowerCase();
      if (AUTH_FORM_ACTION_PATTERNS.some(p => action.includes(p))) return true;
    }
    return false;
  }

  // ── Dangerous button detection ──────────────────────────────
  // Two tiers:
  //   EXACT  — button text must be EXACTLY this (e.g., "post", "send", "submit")
  //            This prevents blocking "Create Post", "Post Launch", etc.
  //   PHRASE — button text must CONTAIN this phrase (multi-word = specific enough)
  const DANGEROUS_EXACT = new Set([
    'send', 'submit', 'post', 'publish', 'pay', 'delete', 'remove',
  ]);
  const DANGEROUS_PHRASE = [
    'purchase', 'buy now', 'place order', 'confirm order',
    'complete purchase', 'checkout', 'place your order',
  ];

  function isDangerousClick(el) {
    const text = (el.innerText || el.value || el.textContent || '').toLowerCase().trim();
    // Exact match — the ENTIRE button text must be one of these single words
    if (DANGEROUS_EXACT.has(text)) return true;
    // Phrase match — button text contains a multi-word dangerous phrase
    if (DANGEROUS_PHRASE.some(d => text.includes(d))) return true;
    return false;
  }

  // ── Helper: Find element by semantic ID ─────────────────────

  function findBySid(sid) {
    // First try the fast path (element in light DOM)
    const el = document.querySelector(`[data-enh-sid="${sid}"]`);
    if (el) return el;

    // If not found, search inside shadow roots (Reddit Shreddit, Salesforce, etc.)
    function searchShadow(root) {
      if (!root) return null;
      const children = root.querySelectorAll('*');
      for (const child of children) {
        if (child.getAttribute('data-enh-sid') === sid) return child;
        if (child.shadowRoot) {
          const found = searchShadow(child.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    }

    // Walk all shadow roots in the document
    const allElements = document.querySelectorAll('*');
    for (const elem of allElements) {
      if (elem.shadowRoot) {
        const found = searchShadow(elem.shadowRoot);
        if (found) return found;
      }
    }
    return null;
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

  // ── Page Type Classifier (URL-based, no DOM/DB needed) ────────
  // Ported from siteMapService.js detectPageType() for snapshot enrichment.
  function detectPageType(url) {
    if (!url) return 'other';
    const path = url.replace(/^https?:\/\/[^/]+/, '').toLowerCase();
    if (!path || path === '/' || path === '/index.html' || path === '/home') return 'homepage';
    if (/[?&](q|query|search|keyword|k|s|term|searchTerm|_nkw)=/i.test(url)) return 'search_results';
    if (/\/(search|results|find|browse|s\?)/.test(path)) return 'search_results';
    if (/\/(product|item|dp|listing|gp\/product|ip)\//i.test(path)) return 'product_detail';
    if (/\/(p|pd|products)\/[a-z0-9-]+/i.test(path)) return 'product_detail';
    if (/\/(checkout|cart|basket|bag|order|payment)/i.test(path)) return 'checkout';
    if (/\/(account|profile|settings|preferences|dashboard|my-)/i.test(path)) return 'account';
    if (/\/(login|signin|sign-in|auth|sso|oauth)/i.test(path)) return 'auth';
    return 'other';
  }

  // ── Exploration Actions ─────────────────────────────────────

  const EXPLORE_ACTIONS = {

    click_by_sid({ target, consentApproved }) {
      if (!target) return { success: false, error: 'No semantic ID provided for click' };

      const el = findBySid(target);
      if (!el) {
        return {
          success: false,
          error: `Element not found: ${target}. The element may have been removed or the page changed.${getRecoverySnapshot()}`,
        };
      }

      // SECURITY: On login pages, only allow clicking sign-in/login/create-account buttons
      if (isLoginPage()) {
        const ALLOWED_LOGIN_CLICKS = ['sign in', 'signin', 'log in', 'login', 'create account', 'register', 'sign up', 'signup', 'continue', 'next'];
        const elText = (el.innerText || el.value || el.textContent || '').toLowerCase().trim();
        const isAllowedClick = ALLOWED_LOGIN_CLICKS.some(p => elText.includes(p));
        if (!isAllowedClick) {
          return { success: false, error: 'LOGIN_PAGE_DETECTED: Agent cannot interact with login forms. Only sign-in/login buttons are allowed. User must log in manually.', blocked: true };
        }
        // Allowed login button — click it, then return pause signal
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.click();
        return {
          success: true,
          observation: `Clicked login button "${elText.slice(0, 60)}". LOGIN_PAUSE: User must now enter credentials manually.`,
          loginPause: true,
        };
      }

      if (isSensitiveElement(el)) {
        return { success: false, error: 'BLOCKED: Sensitive field — cannot interact', blocked: true };
      }

      // ANTI-EXPORT GUARD: Block clicks on Export/Download buttons and redirect AI to scrape_table.
      // Uses contains-match because button innerText may include icon text, hidden spans, etc.
      // Only applies to button-like elements (not navigation links to pages named "Export").
      const elText = (el.innerText || el.value || el.textContent || '').toLowerCase().trim();
      const isButtonLike = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' ||
        el.type === 'submit' || el.classList.contains('btn') || el.closest('button');
      if (!consentApproved && isButtonLike) {
        const EXPORT_WORDS = ['export', 'download csv', 'download xlsx', 'download report', 'export csv', 'export data', 'export all'];
        if (EXPORT_WORDS.some(w => elText.includes(w)) || elText === 'download') {
          return {
            success: false,
            error: 'ANTI-EXPORT: Do NOT click Export/Download buttons — downloaded files cannot be read by the agent. Instead, close this dialog (click Cancel or press Escape) and use scrape_table to read the data directly from the visible table. If there is pagination, scrape each page.',
            blocked: true,
          };
        }
      }

      // Dangerous button check — bypassed when user already approved via consent card
      if (!consentApproved && isDangerousClick(el)) {
        return { success: false, error: 'BLOCKED: This button performs a consequential action (submit/post/send/delete). Set needsConsent=true to request user approval first.', blocked: true };
      }

      // Refuse file upload inputs
      if (el.tagName === 'INPUT' && el.type === 'file') {
        return { success: false, error: 'BLOCKED: File upload — cannot interact', blocked: true };
      }

      // Check if button is disabled — don't click and report why
      if (el.disabled || el.getAttribute('aria-disabled') === 'true' ||
          el.classList.contains('disabled') || el.hasAttribute('disabled')) {
        const elText = (el.innerText || el.value || el.textContent || '').trim().slice(0, 60);
        return {
          success: false,
          error: `BUTTON DISABLED: "${elText}" button is currently disabled. This usually means a required field is empty (e.g., title field). Fill all required fields first, then retry clicking this button.`,
        };
      }

      // Scroll into view first
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Brief highlight before click
      const origOutline = el.style.outline;
      el.style.outline = '2px solid #6366f1';
      setTimeout(() => { el.style.outline = origOutline; }, 1500);

      // Capture DOM state before click to detect dropdown/menu appearance
      const MENU_SELECTORS = '[role="menu"], [role="listbox"], [role="dialog"], [aria-expanded="true"], [class*="dropdown"], [class*="popover"], [class*="menu-panel"], [class*="Popover"], [class*="Dropdown"], [class*="flyout"], [class*="Flyout"]';
      const visibleElementsBefore = document.querySelectorAll(MENU_SELECTORS).length;

      el.click();

      // Read what's nearby after click for observation
      const parentText = (el.parentElement?.innerText || '').trim().slice(0, 300);

      // Quick synchronous check — did a menu appear immediately?
      const visibleElementsAfter = document.querySelectorAll(MENU_SELECTORS).length;
      const menuAppeared = visibleElementsAfter > visibleElementsBefore;
      const menuHint = menuAppeared ? ' A dropdown/menu appeared after clicking.' : '';

      return {
        success: true,
        observation: `Clicked "${(el.innerText || el.textContent || '').trim().slice(0, 100)}".${menuHint} Nearby text: ${parentText}`,
        menuAppeared,
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

      const text = (el.innerText || el.textContent || '').trim().slice(0, 5000);
      return { success: true, observation: text || '(empty element)' };
    },

    async type_text({ target, value }) {
      if (!target) return { success: false, error: 'No semantic ID provided for type_text' };
      if (!value) return { success: false, error: 'No text value provided to type' };

      // ── HARD BLOCK LAYER 1: Never type on login/auth pages ──
      const currentUrl = window.location.href.toLowerCase();
      const hardLoginPatterns = ['signin', 'sign-in', 'login', 'log-in', '/auth/', '/oauth/', '/sso/', '/ap/signin', '/accounts/login', '/servicelogin', '/session/new', '/password', '/users/sign_in', '/account/login', '/authenticate', '/uc/login', '/id/signin', '/idp/login'];
      const isOnLoginPage = hardLoginPatterns.some(pattern => currentUrl.includes(pattern));
      const pageHasPasswordField = !!document.querySelector('input[type="password"]');
      const isOnAuthDomain = AUTH_PROVIDER_DOMAINS.some(d => window.location.hostname.toLowerCase() === d || window.location.hostname.toLowerCase().endsWith('.' + d));

      if (isOnLoginPage || pageHasPasswordField || isOnAuthDomain) {
        console.log('[SECURITY] BLOCKED type_text: Login/auth page detected. URL:', currentUrl, 'hasPassword:', pageHasPasswordField, 'authDomain:', isOnAuthDomain);
        return { success: false, error: 'SECURITY_BLOCK: This is a login page. The agent cannot type here. Please log in manually.', blocked: true };
      }

      // ── SMART TARGET RESOLUTION ──
      // If the SID points to a wrapper/container but there's a more specific
      // editable element inside, drill down to it. This handles cases where:
      // - A contentEditable parent wraps a <textarea> or <input> (Reddit Title)
      // - A div wrapper contains the actual ProseMirror/Slate editable child
      // - A form-group div was tagged but the real input is nested inside
      let el = findBySid(target);
      if (!el) {
        return {
          success: false,
          error: `Element not found: ${target}. Cannot type — element may have been removed or the page changed.${getRecoverySnapshot()}`,
        };
      }

      // ── SMART TARGET RESOLUTION: Find the real editable surface ──
      // When the SID points to a wrapper (web component, form group, div), drill
      // down to find the actual interactive element.
      //
      // CRITICAL ORDER: Check contentEditable FIRST, then inputs.
      // Rich text editors (ProseMirror, Slate, Draft.js) use contentEditable as
      // their primary editing surface. They may ALSO contain hidden <input> elements
      // for form submission. If we grab the hidden input, we bypass the editor's
      // state management entirely — text appears in the DOM but the editor thinks
      // the field is empty (Post button stays grayed out, form validation fails).
      // By checking contentEditable first, we always target the visible editor surface.
      const tag = el.tagName;

      function findNestedEditable(root) {
        // Search light DOM
        let found = root.querySelector('[contenteditable="true"]');
        if (found && found !== root) return found;
        // Search role=textbox (custom editors may use this instead of contenteditable attr)
        found = root.querySelector('[role="textbox"]');
        if (found && found !== root && found.isContentEditable) return found;
        // Search shadow root (Reddit shreddit-*, other web components)
        if (root.shadowRoot) {
          found = root.shadowRoot.querySelector('[contenteditable="true"]');
          if (found) return found;
          found = root.shadowRoot.querySelector('[role="textbox"]');
          if (found && found.isContentEditable) return found;
          // Recursive: search nested shadow DOMs
          for (const child of root.shadowRoot.querySelectorAll('*')) {
            if (child.shadowRoot) {
              found = findNestedEditable(child);
              if (found) return found;
            }
          }
        }
        return null;
      }

      function findNestedInput(root) {
        // Search light DOM first
        let found = root.querySelector('textarea, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="file"])');
        if (found) return found;
        // Search shadow root
        if (root.shadowRoot) {
          found = root.shadowRoot.querySelector('textarea, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="file"])');
          if (found) return found;
          // Recursive: search nested shadow DOMs
          for (const child of root.shadowRoot.querySelectorAll('*')) {
            if (child.shadowRoot) {
              found = findNestedInput(child);
              if (found) return found;
            }
          }
        }
        return null;
      }

      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        // PRIORITY 1: ContentEditable (ProseMirror, Slate, Draft.js, Lexical editors)
        // This is the visible editing surface that manages its own state.
        const nestedEditable = findNestedEditable(el);
        if (nestedEditable) {
          console.log('[type_text] Found nested contentEditable (incl shadow DOM). Switching from', tag, 'to', nestedEditable.tagName, 'class:', (typeof nestedEditable.className === 'string' ? nestedEditable.className.slice(0, 60) : ''));
          el = nestedEditable;
        } else {
          // PRIORITY 2: Standard inputs/textareas (only if no contentEditable found)
          const nestedInput = findNestedInput(el);
          if (nestedInput) {
            console.log('[type_text] Found nested input (incl shadow DOM). Switching from', tag, 'to', nestedInput.tagName, 'type:', nestedInput.type);
            el = nestedInput;
          }
        }
      }

      // ── HARD BLOCK LAYER 2: Never type in sensitive fields on ANY page ──
      const fieldType = (el.getAttribute('type') || '').toLowerCase();
      const fieldName = (el.getAttribute('name') || '').toLowerCase();
      const fieldId = (el.getAttribute('id') || '').toLowerCase();
      const fieldAutocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
      const fieldPlaceholder = (el.getAttribute('placeholder') || '').toLowerCase();
      const fieldAriaLabel = (el.getAttribute('aria-label') || '').toLowerCase();

      const sensitivePatterns = ['password', 'passwd', 'pass', 'secret', 'credential', 'pin', 'ssn', 'cvv', 'cvc', 'card-number', 'cardnumber', 'security-code', 'securitycode', 'credit-card', 'creditcard', 'social-security', 'routing', 'account-number'];

      const isSensitiveField = fieldType === 'password' ||
        sensitivePatterns.some(p => fieldName.includes(p) || fieldId.includes(p) || fieldAutocomplete.includes(p) || fieldPlaceholder.includes(p) || fieldAriaLabel.includes(p));

      if (isSensitiveField) {
        console.log('[SECURITY] BLOCKED type_text: Sensitive field detected. type:', fieldType, 'name:', fieldName, 'id:', fieldId);
        return { success: false, error: 'SECURITY_BLOCK: Cannot type in password/credential fields.', blocked: true };
      }

      if (isSensitiveElement(el)) {
        return { success: false, error: 'BLOCKED: Cannot interact with sensitive credential fields. User must enter credentials manually.', blocked: true };
      }

      // ── DIAGNOSTIC: Log element details for debugging ──
      console.log('[type_text] TARGET ELEMENT:', {
        tag: el.tagName,
        id: el.id,
        className: (typeof el.className === 'string') ? el.className.slice(0, 100) : '',
        role: el.getAttribute('role'),
        contenteditable: el.getAttribute('contenteditable'),
        isContentEditable: el.isContentEditable,
        placeholder: el.getAttribute('placeholder'),
        type: el.getAttribute('type'),
        name: el.getAttribute('name'),
        ariaLabel: el.getAttribute('aria-label'),
        sid: target,
        value: (el.value || '').slice(0, 30),
        innerText: (el.innerText || '').slice(0, 30),
      });

      // ── PRE-FLIGHT CHARACTER LIMIT ENFORCEMENT (Universal) ──
      // Detect the field's character limit from: maxlength attr, nearby counter, or aria.
      // If the text exceeds the limit, smart-truncate at a word boundary so the content
      // is COMPLETE (not chopped mid-word). This is the safety net — the AI should
      // already write within limits, but if it doesn't, we ensure graceful truncation.
      let charLimit = 0;
      const rawMaxLen = el.getAttribute('maxlength') || el.getAttribute('maxLength');
      if (rawMaxLen && parseInt(rawMaxLen, 10) > 0) {
        charLimit = parseInt(rawMaxLen, 10);
      }
      // Also check nearby counter text (Reddit "0/300", Twitter char counter, etc.)
      if (!charLimit && typeof findNearbyCharLimit === 'function') {
        try { charLimit = findNearbyCharLimit(el); } catch (_) {}
      }

      if (charLimit > 0 && value.length > charLimit) {
        console.log(`[type_text] CHARACTER LIMIT: Field has limit of ${charLimit} chars, text is ${value.length} chars. Smart-truncating.`);
        // Smart truncation: cut at the last word boundary that fits within the limit,
        // then try to end at a sentence boundary (. ! ?) for completeness.
        let truncated = value.slice(0, charLimit);
        // Find the last sentence-ending punctuation within the truncated text
        const lastSentenceEnd = Math.max(
          truncated.lastIndexOf('. '),
          truncated.lastIndexOf('! '),
          truncated.lastIndexOf('? '),
          truncated.lastIndexOf('.\n'),
          truncated.lastIndexOf('!\n'),
          truncated.lastIndexOf('?\n'),
        );
        if (lastSentenceEnd > charLimit * 0.5) {
          // Found a sentence boundary in the second half — use it for a clean cutoff
          truncated = truncated.slice(0, lastSentenceEnd + 1).trim();
        } else {
          // No good sentence boundary — cut at the last space (word boundary)
          const lastSpace = truncated.lastIndexOf(' ');
          if (lastSpace > charLimit * 0.7) {
            truncated = truncated.slice(0, lastSpace).trim();
          }
          // If we cut mid-word and it doesn't end with punctuation, add ellipsis
          // only if there's room (3 chars for "...")
          if (truncated.length < charLimit - 3 && !/[.!?]$/.test(truncated)) {
            truncated += '...';
          }
        }
        console.log(`[type_text] Truncated to ${truncated.length} chars (limit: ${charLimit}). Ends: "${truncated.slice(-30)}"`);
        value = truncated;
      }

      // Focus the element
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus();
      el.dispatchEvent(new Event('focus', { bubbles: true }));

      // ── KEYBOARD EVENT SIMULATION HELPER (Tier 2b — Anti-Bot-Safe Sequential Loop) ──
      // Simulates real keystrokes character by character with jitter delays.
      // Fires: keydown → keypress → beforeinput → input → keyup per character.
      // The 8-15ms random jitter between characters bypasses anti-bot timing filters
      // that detect instant bulk insertion (Reddit, Facebook, Medium).
      async function simulateKeyboardTyping(targetEl, text) {
        console.log('[type_text] Attempting keyboard event simulation for', text.length, 'chars');
        targetEl.focus();
        targetEl.click();
        // Ensure cursor is active inside contentEditable
        if (targetEl.isContentEditable) {
          const sel = window.getSelection();
          sel.removeAllRanges();
          const r = document.createRange();
          r.selectNodeContents(targetEl);
          r.collapse(false); // end
          sel.addRange(r);
        }

        for (let i = 0; i < text.length; i++) {
          const char = text[i];
          const isNewline = char === '\n';
          const key = isNewline ? 'Enter' : char;
          const code = isNewline ? 'Enter' : (char.match(/[a-zA-Z]/) ? `Key${char.toUpperCase()}` : `Digit${char}`);
          const keyCode = isNewline ? 13 : char.charCodeAt(0);

          // keydown
          targetEl.dispatchEvent(new KeyboardEvent('keydown', {
            key, code, keyCode, charCode: keyCode,
            which: keyCode, bubbles: true, cancelable: true, composed: true,
          }));

          // keypress (deprecated but ProseMirror and some editors still listen)
          targetEl.dispatchEvent(new KeyboardEvent('keypress', {
            key, code, keyCode, charCode: keyCode,
            which: keyCode, bubbles: true, cancelable: true, composed: true,
          }));

          // beforeinput
          targetEl.dispatchEvent(new InputEvent('beforeinput', {
            data: isNewline ? null : char,
            inputType: isNewline ? 'insertParagraph' : 'insertText',
            bubbles: true, cancelable: true, composed: true,
          }));

          // input
          targetEl.dispatchEvent(new InputEvent('input', {
            data: isNewline ? null : char,
            inputType: isNewline ? 'insertParagraph' : 'insertText',
            bubbles: true, cancelable: false, composed: true,
          }));

          // keyup
          targetEl.dispatchEvent(new KeyboardEvent('keyup', {
            key, code, keyCode, charCode: keyCode,
            which: keyCode, bubbles: true, cancelable: true, composed: true,
          }));

          // 8-15ms random jitter to bypass anti-bot timing detection
          await new Promise(r => setTimeout(r, 8 + Math.floor(Math.random() * 7)));
        }
        console.log('[type_text] Keyboard simulation complete for', text.length, 'chars');
      }

      // ── PROSEMIRROR STATE SYNC ──
      // After typing into a contentEditable element, ProseMirror (and similar editors)
      // may not have updated their internal state even though text is visible in the DOM.
      // This causes the Post/Submit button to stay grayed out.
      // Fix: blur → refocus → type Space → Backspace to force a state reconciliation.
      // This triggers ProseMirror's input handlers to re-read the DOM and sync state.
      async function syncEditorState(targetEl) {
        if (!targetEl.isContentEditable) return;
        try {
          // blur + refocus forces the editor to re-evaluate its content
          targetEl.dispatchEvent(new Event('blur', { bubbles: true }));
          await new Promise(r => setTimeout(r, 50));
          targetEl.focus();
          targetEl.dispatchEvent(new Event('focus', { bubbles: true }));
          await new Promise(r => setTimeout(r, 50));

          // Place cursor at the end of the text
          const sel = window.getSelection();
          if (sel) {
            sel.removeAllRanges();
            const r = document.createRange();
            r.selectNodeContents(targetEl);
            r.collapse(false); // collapse to end
            sel.addRange(r);
          }

          // Type Space then Backspace — triggers beforeinput + input events that
          // ProseMirror listens for, forcing it to reconcile its internal state
          // with the actual DOM content. The net result is zero change to the text.
          document.execCommand('insertText', false, ' ');
          await new Promise(r => setTimeout(r, 30));
          document.execCommand('delete', false, null);
          await new Promise(r => setTimeout(r, 50));

          // Also fire a synthetic input event as a final nudge
          targetEl.dispatchEvent(new InputEvent('input', {
            bubbles: true, inputType: 'insertText', data: '',
          }));
          console.log('[type_text] ProseMirror state sync complete');
        } catch (e) {
          console.log('[type_text] State sync failed (non-fatal):', e.message);
        }
      }

      // ── UNIVERSAL VERIFICATION HELPER ──
      // After any typing action, wait for editor to process, re-scan DOM for the typed string.
      // For contentEditable elements, also runs ProseMirror state sync to ensure
      // the editor's internal state matches the visible DOM content.
      // Returns { found: boolean, truncated: boolean, actualLength: number }
      async function verifyTypingSuccess(targetEl, expectedText) {
        // Run state sync BEFORE verification for contentEditable elements
        // This ensures ProseMirror/Slate/Draft.js have reconciled their state
        if (targetEl.isContentEditable) {
          await syncEditorState(targetEl);
        }

        // Wait for rich editors to process and re-render.
        // contentEditable editors (ProseMirror, Slate) need more time than plain inputs.
        const waitMs = targetEl.isContentEditable ? 1200 : 500;
        await new Promise(r => setTimeout(r, waitMs));

        // Use first 40 chars of expected text for matching
        const matchStr = expectedText.slice(0, 40);
        let actualText = '';

        // Check .value for inputs
        if (targetEl.value && targetEl.value.length > 0) {
          actualText = targetEl.value;
        }
        // Check innerText/textContent for contentEditable and other elements
        if (!actualText || !actualText.includes(matchStr)) {
          const inner = (targetEl.innerText || targetEl.textContent || '').trim();
          if (inner.length > actualText.length) actualText = inner;
        }
        // Check child nodes (ProseMirror renders inside <p>, <div>, <span> children)
        if (!actualText.includes(matchStr)) {
          const children = targetEl.querySelectorAll('p, div, span, [data-contents], [data-block]');
          for (const child of children) {
            const childText = (child.innerText || child.textContent || '').trim();
            if (childText.includes(matchStr)) {
              actualText = childText;
              break;
            }
          }
        }
        // Also check parent container (for canvas editors where typed content
        // may appear in a sibling or parent node)
        if (!actualText.includes(matchStr)) {
          const parent = targetEl.closest('[role="textbox"], [contenteditable="true"], .editor, .ProseMirror, .ql-editor') || targetEl.parentElement;
          if (parent && parent !== targetEl) {
            const parentText = (parent.innerText || parent.textContent || '').trim();
            if (parentText.includes(matchStr)) actualText = parentText;
          }
        }
        // Check shadow DOM — Reddit's <shreddit-composer> and other web components
        // may render the editor surface inside a shadow root
        if (!actualText.includes(matchStr)) {
          const shadowHosts = [targetEl, targetEl.parentElement, targetEl.closest('[contenteditable]')?.parentElement].filter(Boolean);
          for (const host of shadowHosts) {
            if (host.shadowRoot) {
              const shadowText = (host.shadowRoot.textContent || '').trim();
              if (shadowText.includes(matchStr)) {
                actualText = shadowText;
                break;
              }
              // Also check contentEditable children inside shadow DOM
              const shadowEditable = host.shadowRoot.querySelector('[contenteditable="true"], .ProseMirror, [role="textbox"]');
              if (shadowEditable) {
                const seText = (shadowEditable.innerText || shadowEditable.textContent || '').trim();
                if (seText.includes(matchStr)) {
                  actualText = seText;
                  break;
                }
              }
            }
          }
        }
        // Check nearby siblings — some editors render typed text in a sibling element
        if (!actualText.includes(matchStr) && targetEl.parentElement) {
          for (const sibling of targetEl.parentElement.children) {
            if (sibling === targetEl) continue;
            const sibText = (sibling.innerText || sibling.textContent || '').trim();
            if (sibText.includes(matchStr)) {
              actualText = sibText;
              break;
            }
          }
        }

        const found = actualText.length > 0 && actualText.includes(matchStr);
        // Detect silent truncation: browser enforced maxlength and chopped our text
        const truncated = found && actualText.length < expectedText.length * 0.9;
        if (truncated) {
          console.log(`[type_text] WARNING: Text was silently truncated by browser. Expected ${expectedText.length} chars, got ${actualText.length} chars.`);
        }
        if (!found) {
          console.log(`[type_text] Verification FAILED. Expected match for "${matchStr}". Actual text (first 120 chars): "${actualText.slice(0, 120)}"`);
        }
        return { found, truncated, actualLength: actualText.length };
      }

      // ── STRATEGY: Determine whether to use native value path or contentEditable path ──
      // IMPORTANT: If this input/textarea lives INSIDE a rich text editor container
      // (ProseMirror, Slate, Draft.js, Lexical, Quill, CKEditor, TipTap), we MUST
      // skip the native value path. Setting .value on a hidden input inside ProseMirror
      // bypasses the editor's state — text appears in DOM but the editor thinks the
      // field is empty (Post button stays grayed out, form validation fails).
      // Instead, we find the contentEditable parent and use the contentEditable path.
      const elTag = el.tagName;
      const hasValueProperty = (elTag === 'INPUT' || elTag === 'TEXTAREA' ||
        'value' in el && typeof el.value === 'string');

      // Detect if element is inside a rich text editor that manages its own state
      const richEditorParent = el.closest('.ProseMirror, .DraftEditor-root, [data-slate-editor], .ql-editor, .ck-editor__editable, .tox-edit-area, .lexical-editor, [contenteditable="true"]');
      const isInsideRichEditor = richEditorParent && richEditorParent !== el;

      if (isInsideRichEditor) {
        console.log('[type_text] REROUTE: Element is inside a rich text editor. Switching to contentEditable path.', 'Editor class:', (typeof richEditorParent.className === 'string' ? richEditorParent.className.slice(0, 80) : ''));
        // Switch el to the rich editor surface and fall through to contentEditable path
        el = richEditorParent;
      }

      if (hasValueProperty && (elTag === 'INPUT' || elTag === 'TEXTAREA') && !isInsideRichEditor) {
        // ── NATIVE VALUE PATH (inputs, textareas) ──
        // Only used for STANDALONE inputs/textareas NOT inside a rich text editor.
        console.log('[type_text] Using native value path for', elTag, 'SID:', target);

        el.click();
        el.focus();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        el.dispatchEvent(new Event('focus', { bubbles: true }));

        // Native setter — wrapped in try/catch because it throws "Illegal invocation"
        // on Shadow DOM inputs (Reddit shreddit-*, Salesforce lightning-input, Angular Material, etc.)
        // If it throws, we fall through to execCommand → keyboard simulation → CDP.
        let valueSet = false;
        try {
          const nativeSetter =
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set ||
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

          // Clear existing value — use native setter directly, NO el.select() (causes blue highlight)
          if (nativeSetter) nativeSetter.call(el, '');
          else el.value = '';
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));

          // Set the new value
          if (nativeSetter) nativeSetter.call(el, value);
          else el.value = value;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
          el.dispatchEvent(new Event('change', { bubbles: true }));

          // Verify
          valueSet = el.value === value;
        } catch (nativeErr) {
          console.log('[type_text] Native setter threw (Shadow DOM input?):', nativeErr.message, '— falling through to execCommand/keyboard/CDP');
          valueSet = false;
        }

        // If native setter didn't work or threw, try execCommand then CDP
        if (!valueSet) {
          console.log('[type_text] Native setter failed. Trying execCommand...');
          el.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, value);
        }

        let finalValue = el.value || (el.innerText || '').trim();
        let finalSet = finalValue.length > 0;

        // If still empty, try keyboard simulation fallback
        if (!finalSet) {
          console.log('[type_text] Native + execCommand failed. Trying keyboard simulation...');
          el.focus();
          el.click();
          await simulateKeyboardTyping(el, value);
          await new Promise(r => setTimeout(r, 300));
          finalValue = el.value || (el.innerText || '').trim();
          finalSet = finalValue.length > 0;
        }

        // If still empty, try CDP as final fallback
        if (!finalSet) {
          console.log('[type_text] Native + execCommand + keyboard failed. Trying CDP...');
          try {
            const cdpResult = await new Promise((resolve) => {
              try {
                chrome.runtime.sendMessage(
                  { type: 'cdp_insert_text', text: value },
                  (response) => {
                    if (chrome.runtime.lastError) {
                      resolve({ success: false, error: chrome.runtime.lastError.message });
                    } else {
                      resolve(response || { success: false });
                    }
                  }
                );
              } catch (sendErr) {
                resolve({ success: false, error: sendErr.message });
              }
            });
            if (cdpResult?.success) await new Promise(r => setTimeout(r, 200));
            finalValue = el.value || (el.innerText || '').trim();
            finalSet = finalValue.length > 0;
          } catch (e) {
            console.log('[type_text] CDP fallback failed:', e.message);
          }
        }

        // Universal verification: 500ms wait + re-scan + truncation detection
        let truncationWarning = '';
        if (!finalSet) {
          const verifyResult = await verifyTypingSuccess(el, value);
          finalSet = verifyResult.found;
          if (verifyResult.truncated) {
            truncationWarning = ` WARNING: Browser truncated text to ${verifyResult.actualLength} chars (field has character limit). Content may be incomplete.`;
          }
        }

        const origOutline = el.style.outline;
        el.style.outline = finalSet ? '2px solid #6366f1' : '2px solid #ef4444';
        setTimeout(() => { el.style.outline = origOutline; }, 1500);

        return {
          success: finalSet,
          observation: finalSet
            ? `Typed "${value.slice(0, 80)}" into ${elTag.toLowerCase()}${el.placeholder ? ` (placeholder: "${el.placeholder}")` : ''}${truncationWarning}`
            : `FAILED to type into ${elTag.toLowerCase()}. The field rejected all input methods (native setter, execCommand, keyboard simulation, CDP). Try click_element first to activate it, then retry type_text.`,
        };
      }

      // ── CONTENTEDITABLE PATH (divs, spans, custom elements) ──
      // Handle contentEditable elements (used by Facebook, Gmail compose, Reddit body, etc.)
      // 5-Tier cascade with universal verification after each tier:
      //   Tier 1: execCommand('insertText') — works on plain contentEditable, Lexical, some Slate
      //   Tier 2: ClipboardEvent paste — works on ProseMirror (Reddit, Notion, TipTap)
      //   Tier 2b: Sequential keyboard loop with jitter — bypasses anti-bot filters
      //   Tier 3: CDP Input.insertText — trusted browser-level events for canvas editors
      //   Tier 3b: CDP dispatchKeyEvent — Word Online, Google Docs (canvas + hidden input)
      if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
        console.log('[type_text] ContentEditable detected. Tag:', el.tagName, 'SID:', target);

        // ── FORCE FOCUS: Click + mousedown/up + focus to guarantee cursor activation ──
        // Some editors (ProseMirror, Slate) ignore .focus() alone — they need a real click
        // sequence to place the cursor inside the editable region.
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        el.click();
        el.focus();
        el.dispatchEvent(new Event('focus', { bubbles: true }));

        // ── CLEAR EXISTING CONTENT ──
        // Use element-scoped Range, NOT selectAll (which selects entire page)
        const sel = window.getSelection();
        sel.removeAllRanges();
        const existingText = (el.innerText || el.textContent || '').trim();
        if (existingText) {
          const clearRange = document.createRange();
          clearRange.selectNodeContents(el);
          sel.addRange(clearRange);
          document.execCommand('delete', false, null);
          sel.removeAllRanges();
        }

        // ── PLACE CURSOR at start (collapsed — ready for insertion) ──
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(true);
        sel.addRange(range);

        // ═══════════════════════════════════════════════════════════
        // TIER 1: execCommand('insertText')
        // Works on: plain contentEditable, Lexical, some Slate, Draft.js
        // ═══════════════════════════════════════════════════════════
        console.log('[type_text] TIER 1: execCommand insertText');
        let typed = false;
        try {
          typed = document.execCommand('insertText', false, value);
          console.log('[type_text] Tier 1 execCommand returned:', typed);
        } catch (e) {
          console.log('[type_text] Tier 1 execCommand threw:', e.message);
        }

        // ── VERIFY TIER 1 ──
        // verifyTypingSuccess returns { found, truncated, actualLength }
        let vResult = await verifyTypingSuccess(el, value);
        if (vResult.found) {
          console.log('[type_text] TIER 1 SUCCESS — text verified in DOM');
          const truncWarn = vResult.truncated ? ` WARNING: Browser truncated text to ${vResult.actualLength} chars (field has character limit).` : '';
          const origOutline = el.style.outline;
          el.style.outline = '2px solid #6366f1';
          setTimeout(() => { el.style.outline = origOutline; }, 2000);
          return {
            success: true,
            observation: `Typed "${value.slice(0, 80)}" into contentEditable ${el.tagName.toLowerCase()} (execCommand)${truncWarn}`,
          };
        }

        // ═══════════════════════════════════════════════════════════
        // TIER 2: ClipboardEvent paste (enhanced for ProseMirror)
        // Works on: ProseMirror (Reddit body, Notion, TipTap), Quill
        // NOTE: Chrome ignores clipboardData in ClipboardEvent constructor —
        // we must use Object.defineProperty to force it onto the event.
        // Also fires beforeinput(insertFromPaste) which modern ProseMirror
        // versions (2024+) listen to instead of/alongside paste events.
        // ═══════════════════════════════════════════════════════════
        console.log('[type_text] TIER 2: ClipboardEvent paste (Tier 1 failed verification)');
        try {
          // Re-focus and place cursor — essential for ProseMirror
          el.focus();
          el.click();
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          sel.removeAllRanges();
          const r2 = document.createRange();
          r2.selectNodeContents(el);
          r2.collapse(false);
          sel.addRange(r2);

          // Build a DataTransfer with both plain text and HTML
          const dt = new DataTransfer();
          dt.setData('text/plain', value);
          dt.setData('text/html', `<p>${value.replace(/\n/g, '</p><p>')}</p>`);

          // Create the paste event and FORCE clipboardData onto it
          // (Chrome's ClipboardEvent constructor silently drops the clipboardData param)
          const pasteEvent = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
          });
          Object.defineProperty(pasteEvent, 'clipboardData', {
            value: dt,
            writable: false,
            configurable: true,
          });
          el.dispatchEvent(pasteEvent);
          console.log('[type_text] Tier 2 ClipboardEvent paste dispatched (with forced clipboardData)');

          // Also fire beforeinput with insertFromPaste — modern ProseMirror (2024+)
          // and Lexical use InputEvent-based paste handling
          await new Promise(r => setTimeout(r, 50));
          try {
            el.dispatchEvent(new InputEvent('beforeinput', {
              inputType: 'insertFromPaste',
              data: value,
              dataTransfer: dt,
              bubbles: true,
              cancelable: true,
              composed: true,
            }));
            el.dispatchEvent(new InputEvent('input', {
              inputType: 'insertFromPaste',
              data: value,
              bubbles: true,
              cancelable: false,
              composed: true,
            }));
            console.log('[type_text] Tier 2 also fired beforeinput/input insertFromPaste');
          } catch (e2) {
            console.log('[type_text] Tier 2 InputEvent insertFromPaste failed (non-fatal):', e2.message);
          }
        } catch (e) {
          console.log('[type_text] Tier 2 ClipboardEvent failed:', e.message);
        }

        // ── VERIFY TIER 2 ──
        vResult = await verifyTypingSuccess(el, value);
        if (vResult.found) {
          console.log('[type_text] TIER 2 SUCCESS — text verified after ClipboardEvent paste');
          const truncWarn = vResult.truncated ? ` WARNING: Browser truncated text to ${vResult.actualLength} chars (field has character limit).` : '';
          const origOutline = el.style.outline;
          el.style.outline = '2px solid #6366f1';
          setTimeout(() => { el.style.outline = origOutline; }, 2000);
          return {
            success: true,
            observation: `Typed "${value.slice(0, 80)}" into contentEditable ${el.tagName.toLowerCase()} (ClipboardEvent paste)${truncWarn}`,
          };
        }

        // ═══════════════════════════════════════════════════════════
        // TIER 2a: CDP Clipboard Paste (real Ctrl+V via DevTools Protocol)
        // Works on: ProseMirror, Slate, any editor that accepts real paste.
        // Writes text to system clipboard, then sends trusted Ctrl+V keystroke
        // via CDP — this is indistinguishable from a real user paste action.
        // ═══════════════════════════════════════════════════════════
        console.log('[type_text] TIER 2a: CDP clipboard paste (Tier 2 synthetic paste failed)');
        try {
          // Write to clipboard — try navigator.clipboard first, fall back to execCommand
          let clipboardWritten = false;
          try {
            await navigator.clipboard.writeText(value);
            clipboardWritten = true;
            console.log('[type_text] Tier 2a: navigator.clipboard.writeText succeeded');
          } catch (clipErr) {
            console.log('[type_text] Tier 2a: navigator.clipboard failed, trying execCommand copy fallback:', clipErr.message);
            // Fallback: create a hidden textarea, select its content, execCommand('copy')
            const tempTA = document.createElement('textarea');
            tempTA.value = value;
            tempTA.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
            document.body.appendChild(tempTA);
            tempTA.select();
            clipboardWritten = document.execCommand('copy');
            document.body.removeChild(tempTA);
            console.log('[type_text] Tier 2a: execCommand copy fallback result:', clipboardWritten);
          }
          if (!clipboardWritten) throw new Error('Could not write to clipboard');

          // Re-focus the element
          el.focus();
          el.click();
          await new Promise(r => setTimeout(r, 100));

          // Ask background.js to send trusted Ctrl+V via CDP
          const rect2a = el.getBoundingClientRect();
          const cdpPasteResult = await new Promise((resolve) => {
            try {
              chrome.runtime.sendMessage(
                { type: 'cdp_paste', elementRect: { x: Math.round(rect2a.left + rect2a.width / 2), y: Math.round(rect2a.top + rect2a.height / 2) } },
                (response) => {
                  if (chrome.runtime.lastError) {
                    resolve({ success: false, error: chrome.runtime.lastError.message });
                  } else {
                    resolve(response || { success: false, error: 'No response' });
                  }
                }
              );
            } catch (sendErr) {
              resolve({ success: false, error: sendErr.message });
            }
          });
          console.log('[type_text] Tier 2a CDP paste result:', cdpPasteResult);
        } catch (e) {
          console.log('[type_text] Tier 2a CDP clipboard paste failed:', e.message);
        }

        // ── VERIFY TIER 2a ──
        vResult = await verifyTypingSuccess(el, value);
        if (vResult.found) {
          console.log('[type_text] TIER 2a SUCCESS — text verified after CDP Ctrl+V paste');
          const truncWarn = vResult.truncated ? ` WARNING: Browser truncated text to ${vResult.actualLength} chars (field has character limit).` : '';
          const origOutline = el.style.outline;
          el.style.outline = '2px solid #6366f1';
          setTimeout(() => { el.style.outline = origOutline; }, 2000);
          return {
            success: true,
            observation: `Typed "${value.slice(0, 80)}" into contentEditable ${el.tagName.toLowerCase()} (CDP clipboard paste)${truncWarn}`,
          };
        }

        // ═══════════════════════════════════════════════════════════
        // TIER 2b: Sequential keyboard loop with jitter
        // Works on: Reddit title (ProseMirror input), Facebook, Medium,
        // any editor that listens for real keydown/keypress/keyup sequences.
        // Fires full event chain per character with 8-15ms random delay.
        // ═══════════════════════════════════════════════════════════
        console.log('[type_text] TIER 2b: Sequential keyboard simulation (Tiers 1-2a failed)');
        try {
          // Re-focus, re-click, ensure cursor is inside the contentEditable
          el.focus();
          el.click();
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          el.dispatchEvent(new Event('focus', { bubbles: true }));
          await simulateKeyboardTyping(el, value);
        } catch (e) {
          console.log('[type_text] Tier 2b keyboard simulation failed:', e.message);
        }

        // ── VERIFY TIER 2b ──
        vResult = await verifyTypingSuccess(el, value);
        if (vResult.found) {
          console.log('[type_text] TIER 2b SUCCESS — text verified after keyboard simulation');
          const truncWarn = vResult.truncated ? ` WARNING: Browser truncated text to ${vResult.actualLength} chars (field has character limit).` : '';
          const origOutline = el.style.outline;
          el.style.outline = '2px solid #6366f1';
          setTimeout(() => { el.style.outline = origOutline; }, 2000);
          return {
            success: true,
            observation: `Typed "${value.slice(0, 80)}" into contentEditable ${el.tagName.toLowerCase()} (keyboard simulation)${truncWarn}`,
          };
        }

        // ═══════════════════════════════════════════════════════════
        // TIER 3: CDP Input.insertText via background.js
        // Works on: Most canvas-based editors, heavily sandboxed iframes
        // Generates TRUSTED input events at browser level (like Puppeteer)
        // IMPORTANT: Focus + click the element first so CDP targets it
        // ═══════════════════════════════════════════════════════════
        console.log('[type_text] TIER 3: CDP Input.insertText (all DOM methods failed)');
        try {
          // Force-focus the element before CDP — click its center to activate it
          el.focus();
          el.click();
          el.dispatchEvent(new Event('focus', { bubbles: true }));
          // Send element coordinates so CDP can click the exact element
          const rect = el.getBoundingClientRect();
          const cdpResult = await new Promise((resolve) => {
            try {
              chrome.runtime.sendMessage(
                { type: 'cdp_insert_text', text: value, elementRect: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } },
                (response) => {
                  if (chrome.runtime.lastError) {
                    resolve({ success: false, error: chrome.runtime.lastError.message });
                  } else {
                    resolve(response || { success: false, error: 'No response' });
                  }
                }
              );
            } catch (sendErr) {
              resolve({ success: false, error: sendErr.message });
            }
          });
          console.log('[type_text] Tier 3 CDP result:', cdpResult);
        } catch (e) {
          console.log('[type_text] Tier 3 CDP failed:', e.message);
        }

        // ── VERIFY TIER 3 ──
        vResult = await verifyTypingSuccess(el, value);
        if (vResult.found) {
          console.log('[type_text] TIER 3 SUCCESS — text verified after CDP Input.insertText');
          const truncWarn = vResult.truncated ? ` WARNING: Browser truncated text to ${vResult.actualLength} chars (field has character limit).` : '';
          const origOutline = el.style.outline;
          el.style.outline = '2px solid #6366f1';
          setTimeout(() => { el.style.outline = origOutline; }, 2000);
          return {
            success: true,
            observation: `Typed "${value.slice(0, 80)}" into contentEditable ${el.tagName.toLowerCase()} (CDP insertText)${truncWarn}`,
          };
        }

        // ═══════════════════════════════════════════════════════════
        // TIER 3b: CDP dispatchKeyEvent (character-by-character)
        // Works on: Word Online, Google Docs — canvas editors with hidden
        // input layers that ignore insertText but respond to individual
        // key events. Includes Enter/Backspace initialization for Word's
        // text buffer activation.
        // ═══════════════════════════════════════════════════════════
        console.log('[type_text] TIER 3b: CDP dispatchKeyEvent (canvas/hidden-input editors)');
        try {
          // Force-focus before CDP key dispatch
          el.focus();
          el.click();
          el.dispatchEvent(new Event('focus', { bubbles: true }));
          const rect3b = el.getBoundingClientRect();
          const cdpKeyResult = await new Promise((resolve) => {
            try {
              chrome.runtime.sendMessage(
                { type: 'cdp_type_keys', text: value, initializeBuffer: true, elementRect: { x: Math.round(rect3b.left + rect3b.width / 2), y: Math.round(rect3b.top + rect3b.height / 2) } },
                (response) => {
                  if (chrome.runtime.lastError) {
                    resolve({ success: false, error: chrome.runtime.lastError.message });
                  } else {
                    resolve(response || { success: false, error: 'No response' });
                  }
                }
              );
            } catch (sendErr) {
              resolve({ success: false, error: sendErr.message });
            }
          });
          console.log('[type_text] Tier 3b CDP key result:', cdpKeyResult);
        } catch (e) {
          console.log('[type_text] Tier 3b CDP dispatchKeyEvent failed:', e.message);
        }

        // ── VERIFY TIER 3b ──
        vResult = await verifyTypingSuccess(el, value);

        // ── FINAL RESULT ──
        const origOutline = el.style.outline;
        el.style.outline = vResult.found ? '2px solid #6366f1' : '2px solid #ef4444';
        setTimeout(() => { el.style.outline = origOutline; }, 2000);

        if (!vResult.found) {
          console.log('[type_text] ALL 5 TIERS FAILED for contentEditable. Element:', el.tagName, 'id:', el.id, 'class:', (el.className || '').slice(0, 80));
        }

        const truncWarn = vResult.truncated ? ` WARNING: Browser truncated text to ${vResult.actualLength} chars (field has character limit).` : '';
        return {
          success: vResult.found,
          observation: vResult.found
            ? `Typed "${value.slice(0, 80)}" into contentEditable ${el.tagName.toLowerCase()} (CDP dispatchKeyEvent)${truncWarn}`
            : `FAILED: Could not type into this ${el.tagName.toLowerCase()} element. All 5 tiers tried: execCommand, ClipboardEvent paste, keyboard simulation, CDP insertText, CDP dispatchKeyEvent. This editor may require manual text entry. The content was: "${value.slice(0, 120)}"`,
        };
      }

      // ── FALLBACK: Element is not INPUT/TEXTAREA and not contentEditable ──
      // This shouldn't happen often. Try setting .value if it exists, else report failure.
      console.log('[type_text] Element is neither input/textarea nor contentEditable. Tag:', el.tagName, 'SID:', target);
      if ('value' in el) {
        el.value = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const fbValue = el.value || (el.innerText || '').trim();
      return {
        success: fbValue.length > 0,
        observation: fbValue.length > 0
          ? `Typed "${value.slice(0, 80)}" into ${el.tagName.toLowerCase()}`
          : `FAILED: Element ${el.tagName.toLowerCase()} (id="${el.id || ''}", sid="${target}") is not a recognized input type. Look for a different element in the semantic map.`,
      };
    },

    // ── select_option: Change a <select> dropdown or click a custom dropdown option ──
    // target = SID of the <select> element (or the dropdown trigger)
    // value = the option text or value to select
    select_option({ target, value }) {
      if (!target) return { success: false, error: 'No semantic ID provided for select_option' };
      if (!value) return { success: false, error: 'No option value provided for select_option' };

      const el = findBySid(target);
      if (!el) {
        return {
          success: false,
          error: `Element not found: ${target}. Cannot select option.${getRecoverySnapshot()}`,
        };
      }

      if (isSensitiveElement(el)) {
        return { success: false, error: 'BLOCKED: Sensitive field — cannot interact', blocked: true };
      }

      const valueLower = value.toLowerCase().trim();

      // Case 1: Native <select> element
      if (el.tagName === 'SELECT') {
        let bestMatch = null;
        let bestScore = 0;
        for (const opt of el.options) {
          const optText = (opt.text || '').toLowerCase().trim();
          const optVal = (opt.value || '').toLowerCase().trim();
          // Exact match
          if (optText === valueLower || optVal === valueLower) {
            bestMatch = opt;
            bestScore = 1;
            break;
          }
          // Partial match
          if (optText.includes(valueLower) || valueLower.includes(optText)) {
            const score = 0.5;
            if (score > bestScore) { bestMatch = opt; bestScore = score; }
          }
        }

        if (!bestMatch) {
          const available = Array.from(el.options).map(o => o.text).join(', ');
          return { success: false, error: `No matching option for "${value}". Available: ${available}` };
        }

        // Use native setter trick for React compatibility
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, bestMatch.value);
        } else {
          el.value = bestMatch.value;
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));

        el.style.outline = '2px solid #6366f1';
        setTimeout(() => { el.style.outline = ''; }, 1500);

        return {
          success: true,
          observation: `Selected "${bestMatch.text}" in ${el.name || el.id || 'dropdown'}`,
        };
      }

      // Case 2: Custom dropdown (role=combobox, aria-haspopup, etc.)
      // Click the trigger to open it, then look for matching options
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.click();

      // Brief delay for dropdown animation
      return new Promise(resolve => {
        setTimeout(() => {
          // Look for listbox/menu options that appeared
          const optionSelectors = [
            '[role="option"]', '[role="menuitem"]', '[role="listbox"] > *',
            '[class*="option"]', '[class*="Option"]',
            '[class*="menu-item"]', '[class*="MenuItem"]',
            '[class*="dropdown-item"]', '[class*="DropdownItem"]',
            'li[data-value]', 'li[role="option"]',
          ];

          let bestOption = null;
          let bestScore = 0;

          for (const sel of optionSelectors) {
            try {
              for (const opt of document.querySelectorAll(sel)) {
                const optText = (opt.innerText || opt.textContent || '').toLowerCase().trim();
                if (optText === valueLower) { bestOption = opt; bestScore = 1; break; }
                if (optText.includes(valueLower) || valueLower.includes(optText)) {
                  const score = 0.5;
                  if (score > bestScore) { bestOption = opt; bestScore = score; }
                }
              }
            } catch {}
            if (bestScore === 1) break;
          }

          if (bestOption) {
            bestOption.scrollIntoView({ behavior: 'smooth', block: 'center' });
            bestOption.click();
            resolve({
              success: true,
              observation: `Selected "${(bestOption.innerText || '').trim().slice(0, 80)}" from dropdown`,
            });
          } else {
            // Couldn't find option — close dropdown and report
            el.click(); // close it
            resolve({
              success: false,
              error: `Opened dropdown but couldn't find option matching "${value}". Try click_element on the specific option after the dropdown is open.`,
            });
          }
        }, 400);
      });
    },

    // ── PRESS KEY: Press a single navigation/control key on focused element ──
    async press_key({ value }) {
      if (!value || typeof value !== 'string') {
        return { success: false, error: 'No key name provided. Use value: "Tab", "Enter", "Escape", "ArrowDown", etc.' };
      }

      const KEY_MAP = {
        'Tab':        { key: 'Tab',        code: 'Tab',        keyCode: 9 },
        'Enter':      { key: 'Enter',      code: 'Enter',      keyCode: 13 },
        'Escape':     { key: 'Escape',     code: 'Escape',     keyCode: 27 },
        'ArrowDown':  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
        'ArrowUp':    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
        'ArrowLeft':  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
        'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
        'Backspace':  { key: 'Backspace',  code: 'Backspace',  keyCode: 8 },
        'Delete':     { key: 'Delete',     code: 'Delete',     keyCode: 46 },
        'Home':       { key: 'Home',       code: 'Home',       keyCode: 36 },
        'End':        { key: 'End',        code: 'End',        keyCode: 35 },
      };

      const keyInfo = KEY_MAP[value];
      if (!keyInfo) {
        return {
          success: false,
          error: `Unknown key: "${value}". Allowed keys: ${Object.keys(KEY_MAP).join(', ')}`,
        };
      }

      const focusedBefore = document.activeElement;

      // ── Tier 1: DOM KeyboardEvent dispatch ──
      const target = document.activeElement || document.body;
      const eventInit = {
        key: keyInfo.key,
        code: keyInfo.code,
        keyCode: keyInfo.keyCode,
        which: keyInfo.keyCode,
        bubbles: true,
        cancelable: true,
      };

      target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
      target.dispatchEvent(new KeyboardEvent('keyup', eventInit));

      // Wait briefly for the app to process the key
      await new Promise(r => setTimeout(r, 80));

      // ── Tier 2: CDP fallback for canvas editors (Excel Online, Google Sheets) ──
      // Detect if the key press had no visible effect (focus didn't change for Tab,
      // or we're on a canvas-heavy page)
      const focusedAfter = document.activeElement;
      const hasCanvas = !!document.querySelector('canvas');
      const focusUnchanged = focusedBefore === focusedAfter;
      const needsCDP = hasCanvas && focusUnchanged && (value === 'Tab' || value === 'Enter' || value.startsWith('Arrow'));

      if (needsCDP) {
        try {
          const cdpResult = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
              type: 'cdp_press_key',
              key: keyInfo.key,
              code: keyInfo.code,
              keyCode: keyInfo.keyCode,
            }, (response) => {
              resolve(response || { success: false, error: 'No response from CDP handler' });
            });
          });

          if (cdpResult.success) {
            return { success: true, observation: `Pressed ${value} key (via CDP — canvas editor detected)` };
          }
          // CDP also failed — report DOM result anyway
          console.warn('[press_key] CDP fallback also failed:', cdpResult.error);
        } catch (cdpErr) {
          console.warn('[press_key] CDP fallback error:', cdpErr.message);
        }
      }

      return { success: true, observation: `Pressed ${value} key` };
    },

    // ═══════════════════════════════════════════════════════════
    // paste_tsv: Bulk-paste TSV data into spreadsheets via clipboard + CDP Ctrl+V
    // Writes TSV to system clipboard, then triggers trusted Ctrl+V via CDP.
    // Google Sheets, Excel Online, LibreOffice Online auto-distribute TSV across cells.
    // ═══════════════════════════════════════════════════════════
    async paste_tsv({ value }) {
      if (!value || typeof value !== 'string' || !value.trim()) {
        return { success: false, error: 'paste_tsv requires TSV data in the value field. Save data to extractedData first, then use value "__USE_SCRATCHPAD__".' };
      }

      const tsvData = value.trim();
      const rows = tsvData.split('\n');
      const colCount = rows.length > 0 ? rows[0].split('\t').length : 0;
      const rowCount = rows.length;

      // Cap at 64KB to prevent memory issues
      if (tsvData.length > 64000) {
        return { success: false, error: `TSV data too large (${tsvData.length} chars, max 64000). Reduce the dataset or split into batches.` };
      }

      // Write TSV to system clipboard
      let clipboardWritten = false;
      try {
        await navigator.clipboard.writeText(tsvData);
        clipboardWritten = true;
        console.log('[paste_tsv] navigator.clipboard.writeText succeeded');
      } catch (clipErr) {
        console.log('[paste_tsv] navigator.clipboard failed, trying execCommand copy fallback:', clipErr.message);
        const tempTA = document.createElement('textarea');
        tempTA.value = tsvData;
        tempTA.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
        document.body.appendChild(tempTA);
        tempTA.select();
        clipboardWritten = document.execCommand('copy');
        document.body.removeChild(tempTA);
        console.log('[paste_tsv] execCommand copy fallback result:', clipboardWritten);
      }

      if (!clipboardWritten) {
        return { success: false, error: 'Could not write TSV data to clipboard. Clipboard API and execCommand both failed.' };
      }

      // Find the active/focused element to get coordinates for CDP click
      const activeEl = document.activeElement;
      let rect = { x: 300, y: 300 }; // default center-ish if no focused element
      if (activeEl && activeEl !== document.body) {
        const elRect = activeEl.getBoundingClientRect();
        rect = {
          x: Math.round(elRect.left + elRect.width / 2),
          y: Math.round(elRect.top + elRect.height / 2),
        };
      }

      // Ask background.js to send trusted Ctrl+V via CDP (reuses existing cdp_paste handler)
      const cdpResult = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(
            { type: 'cdp_paste', elementRect: rect },
            (response) => {
              if (chrome.runtime.lastError) {
                resolve({ success: false, error: chrome.runtime.lastError.message });
              } else {
                resolve(response || { success: false, error: 'No response from CDP paste' });
              }
            }
          );
        } catch (sendErr) {
          resolve({ success: false, error: sendErr.message });
        }
      });

      if (!cdpResult.success) {
        return {
          success: false,
          error: `Clipboard written but CDP Ctrl+V failed: ${cdpResult.error}. The data is in the clipboard — user can manually press Ctrl+V to paste.`,
        };
      }

      console.log(`[paste_tsv] Successfully pasted ${rowCount} rows × ${colCount} columns`);
      return {
        success: true,
        observation: `Pasted ${rowCount} rows × ${colCount} columns of TSV data into the spreadsheet via clipboard Ctrl+V. Use scrape_page to verify the data landed correctly.`,
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

    // ── Bulk Table Scraper: reads ALL visible table/grid data in one action ──
    scrape_table({ value }) {
      const maxChars = parseInt(value) || 32000;
      const tables = [];

      // Strategy 1: HTML <table> elements
      const htmlTables = document.querySelectorAll('table');
      for (const table of htmlTables) {
        // Skip hidden/tiny tables (nav bars, layout tables)
        if (table.offsetWidth < 100 || table.offsetHeight < 30) continue;
        if (table.closest('nav, footer, header')) continue;

        const rows = [];
        const trElements = table.querySelectorAll('tr');
        for (const tr of trElements) {
          const cells = tr.querySelectorAll('th, td');
          if (cells.length === 0) continue;
          const row = [];
          for (const cell of cells) {
            // Get clean text, collapse whitespace
            const text = (cell.innerText || cell.textContent || '').trim().replace(/\s+/g, ' ');
            row.push(text);
          }
          rows.push(row.join('\t'));
        }
        if (rows.length > 0) {
          tables.push(rows.join('\n'));
        }
      }

      // Strategy 2: ARIA grid/table roles (Notion, Airtable, custom grids)
      if (tables.length === 0) {
        const grids = document.querySelectorAll('[role="grid"], [role="table"], [role="treegrid"]');
        for (const grid of grids) {
          if (grid.offsetWidth < 100 || grid.offsetHeight < 30) continue;
          const rows = [];
          const rowElements = grid.querySelectorAll('[role="row"]');
          for (const rowEl of rowElements) {
            const cells = rowEl.querySelectorAll('[role="gridcell"], [role="cell"], [role="columnheader"], [role="rowheader"]');
            if (cells.length === 0) continue;
            const row = [];
            for (const cell of cells) {
              const text = (cell.innerText || cell.textContent || '').trim().replace(/\s+/g, ' ');
              row.push(text);
            }
            rows.push(row.join('\t'));
          }
          if (rows.length > 0) {
            tables.push(rows.join('\n'));
          }
        }
      }

      // Strategy 3: Notion-specific database views (collection views with .notion-table-view)
      if (tables.length === 0) {
        const notionViews = document.querySelectorAll('.notion-table-view, .notion-collection_view-block, .notion-list-view, .notion-board-view');
        for (const view of notionViews) {
          const rows = [];
          // Notion uses nested divs as rows with specific data attributes
          const rowDivs = view.querySelectorAll('[data-block-id]');
          const seenBlocks = new Set();
          for (const div of rowDivs) {
            const blockId = div.getAttribute('data-block-id');
            if (seenBlocks.has(blockId)) continue;
            seenBlocks.add(blockId);
            // Each Notion row has cell divs inside
            const cellDivs = div.querySelectorAll('.notion-table-view-cell, [data-content-editable-leaf], .notion-page-block');
            if (cellDivs.length === 0) continue;
            const row = [];
            for (const cell of cellDivs) {
              const text = (cell.innerText || cell.textContent || '').trim().replace(/\s+/g, ' ');
              if (text) row.push(text);
            }
            if (row.length > 0) rows.push(row.join('\t'));
          }
          if (rows.length > 0) {
            tables.push(rows.join('\n'));
          }
        }
      }

      // Strategy 4: Generic repeating-row pattern (lists, cards with consistent structure)
      if (tables.length === 0) {
        // Look for repeated list-like structures
        const listContainers = document.querySelectorAll('[role="list"], [role="listbox"], ul, ol');
        for (const list of listContainers) {
          if (list.offsetWidth < 100 || list.offsetHeight < 30) continue;
          if (list.closest('nav, footer, header, [role="navigation"]')) continue;
          const items = list.querySelectorAll('[role="listitem"], [role="option"], li');
          if (items.length < 2) continue; // Need at least 2 items to be a data list
          const rows = [];
          for (const item of items) {
            const text = (item.innerText || item.textContent || '').trim().replace(/\s+/g, ' ');
            if (text && text.length > 1) rows.push(text);
          }
          if (rows.length >= 2) {
            tables.push(rows.join('\n'));
          }
        }
      }

      if (tables.length === 0) {
        return {
          success: false,
          observation: 'No tables, grids, or structured data found on this page. Try scrape_page or read_element instead.',
        };
      }

      // Combine all tables with separators, cap at maxChars
      const combined = tables.join('\n---TABLE_BREAK---\n').slice(0, maxChars);
      const rowCount = combined.split('\n').filter(l => l.trim() && l !== '---TABLE_BREAK---').length;

      return {
        success: true,
        observation: `Scraped ${tables.length} table(s), ${rowCount} total rows:\n${combined}`,
      };
    },

    take_snapshot() {
      // Build a compact semantic map
      // Increased to 100 to capture dropdown/menu items that appear after clicks
      const MAX_ELEMENTS = 100;
      const elements = [];
      let counter = 0;

      // ── Icon-to-meaning mapping ──────────────────────────────────
      // Many sites use icons instead of text. This maps common icon
      // patterns (class names, aria-labels, SVG classes) to meanings.
      const ICON_MEANINGS = {
        'settings': 'Settings', 'gear': 'Settings', 'cog': 'Settings', 'config': 'Settings',
        'preferences': 'Settings', 'options': 'Settings', 'sliders': 'Settings', 'wrench': 'Settings', 'tool': 'Settings',
        'profile': 'Profile/Account', 'person': 'Profile/Account', 'user': 'Profile/Account',
        'avatar': 'Profile/Account', 'account': 'Profile/Account', 'my-account': 'Profile/Account',
        'user-circle': 'Profile/Account', 'user-menu': 'Profile/Account', 'portrait': 'Profile/Account',
        'notification': 'Notifications', 'bell': 'Notifications', 'alert': 'Notifications',
        'search': 'Search', 'magnify': 'Search', 'find': 'Search', 'magnifying': 'Search',
        'edit': 'Edit', 'pencil': 'Edit', 'pen': 'Edit', 'compose': 'Edit/Compose',
        'delete': 'Delete', 'trash': 'Delete', 'remove': 'Delete', 'bin': 'Delete',
        'close': 'Close', 'dismiss': 'Close', 'x-mark': 'Close',
        'menu': 'Menu', 'hamburger': 'Menu', 'nav': 'Menu', 'dots': 'More Options',
        'more': 'More Options', 'ellipsis': 'More Options', 'kebab': 'More Options', 'meatball': 'More Options',
        'three-dot': 'More Options', 'overflow': 'More Options',
        'home': 'Home', 'house': 'Home', 'dashboard': 'Dashboard',
        'mail': 'Email/Mail', 'envelope': 'Email/Mail', 'inbox': 'Email/Mail',
        'share': 'Share', 'export': 'Share/Export',
        'download': 'Download', 'save': 'Save',
        'upload': 'Upload', 'attach': 'Attach', 'paperclip': 'Attach',
        'cart': 'Shopping Cart', 'basket': 'Shopping Cart', 'bag': 'Shopping Cart',
        'help': 'Help', 'question': 'Help', 'support': 'Help', 'info': 'Info',
        'logout': 'Log Out', 'signout': 'Log Out', 'sign-out': 'Log Out', 'log-out': 'Log Out',
        'back': 'Go Back', 'arrow-left': 'Go Back', 'previous': 'Go Back',
        'forward': 'Go Forward', 'arrow-right': 'Go Forward', 'next': 'Go Forward',
        'refresh': 'Refresh', 'reload': 'Refresh',
        'filter': 'Filter', 'sort': 'Sort', 'funnel': 'Filter',
        'add': 'Add/Create', 'plus': 'Add/Create', 'new': 'Add/Create',
        'calendar': 'Calendar/Schedule', 'date': 'Calendar/Schedule',
        'chart': 'Analytics/Charts', 'graph': 'Analytics/Charts', 'stats': 'Analytics/Charts', 'usage': 'Usage/Analytics',
        'lock': 'Security/Privacy', 'shield': 'Security/Privacy', 'privacy': 'Security/Privacy',
        'expand': 'Expand', 'collapse': 'Collapse', 'chevron': 'Expand/Collapse',
        'copy': 'Copy', 'clipboard': 'Copy', 'duplicate': 'Duplicate',
        'pin': 'Pin', 'bookmark': 'Bookmark', 'star': 'Favorite',
        'eye': 'View/Visibility', 'visibility': 'View/Visibility', 'preview': 'Preview',
        'sidebar': 'Sidebar', 'panel': 'Panel', 'layout': 'Layout',
        'billing': 'Billing', 'credit-card': 'Billing', 'payment': 'Payment',
        'team': 'Team/Members', 'group': 'Team/Members', 'people': 'Team/Members',
        'link': 'Link', 'chain': 'Link', 'external': 'External Link',
      };

      function getIconMeaning(node) {
        // Collect all searchable strings: class names, aria-label, title, data attributes, child SVG classes
        const searchStrings = [];
        if (node.className && typeof node.className === 'string') searchStrings.push(node.className.toLowerCase());
        if (node.getAttribute('aria-label')) searchStrings.push(node.getAttribute('aria-label').toLowerCase());
        if (node.getAttribute('title')) searchStrings.push(node.getAttribute('title').toLowerCase());
        // Check data- attributes (data-testid, data-icon, data-label, etc.)
        for (const attr of node.attributes || []) {
          if (attr.name.startsWith('data-') && attr.value) searchStrings.push(attr.value.toLowerCase());
        }
        // Check child SVG and icon element class names, plus <use> href (sprite icons)
        const iconChildren = node.querySelectorAll('svg, [class*="icon"], [class*="Icon"], i, img');
        for (const child of iconChildren) {
          if (child.className && typeof child.className === 'string') searchStrings.push(child.className.toLowerCase());
          if (child.getAttribute && child.getAttribute('aria-label')) searchStrings.push(child.getAttribute('aria-label').toLowerCase());
          // SVG <use> elements reference sprite icons via href/xlink:href
          const useEls = child.tagName === 'SVG' ? child.querySelectorAll('use') : [];
          for (const use of useEls) {
            const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
            if (href) searchStrings.push(href.toLowerCase());
          }
          // Check data-testid on icon children (common in React apps)
          const testId = child.getAttribute && child.getAttribute('data-testid');
          if (testId) searchStrings.push(testId.toLowerCase());
          // Check img alt text
          if (child.tagName === 'IMG' && child.alt) searchStrings.push(child.alt.toLowerCase());
        }

        const combined = searchStrings.join(' ');
        for (const [pattern, meaning] of Object.entries(ICON_MEANINGS)) {
          if (combined.includes(pattern)) return meaning;
        }
        return null;
      }

      // Email action labels — elements with these labels are always interactive
      const EMAIL_ACTION_LABELS = ['reply', 'reply all', 'forward', 'compose', 'send', 'discard', 'archive', 'delete', 'mark as read', 'mark as unread', 'snooze', 'move to', 'more options', 'newer', 'older'];

      function classifyElement(node) {
        const tag = node.tagName;
        const role = node.getAttribute('role');
        if (tag === 'BUTTON' || role === 'button') return 'button';
        if (tag === 'A') return 'link';
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return 'input';
        // Detect toggle switches, checkboxes, and radio buttons by role
        if (role === 'switch' || role === 'checkbox' || role === 'radio') return 'input';
        // Detect custom form controls used by React apps (Facebook, etc.)
        if (role === 'combobox' || role === 'listbox' || role === 'spinbutton' ||
            role === 'slider' || role === 'textbox' || role === 'searchbox') return 'input';
        // Detect contentEditable elements (custom text inputs)
        if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') return 'input';
        // Detect elements with aria-haspopup (custom dropdowns)
        if (node.getAttribute('aria-haspopup') === 'listbox' || node.getAttribute('aria-haspopup') === 'menu') return 'input';

        // ── UNIVERSAL EDITOR DETECTION ──
        // Rich text editors (ProseMirror, Slate, Draft.js, Lexical, CKEditor, TinyMCE,
        // Quill, etc.) wrap contentEditable inside container divs with recognizable
        // class names. The actual contentEditable child will be caught by the tree walk,
        // but sometimes the wrapper itself needs to be classified so its children get
        // walked. Also catches editors that set contenteditable dynamically on focus.
        const cls = (node.className && typeof node.className === 'string') ? node.className.toLowerCase() : '';
        if (cls) {
          const editorPatterns = ['prosemirror', 'ql-editor', 'ce-block', 'slate-editor',
            'drafteditor', 'draft-editor', 'lexical', 'ckeditor', 'tox-edit-area',
            'tinymce', 'editable', 'composer', 'note-editable', 'ck-editor__editable',
            'public-drafteditor-content', 'notranslate'];
          if (editorPatterns.some(p => cls.includes(p))) {
            // Verify it's actually editable (not just a wrapper label)
            if (node.isContentEditable || node.getAttribute('contenteditable') === 'true' ||
                node.querySelector('[contenteditable="true"]')) {
              return 'input';
            }
          }
        }

        // Detect data-* attributes common in rich text editors
        if (node.getAttribute('data-contents') === 'true' || // Draft.js
            node.getAttribute('data-slate-editor') === 'true' || // Slate
            node.getAttribute('data-lexical-editor') === 'true' || // Lexical
            node.getAttribute('data-placeholder')) { // Many editors use data-placeholder
          return 'input';
        }

        // Gmail/email clients: detect action buttons by aria-label, data-tooltip, or title
        const ariaLabel = (node.getAttribute('aria-label') || '').toLowerCase();
        const dataTooltip = (node.getAttribute('data-tooltip') || '').toLowerCase();
        const title = (node.getAttribute('title') || '').toLowerCase();
        if (EMAIL_ACTION_LABELS.some(a => ariaLabel.includes(a) || dataTooltip.includes(a) || title.includes(a))) {
          return 'button';
        }
        // Detect clickable elements with tabindex and role
        if (role === 'link' || role === 'tab' || role === 'menuitem' || role === 'option' || role === 'menuitemradio' || role === 'menuitemcheckbox' || role === 'treeitem') return 'button';
        return null;
      }

      function getElementText(node) {
        const text = (node.innerText || node.textContent || node.value ||
                node.getAttribute('aria-label') || node.getAttribute('data-tooltip') ||
                node.getAttribute('title') || node.getAttribute('placeholder') || '').trim().slice(0, 120);

        // If no meaningful text, try icon meaning
        if (!text || text.length < 2) {
          const iconMeaning = getIconMeaning(node);
          if (iconMeaning) return `[${iconMeaning}]`;

          // ── UNIVERSAL INPUT DETECTION ──
          // Empty form fields (inputs, textareas, contentEditable) MUST appear in
          // the semantic map even when they have no visible text. Without this,
          // the agent cannot type into blank fields on Reddit, Word Online, Notion,
          // Google Docs, customer chat panels, or ANY website with empty inputs.
          // Generate a descriptive fallback label from available attributes.
          const tag = node.tagName;
          const isFormField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
          const isEditable = node.isContentEditable || node.getAttribute('contenteditable') === 'true';
          const role = node.getAttribute('role');
          const isRoleInput = role === 'textbox' || role === 'searchbox' || role === 'combobox';

          if (isFormField || isEditable || isRoleInput) {
            // Build a label from whatever attributes exist
            const name = node.getAttribute('name');
            const id = node.getAttribute('id');
            const type = node.getAttribute('type');
            const placeholder = node.getAttribute('placeholder');
            const ariaLabel = node.getAttribute('aria-label');

            // Check for associated <label> element
            let labelText = '';
            if (id) {
              const labelEl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
              if (labelEl) labelText = (labelEl.innerText || labelEl.textContent || '').trim().slice(0, 60);
            }
            if (!labelText) {
              const parentLabel = node.closest('label');
              if (parentLabel) labelText = (parentLabel.innerText || parentLabel.textContent || '').trim().slice(0, 60);
            }

            // Check CSS pseudo-element placeholder (Reddit uses ::placeholder via CSS)
            let cssPlaceholder = '';
            try {
              const before = window.getComputedStyle(node, '::before').content;
              const after = window.getComputedStyle(node, '::after').content;
              const pseudo = before !== 'none' ? before : (after !== 'none' ? after : '');
              if (pseudo && pseudo !== '""' && pseudo !== "''") {
                cssPlaceholder = pseudo.replace(/^["']|["']$/g, '').trim();
              }
            } catch {}

            // Check for nearby heading/label text (within 2 levels up)
            let nearbyLabel = '';
            if (!labelText && !ariaLabel && !placeholder && !cssPlaceholder) {
              const parent = node.parentElement;
              if (parent) {
                const siblings = parent.children;
                for (const sib of siblings) {
                  if (sib === node) continue;
                  const sibTag = sib.tagName;
                  if (sibTag === 'LABEL' || sibTag === 'SPAN' || sibTag === 'H1' || sibTag === 'H2' || sibTag === 'H3' || sibTag === 'H4' || sibTag === 'P') {
                    const sibText = (sib.innerText || sib.textContent || '').trim();
                    if (sibText && sibText.length < 60) {
                      nearbyLabel = sibText;
                      break;
                    }
                  }
                }
              }
            }

            const label = ariaLabel || placeholder || labelText || cssPlaceholder || nearbyLabel ||
              (name ? `${name} field` : '') ||
              (id ? `${id} field` : '') ||
              (isEditable ? `[editable area]` : '') ||
              (isRoleInput ? `[text input]` : '') ||
              (type ? `[${type} input]` : `[${tag.toLowerCase()} field]`);

            if (label) return `[empty] ${label}`.slice(0, 120);
          }

          // ── CLICKABLE ELEMENT FALLBACK ──
          // Buttons/links with no text AND no icon meaning must still appear in the
          // semantic map — they could be icon-only menu triggers, avatar buttons, etc.
          // Generate a descriptive fallback from element attributes and structure.
          {
            const elTag = node.tagName;
            const elRole = node.getAttribute('role');
            const isClickable = elTag === 'BUTTON' || elTag === 'A' || elRole === 'button' ||
              elRole === 'link' || elRole === 'tab' || elRole === 'menuitem' ||
              node.getAttribute('tabindex') === '0';

            if (isClickable) {
              // Try to describe the button from its children (e.g., <img>, <span>, etc.)
              const childImg = node.querySelector('img');
              if (childImg && childImg.alt) return `[${childImg.alt}]`;

              // Check if it contains an SVG (icon button with unknown icon)
              const hasSvg = node.querySelector('svg');
              const hasImg = node.querySelector('img');

              // Build a fallback label
              const elAriaLabel = node.getAttribute('aria-label');
              if (elAriaLabel) return elAriaLabel;

              const elId = node.getAttribute('id');
              const elName = node.getAttribute('name');
              const testId = node.getAttribute('data-testid');

              // ── POSITIONAL DISAMBIGUATION ──
              // When multiple icon buttons have no text, give the AI spatial
              // and structural cues so it can distinguish them.
              // Format: [icon button, bottom-left, nav, 2nd of 4]
              const posHints = [];

              // 1. Screen region from bounding rect
              try {
                const rect = node.getBoundingClientRect();
                const vw = window.innerWidth || document.documentElement.clientWidth;
                const vh = window.innerHeight || document.documentElement.clientHeight;
                if (rect.width > 0 && rect.height > 0) {
                  const cx = rect.left + rect.width / 2;
                  const cy = rect.top + rect.height / 2;
                  const hZone = cx < vw * 0.3 ? 'left' : cx > vw * 0.7 ? 'right' : 'center';
                  const vZone = cy < vh * 0.25 ? 'top' : cy > vh * 0.75 ? 'bottom' : 'middle';
                  posHints.push(vZone === 'middle' ? hZone : `${vZone}-${hZone}`);
                }
              } catch {}

              // 2. Landmark ancestor (header, nav, sidebar, footer, main, aside)
              try {
                const landmark = node.closest('header, nav, footer, main, aside, [role="navigation"], [role="banner"], [role="complementary"], [role="contentinfo"]');
                if (landmark) {
                  const lTag = landmark.tagName.toLowerCase();
                  const lRole = landmark.getAttribute('role');
                  const landmarkName = lRole === 'navigation' ? 'nav' :
                    lRole === 'banner' ? 'header' :
                    lRole === 'complementary' ? 'sidebar' :
                    lRole === 'contentinfo' ? 'footer' :
                    (lTag === 'aside' ? 'sidebar' : lTag);
                  posHints.push(landmarkName);
                }
              } catch {}

              // 3. Sibling index — "2nd of 4" icon buttons in the same parent
              try {
                const parent = node.parentElement;
                if (parent) {
                  const siblings = Array.from(parent.children).filter(sib => {
                    if (sib.tagName !== 'BUTTON' && sib.tagName !== 'A' &&
                        sib.getAttribute('role') !== 'button') return false;
                    const sibText = (sib.innerText || sib.textContent || sib.getAttribute('aria-label') || '').trim();
                    return !sibText || sibText.length < 2; // only count unlabeled siblings
                  });
                  if (siblings.length > 1) {
                    const idx = siblings.indexOf(node) + 1;
                    if (idx > 0) posHints.push(`${idx} of ${siblings.length}`);
                  }
                }
              } catch {}

              const baseLabel = testId ? testId :
                elId ? `${elId} button` :
                elName ? `${elName} button` :
                hasSvg ? 'icon button' :
                hasImg ? 'image button' :
                `unlabeled ${elTag.toLowerCase()}`;

              const fallbackLabel = posHints.length > 0
                ? `[${baseLabel}, ${posHints.join(', ')}]`
                : `[${baseLabel}]`;

              return fallbackLabel;
            }
          }

          return '';
        }

        // Append icon meaning if element has one and text doesn't already describe it
        const iconMeaning = getIconMeaning(node);
        if (iconMeaning && !text.toLowerCase().includes(iconMeaning.toLowerCase().split('/')[0])) {
          return `${text} [${iconMeaning}]`;
        }

        return text;
      }

      // ── Modal/Dialog Detection ─────────────────────────────────
      // Find open modals/dialogs and prioritize their contents
      function findOpenModals() {
        const modalSelectors = [
          '[role="dialog"]',
          '[role="alertdialog"]',
          '[aria-modal="true"]',
          '[role="menu"]',
          '[role="listbox"]',
          '[role="tooltip"][aria-expanded="true"]',
          '.modal:not(.modal-hidden):not([style*="display: none"])',
          '.dialog:not([style*="display: none"])',
          '.overlay:not([style*="display: none"])',
          '[class*="modal"]:not([style*="display: none"])',
          '[class*="Modal"]:not([style*="display: none"])',
          '[class*="dialog"]:not([style*="display: none"])',
          '[class*="Dialog"]:not([style*="display: none"])',
          '[class*="popup"]:not([style*="display: none"])',
          '[class*="Popup"]:not([style*="display: none"])',
          '[class*="popover"]:not([style*="display: none"])',
          '[class*="Popover"]:not([style*="display: none"])',
          '[class*="dropdown"]:not([style*="display: none"])',
          '[class*="Dropdown"]:not([style*="display: none"])',
          '[class*="drop-down"]:not([style*="display: none"])',
          '[class*="menu-panel"]:not([style*="display: none"])',
          '[class*="MenuPanel"]:not([style*="display: none"])',
          '[class*="context-menu"]:not([style*="display: none"])',
          '[class*="drawer"]:not([style*="display: none"])',
          '[class*="Drawer"]:not([style*="display: none"])',
          '[class*="flyout"]:not([style*="display: none"])',
          '[class*="Flyout"]:not([style*="display: none"])',
          // Expanded dropdown triggers often have adjacent visible menus
          '[aria-expanded="true"] + [role="menu"]',
          '[aria-expanded="true"] + [role="listbox"]',
        ];

        const modals = [];
        const seen = new Set();
        for (const sel of modalSelectors) {
          try {
            for (const el of document.querySelectorAll(sel)) {
              // Skip if already found, hidden, or too small to be a real modal
              if (seen.has(el)) continue;
              const rect = el.getBoundingClientRect();
              // Dropdown menus can be narrow — use smaller thresholds
              if (rect.width < 40 || rect.height < 30) continue;
              if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue;
              seen.add(el);
              modals.push(el);
            }
          } catch {}
        }
        return modals;
      }

      const openModals = findOpenModals();
      const hasOpenModal = openModals.length > 0;

      // ── Element Resolver Helpers: richer metadata per element ──

      // Find the nearest section heading above/before an element
      function getNearestHeading(node) {
        // Walk up the DOM tree looking for a heading or labeled section
        let current = node.parentElement;
        let depth = 0;
        while (current && depth < 8) {
          // Check if this container has a heading child before our element
          const headings = current.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"], legend, label');
          for (const h of headings) {
            // Only count headings that come BEFORE our element in DOM order
            if (h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
              const text = (h.innerText || h.textContent || '').trim().slice(0, 60);
              if (text) return text;
            }
          }
          // Check aria-label on the container itself (e.g., <section aria-label="Privacy">)
          const sectionLabel = current.getAttribute('aria-label') || current.getAttribute('aria-labelledby');
          if (sectionLabel) {
            if (current.getAttribute('aria-labelledby')) {
              const labelEl = document.getElementById(sectionLabel);
              if (labelEl) return (labelEl.innerText || '').trim().slice(0, 60);
            }
            return sectionLabel.slice(0, 60);
          }
          current = current.parentElement;
          depth++;
        }
        return null;
      }

      // Calculate DOM depth (for structural context)
      function getDomDepth(node) {
        let depth = 0;
        let current = node;
        while (current.parentElement) {
          depth++;
          current = current.parentElement;
        }
        return depth;
      }

      // Count sibling elements of the same type with the same text (disambiguation signal)
      function countSimilarSiblings(node, text) {
        if (!node.parentElement) return 0;
        const siblings = node.parentElement.children;
        let count = 0;
        for (const sib of siblings) {
          if (sib === node) continue;
          const sibText = (sib.innerText || sib.textContent || '').trim().slice(0, 120);
          if (sibText === text) count++;
        }
        return count;
      }

      // ── findNearbyCharLimit: Detect character limit from nearby counter text ──
      // Scans siblings, parent's children, and aria-describedby targets for patterns
      // like "0/300", "245 / 280", "3000 characters remaining", "Max 100 characters".
      // Works universally across Reddit, Twitter, LinkedIn, Facebook, etc.
      function findNearbyCharLimit(inputNode) {
        // Pattern 1: "X/Y" or "X / Y" where Y is the max (Reddit "0/300", Twitter style)
        const counterRegex = /(\d{1,5})\s*\/\s*(\d{1,5})/;
        // Pattern 2: "N characters remaining" or "N chars left" or "N remaining"
        const remainingRegex = /(\d{1,5})\s*(?:characters?|chars?)\s*(?:remaining|left)/i;
        // Pattern 3: "Max N characters" or "Maximum N chars" or "Limit: N"
        const maxRegex = /(?:max(?:imum)?|limit)\s*:?\s*(\d{1,5})\s*(?:characters?|chars?)?/i;
        // Pattern 4: "N of M characters" (LinkedIn style)
        const ofRegex = /(\d{1,5})\s+of\s+(\d{1,5})\s*(?:characters?|chars?)?/i;

        function extractLimit(text) {
          let m;
          m = text.match(counterRegex);
          if (m) return parseInt(m[2], 10);
          m = text.match(ofRegex);
          if (m) return parseInt(m[2], 10);
          m = text.match(maxRegex);
          if (m) return parseInt(m[1], 10);
          m = text.match(remainingRegex);
          // For "remaining" pattern, the number is what's left, not the max.
          // We can't determine max from remaining alone, so skip.
          return 0;
        }

        // Search strategy: check nearby elements (siblings, parent children, aria references)
        const searchTargets = [];

        // Siblings of the input
        if (inputNode.parentElement) {
          for (const sib of inputNode.parentElement.children) {
            if (sib === inputNode) continue;
            searchTargets.push(sib);
          }
        }
        // Parent's siblings (counter might be at the same level as the input's wrapper)
        if (inputNode.parentElement?.parentElement) {
          for (const uncle of inputNode.parentElement.parentElement.children) {
            if (uncle === inputNode.parentElement) continue;
            searchTargets.push(uncle);
          }
        }
        // aria-describedby target
        const describedBy = inputNode.getAttribute('aria-describedby');
        if (describedBy) {
          const descEl = document.getElementById(describedBy);
          if (descEl) searchTargets.push(descEl);
        }

        for (const el of searchTargets) {
          const elText = (el.innerText || el.textContent || '').trim();
          if (elText.length > 0 && elText.length < 50) {
            const limit = extractLimit(elText);
            if (limit > 0 && limit <= 100000) return limit;
          }
        }
        return 0;
      }

      // Build rich element metadata (shared by walkContainer and walkPage)
      function buildElementEntry(node, type, text, isModal) {
        const sid = `${type.slice(0, 4)}-${counter++}`;
        try { node.setAttribute('data-enh-sid', sid); } catch {}

        const attrs = {};
        if (node.href) attrs.href = node.href.slice(0, 200);
        if (node.name) attrs.name = node.name;
        if (node.type) attrs.type = node.type;
        if (node.getAttribute('aria-label')) attrs.ariaLabel = node.getAttribute('aria-label');
        if (node.getAttribute('aria-describedby')) {
          const descEl = document.getElementById(node.getAttribute('aria-describedby'));
          if (descEl) attrs.ariaDescription = (descEl.innerText || '').trim().slice(0, 80);
        }
        if (node.getAttribute('title')) attrs.title = node.getAttribute('title');
        if (node.getAttribute('data-tooltip')) attrs.dataTooltip = node.getAttribute('data-tooltip');
        if (node.getAttribute('role')) attrs.role = node.getAttribute('role');
        const iconMeaning = getIconMeaning(node);
        if (iconMeaning) attrs.iconMeaning = iconMeaning;

        // ── CHARACTER LIMIT DETECTION (Universal) ──
        // Extract maxlength from the element itself OR from nearby counter text.
        // This tells the AI how long the content can be so it writes COMPLETE
        // content that fits within the limit — not truncated, but crafted to fit.
        const nodeTag = node.tagName;
        if (nodeTag === 'INPUT' || nodeTag === 'TEXTAREA' || node.isContentEditable || node.getAttribute('contenteditable') === 'true' || node.getAttribute('role') === 'textbox') {
          // Method 1: HTML maxlength attribute (most reliable)
          const maxLen = node.getAttribute('maxlength') || node.getAttribute('maxLength');
          if (maxLen && parseInt(maxLen, 10) > 0) {
            attrs.maxlength = parseInt(maxLen, 10);
          }
          // Method 2: aria-valuemax (some custom inputs)
          if (!attrs.maxlength) {
            const ariaMax = node.getAttribute('aria-valuemax');
            if (ariaMax && parseInt(ariaMax, 10) > 0) {
              attrs.maxlength = parseInt(ariaMax, 10);
            }
          }
          // Method 3: Scan nearby sibling/parent for counter text like "0/300", "245/280"
          // These are universal patterns — Reddit shows "0/300", Twitter shows char count,
          // LinkedIn shows remaining chars, etc.
          if (!attrs.maxlength) {
            const counterLimit = findNearbyCharLimit(node);
            if (counterLimit > 0) {
              attrs.maxlength = counterLimit;
            }
          }
        }

        const parentText = node.parentElement
          ? (node.parentElement.innerText || '').trim().slice(0, 80)
          : '';

        // Structural context for element resolver
        const sectionHeading = getNearestHeading(node);
        const domDepth = getDomDepth(node);
        const similarCount = countSimilarSiblings(node, text);

        // ── Toggle/Switch/Checkbox state detection ──
        let toggleState = null;
        const nodeRole = node.getAttribute('role');
        const nodeType = (node.getAttribute('type') || '').toLowerCase();

        if (nodeRole === 'switch' || nodeRole === 'checkbox' || nodeRole === 'radio' ||
            nodeType === 'checkbox' || nodeType === 'radio') {
          const ariaChecked = node.getAttribute('aria-checked');
          const ariaPressed = node.getAttribute('aria-pressed');
          const isChecked = node.checked ||
            ariaChecked === 'true' ||
            ariaPressed === 'true' ||
            node.classList.contains('active') ||
            node.classList.contains('on') ||
            node.classList.contains('enabled') ||
            node.classList.contains('checked');
          toggleState = isChecked ? 'ON/ENABLED' : 'OFF/DISABLED';
        }

        // Get the label near this toggle for context
        let toggleLabel = null;
        if (toggleState) {
          toggleLabel = node.closest('label')?.textContent?.trim() ||
            node.closest('[class*="setting"]')?.querySelector('h3, h4, label, span')?.textContent?.trim() ||
            node.getAttribute('aria-label') ||
            sectionHeading || '';
          if (toggleLabel) toggleLabel = toggleLabel.slice(0, 100);
        }

        // Append toggle state to text for AI visibility
        let finalText = text;
        if (toggleState) {
          finalText += ` [STATE: ${toggleState}]`;
          if (toggleLabel && !text.includes(toggleLabel)) {
            finalText += ` Label: "${toggleLabel}"`;
          }
        }

        // ── Current Value Detection for form fields ──
        // Captures the ACTUAL current value of inputs, selects, textareas
        // so the AI can see what defaults are set and decide whether to change them.
        let currentValue = null;
        const tag = node.tagName;

        if (tag === 'INPUT') {
          const iType = (node.getAttribute('type') || 'text').toLowerCase();
          if (iType !== 'checkbox' && iType !== 'radio' && iType !== 'hidden' && iType !== 'submit' && iType !== 'button') {
            const val = (node.value || '').trim();
            if (val) currentValue = val.slice(0, 120);
          }
        } else if (tag === 'TEXTAREA') {
          const val = (node.value || '').trim();
          if (val) currentValue = val.slice(0, 200);
        } else if (tag === 'SELECT') {
          const selOpt = node.options?.[node.selectedIndex];
          if (selOpt) currentValue = (selOpt.text || selOpt.value || '').trim().slice(0, 120);
        }

        // Also detect custom dropdown/combobox current values (React, Facebook, etc.)
        if (!currentValue) {
          const nodeRole = node.getAttribute('role');
          if (nodeRole === 'combobox' || nodeRole === 'listbox' || nodeRole === 'spinbutton' ||
              node.getAttribute('aria-haspopup') === 'listbox' || node.getAttribute('aria-haspopup') === 'true') {
            const ariaVal = node.getAttribute('aria-valuenow') || node.getAttribute('aria-valuetext');
            if (ariaVal) {
              currentValue = ariaVal.slice(0, 120);
            } else {
              // Facebook/React: value is often the innerText of the control
              const innerVal = (node.innerText || node.textContent || '').trim();
              if (innerVal && innerVal.length < 80 && innerVal !== text) {
                currentValue = innerVal.slice(0, 120);
              }
            }
          }
          // ContentEditable elements (custom text inputs)
          if (!currentValue && (node.isContentEditable || node.getAttribute('contenteditable') === 'true')) {
            const ceVal = (node.innerText || node.textContent || '').trim();
            if (ceVal) currentValue = ceVal.slice(0, 200);
          }
          // Role=textbox (custom input elements)
          if (!currentValue && nodeRole === 'textbox') {
            const tbVal = (node.innerText || node.textContent || node.value || '').trim();
            if (tbVal) currentValue = tbVal.slice(0, 120);
          }
        }

        // Append current value to text so AI can see it
        if (currentValue && !finalText.includes(currentValue)) {
          finalText += ` [CURRENT VALUE: "${currentValue}"]`;
        }

        // Detect disabled state
        const isDisabled = node.disabled ||
          node.getAttribute('aria-disabled') === 'true' ||
          node.hasAttribute('disabled') ||
          node.classList.contains('disabled');

        // Detect if this element is editable (helps AI choose type_text targets)
        const isEditableElement = node.isContentEditable ||
          node.getAttribute('contenteditable') === 'true' ||
          node.getAttribute('role') === 'textbox' ||
          node.getAttribute('role') === 'searchbox' ||
          node.tagName === 'INPUT' || node.tagName === 'TEXTAREA';

        // ── Lightweight Positional Data ──
        // Compute a human-readable screen region (e.g., "top-right", "bottom-left", "center")
        // so the AI can distinguish a profile icon in the top-right from sidebar nav items.
        // Also compute normalized percentage coordinates (xPct, yPct) for screen-size-independent
        // fingerprinting. These are 0.0-1.0 values relative to viewport dimensions.
        let pos = null;
        let xPct = null;
        let yPct = null;
        try {
          const rect = node.getBoundingClientRect();
          const vw = window.innerWidth || document.documentElement.clientWidth;
          const vh = window.innerHeight || document.documentElement.clientHeight;
          if (rect.width > 0 && rect.height > 0) {
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const hZone = cx < vw * 0.3 ? 'left' : cx > vw * 0.7 ? 'right' : 'center';
            const vZone = cy < vh * 0.25 ? 'top' : cy > vh * 0.75 ? 'bottom' : 'middle';
            pos = vZone === 'middle' ? (hZone === 'center' ? 'center' : `middle-${hZone}`) : `${vZone}-${hZone}`;
            // Normalized coordinates for SiteMap fingerprinting (screen-size independent)
            xPct = Math.round(cx / vw * 1000) / 1000;
            yPct = Math.round(cy / vh * 1000) / 1000;
          }
        } catch {}

        return {
          sid, type, text: finalText, attrs,
          context: parentText,
          inModal: isModal,
          section: sectionHeading,        // nearest heading above this element
          depth: domDepth,                 // DOM depth for structural grouping
          duplicates: similarCount,        // count of siblings with identical text
          currentValue: currentValue,      // raw value for programmatic access
          isEditable: isEditableElement || false,
          isDisabled: isDisabled || false,
          pos,                             // screen region: "top-right", "bottom-left", etc.
          xPct,                            // normalized X (0.0-1.0) for fingerprinting
          yPct,                            // normalized Y (0.0-1.0) for fingerprinting
        };
      }

      function walkContainer(root, prefix) {
        const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','IFRAME','CANVAS','TEMPLATE']);

        function walk(node) {
          if (elements.length >= MAX_ELEMENTS) return;
          if (!node || !node.tagName) return;
          if (SKIP.has(node.tagName)) return;

          const type = classifyElement(node);
          const text = getElementText(node);

          if (type && text) {
            elements.push(buildElementEntry(node, type, text, prefix === '[MODAL] '));
          }

          // Walk shadow DOM children (Shreddit/Reddit, Salesforce Lightning, etc.)
          if (node.shadowRoot) {
            for (const child of node.shadowRoot.children) walk(child);
          }
          for (const child of node.children) walk(child);
        }

        walk(root);
      }

      // If a modal is open, scan modal elements FIRST (they appear at top of list)
      if (hasOpenModal) {
        for (const modal of openModals) {
          walkContainer(modal, '[MODAL] ');
        }
      }

      // Then scan the rest of the page (remaining budget)
      if (elements.length < MAX_ELEMENTS) {
        const modalSet = new Set(openModals);
        const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','IFRAME','CANVAS','TEMPLATE']);

        function walkPage(node) {
          if (elements.length >= MAX_ELEMENTS) return;
          if (!node || !node.tagName) return;
          if (SKIP.has(node.tagName)) return;
          if (modalSet.has(node)) return;

          const type = classifyElement(node);
          const text = getElementText(node);

          if (type && text) {
            elements.push(buildElementEntry(node, type, text, false));
          }

          // Walk shadow DOM children (Shreddit/Reddit, Salesforce Lightning, etc.)
          if (node.shadowRoot) {
            for (const child of node.shadowRoot.children) walkPage(child);
          }
          for (const child of node.children) walkPage(child);
        }

        walkPage(document.body);
      }

      // Also extract visible text — prioritize modal content
      let visibleText;
      if (hasOpenModal) {
        // Extract text from modal first, then page
        const modalTexts = openModals.map(m => (m.innerText || '').trim()).join('\n');
        const modalContent = modalTexts.slice(0, 1500);
        const pageContent = EXPLORE_ACTIONS.extract_visible_text({ value: '500' }).observation || '';
        visibleText = { observation: `[MODAL CONTENT]\n${modalContent}\n\n[BACKGROUND PAGE]\n${pageContent}` };
      } else {
        visibleText = EXPLORE_ACTIONS.extract_visible_text({ value: '2000' });
      }

      // ── Session Context: Detect active account on multi-account platforms ──
      const accountContext = SessionContextValidator.detectActiveAccount();

      // Auth gate detection — uses the comprehensive AuthGateDetector
      const authGate = AuthGateDetector.detect();

      // ── Platform Detection (for SiteMap fingerprinting) ──
      // Detects CMS/platform so one fingerprint can cover millions of sites.
      const platformHints = {};
      try {
        // Collect script sources (for Shopify, WordPress, Wix detection)
        const scriptEls = document.querySelectorAll('script[src]');
        platformHints.scripts = Array.from(scriptEls).slice(0, 20).map(s => s.src || '');
        // Collect meta tags (generator, platform identifiers)
        const metaEls = document.querySelectorAll('meta[name], meta[property], meta[content]');
        platformHints.metaTags = Array.from(metaEls).slice(0, 20).map(m =>
          `${m.getAttribute('name') || m.getAttribute('property') || ''}=${(m.getAttribute('content') || '').slice(0, 100)}`
        );
        // Check for common platform CSS classes on body/html
        const bodyClasses = (document.body?.className || '').slice(0, 300);
        const htmlClasses = (document.documentElement?.className || '').slice(0, 300);
        platformHints.cssClasses = [bodyClasses, htmlClasses].filter(Boolean);
      } catch {}

      return {
        success: true,
        observation: 'Page snapshot taken.',
        snapshot: {
          url: location.href,
          title: document.title || '',
          mainContent: visibleText.observation || '',
          semanticElements: elements,
          isLoginPage: authGate.isAuthPage,
          hasOpenModal,
          authGate: authGate.isAuthPage ? {
            authType: authGate.authType,
            signals: authGate.signals,
            signalCount: authGate.signalCount,
          } : null,
          accountContext: accountContext.activeAccount ? accountContext : null,
          pageType: detectPageType(location.href),
          // SiteMap fingerprinting data
          viewportWidth: window.innerWidth || document.documentElement.clientWidth,
          viewportHeight: window.innerHeight || document.documentElement.clientHeight,
          platformHints,
        },
      };
    },

    wait({ value }) {
      const ms = Math.min(parseInt(value) || 1000, 3000);
      return new Promise(resolve =>
        setTimeout(() => resolve({ success: true, observation: `Waited ${ms}ms.` }), ms)
      );
    },

    // ── DOM Fingerprint ────────────────────────────────────────
    // Lightweight structural hash for DOM stability detection.
    // Returns a fast fingerprint (element count, tag distribution,
    // text length) — NOT a full snapshot. Used by background.js
    // waitForDomStable() to detect when page stops changing.
    dom_fingerprint() {
      const body = document.body;
      if (!body) return { success: true, fingerprint: 'nobody' };

      const allEls = body.querySelectorAll('*');
      const elCount = allEls.length;
      const textLen = (body.innerText || '').length;

      // Count interactive elements (buttons, links, inputs) — these
      // are what matters for agent actions. Cheap to compute.
      let interactive = 0;
      let imgCount = 0;
      for (let i = 0; i < allEls.length; i++) {
        const tag = allEls[i].tagName;
        if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' ||
            tag === 'SELECT' || tag === 'TEXTAREA') interactive++;
        if (tag === 'IMG') imgCount++;
      }

      // Combine into a single string — two identical fingerprints
      // means the DOM structure hasn't changed between polls
      const fp = `${elCount}:${interactive}:${imgCount}:${textLen}`;
      return { success: true, fingerprint: fp };
    },

    // ── Precise Element Resolver ─────────────────────────────
    // Multi-signal scoring to find the RIGHT element when there
    // are multiple similar ones (e.g., 6 "Edit" buttons).
    // Called with target = text description, value = contextHint (nearby label/section).
    resolve_element({ target, value }) {
      if (!target) return { success: false, error: 'No target description for resolve_element' };

      const targetText = target.toLowerCase().trim();
      const contextHint = (value || '').toLowerCase().trim();

      // Find ALL candidate elements matching the target text
      const candidates = [];
      const allInteractive = document.querySelectorAll(
        'button, a, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"]'
      );

      for (const el of allInteractive) {
        const elText = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
        const elTextLower = elText.toLowerCase();

        // Text content match (exact or fuzzy)
        let textScore = 0;
        if (elTextLower === targetText) {
          textScore = 1.0;
        } else if (elTextLower.includes(targetText) || targetText.includes(elTextLower)) {
          textScore = 0.7;
        } else {
          // Fuzzy: check if words overlap significantly
          const targetWords = targetText.split(/\s+/);
          const elWords = elTextLower.split(/\s+/);
          const overlap = targetWords.filter(w => elWords.some(ew => ew.includes(w) || w.includes(ew)));
          if (overlap.length > 0) textScore = 0.3 * (overlap.length / targetWords.length);
        }
        if (textScore === 0) continue; // Skip non-matches entirely

        // Aria/role match
        let ariaScore = 0;
        const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
        const title = (el.getAttribute('title') || '').toLowerCase();
        if (ariaLabel && (ariaLabel.includes(targetText) || targetText.includes(ariaLabel))) ariaScore = 1.0;
        else if (title && (title.includes(targetText) || targetText.includes(title))) ariaScore = 0.7;
        else if (el.getAttribute('role')) ariaScore = 0.1; // has a role = slightly better candidate

        // Spatial/structural context match (proximity to contextHint)
        let spatialScore = 0;
        if (contextHint) {
          // Check nearest section heading
          const heading = getNearestHeading(el);
          if (heading && heading.toLowerCase().includes(contextHint)) spatialScore = 1.0;
          else {
            // Check parent text for context hint
            const parentText = (el.parentElement?.innerText || '').toLowerCase().slice(0, 200);
            if (parentText.includes(contextHint)) spatialScore = 0.7;
            // Check sibling text
            const siblingText = Array.from(el.parentElement?.children || [])
              .filter(s => s !== el)
              .map(s => (s.innerText || s.textContent || '').toLowerCase().trim())
              .join(' ')
              .slice(0, 300);
            if (siblingText.includes(contextHint)) spatialScore = 0.5;
          }
        }

        // Visibility check (visible elements preferred)
        const rect = el.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0 &&
          rect.top < window.innerHeight && rect.bottom > 0;
        const visibilityScore = isVisible ? 1.0 : 0.2;

        // Weighted total
        const totalScore = (textScore * 0.3) + (ariaScore * 0.25) + (spatialScore * 0.25) + (visibilityScore * 0.2);

        // Assign or reuse SID
        let sid = el.getAttribute('data-enh-sid');
        if (!sid) {
          const type = classifyElement(el) || 'elem';
          sid = `${type.slice(0, 4)}-${counter++}`;
          try { el.setAttribute('data-enh-sid', sid); } catch {}
        }

        candidates.push({
          sid,
          text: elText.slice(0, 100),
          score: Math.round(totalScore * 100) / 100,
          signals: {
            text: Math.round(textScore * 100) / 100,
            aria: Math.round(ariaScore * 100) / 100,
            spatial: Math.round(spatialScore * 100) / 100,
            visible: Math.round(visibilityScore * 100) / 100,
          },
          section: getNearestHeading(el)?.slice(0, 60) || null,
          ariaLabel: ariaLabel || null,
        });
      }

      // Sort by score descending
      candidates.sort((a, b) => b.score - a.score);
      const top = candidates.slice(0, 5);

      if (top.length === 0) {
        return {
          success: false,
          error: `No elements found matching "${target}".${getRecoverySnapshot()}`,
        };
      }

      const best = top[0];

      // Confidence thresholds
      if (best.score >= 0.8) {
        return {
          success: true,
          observation: `Resolved "${target}" → [${best.sid}] "${best.text}" (score: ${best.score}, section: ${best.section || 'none'})`,
          resolvedSid: best.sid,
          confidence: 'high',
          candidates: top,
        };
      } else if (best.score >= 0.5) {
        return {
          success: true,
          observation: `Medium confidence: "${target}" → [${best.sid}] "${best.text}" (score: ${best.score}). Other candidates: ${top.slice(1).map(c => `[${c.sid}] "${c.text}" (${c.score})`).join(', ')}`,
          resolvedSid: best.sid,
          confidence: 'medium',
          candidates: top,
        };
      } else {
        return {
          success: false,
          error: `Low confidence resolving "${target}". Best: [${best.sid}] "${best.text}" (score: ${best.score}). All candidates: ${top.map(c => `[${c.sid}] "${c.text}" score=${c.score} section="${c.section || 'none'}"`).join(' | ')}`,
          confidence: 'low',
          candidates: top,
        };
      }
    },
  };

  // ── Message Listener ────────────────────────────────────────

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    // Ping/pong readiness check — background.js uses this to verify script is alive before sending commands
    if (request.type === 'explore_ping') {
      sendResponse({ alive: true, url: window.location.href });
      return true;
    }

    if (request.type !== 'explore_action') return;

    const { actionType, target, value, consentApproved } = request;

    // Dedicated auth gate check — called by background.js before any action
    if (actionType === 'auth_check') {
      const result = AuthGateDetector.detect();
      sendResponse({
        success: true,
        isAuthPage: result.isAuthPage,
        authType: result.authType,
        signals: result.signals,
        signalCount: result.signalCount,
      });
      return true;
    }

    // Session context check — detect active account on multi-account platforms
    if (actionType === 'session_context') {
      const result = SessionContextValidator.detectActiveAccount();
      sendResponse({ success: true, ...result });
      return true;
    }

    // Map action types to handlers
    const handlerMap = {
      'click_element': 'click_by_sid',
      'read_element':  'read_by_sid',
      'type_text':     'type_text',
      'select_option': 'select_option',
      'scroll':        'scroll_page',
      'scroll_to':     'scroll_to_sid',
      'scrape_page':   'extract_visible_text',
      'scrape_table':  'scrape_table',
      'wait':          'wait',
      'take_snapshot': 'take_snapshot',
      'dom_fingerprint': 'dom_fingerprint',
      'resolve_element': 'resolve_element',
      'press_key':       'press_key',
      'paste_tsv':       'paste_tsv',
    };

    // SECURITY: Block fill_field and type_text entirely on login/auth pages
    // Triple-check: AuthGateDetector + URL patterns + password field presence + auth domains
    if (actionType === 'fill_field' || actionType === 'type_text' || actionType === 'select_option' || actionType === 'press_key' || actionType === 'paste_tsv') {
      const authCheck = AuthGateDetector.detect();
      const currentUrl = window.location.href.toLowerCase();
      const hardLoginPatterns = ['signin', 'sign-in', 'login', 'log-in', '/auth/', '/oauth/', '/sso/', '/ap/signin', '/accounts/login', '/servicelogin', '/session/new', '/password', '/users/sign_in', '/account/login', '/authenticate', '/uc/login', '/id/signin', '/idp/login'];
      const isOnLoginUrl = hardLoginPatterns.some(p => currentUrl.includes(p));
      const hasPasswordField = !!document.querySelector('input[type="password"]');
      const isOnAuthDomain = AUTH_PROVIDER_DOMAINS.some(d => window.location.hostname.toLowerCase() === d || window.location.hostname.toLowerCase().endsWith('.' + d));

      if (authCheck.isAuthPage || isOnLoginUrl || hasPasswordField || isOnAuthDomain) {
        console.log('[SECURITY] BLOCKED', actionType, 'at dispatch level. authGate:', authCheck.isAuthPage, 'loginUrl:', isOnLoginUrl, 'passwordField:', hasPasswordField, 'authDomain:', isOnAuthDomain);
        sendResponse({
          success: false,
          error: `SECURITY_BLOCK: This is a login/authentication page. The agent cannot type or fill fields here. Please log in manually.`,
          blocked: true,
          authGate: { authType: authCheck.authType || 'login', signals: authCheck.signals || ['url_or_password_field'] },
        });
        return true;
      }
    }

    const handlerName = handlerMap[actionType] || actionType;
    const handler = EXPLORE_ACTIONS[handlerName];

    if (!handler) {
      sendResponse({ success: false, error: `Unknown explore action: ${actionType}` });
      return true;
    }

    const result = handler({ target, value, consentApproved });

    // Handle async actions (type_text, wait, etc.)
    if (result instanceof Promise) {
      result
        .then(sendResponse)
        .catch((err) => {
          console.error(`[content_explore] Async handler "${actionType}" threw:`, err);
          sendResponse({
            success: false,
            error: `Handler "${actionType}" crashed: ${err.message || String(err)}`,
          });
        });
      return true;
    }

    sendResponse(result);
    return true;
  });
})();
