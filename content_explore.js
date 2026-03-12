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
      // After any typing action, wait 500ms, re-scan DOM for the typed string.
      // For contentEditable elements, also runs ProseMirror state sync to ensure
      // the editor's internal state matches the visible DOM content.
      // Returns { found: boolean, truncated: boolean, actualLength: number }
      async function verifyTypingSuccess(targetEl, expectedText) {
        // Run state sync BEFORE verification for contentEditable elements
        // This ensures ProseMirror/Slate/Draft.js have reconciled their state
        if (targetEl.isContentEditable) {
          await syncEditorState(targetEl);
        }

        await new Promise(r => setTimeout(r, 500));
        let actualText = '';

        // Check .value for inputs
        if (targetEl.value && targetEl.value.length > 0) {
          actualText = targetEl.value;
        }
        // Check innerText/textContent for contentEditable and other elements
        if (!actualText) {
          actualText = (targetEl.innerText || targetEl.textContent || '').trim();
        }
        // Also check parent container (for canvas editors where typed content
        // may appear in a sibling or parent node)
        if (!actualText) {
          const parent = targetEl.closest('[role="textbox"], [contenteditable="true"], .editor, .ProseMirror, .ql-editor') || targetEl.parentElement;
          if (parent && parent !== targetEl) {
            actualText = (parent.innerText || parent.textContent || '').trim();
          }
        }

        const found = actualText.length > 0 && actualText.includes(expectedText.slice(0, 40));
        // Detect silent truncation: browser enforced maxlength and chopped our text
        const truncated = found && actualText.length < expectedText.length * 0.9;
        if (truncated) {
          console.log(`[type_text] WARNING: Text was silently truncated by browser. Expected ${expectedText.length} chars, got ${actualText.length} chars.`);
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
        const actualValue = el.value;
        const valueSet = actualValue === value;

        // If native setter didn't work, try execCommand then CDP
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
              chrome.runtime.sendMessage(
                { type: 'cdp_insert_text', text: value },
                (response) => resolve(response || { success: false })
              );
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
        // TIER 2: ClipboardEvent paste
        // Works on: ProseMirror (Reddit body, Notion, TipTap), Quill
        // ProseMirror intercepts paste events and reads clipboardData
        // ═══════════════════════════════════════════════════════════
        console.log('[type_text] TIER 2: ClipboardEvent paste (Tier 1 failed verification)');
        try {
          // Re-focus and place cursor — essential for ProseMirror
          el.focus();
          el.click();
          sel.removeAllRanges();
          const r2 = document.createRange();
          r2.selectNodeContents(el);
          r2.collapse(false);
          sel.addRange(r2);

          const dt = new DataTransfer();
          dt.setData('text/plain', value);
          dt.setData('text/html', value.replace(/\n/g, '<br>'));
          const pasteEvent = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: dt,
          });
          el.dispatchEvent(pasteEvent);
          console.log('[type_text] Tier 2 ClipboardEvent paste dispatched');
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
        // TIER 2b: Sequential keyboard loop with jitter
        // Works on: Reddit title (ProseMirror input), Facebook, Medium,
        // any editor that listens for real keydown/keypress/keyup sequences.
        // Fires full event chain per character with 8-15ms random delay.
        // ═══════════════════════════════════════════════════════════
        console.log('[type_text] TIER 2b: Sequential keyboard simulation (Tiers 1-2 failed)');
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
            chrome.runtime.sendMessage(
              { type: 'cdp_insert_text', text: value, elementRect: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } },
              (response) => resolve(response || { success: false, error: 'No response' })
            );
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
            chrome.runtime.sendMessage(
              { type: 'cdp_type_keys', text: value, initializeBuffer: true, elementRect: { x: Math.round(rect3b.left + rect3b.width / 2), y: Math.round(rect3b.top + rect3b.height / 2) } },
              (response) => resolve(response || { success: false, error: 'No response' })
            );
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
      // Build a compact semantic map
      // Increased to 80 to capture form fields on complex pages (Facebook Ads, etc.)
      const MAX_ELEMENTS = 80;
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
        if (role === 'link' || role === 'tab' || role === 'menuitem') return 'button';
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

        return {
          sid, type, text: finalText, attrs,
          context: parentText,
          inModal: isModal,
          section: sectionHeading,        // nearest heading above this element
          depth: domDepth,                 // DOM depth for structural grouping
          duplicates: similarCount,        // count of siblings with identical text
          currentValue: currentValue,      // raw value for programmatic access
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
      'wait':          'wait',
      'take_snapshot': 'take_snapshot',
      'dom_fingerprint': 'dom_fingerprint',
      'resolve_element': 'resolve_element',
    };

    // SECURITY: Block fill_field and type_text entirely on login/auth pages
    // Triple-check: AuthGateDetector + URL patterns + password field presence + auth domains
    if (actionType === 'fill_field' || actionType === 'type_text' || actionType === 'select_option') {
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

    // Handle async actions (wait)
    if (result instanceof Promise) {
      result.then(sendResponse);
      return true;
    }

    sendResponse(result);
    return true;
  });
})();
