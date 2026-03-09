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
    'password', 'passwd', 'pass', 'secret', 'credential',
    'pin', 'ssn', 'cvv', 'cvc', 'card-number', 'credit-card',
    'cardnumber', 'securitycode', 'security-code',
  ];

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

  const DANGEROUS_BUTTON_TEXT = [
    'send', 'submit', 'pay', 'purchase', 'buy now',
    'place order', 'confirm order', 'complete purchase',
    'checkout', 'place your order', 'delete', 'remove',
  ];


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

      // SECURITY: Block ALL typing on login/auth pages (URL match OR password field present)
      if (isLoginPage()) {
        return { success: false, error: 'LOGIN_PAGE_DETECTED: Agent cannot interact with login forms. User must log in manually.', blocked: true };
      }

      const el = findBySid(target);
      if (!el) {
        return {
          success: false,
          error: `Element not found: ${target}. Cannot type — element may have been removed or the page changed.${getRecoverySnapshot()}`,
        };
      }

      // SECURITY: Block password fields even on non-login pages
      if (el.matches('input[type="password"]')) {
        return { success: false, error: 'BLOCKED: Cannot type in password fields.', blocked: true };
      }

      if (isSensitiveElement(el)) {
        return { success: false, error: 'BLOCKED: Cannot interact with sensitive credential fields. User must enter credentials manually.', blocked: true };
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

      // ── Icon-to-meaning mapping ──────────────────────────────────
      // Many sites use icons instead of text. This maps common icon
      // patterns (class names, aria-labels, SVG classes) to meanings.
      const ICON_MEANINGS = {
        'settings': 'Settings', 'gear': 'Settings', 'cog': 'Settings', 'config': 'Settings',
        'profile': 'Profile/Account', 'person': 'Profile/Account', 'user': 'Profile/Account',
        'avatar': 'Profile/Account', 'account': 'Profile/Account',
        'notification': 'Notifications', 'bell': 'Notifications', 'alert': 'Notifications',
        'search': 'Search', 'magnify': 'Search', 'find': 'Search',
        'edit': 'Edit', 'pencil': 'Edit', 'pen': 'Edit', 'compose': 'Edit/Compose',
        'delete': 'Delete', 'trash': 'Delete', 'remove': 'Delete', 'bin': 'Delete',
        'close': 'Close', 'dismiss': 'Close', 'x-mark': 'Close',
        'menu': 'Menu', 'hamburger': 'Menu', 'nav': 'Menu',
        'home': 'Home', 'house': 'Home',
        'mail': 'Email/Mail', 'envelope': 'Email/Mail', 'inbox': 'Email/Mail',
        'share': 'Share', 'export': 'Share/Export',
        'download': 'Download', 'save': 'Save',
        'upload': 'Upload', 'attach': 'Attach',
        'cart': 'Shopping Cart', 'basket': 'Shopping Cart', 'bag': 'Shopping Cart',
        'help': 'Help', 'question': 'Help', 'support': 'Help',
        'logout': 'Log Out', 'signout': 'Log Out', 'sign-out': 'Log Out',
        'back': 'Go Back', 'arrow-left': 'Go Back', 'previous': 'Go Back',
        'forward': 'Go Forward', 'arrow-right': 'Go Forward', 'next': 'Go Forward',
        'refresh': 'Refresh', 'reload': 'Refresh',
        'filter': 'Filter', 'sort': 'Sort',
        'add': 'Add/Create', 'plus': 'Add/Create', 'new': 'Add/Create',
        'calendar': 'Calendar/Schedule', 'date': 'Calendar/Schedule',
        'chart': 'Analytics/Charts', 'graph': 'Analytics/Charts', 'stats': 'Analytics/Charts',
        'lock': 'Security/Privacy', 'shield': 'Security/Privacy', 'privacy': 'Security/Privacy',
      };

      function getIconMeaning(node) {
        // Collect all searchable strings: class names, aria-label, title, data attributes, child SVG classes
        const searchStrings = [];
        if (node.className && typeof node.className === 'string') searchStrings.push(node.className.toLowerCase());
        if (node.getAttribute('aria-label')) searchStrings.push(node.getAttribute('aria-label').toLowerCase());
        if (node.getAttribute('title')) searchStrings.push(node.getAttribute('title').toLowerCase());
        // Check data- attributes
        for (const attr of node.attributes || []) {
          if (attr.name.startsWith('data-') && attr.value) searchStrings.push(attr.value.toLowerCase());
        }
        // Check child SVG and icon element class names
        const iconChildren = node.querySelectorAll('svg, [class*="icon"], [class*="Icon"], i');
        for (const child of iconChildren) {
          if (child.className && typeof child.className === 'string') searchStrings.push(child.className.toLowerCase());
          if (child.getAttribute && child.getAttribute('aria-label')) searchStrings.push(child.getAttribute('aria-label').toLowerCase());
        }

        const combined = searchStrings.join(' ');
        for (const [pattern, meaning] of Object.entries(ICON_MEANINGS)) {
          if (combined.includes(pattern)) return meaning;
        }
        return null;
      }

      function classifyElement(node) {
        const tag = node.tagName;
        if (tag === 'BUTTON' || node.getAttribute('role') === 'button') return 'button';
        if (tag === 'A') return 'link';
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return 'input';
        return null;
      }

      function getElementText(node) {
        const text = (node.innerText || node.textContent || node.value ||
                node.getAttribute('aria-label') || node.getAttribute('title') ||
                node.getAttribute('placeholder') || '').trim().slice(0, 120);

        // If no meaningful text, try icon meaning
        if (!text || text.length < 2) {
          const iconMeaning = getIconMeaning(node);
          return iconMeaning ? `[${iconMeaning}]` : '';
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
          '.modal:not(.modal-hidden):not([style*="display: none"])',
          '.dialog:not([style*="display: none"])',
          '.overlay:not([style*="display: none"])',
          '[class*="modal"]:not([style*="display: none"])',
          '[class*="Modal"]:not([style*="display: none"])',
          '[class*="dialog"]:not([style*="display: none"])',
          '[class*="Dialog"]:not([style*="display: none"])',
          '[class*="popup"]:not([style*="display: none"])',
          '[class*="Popup"]:not([style*="display: none"])',
          '[class*="drawer"]:not([style*="display: none"])',
          '[class*="Drawer"]:not([style*="display: none"])',
        ];

        const modals = [];
        const seen = new Set();
        for (const sel of modalSelectors) {
          try {
            for (const el of document.querySelectorAll(sel)) {
              // Skip if already found, hidden, or too small to be a real modal
              if (seen.has(el)) continue;
              const rect = el.getBoundingClientRect();
              if (rect.width < 100 || rect.height < 50) continue;
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
        if (node.getAttribute('role')) attrs.role = node.getAttribute('role');
        const iconMeaning = getIconMeaning(node);
        if (iconMeaning) attrs.iconMeaning = iconMeaning;

        const parentText = node.parentElement
          ? (node.parentElement.innerText || '').trim().slice(0, 80)
          : '';

        // Structural context for element resolver
        const sectionHeading = getNearestHeading(node);
        const domDepth = getDomDepth(node);
        const similarCount = countSimilarSiblings(node, text);

        return {
          sid, type, text, attrs,
          context: parentText,
          inModal: isModal,
          section: sectionHeading,        // nearest heading above this element
          depth: domDepth,                 // DOM depth for structural grouping
          duplicates: similarCount,        // count of siblings with identical text
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
        },
      };
    },

    wait({ value }) {
      const ms = Math.min(parseInt(value) || 1000, 3000);
      return new Promise(resolve =>
        setTimeout(() => resolve({ success: true, observation: `Waited ${ms}ms.` }), ms)
      );
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
    if (request.type !== 'explore_action') return;

    const { actionType, target, value } = request;

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
      'scroll':        'scroll_page',
      'scroll_to':     'scroll_to_sid',
      'scrape_page':   'extract_visible_text',
      'wait':          'wait',
      'take_snapshot': 'take_snapshot',
      'resolve_element': 'resolve_element',
    };

    // SECURITY: Block fill_field and type_text entirely on login/auth pages
    // Use AuthGateDetector for comprehensive detection
    const authCheck = AuthGateDetector.detect();
    if ((actionType === 'fill_field' || actionType === 'type_text') && authCheck.isAuthPage) {
      sendResponse({
        success: false,
        error: `AUTH_GATE_DETECTED (${authCheck.authType}): Agent cannot interact with authentication pages. User must log in manually.`,
        blocked: true,
        authGate: { authType: authCheck.authType, signals: authCheck.signals },
      });
      return true;
    }

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
