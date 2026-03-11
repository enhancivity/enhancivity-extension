// ============================================================
// Enhancivity Background Service Worker — Grand Extension v4.0
// Responsibilities:
//   1. Auth (email/password + Google OAuth)
//   2. 3-Tier Memory caching (30-min TTL)
//   3. Message routing (popup → Gmail/Amazon scripts → backend)
//   4. API orchestration with memory-enriched payloads
//   5. Universal Ghost-Driver: AI-driven semantic scraping via hidden tabs
//   6. stageAction: Ghost-Driver form filling (travel, bills, etc.)
// ============================================================

// Toggle for deployment: 'https://service.enhancivity.com' for production, 'http://localhost:3001' for local dev
const API_BASE = 'https://service.enhancivity.com';
const MEMORY_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Allow content scripts to access chrome.storage.session (required for conversation persistence + exploration recovery)
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

// --- URL Allowlist for Navigate Actions (v1 safety) ---

const ALLOWED_DOMAINS = [
  // Shopping
  'amazon.com', 'ebay.com', 'etsy.com', 'walmart.com', 'target.com', 'bestbuy.com',
  // Travel
  'expedia.com', 'kayak.com', 'skyscanner.net', 'booking.com', 'airbnb.com', 'hotels.com',
  // Jobs
  'indeed.com', 'linkedin.com', 'glassdoor.com', 'monster.com', 'ziprecruiter.com',
  // Freelance
  'fiverr.com', 'upwork.com',
  // Real estate
  'zillow.com', 'rightmove.co.uk',
  // Cars
  'autotrader.com', 'cargurus.com',
  // Productivity & communication
  'mail.google.com', 'slack.com', 'notion.so', 'trello.com', 'asana.com',
  'docs.google.com', 'drive.google.com', 'calendar.google.com',
  'outlook.live.com', 'outlook.office.com',
  'github.com', 'youtube.com', 'twitter.com', 'x.com', 'reddit.com',
  // Finance & payments
  'wise.com', 'paypal.com', 'stripe.com', 'dashboard.stripe.com',
  // Dev & infra
  'platform.openai.com', 'openai.com', 'vercel.com', 'netlify.com', 'aws.amazon.com',
  // Search
  'google.com', 'bing.com',
  // Enhancivity
  'enhancivity.com',
];

function isAllowedUrl(url) {
  try {
    const host = new URL(url).hostname;
    return ALLOWED_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

// --- BYOK: Retrieve user's own API key + provider + model preferences from local storage ---
async function getByokKey() {
  const { userApiKey } = await chrome.storage.local.get(['userApiKey']);
  return userApiKey || null;
}

async function getByokConfig() {
  const { userApiKey, userApiKeyProvider, userIntent, userSelectedModel, userCustomModel } = await chrome.storage.local.get([
    'userApiKey', 'userApiKeyProvider', 'userIntent', 'userSelectedModel', 'userCustomModel'
  ]);
  return {
    userApiKey: userApiKey || null,
    userApiKeyProvider: userApiKeyProvider || null,
    userIntent: userIntent || 'balanced',
    userSelectedModel: userSelectedModel || null,
    userCustomModel: userCustomModel || null,
  };
}

// Spread helper: adds BYOK fields to API payloads only if a key is set
function byokPayload(config) {
  if (!config.userApiKey) return {};
  return {
    userApiKey: config.userApiKey,
    userApiKeyProvider: config.userApiKeyProvider,
    userIntent: config.userIntent,
    ...(config.userSelectedModel && { userSelectedModel: config.userSelectedModel }),
    ...(config.userCustomModel && { userCustomModel: config.userCustomModel }),
  };
}

// --- Domain Blocklist for EXPLORE (relaxed navigation) ---

const EXPLORE_BLOCKED_DOMAINS = [
  // Banking / Financial
  'chase.com', 'wellsfargo.com', 'bankofamerica.com', 'citi.com',
  'capitalone.com', 'usbank.com', 'schwab.com', 'fidelity.com',
  'vanguard.com', 'tdameritrade.com', 'ally.com', 'discover.com',
  // Healthcare
  'myhealth.va.gov', 'mychart.com',
  // Payment processors
  'paypal.com', 'venmo.com', 'zelle.com',
  // Note: OAuth providers (accounts.google.com, login.microsoftonline.com)
  // are NOT blocked — users need them for Google/Microsoft login on third-party
  // sites. The content_explore.js safety guards prevent AI from interacting
  // with password fields and sensitive inputs.
];

function isAllowedForExplore(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    // Block .gov and .mil domains
    if (host.endsWith('.gov') || host.endsWith('.mil')) return false;
    // Block known sensitive domains
    if (EXPLORE_BLOCKED_DOMAINS.some(d => host === d || host.endsWith('.' + d))) return false;
    // Everything else is allowed for exploration
    return true;
  } catch {
    return false;
  }
}

// ─── Authentication Bridge ──────────────────────────────────
// 3-Layer system for handling login-required sites during EXPLORE:
//   Layer 1: Session Detection — check cookies + existing tabs
//   Layer 2: Smart Login Bypass — navigate to authenticated app URL
//   Layer 3: Session Persistence — remember authenticated sites

// Known app URLs that bypass landing/login pages when user has cookies.
// Used as HINTS — the generic bypass logic works for any site, but these
// give a faster path for popular apps. Key = base domain (no www).
const SESSION_BYPASS_HINTS = {
  'figma.com':       '/files/recents-and-sharing',
  'canva.com':       '/folder/all-designs',
  'facebook.com':    '/',
  'trello.com':      '/u/me/boards',
  'notion.so':       '/',
  'github.com':      '/dashboard',
  'twitter.com':     '/home',
  'x.com':           '/home',
  'linkedin.com':    '/feed/',
  'instagram.com':   '/',
  'docs.google.com': '/document/u/0/',
  'drive.google.com':'/drive/my-drive',
  'sheets.google.com':'/spreadsheets/u/0/',
  'slides.google.com':'/presentation/u/0/',
};

// Common auth cookie name patterns that indicate an active session
const AUTH_COOKIE_PATTERNS = [
  'session', 'token', 'auth', 'logged_in', 'sid', 'csrf',
  '__Host-next-auth', '__Secure-next-auth', '_gh_sess',
  'connect.sid', 'JSESSIONID', 'PHPSESSID', 'li_at',
  'c_user', 'xs',  // Facebook
  'figma.authn', '__cf_bm',
];

/**
 * Layer 1: Probe whether the user has an existing session for a domain.
 * Checks: (1) other open tabs on that domain, (2) auth cookies.
 * @param {string} domain — e.g. "www.figma.com"
 * @returns {{ hasSession: boolean, method: string, detail?: string }}
 */
async function probeExistingSession(domain) {
  // Strip www. for matching flexibility
  const baseDomain = domain.replace(/^www\./, '');

  // Check 1: Is the user already on this site in another tab (and NOT on a login page)?
  try {
    const tabs = await chrome.tabs.query({});
    const domainTabs = tabs.filter(t => {
      try {
        const host = new URL(t.url).hostname;
        return host === domain || host === `www.${baseDomain}` || host.endsWith(`.${baseDomain}`);
      } catch { return false; }
    });

    if (domainTabs.length > 0) {
      // User has this site open — cookies are shared, session likely active
      return { hasSession: true, method: 'existing_tab', detail: `Found ${domainTabs.length} open tab(s) on ${baseDomain}` };
    }
  } catch (e) {
    console.warn('[AuthBridge] Tab query failed:', e.message);
  }

  // Check 2: Look for auth cookies on this domain
  try {
    const cookies = await chrome.cookies.getAll({ domain: baseDomain });
    const authCookies = cookies.filter(c =>
      AUTH_COOKIE_PATTERNS.some(p => c.name.toLowerCase().includes(p.toLowerCase()))
    );

    if (authCookies.length > 0) {
      return { hasSession: true, method: 'cookies', detail: `Found ${authCookies.length} auth cookie(s) for ${baseDomain}` };
    }
  } catch (e) {
    console.warn('[AuthBridge] Cookie query failed:', e.message);
  }

  // Check 3: Check our session persistence cache
  try {
    const { authenticatedSites = {} } = await chrome.storage.local.get('authenticatedSites');
    const record = authenticatedSites[baseDomain] || authenticatedSites[domain];
    if (record) {
      const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
      if (Date.now() - record.lastVerified < SEVEN_DAYS) {
        return { hasSession: true, method: 'cached', detail: `${baseDomain} was authenticated ${Math.round((Date.now() - record.lastVerified) / 3600000)}h ago` };
      }
    }
  } catch (e) {
    console.warn('[AuthBridge] Cache check failed:', e.message);
  }

  return { hasSession: false, method: 'none' };
}

/**
 * Layer 2: Try to bypass a login/landing page by navigating to an
 * authenticated app URL. Works for ANY site:
 *   1. Check SESSION_BYPASS_HINTS for known fast paths
 *   2. If no hint, try the site root (/) — many sites auto-redirect
 *      authenticated users past the login page
 *   3. Check if the current URL has a redirect param (e.g., ?next=/dashboard)
 *      and try navigating to that destination directly
 *
 * @param {number} tabId
 * @param {string} currentUrl
 * @returns {{ bypassed: boolean, newUrl?: string }}
 */
async function trySessionBypass(tabId, currentUrl) {
  try {
    const parsed = new URL(currentUrl);
    const domain = parsed.hostname.toLowerCase();
    const baseDomain = domain.replace(/^www\./, '');

    // Build a list of URLs to try, in priority order
    const candidates = [];

    // 0. Check if we previously learned a working bypass for this domain
    try {
      const { learnedBypasses = {} } = await chrome.storage.local.get('learnedBypasses');
      const learned = learnedBypasses[baseDomain];
      if (learned?.path) {
        candidates.push(`${parsed.protocol}//${domain}${learned.path}`);
      }
    } catch {}

    // 1. Known hint for this domain
    const hintPath = SESSION_BYPASS_HINTS[baseDomain] || SESSION_BYPASS_HINTS[domain];
    if (hintPath) {
      candidates.push(`${parsed.protocol}//${domain}${hintPath}`);
    }

    // 2. Extract redirect target from URL params (e.g., ?next=/dashboard, ?redirect_uri=..., ?return_to=...)
    const redirectParams = ['next', 'redirect', 'redirect_uri', 'return_to', 'returnTo', 'continue', 'destination', 'from', 'ref'];
    for (const param of redirectParams) {
      const val = parsed.searchParams.get(param);
      if (val) {
        try {
          // Could be a full URL or a relative path
          const redirectUrl = val.startsWith('http') ? val : `${parsed.protocol}//${domain}${val.startsWith('/') ? '' : '/'}${val}`;
          if (isAllowedForExplore(redirectUrl)) {
            candidates.push(redirectUrl);
          }
        } catch {}
      }
    }

    // 3. Try site root as last resort (skip if we're already at root)
    if (parsed.pathname !== '/' && parsed.pathname !== '') {
      candidates.push(`${parsed.protocol}//${domain}/`);
    }

    // Deduplicate candidates
    const uniqueCandidates = [...new Set(candidates)];

    // Try each candidate — first one that lands on a non-login page wins
    for (const candidateUrl of uniqueCandidates) {
      console.log(`[AuthBridge] Trying bypass: ${domain} → ${candidateUrl}`);
      await chrome.tabs.update(tabId, { url: candidateUrl });
      await waitForTabLoad(tabId, 12000, 800);

      // Re-inject explore script for snapshot
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content_explore.js'] });
      } catch {}
      await new Promise(r => setTimeout(r, 400));

      const newSnapshot = await takePageSnapshot(tabId);

      if (!newSnapshot.isLoginPage) {
        // Extra check: even though it's not a "login page" (no password field),
        // the page might still show the user as NOT signed in (e.g., Amazon homepage
        // with "Sign in" link). Check for signed-in indicators vs sign-in prompts.
        const pageText = (newSnapshot.mainContent || '').toLowerCase();
        const hasSignInPrompt = newSnapshot.semanticElements?.some(el => {
          const text = (el.text || '').toLowerCase();
          return (text.includes('sign in') || text.includes('log in') || text.includes('hello, sign in'))
            && (el.type === 'link' || el.type === 'button');
        });
        const hasSignedInIndicator = newSnapshot.semanticElements?.some(el => {
          const text = (el.text || '').toLowerCase();
          return text.includes('sign out') || text.includes('log out') || text.includes('my account')
            || text.includes('your account') || text.includes('hello,') && !text.includes('hello, sign in');
        });

        if (hasSignInPrompt && !hasSignedInIndicator) {
          console.log(`[AuthBridge] Bypass landed on non-login page but user is NOT signed in (${candidateUrl}). Continuing to next candidate.`);
          continue; // Try next candidate
        }

        console.log(`[AuthBridge] Bypass SUCCESS for ${domain} via ${candidateUrl}`);
        await markSiteAuthenticated(baseDomain);

        // Learn: save this working bypass path for future use
        await learnBypassPath(baseDomain, new URL(candidateUrl).pathname);

        return { bypassed: true, newUrl: candidateUrl };
      }
    }

    console.log(`[AuthBridge] All bypass attempts FAILED for ${domain} — login truly required`);
    // Navigate back to original URL so user can log in there
    await chrome.tabs.update(tabId, { url: currentUrl });
    await waitForTabLoad(tabId, 10000, 500);
    return { bypassed: false };

  } catch (err) {
    console.warn('[AuthBridge] Session bypass error:', err.message);
    return { bypassed: false };
  }
}

/**
 * Learn and save a bypass path that worked for a domain.
 * Next time we encounter this domain's login page, we try the learned path first.
 */
async function learnBypassPath(baseDomain, path) {
  try {
    const { learnedBypasses = {} } = await chrome.storage.local.get('learnedBypasses');
    learnedBypasses[baseDomain] = { path, learnedAt: Date.now() };
    await chrome.storage.local.set({ learnedBypasses });
    console.log(`[AuthBridge] Learned bypass for ${baseDomain}: ${path}`);
  } catch {}
}

/**
 * Layer 3a: Mark a site as authenticated in persistent cache.
 */
async function markSiteAuthenticated(domain) {
  const baseDomain = domain.replace(/^www\./, '');
  const { authenticatedSites = {} } = await chrome.storage.local.get('authenticatedSites');
  authenticatedSites[baseDomain] = {
    lastVerified: Date.now(),
    method: 'session_bypass',
  };
  await chrome.storage.local.set({ authenticatedSites });
  console.log(`[AuthBridge] Marked ${baseDomain} as authenticated`);
}

/**
 * Layer 3b: Remove a site from the authenticated cache (session expired).
 */
async function removeSiteFromAuthenticated(domain) {
  const baseDomain = domain.replace(/^www\./, '');
  const { authenticatedSites = {} } = await chrome.storage.local.get('authenticatedSites');
  delete authenticatedSites[baseDomain];
  await chrome.storage.local.set({ authenticatedSites });
  console.log(`[AuthBridge] Removed ${baseDomain} from authenticated cache`);
}

/**
 * Auto-resume watcher: When EXPLORE pauses for login, this watches the
 * tab for navigation (user finished logging in) and auto-resumes the
 * exploration loop without requiring the user to click "Resume".
 *
 * @param {number} tabId — the tab where login is happening
 * @param {string} resumeStateKey — key to retrieve saved exploration state
 * @param {string} token — Enhancivity auth token for API calls
 */
function watchForLoginCompletion(tabId, resumeStateKey, token) {
  let watcherCleanedUp = false;

  const loginWatcher = async (details) => {
    if (details.tabId !== tabId || details.frameId !== 0) return;
    if (watcherCleanedUp) return;

    // Wait for SPA rendering after navigation
    await new Promise(r => setTimeout(r, 2000));

    try {
      // Re-inject explore script for snapshot
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content_explore.js'] }).catch(() => {});
      await new Promise(r => setTimeout(r, 300));

      const snapshot = await takePageSnapshot(tabId);

      if (!snapshot.isLoginPage) {
        // User logged in successfully — auto-resume
        watcherCleanedUp = true;
        chrome.webNavigation.onCompleted.removeListener(loginWatcher);

        const stored = await chrome.storage.session.get([resumeStateKey]);
        const resumeState = stored[resumeStateKey];
        if (!resumeState) {
          console.warn('[AuthBridge] Auto-resume: state not found, may have been manually resumed');
          return;
        }

        await chrome.storage.session.remove([resumeStateKey]);

        const domain = new URL(snapshot.url).hostname;
        await markSiteAuthenticated(domain);

        console.log(`[AuthBridge] Auto-resume triggered for ${domain}`);
        await updateExplorationProgress(
          resumeState.nextStep, resumeState.explorePlan.maxSteps,
          `Signed in to ${domain} — resuming...`, 'running'
        );

        // Side panel persists — no re-injection needed for panel UI

        // Resume the exploration loop
        const result = await runExplorationLoop(
          resumeState.explorePlan,
          tabId,
          token,
          resumeState,
        );

        // Store result for panel to pick up
        await finishExploration(result);
      }
    } catch (err) {
      console.warn('[AuthBridge] Auto-resume check error:', err.message);
    }
  };

  chrome.webNavigation.onCompleted.addListener(loginWatcher);

  // Cleanup after 5 minutes (user abandoned login)
  setTimeout(() => {
    if (!watcherCleanedUp) {
      watcherCleanedUp = true;
      chrome.webNavigation.onCompleted.removeListener(loginWatcher);
      console.log('[AuthBridge] Login watcher timed out after 5 minutes');
    }
  }, 5 * 60 * 1000);
}

// --- Site Type Detection (for universal scraper) ---

function detectSiteType(url) {
  if (!url) return 'general';
  if (url.includes('slack.com')) return 'slack';
  if (url.includes('linkedin.com')) return 'linkedin';
  if (url.includes('docs.google.com')) return 'google-docs';
  if (url.includes('sheets.google.com')) return 'google-sheets';
  if (url.includes('outlook.live.com') || url.includes('outlook.office.com')) return 'outlook';
  if (/indeed|glassdoor|monster|ziprecruiter/i.test(url)) return 'job-board';
  if (/trello|asana|notion|jira/i.test(url)) return 'project-tool';
  if (/twitter|x\.com|facebook|instagram/i.test(url)) return 'social';
  if (/github\.com/i.test(url)) return 'github';
  if (/stackoverflow|stackexchange/i.test(url)) return 'stackoverflow';
  if (/youtube\.com/i.test(url)) return 'youtube';
  return 'webpage';
}

// --- JWT Decoder (read-only, no verification needed client-side) ---
function decodeJwt(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload));
  } catch {
    return null;
  }
}

// --- Memory Management ---

async function refreshMemory(token) {
  const decoded = decodeJwt(token);
  const userId = decoded?.id || decoded?.sub || decoded?.userId;
  if (!userId) return;

  try {
    const res = await fetch(`${API_BASE}/api/teach-agent/${userId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    await chrome.storage.local.set({
      userMemory: data,
      userId,
      memoryLastFetched: Date.now()
    });
  } catch (e) {
    console.warn('Enhancivity: Memory refresh failed', e.message);
  }
}

async function getOrRefreshMemory() {
  const { token, userMemory, memoryLastFetched } = await chrome.storage.local.get([
    'token', 'userMemory', 'memoryLastFetched'
  ]);
  if (!token) return null;

  const isStale = !memoryLastFetched || (Date.now() - memoryLastFetched > MEMORY_TTL_MS);
  if (isStale || !userMemory) {
    await refreshMemory(token);
    const updated = await chrome.storage.local.get(['userMemory']);
    return updated.userMemory || null;
  }
  return userMemory;
}

// Refresh memory on browser startup (service worker wakes up)
chrome.runtime.onStartup.addListener(async () => {
  const { token } = await chrome.storage.local.get(['token']);
  if (token) await refreshMemory(token).catch(() => {});
});

// --- Orchestration Engine: Universal Ghost-Driver ---

const SEARCH_URLS = {
  // ── Shopping ────────────────────────────────────────────────
  amazon:      (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
  ebay:        (q) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`,
  etsy:        (q) => `https://www.etsy.com/search?q=${encodeURIComponent(q)}`,
  walmart:     (q) => `https://www.walmart.com/search?q=${encodeURIComponent(q)}`,
  target:      (q) => `https://www.target.com/s?searchTerm=${encodeURIComponent(q)}`,
  bestbuy:     (q) => `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(q)}`,
  google:      (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&tbm=shop`,

  // ── Travel: Flights ─────────────────────────────────────────
  kayak:       (q) => `https://www.kayak.com/flights/${encodeURIComponent(q)}`,
  skyscanner:  (q) => `https://www.skyscanner.net/transport/flights/?query=${encodeURIComponent(q)}`,
  google_flights: (q) => `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`,

  // ── Travel: Hotels ──────────────────────────────────────────
  expedia:     (q) => `https://www.expedia.com/Hotel-Search?destination=${encodeURIComponent(q)}`,
  booking:     (q) => `https://www.booking.com/search.html?ss=${encodeURIComponent(q)}`,
  airbnb:      (q) => `https://www.airbnb.com/s/${encodeURIComponent(q)}/homes`,
  hotels:      (q) => `https://www.hotels.com/search.do?q-destination=${encodeURIComponent(q)}`,

  // ── Jobs ─────────────────────────────────────────────────────
  indeed:      (q) => `https://www.indeed.com/jobs?q=${encodeURIComponent(q)}`,
  linkedin:    (q) => `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(q)}`,
  glassdoor:   (q) => `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodeURIComponent(q)}`,
  ziprecruiter:(q) => `https://www.ziprecruiter.com/jobs-search?search=${encodeURIComponent(q)}`,

  // ── Freelance / Services ─────────────────────────────────────
  fiverr:      (q) => `https://www.fiverr.com/search/gigs?query=${encodeURIComponent(q)}`,
  upwork:      (q) => `https://www.upwork.com/search/jobs/?q=${encodeURIComponent(q)}`,

  // ── Real Estate ──────────────────────────────────────────────
  zillow:      (q) => `https://www.zillow.com/homes/${encodeURIComponent(q)}_rb/`,
  rightmove:   (q) => `https://www.rightmove.co.uk/property-for-sale/find.html?searchLocation=${encodeURIComponent(q)}`,

  // ── Cars ─────────────────────────────────────────────────────
  autotrader:  (q) => `https://www.autotrader.com/cars-for-sale/all-cars?zip=10001&query=${encodeURIComponent(q)}`,
  cargurus:    (q) => `https://www.cargurus.com/Cars/new/nl#listing=${encodeURIComponent(q)}`,

  // ── General Web Search ───────────────────────────────────────
  google_web:  (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  bing:        (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
};

// Universal semantic scraper — replaces all site-specific scrapers
const SEMANTIC_SCRAPER = 'content_search_semantic.js';

// Progress HUD content script
const HUD_SCRIPT = 'content_hud.js';

// ─── HUD Helpers (inject + send messages) ─────────────────

async function injectHud(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [HUD_SCRIPT],
    });
  } catch {
    // HUD injection failed — non-fatal (e.g., chrome:// pages)
  }
}

async function hudShow(tabId, taskTitle, initialSteps) {
  await injectHud(tabId);
  return chrome.tabs.sendMessage(tabId, {
    type: 'hud_show',
    taskTitle,
    initialSteps,
  }).catch(err => {
    console.warn(`[HUD] hudShow failed for tab ${tabId}: ${err.message}`);
    return null;
  });
}

async function hudUpdate(tabId, stepId, status, detail, label) {
  return chrome.tabs.sendMessage(tabId, {
    type: 'hud_update',
    stepId,
    status,
    detail,
    label,
  }).catch(err => {
    console.warn(`[HUD] hudUpdate failed (${stepId}, ${status}): ${err.message}`);
    return null;
  });
}

async function hudTrust(tabId, trustBadge, trustScore, siteName) {
  return chrome.tabs.sendMessage(tabId, {
    type: 'hud_trust',
    trustBadge,
    trustScore,
    siteName,
  }).catch(() => null);
}

async function hudConsent(tabId, message, targetSelector) {
  return chrome.tabs.sendMessage(tabId, {
    type: 'hud_consent',
    message,
    targetSelector,
  }).catch(() => ({ approved: false, reason: 'hud_not_available' }));
}

async function hudHide(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: 'hud_hide' }).catch(() => null);
}

function waitForTabLoad(tabId, timeout = 15000, extraDelay = 2000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // Resolve anyway — partial scrape is better than nothing
    }, timeout);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // Extra delay for JS rendering (SPAs, lazy-loaded product cards)
        setTimeout(resolve, extraDelay);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function updateOrchestrationProgress(phase, detail) {
  await chrome.storage.local.set({
    orchestrationProgress: { phase, detail, timestamp: Date.now() }
  });
}

// --- Semantic Search Tab: inject semantic scraper → parse-intent API ---

async function spawnSearchTab(site, query, category, token) {
  let url;
  let skillId = null; // Track for Skill Engine outcome recording

  const urlBuilder = SEARCH_URLS[site];
  if (urlBuilder) {
    // Known site — use hardcoded builder (fast path)
    url = urlBuilder(query);
  } else {
    // Unknown site — ask Skill Engine for a URL template
    console.log(`[Ghost-Driver] ${site}: not in SEARCH_URLS, calling Skill Engine...`);
    try {
      const resolveRes = await fetch(`${API_BASE}/api/skills/resolve-site`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ domain: site, query, category }),
      });

      if (!resolveRes.ok) {
        const err = await resolveRes.json().catch(() => ({}));
        console.warn(`[Ghost-Driver] ${site}: Skill Engine rejected:`, err.error);
        return { site, results: [], error: err.error || `Cannot search ${site}: no URL template available` };
      }

      const resolved = await resolveRes.json();
      if (!resolved.success || !resolved.skill?.searchUrl) {
        return { site, results: [], error: `Skill Engine returned no URL for ${site}` };
      }

      skillId = resolved.skill.id;
      url = resolved.skill.searchUrl.replace('{query}', encodeURIComponent(query));
      console.log(`[Ghost-Driver] ${site}: Skill Engine resolved URL (fromCache: ${resolved.fromCache}): ${url}`);
    } catch (err) {
      console.warn(`[Ghost-Driver] ${site}: Skill Engine call failed:`, err.message);
      return { site, results: [], error: `Skill Engine unavailable: ${err.message}` };
    }
  }

  let tab;

  try {
    // Create hidden tab (active: false = no focus steal)
    tab = await chrome.tabs.create({ url, active: false });

    await updateOrchestrationProgress(`searching:${site}`, `Searching ${site}...`);

    // Wait for page to fully load
    await waitForTabLoad(tab.id, 15000);

    // Phase 1: Inject semantic scraper → get DOM Semantic Map
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [SEMANTIC_SCRAPER],
    }).catch((err) => {
      console.warn(`[Ghost-Driver] Failed to inject semantic scraper for ${site}:`, err.message);
      return null;
    });

    const semanticMap = injected?.[0]?.result;
    if (!semanticMap || !semanticMap.elements || semanticMap.elements.length === 0) {
      console.warn(`[Ghost-Driver] ${site}: semantic map empty`);
      if (skillId) {
        fetch(`${API_BASE}/api/skills/record-outcome`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ skillId, success: false }),
        }).catch(() => {});
      }
      return { site, results: [], error: 'Semantic map empty' };
    }

    console.log(`[Ghost-Driver] ${site}: mapped ${semanticMap.mappedCount} elements`);

    // Phase 2: Send semantic map to parse-intent for AI interpretation
    const ghostByokConfig = await getByokConfig();
    const parseRes = await fetch(`${API_BASE}/api/agent/parse-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        semanticMap,
        userGoal: query,
        pageUrl: url,
        category: category || 'shopping',
        mode: 'extract_products',
        ...byokPayload(ghostByokConfig),
      }),
    });

    if (!parseRes.ok) {
      const err = await parseRes.json().catch(() => ({}));
      console.warn(`[Ghost-Driver] ${site}: parse-intent failed:`, err.error);
      return { site, results: [], error: err.error || `Parse failed (${parseRes.status})` };
    }

    const parsed = await parseRes.json();
    const results = parsed.products || [];

    // Pass trust scores through to the compare endpoint
    const trustScore = parsed.trustScore || 5.0;
    const trustRationale = parsed.trustRationale || '';

    console.log(`[Ghost-Driver] ${site}: extracted ${results.length} products (trust: ${trustScore})`);

    // Record outcome for Skill Engine (only for skill-based searches)
    if (skillId) {
      fetch(`${API_BASE}/api/skills/record-outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ skillId, success: results.length > 0 }),
      }).catch(err => console.warn(`[Ghost-Driver] Failed to record skill outcome:`, err.message));
    }

    return { site, results, trustScore, trustRationale };

  } catch (err) {
    console.warn(`[Ghost-Driver] ${site} search failed:`, err.message);
    if (skillId) {
      fetch(`${API_BASE}/api/skills/record-outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ skillId, success: false }),
      }).catch(() => {});
    }
    return { site, results: [], error: err.message };
  } finally {
    // Always clean up — close the hidden tab
    if (tab?.id) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}

async function runOrchestration(userPrompt, searchPlan, token) {
  try {
    await updateOrchestrationProgress('searching', `Searching ${searchPlan.sites.length} sites...`);

    // Parallel search across all sites (now using semantic scraper)
    const searchPromises = searchPlan.sites.map(site => {
      const query = searchPlan.queries[site] || searchPlan.queries.default || userPrompt;
      return spawnSearchTab(site, query, searchPlan.category, token);
    });

    const searchResults = await Promise.allSettled(searchPromises);

    // Collect successful results
    const allResults = searchResults
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      .filter(r => r.results && r.results.length > 0);

    if (allResults.length === 0) {
      await updateOrchestrationProgress('error', 'No results found across any site.');
      return { success: false, error: 'No results found. Try rephrasing your search.' };
    }

    const totalProducts = allResults.reduce((sum, r) => sum + r.results.length, 0);
    await updateOrchestrationProgress('comparing', `AI is comparing ${totalProducts} products...`);

    // Send to backend for trust-weighted comparison
    const compareByokConfig = await getByokConfig();
    const compareRes = await fetch(`${API_BASE}/api/agent/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        results: allResults,
        criteria: searchPlan.criteria,
        category: searchPlan.category,
        userPrompt,
        ...byokPayload(compareByokConfig),
      }),
    });

    if (!compareRes.ok) {
      const err = await compareRes.json().catch(() => ({}));
      await updateOrchestrationProgress('error', err.error || 'Comparison failed.');
      return { success: false, error: err.error || `Comparison failed (${compareRes.status})` };
    }

    const comparison = await compareRes.json();
    await updateOrchestrationProgress('done', null);

    return { success: true, data: comparison };

  } catch (err) {
    console.error('[Orchestrator] Unhandled error:', err);
    await updateOrchestrationProgress('error', err.message);
    return { success: false, error: err.message || 'Orchestration failed.' };
  }
}

// --- EXPLORE: Multi-step agentic exploration loop ---

async function updateExplorationProgress(step, total, description, status, phase = 1) {
  await chrome.storage.local.set({
    explorationProgress: { step, total, description, status, phase, timestamp: Date.now() },
  });
}

async function takePageSnapshot(tabId) {
  try {
    // Inject the explore content script (handles double-injection guard internally)
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content_explore.js'],
    });

    // Request a snapshot
    const result = await chrome.tabs.sendMessage(tabId, {
      type: 'explore_action',
      actionType: 'take_snapshot',
    });

    if (result?.success && result.snapshot) {
      return result.snapshot;
    }

    // Fallback: just get basic page info
    const tab = await chrome.tabs.get(tabId);
    return {
      url: tab.url || 'unknown',
      title: tab.title || 'unknown',
      mainContent: '(Could not extract page content)',
      semanticElements: [],
    };
  } catch (err) {
    console.warn('[Explore] Snapshot failed:', err.message);
    try {
      const tab = await chrome.tabs.get(tabId);
      return {
        url: tab.url || 'unknown',
        title: tab.title || 'unknown',
        mainContent: '(Snapshot failed: ' + err.message + ')',
        semanticElements: [],
      };
    } catch {
      return { url: 'unknown', title: 'unknown', mainContent: '', semanticElements: [] };
    }
  }
}

// Re-inject content_universal.js and return page text for post-action verification
async function scrapePageState(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content_universal.js'],
    });
    const scraped = results?.[0]?.result;
    if (scraped) {
      return {
        pageTitle: scraped.pageTitle || '',
        mainContent: scraped.mainContent || '',
        meta: scraped.meta || {},
      };
    }
  } catch {
    // Non-fatal — some pages block injection (chrome://, pdf, etc.)
  }
  return null;
}

// Placeholder URL patterns — these are template URLs, not real websites
const PLACEHOLDER_URL_PATTERNS = [
  'your-', 'example.', 'placeholder', 'instance-url', 'xxx.',
  'sample.', 'test.', 'demo.', 'foo.', 'bar.',
  '[your', '{your', '<your',
];

function isPlaceholderUrl(url) {
  const lower = (url || '').toLowerCase();
  return PLACEHOLDER_URL_PATTERNS.some(p => lower.includes(p));
}

async function executeExploreAction(tabId, action, token) {
  try {
    // AUTH GATE PRE-CHECK: Before any DOM-interactive action, verify we're not on an auth page.
    // This catches session expiry mid-task (user gets redirected to login).
    if (['click_element', 'type_text', 'fill_field', 'read_element', 'select_option'].includes(action.type)) {
      // LAYER 1: URL-level check in background.js (works even if content script fails)
      if (action.type === 'type_text' || action.type === 'fill_field' || action.type === 'select_option') {
        try {
          const tab = await chrome.tabs.get(tabId);
          const tabUrl = (tab.url || '').toLowerCase();
          const AUTH_URL_PATTERNS_BG = ['signin', 'sign-in', 'login', 'log-in', '/auth/', '/oauth/', '/sso/', '/ap/signin', '/accounts/login', '/servicelogin', '/session/new', '/password', '/users/sign_in', '/account/login', '/authenticate', '/uc/login', '/id/signin', '/idp/login'];
          const AUTH_DOMAINS_BG = ['accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'auth0.com', 'okta.com', 'login.yahoo.com', 'appleid.apple.com', 'id.atlassian.com', 'login.salesforce.com', 'sso.godaddy.com'];
          let tabHostname = '';
          try { tabHostname = new URL(tab.url || '').hostname.toLowerCase(); } catch {}
          const isLoginUrl = AUTH_URL_PATTERNS_BG.some(p => tabUrl.includes(p));
          const isAuthDomain = AUTH_DOMAINS_BG.some(d => tabHostname === d || tabHostname.endsWith('.' + d));
          if (isLoginUrl || isAuthDomain) {
            console.log(`[SECURITY] BLOCKED ${action.type} at background.js level. URL: ${tab.url}`);
            return {
              success: false,
              error: `SECURITY_BLOCK: This is a login/authentication page (${tab.url}). The agent cannot type or fill fields here. Please log in manually.`,
              blocked: true,
              authGate: { authType: 'login', signals: ['url_pattern_background'] },
            };
          }
        } catch {}
      }

      // LAYER 2: Content script auth check (DOM-level, catches password fields)
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content_explore.js'] }).catch(() => {});
        const authCheck = await chrome.tabs.sendMessage(tabId, { type: 'explore_action', actionType: 'auth_check' }).catch(() => null);
        if (authCheck?.isAuthPage) {
          return {
            success: false,
            error: `AUTH_GATE_DETECTED (${authCheck.authType}): Page is an authentication page. Agent cannot interact — user must log in manually.`,
            blocked: true,
            authGate: { authType: authCheck.authType, signals: authCheck.signals },
          };
        }
      } catch {
        // Non-fatal — if auth check fails, URL check above already caught login pages
      }
    }

    if (action.type === 'navigate') {
      // Navigate to URL
      const url = action.target || action.value;
      if (!url) return { success: false, error: 'No URL provided for navigate' };
      if (isPlaceholderUrl(url)) {
        return { success: false, error: 'BLOCKED: This appears to be a placeholder URL, not a real website. Ask the user for the actual URL.' };
      }
      if (!isAllowedForExplore(url)) {
        return { success: false, error: `BLOCKED: Domain not allowed for exploration: ${url}` };
      }

      await chrome.tabs.update(tabId, { url });
      await waitForTabLoad(tabId, 15000, 500); // 500ms after load for SPA rendering

      // Get the ACTUAL loaded URL (chrome.tabs.update returns before navigation)
      const loadedTab = await chrome.tabs.get(tabId);
      const actualUrl = loadedTab.url || url;

      // Re-inject DOM interaction scripts with retry (Reddit/SPAs may need a moment)
      // Side panel UI persists — only content scripts need re-injection
      const scriptsToInject = ['content_explore.js', HUD_SCRIPT];
      for (const script of scriptsToInject) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId },
              files: [script],
            });
            console.log(`[Explore] Injected ${script} on`, actualUrl);
            break;
          } catch (injectErr) {
            console.warn(`[Explore] ${script} inject attempt ${attempt + 1} failed:`, injectErr.message);
            if (attempt === 0) await new Promise(r => setTimeout(r, 500));
          }
        }
      }

      // Brief delay to ensure content script listeners are registered
      await new Promise(r => setTimeout(r, 200));

      return {
        success: true,
        observation: `Navigated to ${actualUrl}`,
        newUrl: actualUrl,
      };
    }

    // resolve_element: multi-signal element resolution, returns best match SID
    if (action.type === 'resolve_element') {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content_explore.js'] }).catch(() => {});
        await new Promise(r => setTimeout(r, 200));
        const result = await chrome.tabs.sendMessage(tabId, {
          type: 'explore_action',
          actionType: 'resolve_element',
          target: action.target,
          value: action.value,
        });
        return result || { success: false, error: 'No response from resolve_element' };
      } catch (err) {
        return { success: false, error: `resolve_element failed: ${err.message}` };
      }
    }

    // fill_field: delegate to Ghost-Driver's semantic form filler
    if (action.type === 'fill_field') {
      const goal = action.value || action.description || '';
      if (!goal) return { success: false, error: 'No fill description provided' };
      const result = await stageAction(tabId, goal, 'forms', token);
      return {
        success: result?.success || false,
        observation: result?.success
          ? 'Form fields filled successfully'
          : (result?.error || 'Form filling failed'),
      };
    }

    // For all other actions, send to content script
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content_explore.js'],
    });

    // Brief delay to ensure message listener is registered
    await new Promise(r => setTimeout(r, 200));

    const result = await chrome.tabs.sendMessage(tabId, {
      type: 'explore_action',
      actionType: action.type,
      target: action.target,
      value: action.value,
    });

    return result || { success: false, error: 'No response from content script' };

  } catch (err) {
    return { success: false, error: err.message || 'Action execution failed' };
  }
}

// Helper: mark exploration as finished and store result for panel recovery
async function finishExploration(result) {
  // Set result first, THEN remove active flag — so listener sees result when it checks
  await chrome.storage.session.set({ explorationResult: { ...result, finishedAt: Date.now() } });
  await chrome.storage.session.remove('explorationActive');
  return result;
}

// ── Checkpoint Generator: builds a compact summary from stepLog ──
// No AI call needed — just extracts what was done from the step log.
function generateCheckpoint(stepLog, goal) {
  const successfulSteps = stepLog.filter(s => s.result?.success !== false && s.action?.type !== 'session_context');
  const failedSteps = stepLog.filter(s => s.result?.success === false);

  // Build a compact list of what was accomplished
  // CRITICAL: Strip semantic IDs (butt-5, link-12, inp-0, etc.) from descriptions
  // so the AI doesn't try to reuse stale IDs from a previous phase
  const SID_PATTERN = /\b(butt|link|inp|sel|chk|rad|tab|menu|img|icon|txt)-\d+\b/g;

  const accomplishments = successfulSteps
    .map(s => {
      let desc = s.action?.description || s.action?.type || 'action';
      // Remove semantic IDs to prevent stale ID usage in next phase
      desc = desc.replace(SID_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
      // Truncate long descriptions
      return desc.length > 80 ? desc.slice(0, 77) + '...' : desc;
    })
    .filter(d => d && d.length > 2); // Filter out empty results after stripping

  // Deduplicate similar steps (e.g., multiple "Observing page..." entries)
  const uniqueAccomplishments = [...new Set(accomplishments)];

  const checkpoint = [
    `Completed ${successfulSteps.length} actions (${failedSteps.length} failed).`,
    `Done: ${uniqueAccomplishments.join('; ')}.`,
  ].join(' ');

  // Cap at 500 chars to keep prompt compact
  return checkpoint.length > 500 ? checkpoint.slice(0, 497) + '...' : checkpoint;
}

// ── Auto-Continuation Constants ──
const MAX_PHASES = 3;         // Max 3 phases × 30 steps = 90 steps total
const PHASE_TIMEOUT_MS = 480000; // 8 minutes per phase (accounts for slow connections + observe→plan call)

async function runExplorationLoop(explorePlan, tabId, token, resumeState = null, continuationContext = null) {
  const { goal, strategy, maxSteps, creditBudget, startAction } = explorePlan;

  // Validate startAction before proceeding
  if (!resumeState && (!startAction || !startAction.type)) {
    console.error('[Explore] Invalid explorePlan: missing or malformed startAction', JSON.stringify(explorePlan).slice(0, 300));
    return finishExploration({
      success: false,
      error: 'Invalid explore plan: missing startAction. Please try again.',
      goalResult: null,
      stepsUsed: 0,
      creditsUsed: 0,
      stepLog: [],
    });
  }

  const stepLog = resumeState?.stepLog || [];
  let currentStrategy = resumeState?.currentStrategy || strategy;
  let creditsUsed = resumeState?.creditsUsed || 0;
  let currentTabId = resumeState?.tabId || tabId;
  let consecutiveFailures = resumeState?.consecutiveFailures || 0;
  const startStep = resumeState?.nextStep || 1;

  // Auto-continuation context
  const currentPhase = continuationContext?.phase || 1;
  const previousPhases = continuationContext?.previousPhases || [];
  const originalPrompt = continuationContext?.originalPrompt || null;
  const totalStepsAcrossPhases = continuationContext?.totalSteps || 0;

  // Mark exploration as in-progress (so re-injected panel can detect it)
  await chrome.storage.session.set({
    explorationActive: { goal, maxSteps, tabId: currentTabId, startedAt: Date.now(), phase: currentPhase },
  });

  // Auto-inject panel + explore + HUD when the explore tab navigates (backup for executeExploreAction injection)
  const navListener = (details) => {
    if (details.tabId !== currentTabId || details.frameId !== 0) return;
    console.log('[Explore] webNavigation.onCompleted — re-injecting DOM scripts on', details.url);
    // Side panel persists — only re-inject content scripts for DOM interaction
    chrome.scripting.executeScript({ target: { tabId: currentTabId }, files: ['content_explore.js'] }).catch(() => {});
    chrome.scripting.executeScript({ target: { tabId: currentTabId }, files: [HUD_SCRIPT] }).catch(() => {});
  };
  chrome.webNavigation.onCompleted.addListener(navListener);

  // Service worker keepalive during exploration
  const keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);

  // Per-phase timeout (5 minutes per phase)
  const explorationTimeout = setTimeout(() => {
    cleanupLoop();
  }, PHASE_TIMEOUT_MS);

  // Cleanup helper — called at every exit
  function cleanupLoop() {
    clearInterval(keepAlive);
    clearTimeout(explorationTimeout);
    chrome.webNavigation.onCompleted.removeListener(navListener);
  }

  try {
    // Show HUD on the page — show up to 10 step dots for readability
    const hudSteps = [];
    const hudMax = Math.min(maxSteps, 10);
    for (let i = 0; i <= hudMax; i++) {
      const label = i === 0 ? 'Start' : (currentPhase > 1 ? `P${currentPhase}:${i}` : `Step ${i}`);
      hudSteps.push({ id: `explore-${i}`, label });
    }
    await hudShow(currentTabId, `${currentPhase > 1 ? `[Phase ${currentPhase}] ` : ''}Exploring: ${goal.slice(0, 50)}`, hudSteps);

    // Inject explore content script
    try {
      await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        files: ['content_explore.js'],
      });
    } catch (err) {
      console.warn('[Explore] Could not inject explore script:', err.message);
    }

    // Execute start action (skip if resuming — already done before pause)
    if (!resumeState) {
      await hudUpdate(currentTabId, 'explore-0', 'processing', startAction.description);
      await updateExplorationProgress(0, maxSteps, startAction.description, 'running');

      const startResult = await executeExploreAction(currentTabId, startAction, token);
      stepLog.push({
        step: 0,
        action: startAction,
        result: { success: startResult.success },
        observation: startResult.observation || startResult.error || '',
      });

      await hudUpdate(currentTabId, 'explore-0', startResult.success ? 'success' : 'error',
        startAction.description);

      if (!startResult.success) consecutiveFailures++;

      // ── OBSERVE → PLAN: Call grounded planner with real page snapshot ──
      // The AI now sees the actual page before creating a strategy.
      // This replaces the blind strategy guess from agentProcess.js.
      // Fires after ANY successful startAction (navigate, scrape_page, etc.)
      if (startResult.success) {
        try {
          await updateExplorationProgress(0, maxSteps, 'Creating strategy from observed page...', 'running');
          console.log('[Explore] Observe→Plan: taking snapshot for grounded planning...');

          const planSnapshot = await takePageSnapshot(currentTabId);
          const planByokConfig = await getByokConfig();
          const planUrl = `${API_BASE}/api/agent/explore-plan`;

          const planPayload = JSON.stringify({
            goal,
            currentPageState: planSnapshot,
            previousPhases: previousPhases.length > 0 ? previousPhases : undefined,
            originalPrompt: originalPrompt || undefined,
            ...byokPayload(planByokConfig),
          });

          // Retry logic for network resilience (1 retry on transient failure)
          let planRes = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              planRes = await fetch(planUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: planPayload,
              });
              break;
            } catch (fetchErr) {
              if (attempt === 0 && (fetchErr.message || '').match(/Failed to fetch|NetworkError|ERR_CONNECTION|ECONNRESET|ETIMEDOUT/)) {
                console.warn('[Explore] Observe→Plan: fetch failed, retrying in 2s...');
                await new Promise(r => setTimeout(r, 2000));
              } else {
                throw fetchErr;
              }
            }
          }

          if (planRes.ok) {
            const planData = await planRes.json();
            if (planData.strategy && planData.strategy.length > 10) {
              currentStrategy = planData.strategy;
              console.log(`[Explore] Observe→Plan: grounded strategy created (${planData.maxSteps} steps recommended): ${currentStrategy.slice(0, 200)}`);

              // Update maxSteps if the planner recommends a different amount
              // (only if the planner's recommendation is within bounds)
              if (planData.maxSteps && planData.maxSteps >= 1 && planData.maxSteps <= 30) {
                // Use the planner's recommendation, but don't exceed the original budget
                const originalMaxSteps = maxSteps;
                // Note: we don't override maxSteps here — the plan just informs strategy.
                // The original maxSteps from agentProcess.js is the budget cap.
                console.log(`[Explore] Planner recommended ${planData.maxSteps} steps (budget cap: ${originalMaxSteps})`);
              }

              creditsUsed += 0.5; // EXPLORE_PLAN cost

              stepLog.push({
                step: -1, // meta-step, not counted
                action: { type: 'grounded_plan', description: 'Created strategy from observed page' },
                result: { success: true },
                observation: `Grounded strategy: ${currentStrategy.slice(0, 250)}`,
              });
            } else {
              console.warn('[Explore] Observe→Plan: AI returned weak strategy, keeping original');
            }
          } else {
            const planErr = await planRes.json().catch(() => ({}));
            console.warn('[Explore] Observe→Plan: planning call failed:', planErr.error || planRes.status, '— continuing with original strategy');
          }
        } catch (planError) {
          console.warn('[Explore] Observe→Plan: error during planning call:', planError.message, '— continuing with original strategy');
        }
      }

      // Brief pause after start action
      await new Promise(r => setTimeout(r, 800));
    } else {
      console.log(`[Explore] Resuming from step ${startStep}, ${stepLog.length} steps already done`);
    }

    // Main exploration loop
    for (let step = startStep; step <= maxSteps; step++) {
      // Frustration failsafe: 3 consecutive failures → stop
      if (consecutiveFailures >= 3) {
        await hudUpdate(currentTabId, `explore-${step}`, 'error', 'Too many failures — stopping');
        break;
      }

      // Credit budget check
      if (creditsUsed >= creditBudget) {
        await hudUpdate(currentTabId, `explore-${step}`, 'error', 'Credit budget exhausted');
        break;
      }

      // OBSERVE: take snapshot of current page
      await hudUpdate(currentTabId, `explore-${step}`, 'processing', 'Observing page...');
      await updateExplorationProgress(step, maxSteps, 'Observing page...', 'running');

      const snapshot = await takePageSnapshot(currentTabId);

      // ── AUTH GATE DETECTOR: Comprehensive auth page handling ──
      // Runs BEFORE any action decision. Checks for login, 2FA, CAPTCHA, OAuth.
      // Uses the enhanced AuthGateDetector in content_explore.js for multi-signal detection.
      const authGateInfo = snapshot.authGate || (snapshot.isLoginPage ? { authType: 'login', signals: ['legacy_detection'], signalCount: 1 } : null);
      const isAuthGatePage = snapshot.isLoginPage || (authGateInfo && authGateInfo.signalCount >= 2);

      if (isAuthGatePage) {
        const loginDomain = (() => { try { return new URL(snapshot.url).hostname; } catch { return 'unknown'; } })();
        const authType = authGateInfo?.authType || 'login';
        const authSignals = authGateInfo?.signals || [];
        console.log(`[AuthGate] ${authType} page detected on ${loginDomain} (signals: ${authSignals.join(', ')})`);

        // 2FA and CAPTCHA pages: user MUST handle these manually, no bypass possible
        if (authType === 'two_factor' || authType === 'captcha') {
          console.log(`[AuthGate] ${authType} detected — immediate pause, no bypass attempt`);
          const stateKey = `exploreResume_${Date.now()}`;
          await chrome.storage.session.set({
            [stateKey]: {
              stepLog, currentStrategy, creditsUsed,
              consecutiveFailures, nextStep: step,
              explorePlan, tabId: currentTabId,
            },
          });

          const pauseMsg = authType === 'two_factor'
            ? `Two-factor verification required on ${loginDomain}. Please complete the verification — the agent will resume automatically.`
            : `CAPTCHA verification required on ${loginDomain}. Please solve the CAPTCHA — the agent will resume automatically.`;

          await updateExplorationProgress(step, maxSteps, pauseMsg, 'login_required');
          watchForLoginCompletion(currentTabId, stateKey, token);
          cleanupLoop();

          return finishExploration({
            success: false, paused: true,
            pauseReason: pauseMsg,
            resumeStateKey: stateKey,
            creditsUsed, stepLog,
            authType,
          });
        }

        // Login/OAuth pages: try session bypass first
        // Loop detection: if we already attempted auth_bypass for this domain, don't try again
        const alreadyTriedBypass = stepLog.some(s => s.action?.type === 'auth_bypass' && s.observation?.includes(loginDomain));
        if (alreadyTriedBypass) {
          console.log(`[AuthGate] Already tried bypass for ${loginDomain} — skipping to manual login`);
        }

        await updateExplorationProgress(step, maxSteps, `Checking session for ${loginDomain}...`, 'running');

        // Layer 1: Probe for existing session (other tabs, cookies, cache)
        const sessionProbe = await probeExistingSession(loginDomain);

        if (sessionProbe.hasSession && !alreadyTriedBypass) {
          console.log(`[AuthGate] Session hint found: ${sessionProbe.method} — ${sessionProbe.detail}`);
          await updateExplorationProgress(step, maxSteps, `Found session (${sessionProbe.method}) — trying bypass...`, 'running');

          // Layer 2: Try to bypass the login page
          const bypass = await trySessionBypass(currentTabId, snapshot.url);

          if (bypass.bypassed) {
            console.log(`[AuthGate] Bypassed login for ${loginDomain}`);
            await updateExplorationProgress(step, maxSteps, `Signed in to ${loginDomain} (existing session)`, 'running');
            stepLog.push({
              step,
              action: { type: 'auth_bypass', description: `Bypassed login on ${loginDomain}` },
              result: { success: true },
              observation: `Used existing session to authenticate on ${loginDomain} via ${sessionProbe.method}`,
            });
            consecutiveFailures = 0;
            continue; // Next step — re-snapshot the now-authenticated page
          }
        }

        // No session found or bypass failed — must pause for manual login
        console.log(`[AuthGate] No usable session for ${loginDomain} — pausing for user login`);
        const stateKey = `exploreResume_${Date.now()}`;
        await chrome.storage.session.set({
          [stateKey]: {
            stepLog, currentStrategy, creditsUsed,
            consecutiveFailures, nextStep: step,
            explorePlan, tabId: currentTabId,
          },
        });

        await updateExplorationProgress(step, maxSteps,
          'Login required \u2014 sign in and the agent will resume', 'login_required');

        watchForLoginCompletion(currentTabId, stateKey, token);
        cleanupLoop();

        return finishExploration({
          success: false, paused: true,
          pauseReason: `This page requires you to sign in to ${loginDomain}. Log in on this page — the agent will detect when you're done and resume automatically.`,
          resumeStateKey: stateKey,
          creditsUsed, stepLog,
          authType,
        });
      }

      // ── SESSION CONTEXT VALIDATOR: Track & validate active account ──
      // Detects which account is active on multi-account platforms (Google, Facebook, AWS)
      // and stores it in session-level context. The AI receives this info to make
      // account-aware decisions.
      if (snapshot.accountContext && snapshot.accountContext.activeAccount) {
        const acct = snapshot.accountContext;
        try {
          const { sessionAccountMap = {} } = await chrome.storage.session.get('sessionAccountMap');
          const platform = acct.platform || 'unknown';

          // Store/update account context for this platform
          sessionAccountMap[platform] = {
            activeAccount: acct.activeAccount,
            accountIndex: acct.accountIndex,
            allAccounts: acct.allAccounts || [],
            composingAs: acct.composingAs || null,
            businessAccountId: acct.businessAccountId || null,
            lastSeen: Date.now(),
          };
          await chrome.storage.session.set({ sessionAccountMap });

          // Log for debugging
          console.log(`[SessionContext] ${platform}: active=${acct.activeAccount}, index=${acct.accountIndex}`);

          // Inject account context into step log observation so AI knows which account is active
          // This doesn't cost a step — it's metadata attached to the snapshot observation
          if (step === startStep || (stepLog.length > 0 && stepLog[stepLog.length - 1].action?.type === 'navigate')) {
            stepLog.push({
              step: -1, // meta-step, not counted
              action: { type: 'session_context', description: `Detected active account: ${acct.activeAccount}` },
              result: { success: true },
              observation: `Active ${platform} account: ${acct.activeAccount}${acct.accountIndex !== null ? ` (index ${acct.accountIndex})` : ''}${acct.composingAs ? ` | Composing as: ${acct.composingAs}` : ''}${acct.allAccounts.length > 1 ? ` | All accounts: ${acct.allAccounts.join(', ')}` : ''}`,
            });
          }
        } catch (e) {
          console.warn('[SessionContext] Failed to store account context:', e.message);
        }
      }

      // THINK: call backend for next action
      const exploreStepUrl = `${API_BASE}/api/agent/explore-step`;
      await updateExplorationProgress(step, maxSteps, 'Deciding next action...', 'running');

      let decision;
      try {
        console.log(`[Explore] Step ${step}: calling ${exploreStepUrl}`);
        console.log(`[Explore] Step ${step}: snapshot url=${snapshot.url}, elements=${snapshot.semanticElements?.length || 0}, content=${(snapshot.mainContent || '').length} chars`);
        const exploreByokConfig = await getByokConfig();
        const stepPayload = {
          goal,
          strategy: currentStrategy,
          stepNumber: step,
          maxSteps,
          previousActions: stepLog,
          currentPageState: snapshot,
          previousPhases: previousPhases.length > 0 ? previousPhases : undefined,
          originalPrompt: originalPrompt || undefined,
          ...byokPayload(exploreByokConfig),
        };

        // Retry logic for network resilience (up to 2 retries on transient failures)
        let thinkRes = null;
        let lastFetchErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            thinkRes = await fetch(exploreStepUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify(stepPayload),
            });
            lastFetchErr = null;
            break; // Success — exit retry loop
          } catch (fetchErr) {
            lastFetchErr = fetchErr;
            const isTransient = (fetchErr.message || '').match(/Failed to fetch|NetworkError|ERR_CONNECTION|ECONNRESET|ETIMEDOUT/);
            if (isTransient && attempt < 2) {
              console.warn(`[Explore] Step ${step}: fetch attempt ${attempt + 1} failed (${fetchErr.message}), retrying in ${(attempt + 1) * 2}s...`);
              await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
            } else {
              break; // Non-transient error or max retries — stop
            }
          }
        }

        if (lastFetchErr) throw lastFetchErr;

        if (!thinkRes.ok) {
          const err = await thinkRes.json().catch(() => ({}));
          if (err.errorType === 'INSUFFICIENT_CREDITS') {
            await hudUpdate(currentTabId, `explore-${step}`, 'error', 'Insufficient credits');
            break;
          }
          throw new Error(err.error || `explore-step failed (HTTP ${thinkRes.status})`);
        }

        decision = await thinkRes.json();
        creditsUsed += 0.3;
        console.log(`[Explore] Step ${step}: FULL decision object:`, JSON.stringify(decision, null, 2));
        console.log(`[Explore] Step ${step}: AI decided action=${decision.nextAction?.type}, desc="${decision.nextAction?.description}", goalComplete=${decision.isGoalComplete}`);
      } catch (err) {
        const errMsg = err.message || 'Unknown error';
        const isNetworkError = errMsg.includes('Failed to fetch') || errMsg.includes('NetworkError') || errMsg.includes('ERR_CONNECTION');
        const userMsg = isNetworkError
          ? `Backend unreachable (${API_BASE}) — is the server running? (retried 3 times)`
          : `AI error: ${errMsg}`;
        console.error(`[Explore] Think step ${step} failed:`, errMsg);
        consecutiveFailures++;
        stepLog.push({
          step,
          action: { type: 'think', description: 'AI decision' },
          result: { success: false },
          observation: `Think failed: ${userMsg}`,
        });
        await hudUpdate(currentTabId, `explore-${step}`, 'error', userMsg);
        await updateExplorationProgress(step, maxSteps, userMsg, 'running');
        continue;
      }

      // ── Loop Detection: stop the AI from repeating the same action ──
      if (decision.nextAction && stepLog.length > 0) {
        const currType = decision.nextAction.type;
        const currTarget = decision.nextAction.target;

        // Skip loop detection for non-interactive actions
        if (currType !== 'scrape_page' && currType !== 'scroll' && currType !== 'wait' && currType !== 'resolve_element') {
          // Count consecutive repeats of the exact same action+target
          let repeatCount = 0;
          for (let ri = stepLog.length - 1; ri >= 0; ri--) {
            if (stepLog[ri].action?.type === currType && stepLog[ri].action?.target === currTarget) repeatCount++;
            else break;
          }
          repeatCount++; // include current attempt

          if (repeatCount >= 3) {
            console.warn(`[Explore] Step ${step}: LOOP DETECTED — ${currType}(${currTarget}) repeated ${repeatCount} times`);
            // Log the loop and try alternative approach
            stepLog.push({
              step,
              action: { type: 'loop_break', description: `Loop detected: ${currType}(${currTarget}) x${repeatCount}` },
              result: { success: false },
              observation: `LOOP BREAK: Agent tried ${currType} on "${currTarget}" ${repeatCount} times with no progress. Attempting alternative approach: scroll + re-scan.`,
            });

            // Try scrolling to reveal hidden elements, then force scrape
            try {
              await chrome.tabs.sendMessage(currentTabId, {
                type: 'explore_action', actionType: 'scroll', target: 'down',
              }).catch(() => {});
            } catch {}
            await new Promise(r => setTimeout(r, 500));

            decision.nextAction = {
              type: 'scrape_page',
              description: `Re-scanning after loop break (tried ${currType} on ${currTarget} ${repeatCount}x)`,
            };
            decision.revisedStrategy = `Previous approach failed (loop on ${currTarget}). Try a different element, use keyboard navigation, or navigate to a different URL.`;
            consecutiveFailures++;
            continue;
          }

          if (repeatCount >= 2) {
            // Force a scrape_page on second repeat instead of letting it continue
            console.warn(`[Explore] Step ${step}: Blocked repeated ${currType}(${currTarget}), forcing scrape_page`);
            decision.nextAction = {
              type: 'scrape_page',
              description: `Re-reading page (blocked repeated ${currType} on ${currTarget})`,
            };
          }

          // Also detect "same action type on different targets with no state change"
          // (e.g., clicking 3 different "Edit" buttons with none working)
          if (currType === 'click_element' && stepLog.length >= 3) {
            const recentClicks = stepLog.slice(-3).filter(s =>
              s.action?.type === 'click_element' && s.result?.success !== false
            );
            if (recentClicks.length >= 3) {
              // Check if the page URL hasn't changed across these clicks
              const sameUrl = recentClicks.every(s =>
                s.observation && !s.observation.includes('Navigated')
              );
              if (sameUrl) {
                console.warn(`[Explore] Step ${step}: 3 clicks with no navigation — adding disambiguation hint`);
                // Don't break, but inject a hint for the AI
                decision.revisedStrategy = (decision.revisedStrategy || currentStrategy) +
                  ' NOTE: Multiple clicks have not changed the page. Consider using resolve_element to find the correct target, or try a completely different approach.';
              }
            }
          }
        }
      }

      // Check if goal is complete
      if (decision.isGoalComplete) {
        await hudUpdate(currentTabId, `explore-${step}`, 'success', 'Goal achieved!');
        await updateExplorationProgress(step, maxSteps, 'Goal achieved!', 'complete');

        cleanupLoop();

        return finishExploration({
          success: true,
          goalResult: decision.goalResult || 'Exploration complete.',
          stepsUsed: step,
          creditsUsed,
          stepLog,
        });
      }

      // Check if consent is needed
      if (decision.needsConsent) {
        const reason = (decision.consentReason || '').toLowerCase();
        const isLoginRequired = reason.includes('login') || reason.includes('sign in') || reason.includes('log in');

        if (isLoginRequired) {
          // Auth Bridge: try session probe + bypass before pausing
          const loginDomain = (() => { try { return new URL(snapshot.url).hostname; } catch { return 'unknown'; } })();
          const sessionProbe = await probeExistingSession(loginDomain);

          if (sessionProbe.hasSession) {
            const bypass = await trySessionBypass(currentTabId, snapshot.url);
            if (bypass.bypassed) {
              // Bypassed — continue exploration instead of pausing
              stepLog.push({
                step,
                action: { type: 'auth_bypass', description: `Bypassed login on ${loginDomain}` },
                result: { success: true },
                observation: `Used existing session on ${loginDomain}`,
              });
              consecutiveFailures = 0;
              continue;
            }
          }

          // No bypass possible — pause with auto-resume watcher
          const stateKey = `exploreResume_${Date.now()}`;
          await chrome.storage.session.set({
            [stateKey]: {
              stepLog, currentStrategy, creditsUsed,
              consecutiveFailures, nextStep: step,
              explorePlan, tabId: currentTabId,
            },
          });

          await updateExplorationProgress(step, maxSteps,
            decision.consentReason || 'Login required', 'login_required');

          watchForLoginCompletion(currentTabId, stateKey, token);
          cleanupLoop();

          return finishExploration({
            success: false, paused: true,
            pauseReason: `Sign in to ${loginDomain} on this page — the agent will resume automatically when you're done.`,
            resumeStateKey: stateKey,
            creditsUsed, stepLog,
            authType: 'login',
          });
        }

        // Non-login consent (e.g., payment) — skip and continue
        await updateExplorationProgress(step, maxSteps,
          `Consent needed: ${decision.consentReason || 'Action requires approval'}`, 'consent');
        stepLog.push({
          step,
          action: decision.nextAction,
          reasoning: decision.reasoning,
          result: { success: false },
          observation: `Skipped — requires consent: ${decision.consentReason}`,
        });
        await hudUpdate(currentTabId, `explore-${step}`, 'error',
          `Needs consent: ${decision.consentReason || 'Requires approval'}`);
        continue;
      }

      // Update strategy if revised
      if (decision.revisedStrategy) {
        currentStrategy = decision.revisedStrategy;
      }

      // ACT: execute the decided action
      if (!decision.nextAction) {
        // AI returned no action and goal is not complete — treat as a failure
        console.error(`[Explore] Step ${step}: NO nextAction! decision keys:`, Object.keys(decision), 'full:', JSON.stringify(decision).slice(0, 1000));
        consecutiveFailures++;
        stepLog.push({
          step,
          action: { type: 'none', description: 'AI returned no action' },
          result: { success: false },
          observation: 'AI did not provide a nextAction. Goal may need rephrasing.',
        });
        await hudUpdate(currentTabId, `explore-${step}`, 'error', 'No action from AI');
        await updateExplorationProgress(step, maxSteps, 'AI returned no action', 'running');
        continue;
      }

      const actionDesc = decision.nextAction.description || decision.nextAction.type || 'Action';
      await hudUpdate(currentTabId, `explore-${step}`, 'processing', actionDesc);
      await updateExplorationProgress(step, maxSteps, actionDesc, 'running');

      const actionResult = await executeExploreAction(currentTabId, decision.nextAction, token);

      // If navigation happened, re-inject all scripts and restore HUD
      if (decision.nextAction?.type === 'navigate' && actionResult.success) {
        for (const script of ['content_explore.js', HUD_SCRIPT]) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: currentTabId },
              files: [script],
            });
          } catch {}
        }
        // Re-show HUD with current progress after navigation destroyed the DOM
        const hudStepsForReshow = [];
        const hudMaxReshow = Math.min(maxSteps, 10);
        for (let i = 0; i <= hudMaxReshow; i++) {
          const label = i === 0 ? 'Start' : (currentPhase > 1 ? `P${currentPhase}:${i}` : `Step ${i}`);
          hudStepsForReshow.push({ id: `explore-${i}`, label });
        }
        await hudShow(currentTabId, `${currentPhase > 1 ? `[Phase ${currentPhase}] ` : ''}Exploring: ${goal.slice(0, 50)}`, hudStepsForReshow);
        // Mark completed/failed steps so HUD shows accurate state
        for (const entry of stepLog) {
          const status = entry.result?.success === false ? 'error' : 'success';
          await hudUpdate(currentTabId, `explore-${entry.step}`, status,
            entry.action?.description || entry.action?.type || '');
        }
      }

      stepLog.push({
        step,
        action: decision.nextAction,
        reasoning: decision.reasoning,
        result: { success: actionResult.success },
        observation: actionResult.observation || actionResult.error || '',
      });

      if (actionResult.success) {
        consecutiveFailures = 0;
        await hudUpdate(currentTabId, `explore-${step}`, 'success', actionDesc);
        await updateExplorationProgress(step, maxSteps, `Done: ${actionDesc}`, 'running');
      } else {
        consecutiveFailures++;
        await hudUpdate(currentTabId, `explore-${step}`, 'error',
          `Failed: ${actionResult.error || 'unknown error'}`);
        await updateExplorationProgress(step, maxSteps, `Failed: ${actionResult.error || actionDesc}`, 'running');
      }

      // Brief pause between steps for page rendering
      await new Promise(r => setTimeout(r, 500));
    }

    // Max steps reached or stopped
    cleanupLoop();

    const stoppedDueToFailures = consecutiveFailures >= 3;

    // ── AUTO-CONTINUATION: if goal not complete and phases remain, auto-continue ──
    if (!stoppedDueToFailures && currentPhase < MAX_PHASES) {
      const checkpoint = generateCheckpoint(stepLog, goal);
      const newPhaseNumber = currentPhase + 1;
      const newTotalSteps = totalStepsAcrossPhases + stepLog.length;

      console.log(`[Explore] Phase ${currentPhase} complete (${stepLog.length} steps). Auto-continuing to phase ${newPhaseNumber}. Checkpoint: ${checkpoint.slice(0, 200)}`);

      await updateExplorationProgress(maxSteps, maxSteps,
        `Phase ${currentPhase} complete — continuing automatically (phase ${newPhaseNumber}/${MAX_PHASES})...`, 'running');

      // Build continuation context for the next phase
      const newPreviousPhases = [
        ...previousPhases,
        { phase: currentPhase, stepsUsed: stepLog.length, checkpoint, creditsUsed },
      ];

      // New explore plan for continuation — start with scrape_page to observe current state
      const continuationPlan = {
        goal,
        strategy: currentStrategy || strategy,
        maxSteps,
        creditBudget,
        startAction: { type: 'scrape_page', description: `Phase ${newPhaseNumber} — observing current page state` },
      };

      const newContinuationContext = {
        phase: newPhaseNumber,
        previousPhases: newPreviousPhases,
        originalPrompt: originalPrompt || goal,
        totalSteps: newTotalSteps,
      };

      // Brief pause between phases
      await new Promise(r => setTimeout(r, 1000));

      // Recursively start next phase (non-blocking — returns result up the chain)
      return runExplorationLoop(continuationPlan, currentTabId, token, null, newContinuationContext);
    }

    // ── No more phases or stopped due to failures — build final result ──
    const successObservations = stepLog
      .filter(s => s.observation && s.result?.success)
      .map(s => s.observation)
      .join('\n');

    const errorObservations = stepLog
      .filter(s => s.result?.success === false && s.observation)
      .map(s => s.observation);

    let goalResult;

    if (stoppedDueToFailures && errorObservations.length > 0) {
      const lastError = errorObservations[errorObservations.length - 1];
      goalResult = successObservations
        ? `Exploration stopped after errors. What I found:\n\n${successObservations}\n\nLast error: ${lastError}`
        : `Exploration failed: ${lastError}`;
    } else if (currentPhase >= MAX_PHASES) {
      // Exhausted all phases
      const allPhasesSummary = previousPhases.map(p => `Phase ${p.phase}: ${p.checkpoint}`).join('\n');
      goalResult = successObservations
        ? `Completed ${currentPhase} phases (${totalStepsAcrossPhases + stepLog.length} total steps). Here's what was accomplished:\n\n${allPhasesSummary ? allPhasesSummary + '\n\nFinal phase:\n' : ''}${successObservations}`
        : `Completed ${currentPhase} phases but could not fully achieve the goal.\n\n${allPhasesSummary || 'No results captured.'}`;
    } else if (successObservations) {
      goalResult = `I explored ${stepLog.length} steps but couldn't fully complete the goal. Here's what I found:\n\n${successObservations}`;
    } else {
      goalResult = 'Exploration could not complete. Try rephrasing your request or check if the backend server is running.';
    }

    const finalStatus = stoppedDueToFailures ? 'Stopped after repeated failures'
      : currentPhase >= MAX_PHASES ? `All ${MAX_PHASES} phases completed`
      : 'Max steps reached';

    await updateExplorationProgress(maxSteps, maxSteps, finalStatus, 'partial');

    return finishExploration({
      success: !stoppedDueToFailures && currentPhase >= MAX_PHASES,
      goalResult,
      stepsUsed: totalStepsAcrossPhases + stepLog.length,
      creditsUsed,
      stepLog,
      partial: true,
      phasesUsed: currentPhase,
    });

  } catch (err) {
    cleanupLoop();
    console.error('[Explore] Loop error:', err);
    return finishExploration({ success: false, error: err.message || 'Exploration loop failed.', stepLog });
  }
}

// --- Ghost-Driver: stageAction (AI-driven form filling) ---

async function stageAction(tabId, userGoal, category, token) {
  // Show HUD with progress steps
  await hudShow(tabId, 'Ghost-Driver', [
    { id: 'scan', label: 'Scanning page elements' },
    { id: 'analyze', label: 'AI analyzing form structure' },
    { id: 'resolve', label: 'Mapping fields' },
    { id: 'execute', label: 'Filling form fields' },
  ]);

  // Step 1: Inject semantic scraper into the target tab
  await hudUpdate(tabId, 'scan', 'processing');
  let semanticMap;
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      files: [SEMANTIC_SCRAPER],
    });
    semanticMap = injected?.[0]?.result;
  } catch (err) {
    await hudUpdate(tabId, 'scan', 'error', 'Cannot access this page');
    return { success: false, error: 'Cannot inject semantic scraper into this page.' };
  }

  if (!semanticMap || !semanticMap.elements?.length) {
    // Read-only page (profile, article, search results) — no form fields to fill.
    // Scrape visible text and return it as readable content instead of failing hard.
    await hudUpdate(tabId, 'scan', 'error', 'Read-only page — no form fields');
    const textResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.body?.innerText?.slice(0, 3000) || '',
    }).catch(() => null);
    const pageText = textResult?.[0]?.result || '';
    await hudHide(tabId);
    return {
      success: false,
      errorType: 'READ_ONLY_PAGE',
      error: 'This page has no form fields to fill. ' + (pageText ? `Here is what I can see:\n\n${pageText}` : 'Try searching within this site instead.'),
    };
  }
  await hudUpdate(tabId, 'scan', 'success', `${semanticMap.elements.length} elements found`);

  // Step 2: Send to parse-intent in fill_form mode
  await hudUpdate(tabId, 'analyze', 'processing');
  const fillByokConfig = await getByokConfig();
  const parseRes = await fetch(`${API_BASE}/api/agent/parse-intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      semanticMap,
      userGoal,
      pageUrl: semanticMap.pageUrl,
      category: category || 'forms',
      mode: 'fill_form',
      ...byokPayload(fillByokConfig),
    }),
  });

  if (!parseRes.ok) {
    const err = await parseRes.json().catch(() => ({}));
    await hudUpdate(tabId, 'analyze', 'error', err.error || 'Analysis failed');
    return { success: false, error: err.error || 'Form analysis failed.' };
  }

  const parsed = await parseRes.json();
  const actions = parsed.actions || [];

  if (actions.length === 0) {
    await hudUpdate(tabId, 'analyze', 'error', 'No fields identified');
    return { success: false, error: 'No form fields identified on this page.' };
  }
  await hudUpdate(tabId, 'analyze', 'success', `${actions.length} field${actions.length > 1 ? 's' : ''} to fill`);

  // Show trust info if available from parse-intent
  if (parsed.siteName) {
    const trustBadge = parsed.trustScore >= 7 ? 'verified' : parsed.trustScore >= 4 ? 'aggregator' : 'caution';
    await hudTrust(tabId, trustBadge, parsed.trustScore, parsed.siteName);
  }

  // Step 3: Resolve semanticIds → CSS selectors via data-enh-sid attributes
  await hudUpdate(tabId, 'resolve', 'processing');
  const resolveResult = await chrome.scripting.executeScript({
    target: { tabId },
    func: (actionsToResolve) => {
      return actionsToResolve.map(action => {
        const el = document.querySelector(`[data-enh-sid="${action.semanticId}"]`);
        if (!el) return null;

        let selector;
        if (el.id) {
          selector = `#${el.id}`;
        } else if (el.name) {
          selector = `[name="${el.name}"]`;
        } else {
          selector = `[data-enh-sid="${action.semanticId}"]`;
        }

        return {
          action: action.action,
          selector,
          value: action.value || undefined,
          description: action.rationale || `${action.action} on ${action.semanticId}`,
        };
      }).filter(Boolean);
    },
    args: [actions],
  });

  const resolvedActions = resolveResult?.[0]?.result;
  if (!resolvedActions || resolvedActions.length === 0) {
    await hudUpdate(tabId, 'resolve', 'error', 'Fields not found on page');
    return { success: false, error: 'Could not locate form fields on page.' };
  }
  await hudUpdate(tabId, 'resolve', 'success', `${resolvedActions.length} field${resolvedActions.length > 1 ? 's' : ''} located`);

  // Step 4: Inject content_actions.js and execute each resolved action
  await hudUpdate(tabId, 'execute', 'processing');
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content_actions.js'],
  });

  const results = [];
  for (const action of resolvedActions) {
    const result = await chrome.tabs.sendMessage(tabId, {
      type: 'execute_dom_action',
      step: action,
    }).catch(() => null);
    const safeResult = (result && typeof result === 'object') ? result : { success: false, error: 'No response from content script' };
    results.push(safeResult);
    if (!safeResult.success) break;
  }

  const allSuccess = results.every(r => r.success);
  await hudUpdate(tabId, 'execute', allSuccess ? 'success' : 'error',
    allSuccess ? `${results.length} action${results.length > 1 ? 's' : ''} completed` : 'Some actions failed'
  );

  // Post-action verification: re-scrape page to detect success/error state
  let pageStateAfter = null;
  if (allSuccess) {
    await new Promise(r => setTimeout(r, 1500)); // Wait for SPA/AJAX to settle
    pageStateAfter = await scrapePageState(tabId);
    setTimeout(() => hudHide(tabId), 1500); // Auto-hide HUD (adjusted for the 1.5s wait)
  }

  return {
    success: allSuccess,
    results,
    actionsPlanned: actions.length,
    actionsExecuted: results.length,
    pageStateAfter,
  };
}

// --- Central Message Handler ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Timeout guard: if handleMessage takes longer than 30s, send an error response
  // so the message channel doesn't hang open indefinitely (causing "message channel closed" warnings).
  let responded = false;
  const safeRespond = (result) => {
    if (responded) return; // Only send once
    responded = true;
    try { sendResponse(result); } catch (_) { /* channel already closed */ }
  };

  const timeoutId = setTimeout(() => {
    if (!responded) {
      console.warn(`[BG_TIMEOUT] Handler for '${request.type}' exceeded 30s — sending timeout response.`);
      safeRespond({
        success: false,
        errorType: 'BACKEND_TIMEOUT',
        error: `Handler for '${request.type}' timed out after 30 seconds. The operation may still be running in the background.`,
      });
    }
  }, 30000);

  handleMessage(request, sender)
    .then(result => {
      clearTimeout(timeoutId);
      // Ensure we ALWAYS send a valid response object
      const safeResult = (result && typeof result === 'object')
        ? result
        : { success: false, errorType: 'EMPTY_HANDLER', error: `Handler for '${request.type}' returned no data.` };
      safeRespond(safeResult);
    })
    .catch(err => {
      clearTimeout(timeoutId);
      console.error(`[BG_ERROR] ${request.type}:`, err);
      const errorObj = {
        success: false,
        errorType: 'HANDLER_CRASH',
        error: (err && err.message) || 'Background handler crashed unexpectedly.',
      };
      safeRespond(errorObj);
    });
  return true; // Keep message channel open for async response
});

async function handleMessage(request, sender) {

  // ── GET ACTIVE TAB: Returns current active tab info ───
  if (request.type === 'get_active_tab') {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return { url: tab?.url || '', title: tab?.title || '', id: tab?.id };
    } catch {
      return { url: '', title: '', id: null };
    }
  }

  // ── MODEL REGISTRY: Fetch from backend for settings UI ───
  if (request.type === 'fetch_model_registry') {
    try {
      const res = await fetch(`${API_BASE}/api/models`);
      if (res.ok) {
        const data = await res.json();
        return { success: true, models: data.models || [] };
      }
      return { success: false, error: 'Failed to fetch model registry.' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ── TAB TRIAGE MAP: Zero-Token spatial awareness ─────────
  if (request.type === 'GET_TAB_TRIAGE_MAP') {
    const tabs = await chrome.tabs.query({});
    const triageMap = tabs.map(tab => ({
      tabId: tab.id,
      title: (tab.title || '').slice(0, 80),
      url: tab.url || '',
      active: tab.active,
    }));
    return { success: true, tabs: triageMap };
  }

  // ── FETCH_TODOS: Pull tasks from backend API ────────────
  if (request.type === 'fetch_todos') {
    const { token } = await chrome.storage.local.get(['token']);
    if (!token) return { success: false, errorType: 'AUTH_REQUIRED', error: 'Not logged in.' };

    const { status, period } = request.data || {};
    const params = new URLSearchParams();
    if (status) params.append('status', status);

    try {
      const pendingRes = await fetch(`${API_BASE}/api/todos?status=PENDING`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const inProgressRes = await fetch(`${API_BASE}/api/todos?status=IN_PROGRESS`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const completedRes = await fetch(`${API_BASE}/api/todos?status=COMPLETED`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!pendingRes.ok && !inProgressRes.ok && !completedRes.ok) {
        return { success: false, errorType: 'API_ERROR', error: 'Failed to fetch tasks from server.' };
      }

      const [pendingData, inProgressData, completedData] = await Promise.all([
        pendingRes.ok ? pendingRes.json() : { todos: [] },
        inProgressRes.ok ? inProgressRes.json() : { todos: [] },
        completedRes.ok ? completedRes.json() : { todos: [] },
      ]);

      let allTodos = [
        ...(inProgressData.todos || []),
        ...(pendingData.todos || []),
        ...(completedData.todos || []),
      ];

      // Period filtering: if user specified a month/period, filter by it
      if (period) {
        const periodLower = period.toLowerCase();
        const now = new Date();
        let filterStart, filterEnd;

        // Parse month names
        const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
        const monthIdx = months.findIndex(m => periodLower.includes(m) || periodLower.includes(m.slice(0,3)));
        if (monthIdx !== -1) {
          const year = now.getFullYear();
          filterStart = new Date(year, monthIdx, 1);
          filterEnd = new Date(year, monthIdx + 1, 0, 23, 59, 59);
        } else if (periodLower.includes('this week')) {
          const dayOfWeek = now.getDay();
          filterStart = new Date(now);
          filterStart.setDate(now.getDate() - dayOfWeek);
          filterStart.setHours(0, 0, 0, 0);
          filterEnd = new Date(filterStart);
          filterEnd.setDate(filterStart.getDate() + 6);
          filterEnd.setHours(23, 59, 59);
        } else if (periodLower.includes('today')) {
          filterStart = new Date(now);
          filterStart.setHours(0, 0, 0, 0);
          filterEnd = new Date(now);
          filterEnd.setHours(23, 59, 59);
        }

        if (filterStart && filterEnd) {
          allTodos = allTodos.filter(t => {
            const due = t.dueDate ? new Date(t.dueDate) : null;
            const created = t.createdAt ? new Date(t.createdAt) : null;
            // Match if due date OR created date falls within period
            return (due && due >= filterStart && due <= filterEnd) ||
                   (created && created >= filterStart && created <= filterEnd);
          });
        }
      }

      return {
        success: true,
        todos: allTodos.map(t => ({
          id: t.id,
          title: t.title,
          description: t.description || '',
          status: t.status,
          priority: t.priority,
          dueDate: t.dueDate,
          createdAt: t.createdAt,
        })),
        count: allTodos.length,
        period: period || 'all',
      };
    } catch (err) {
      return { success: false, errorType: 'NETWORK_ERROR', error: err.message || 'Network error fetching tasks.' };
    }
  }

  // ── LOGIN: Email + Password ──────────────────────────────
  if (request.type === 'extension_login') {
    const { email, password } = request.data;
    const res = await fetch(`${API_BASE}/api/auth/extension/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (data.success) {
      await chrome.storage.local.set({ token: data.token });
      await refreshMemory(data.token).catch(() => {});
      return { success: true };
    }
    return { success: false, message: data.error || 'Login failed' };
  }

  // ── SIGNUP: Email + Password ───────────────────────────────
  if (request.type === 'extension_signup') {
    const { name, email, password } = request.data;
    const res = await fetch(`${API_BASE}/api/auth/extension/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });
    const data = await res.json();
    if (data.success) {
      await chrome.storage.local.set({ token: data.token });
      await refreshMemory(data.token).catch(() => {});
      return { success: true };
    }
    return { success: false, message: data.error || 'Sign up failed' };
  }

  // ── RESET PASSWORD ─────────────────────────────────────────
  if (request.type === 'extension_reset_password') {
    const { email, newPassword } = request.data;
    const res = await fetch(`${API_BASE}/api/auth/extension/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, newPassword })
    });
    const data = await res.json();
    if (data.success) {
      return { success: true, message: data.message };
    }
    return { success: false, message: data.error || 'Password reset failed' };
  }

  // ── LOGIN: Google OAuth ──────────────────────────────────
  if (request.type === 'google_login') {
    const clientId = '409104365095-beonfvn8d6cdtnmgcjqk42bav4uk5amc.apps.googleusercontent.com';
    const redirectUri = chrome.identity.getRedirectURL();
    const scopes = 'email profile openid';
    const authUrl = `https://accounts.google.com/o/oauth2/auth?client_id=${clientId}&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}`;

    const redirectUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (url) => {
        if (chrome.runtime.lastError || !url) {
          reject(new Error(chrome.runtime.lastError?.message || 'Google auth failed'));
        } else {
          resolve(url);
        }
      });
    });

    const match = redirectUrl.match(/access_token=([^&]*)/);
    if (!match) return { success: false, message: 'No access token returned from Google.' };

    const res = await fetch(`${API_BASE}/api/auth/extension/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: match[1] })
    });
    const data = await res.json();
    if (data.success) {
      await chrome.storage.local.set({ token: data.token });
      await refreshMemory(data.token).catch(() => {});
      return { success: true };
    }
    return { success: false, message: data.error || 'Google login failed on server.' };
  }

  // ── All routes below require a valid token ───────────────
  const { token } = await chrome.storage.local.get(['token']);
  if (!token) return { success: false, error: 'Not logged in' };

  // ── CREATE SINGLE TASK ───────────────────────────────────
  if (request.type === 'create_todo') {
    const res = await fetch(`${API_BASE}/api/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(request.data)
    });
    const data = await res.json();
    if (data.error) return { success: false, error: data.error };
    return { success: true, data };
  }

  // ── CREATE MULTIPLE TASKS (bulk from results) ────────────
  if (request.type === 'create_todos_bulk') {
    const results = [];
    for (const todo of request.data) {
      const res = await fetch(`${API_BASE}/api/todos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(todo)
      });
      const data = await res.json();
      results.push({ success: !data.error, data });
    }
    const allOk = results.every(r => r.success);
    return { success: allOk, results };
  }

  // ── MAIN: Process a user request with 3-Tier Memory ─────
  if (request.type === 'process_request') {
    const { userPrompt, tabId, url, availableTabs, conversationHistory, siteHint } = request.data;

    // Load memory (from cache or fresh fetch)
    let userMemory;
    try {
      userMemory = await getOrRefreshMemory();
    } catch (memErr) {
      console.warn('[BG] Memory fetch failed, proceeding without:', memErr.message);
      userMemory = {}; // Non-critical — proceed without memory
    }

    // Build page context by detecting site and optionally scraping
    const pageContext = { url, site: 'general' };

    // Zero-Token Triage: attach lightweight tab map for spatial awareness
    if (availableTabs && availableTabs.length > 0) {
      pageContext.availableTabs = availableTabs
        .filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'))
        .slice(0, 15)
        .map(t => ({ title: t.title, url: t.url, active: t.active }));
    }

    if (url && url.includes('mail.google.com')) {
      pageContext.site = 'gmail';
      try {
        const scraped = await chrome.tabs.sendMessage(tabId, { type: 'scrape_email' });
        if (scraped) {
          pageContext.emailBody = scraped.emailBody;
          pageContext.subject = scraped.subject;
          pageContext.sender = scraped.sender;
        }
      } catch { /* Content script not ready — proceed without scrape */ }
      // Fallback: if Gmail scraper returned empty body, use universal scraper
      if (!pageContext.emailBody && tabId) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content_universal.js'],
          });
          const scraped = results?.[0]?.result;
          if (scraped?.mainContent) {
            pageContext.emailBody = scraped.mainContent.slice(0, 3000);
            if (!pageContext.subject && scraped.pageTitle) pageContext.subject = scraped.pageTitle;
          }
        } catch { /* universal fallback also failed */ }
      }

    } else if (url && /amazon\.(com|co\.uk|de|fr|ca|com\.au)/.test(url)) {
      pageContext.site = 'amazon';
      try {
        const scraped = await chrome.tabs.sendMessage(tabId, { type: 'scrape_amazon' });
        if (scraped) {
          pageContext.productTitle = scraped.productTitle;
          pageContext.searchQuery = scraped.searchQuery;
          pageContext.price = scraped.price;
          pageContext.rating = scraped.rating;
        }
      } catch { /* Proceed without scrape */ }

    } else if (tabId) {
      pageContext.site = detectSiteType(url);
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content_universal.js'],
        });
        const scraped = results?.[0]?.result;
        if (scraped) {
          pageContext.pageTitle = scraped.pageTitle;
          pageContext.mainContent = scraped.mainContent;
          pageContext.selectedText = scraped.selectedText;
          pageContext.siteType = scraped.siteType;
          pageContext.meta = scraped.meta;
        }
      } catch { /* Some pages block injection — proceed without */ }
    }

    // Send enriched payload to backend agent endpoint (dual-provider BYOK)
    const byokConfig = await getByokConfig();
    let res;
    try {
      res = await fetch(`${API_BASE}/api/agent/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userPrompt, pageContext: { ...pageContext, siteHint: siteHint || null }, userMemory, conversationHistory: conversationHistory || [], ...byokPayload(byokConfig) })
      });
    } catch (fetchErr) {
      return { success: false, errorType: 'NETWORK_ERROR', error: `Cannot reach server: ${fetchErr.message}` };
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // Categorize by HTTP status for more specific UI feedback
      let errorType = 'SERVER_ERROR';
      if (res.status === 402 || err.errorType === 'INSUFFICIENT_CREDITS') errorType = 'INSUFFICIENT_CREDITS';
      else if (res.status === 401 || res.status === 403) errorType = 'AUTH_ERROR';
      else if (res.status === 429) errorType = 'RATE_LIMITED';
      else if (res.status === 413 || (err.error && /token|limit|too long/i.test(err.error))) errorType = 'TOKEN_LIMIT';
      else if (res.status === 422) errorType = 'PARSE_ERROR';
      else if (res.status >= 500) errorType = 'BACKEND_DOWN';
      return { success: false, errorType, error: err.error || `Server error (HTTP ${res.status})`, httpStatus: res.status };
    }

    let data;
    try {
      data = await res.json();
    } catch (parseErr) {
      return { success: false, errorType: 'PARSE_ERROR', error: 'Server returned invalid JSON.' };
    }

    return { success: true, data };
  }

  // ── SWITCH TO EXISTING TAB ───────────────────────────────
  if (request.type === 'switch_tab') {
    const { targetTabUrl } = request.data;
    if (!targetTabUrl) {
      return { success: false, errorType: 'INVALID_INPUT', error: 'No target tab URL provided.' };
    }

    // Find the tab by matching URL
    let allTabs;
    try {
      allTabs = await chrome.tabs.query({});
    } catch (tabErr) {
      return { success: false, errorType: 'TAB_QUERY_FAILED', error: 'Could not query browser tabs.' };
    }

    let match;
    try {
      match = allTabs.find(t => t.url && t.url.includes(targetTabUrl)) ||
              allTabs.find(t => t.url && new URL(t.url).hostname === new URL(targetTabUrl).hostname);
    } catch {
      match = null; // URL parsing failed — treat as not found
    }

    if (!match) {
      // Fallback: navigate the current active tab instead of opening a new one
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        await chrome.tabs.update(activeTab.id, { url: targetTabUrl });
        return { success: true, tabId: activeTab.id, switched: true, message: 'Navigated in current tab.' };
      }
      const newTab = await chrome.tabs.create({ url: targetTabUrl, active: true });
      return { success: true, tabId: newTab.id, opened: true, message: 'Opened in new tab.' };
    }

    // Activate the existing tab
    await chrome.tabs.update(match.id, { active: true });
    // Bring its window to focus
    if (match.windowId) {
      await chrome.windows.update(match.windowId, { focused: true });
    }
    return { success: true, tabId: match.id, switched: true, tabTitle: match.title };
  }

  // ── EXECUTE SINGLE DOM ACTION ─────────────────────────────
  if (request.type === 'execute_action') {
    const { action, tabId } = request.data;

    // Navigate is handled by background.js directly (no content script)
    if (action.action === 'navigate') {
      if (!isAllowedUrl(action.value)) {
        return { success: false, error: `Navigation to ${action.value} is not allowed.` };
      }
      // Check if the target URL is already open in an existing tab
      const allTabs = await chrome.tabs.query({ currentWindow: true });
      const targetHost = new URL(action.value).hostname;
      const existingTab = allTabs.find(t => {
        try { return new URL(t.url).hostname === targetHost; } catch { return false; }
      });

      let navTabId;
      if (existingTab) {
        // Site already open — just switch to it
        await chrome.tabs.update(existingTab.id, { active: true });
        navTabId = existingTab.id;
      } else {
        // Open in a NEW tab so the current page is preserved
        const newTab = await chrome.tabs.create({ url: action.value, active: true });
        navTabId = newTab.id;
        await waitForTabLoad(navTabId, 10000);
      }
      return { success: true, tabId: navTabId };
    }

    // semantic_fill: Ghost-Driver AI form filling (stageAction already returns pageStateAfter)
    if (action.action === 'semantic_fill') {
      return await stageAction(tabId, action.value || '', action.category || 'forms', token);
    }

    // For DOM actions, inject content_actions.js then send the step
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content_actions.js'],
      });
    } catch {
      return { success: false, error: 'Cannot inject action script into this page.' };
    }

    const result = await chrome.tabs.sendMessage(tabId, {
      type: 'execute_dom_action',
      step: action,
    });

    // Post-action verification for DOM actions
    if (result?.success) {
      await new Promise(r => setTimeout(r, 1500));
      const pageStateAfter = await scrapePageState(tabId);
      return { ...result, pageStateAfter };
    }
    return result;
  }

  // ── EXECUTE MULTI-STEP FLOW ─────────────────────────────
  if (request.type === 'execute_multi_step') {
    const { steps, tabId } = request.data;
    const results = [];
    let currentTabId = tabId;

    for (const step of steps) {
      const stepResult = await handleMessage({
        type: 'execute_action',
        data: { action: step, tabId: currentTabId },
      });
      results.push(stepResult);

      if (!stepResult.success) {
        return { success: false, failedAt: results.length - 1, results };
      }

      // If the step was a navigation, update tabId and wait for page load
      if (step.action === 'navigate' && stepResult.tabId) {
        currentTabId = stepResult.tabId;
        await new Promise(r => setTimeout(r, 2500));
      }

      // If the step was semantic_fill, allow time for fields to settle
      if (step.action === 'semantic_fill') {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    return { success: true, results };
  }

  // ── ORCHESTRATE: Multi-site parallel search ──────────────
  // Fire-and-forget: return immediately, results come via chrome.storage/progress events
  if (request.type === 'orchestrate_search') {
    const { searchPlan, userPrompt } = request.data;

    if (!searchPlan || !searchPlan.sites || searchPlan.sites.length === 0) {
      return { success: false, error: 'Invalid search plan: no sites specified.' };
    }

    // Clear stale result before starting
    await chrome.storage.session.remove(['orchestrationResult']).catch(() => {});

    // Run in background — don't await (prevents message channel timeout)
    runOrchestration(userPrompt, searchPlan, token)
      .then(result => {
        // Store result for the panel to pick up
        chrome.storage.session.set({ orchestrationResult: result }).catch(() => {});
        console.log('[Orchestrate] Completed in background, result stored in session storage.');
      })
      .catch(err => {
        console.error('[Orchestrate] Background error:', err);
        chrome.storage.session.set({ orchestrationResult: { success: false, error: err.message } }).catch(() => {});
      });
    return { success: true, async: true, message: 'Orchestration started. Results will arrive via progress updates.' };
  }

  // ── OPEN SETTINGS: Open popup in a new tab at #settings ────
  if (request.type === 'open_settings') {
    const popupUrl = chrome.runtime.getURL('popup/popup.html#settings');
    await chrome.tabs.create({ url: popupUrl });
    return { success: true };
  }

  // ── EXPLORE: Multi-step agentic exploration loop ────────────
  // Fire-and-forget: return immediately, results come via updateExplorationProgress
  if (request.type === 'explore_start') {
    const { explorePlan, userPrompt } = request.data;
    if (!explorePlan || !explorePlan.goal) {
      return { success: false, error: 'Invalid explore plan: no goal specified.' };
    }
    // Use tabId from request, or fall back to sender tab (content script's tab), or active tab
    let tabId = request.data.tabId || sender?.tab?.id;
    if (!tabId) {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = activeTab?.id;
      } catch {}
    }
    if (!tabId) {
      return { success: false, error: 'Could not determine which tab to explore.' };
    }

    // Clear stale result before starting
    await chrome.storage.session.remove(['explorationResult']).catch(() => {});

    // Initial continuation context with the original user prompt
    const initialContinuationContext = {
      phase: 1,
      previousPhases: [],
      originalPrompt: userPrompt || explorePlan.goal,
      totalSteps: 0,
    };

    // Run in background — don't await (prevents message channel timeout)
    runExplorationLoop(explorePlan, tabId, token, null, initialContinuationContext)
      .then(result => {
        chrome.storage.session.set({ explorationResult: result }).catch(() => {});
        console.log(`[Explore] Loop completed in background (${result.phasesUsed || 1} phase(s), ${result.stepsUsed || 0} steps). Result stored.`);
      })
      .catch(err => {
        console.error('[Explore] Background loop error:', err);
        chrome.storage.session.set({ explorationResult: { success: false, error: err.message } }).catch(() => {});
      });
    return { success: true, async: true, message: 'Exploration started. Progress updates will arrive separately.' };
  }

  // ── EXPLORE RESUME: Continue a paused exploration after login ──
  if (request.type === 'explore_resume') {
    const { resumeStateKey } = request.data;
    if (!resumeStateKey) {
      return { success: false, error: 'No resume state key provided.' };
    }

    const stored = await chrome.storage.session.get([resumeStateKey]);
    const resumeState = stored[resumeStateKey];

    if (!resumeState) {
      return { success: false, error: 'Resume state not found or expired. Please start a new exploration.' };
    }

    // Clean up saved state (will re-save if another pause occurs)
    await chrome.storage.session.remove([resumeStateKey]);

    return await runExplorationLoop(
      resumeState.explorePlan,
      resumeState.tabId,
      token,
      resumeState,
    );
  }

  // ── SEMANTIC SCRAPE: On-demand semantic analysis of any tab ──
  if (request.type === 'semantic_scrape') {
    const { tabId, userGoal, category, mode } = request.data;

    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId },
        files: [SEMANTIC_SCRAPER],
      });
      const semanticMap = injected?.[0]?.result;
      if (!semanticMap || !semanticMap.elements?.length) {
        return { success: false, error: 'Could not build semantic map from this page.' };
      }

      const scrapeByokConfig = await getByokConfig();
      const parseRes = await fetch(`${API_BASE}/api/agent/parse-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          semanticMap,
          userGoal: userGoal || 'Analyze this page',
          pageUrl: semanticMap.pageUrl,
          category: category || 'general',
          mode: mode || 'extract_products',
          ...byokPayload(scrapeByokConfig),
        }),
      });

      if (!parseRes.ok) {
        const err = await parseRes.json().catch(() => ({}));
        return { success: false, error: err.error || 'Parse intent failed.' };
      }

      const parsed = await parseRes.json();
      return { success: true, data: parsed };

    } catch (err) {
      return { success: false, error: err.message || 'Semantic scrape failed.' };
    }
  }

  // ── STAGE ACTION: Ghost-Driver form filling ──────────────
  if (request.type === 'stage_action') {
    const { tabId, userGoal, category } = request.data;
    return await stageAction(tabId, userGoal, category || 'forms', token);
  }

  // ── NAVIGATE TO WINNER (Closer Logic — HUD + Consent + AI-driven) ────
  if (request.type === 'navigate_to_winner') {
    const { url, tabId } = request.data;

    if (!isAllowedUrl(url)) {
      return { success: false, error: `Navigation to ${new URL(url).hostname} is not allowed.` };
    }

    // Navigate the active tab to the winner URL
    await chrome.tabs.update(tabId, { url });

    // Wait for page to load
    await waitForTabLoad(tabId, 15000);

    // Show HUD on the product page
    await hudShow(tabId, 'Enhancivity Agent', [
      { id: 'navigate', label: 'Navigating to product page' },
      { id: 'scan', label: 'Scanning page for Buy button' },
      { id: 'consent', label: 'Awaiting your approval' },
    ]);
    await hudUpdate(tabId, 'navigate', 'success', new URL(url).hostname);

    // Use semantic scraper + parse-intent to find the Buy button
    try {
      await hudUpdate(tabId, 'scan', 'processing');
      const injected = await chrome.scripting.executeScript({
        target: { tabId },
        files: [SEMANTIC_SCRAPER],
      });

      const semanticMap = injected?.[0]?.result;
      if (semanticMap && semanticMap.elements?.length) {
        const cartByokConfig = await getByokConfig();
        const parseRes = await fetch(`${API_BASE}/api/agent/parse-intent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            semanticMap,
            userGoal: 'Find the Add to Cart or Buy button',
            pageUrl: url,
            category: 'shopping',
            mode: 'find_element',
            ...byokPayload(cartByokConfig),
          }),
        });

        if (parseRes.ok) {
          const parsed = await parseRes.json();

          // Show trust info
          if (parsed.siteName) {
            const badge = parsed.trustScore >= 7 ? 'verified' : parsed.trustScore >= 4 ? 'aggregator' : 'caution';
            await hudTrust(tabId, badge, parsed.trustScore, parsed.siteName);
          }

          if (parsed.target?.semanticId) {
            await hudUpdate(tabId, 'scan', 'success', parsed.target.rationale || 'Buy button found');

            const targetSelector = `[data-enh-sid="${parsed.target.semanticId}"]`;

            // Show consent modal with indigo glow on the target button
            await hudUpdate(tabId, 'consent', 'processing', 'Waiting for your approval...');
            const consent = await hudConsent(
              tabId,
              `The agent found the purchase button and wants to highlight it for you. Approve to proceed?`,
              targetSelector
            );

            if (consent?.approved) {
              await hudUpdate(tabId, 'consent', 'success', 'Approved');

              // Execute the highlight
              await chrome.scripting.executeScript({
                target: { tabId },
                files: ['content_actions.js'],
              });

              const result = await chrome.tabs.sendMessage(tabId, {
                type: 'execute_dom_action',
                step: {
                  action: 'highlight',
                  selector: targetSelector,
                  description: parsed.target.rationale || 'Highlighting the purchase button',
                },
              }).catch(() => null);

              setTimeout(() => hudHide(tabId), 3000);
              return { success: true, navigated: true, highlighted: !!result?.success };
            } else {
              await hudUpdate(tabId, 'consent', 'error', 'Cancelled by user');
              setTimeout(() => hudHide(tabId), 2000);
              return { success: true, navigated: true, highlighted: false, cancelled: true };
            }
          }
        }
      }

      await hudUpdate(tabId, 'scan', 'error', 'Button not found');
      setTimeout(() => hudHide(tabId), 3000);
      return { success: true, navigated: true, highlighted: false };

    } catch {
      await hudUpdate(tabId, 'scan', 'error', 'Scan failed');
      setTimeout(() => hudHide(tabId), 3000);
      return { success: true, navigated: true, highlighted: false };
    }
  }

  // ── GMAIL COMPOSE (site-specific action) ────────────────
  if (request.type === 'gmail_compose') {
    const { tabId, data } = request.data;
    try {
      const result = await chrome.tabs.sendMessage(tabId, {
        type: 'gmail_compose',
        data,
      });
      return result;
    } catch {
      return { success: false, error: 'Gmail content script not ready. Please reload Gmail.' };
    }
  }

  // ── GMAIL REPLY (site-specific action) ──────────────────
  if (request.type === 'gmail_reply') {
    const { tabId, data } = request.data;
    try {
      const result = await chrome.tabs.sendMessage(tabId, {
        type: 'gmail_reply',
        data,
      });
      return result;
    } catch {
      return { success: false, error: 'Gmail content script not ready. Please reload Gmail.' };
    }
  }

  // ── GMAIL FIND AND REPLY (agentic: search inbox → open email → pre-fill reply) ──
  // Non-consequential: agent searches and pre-fills. User clicks Send manually.
  if (request.type === 'gmail_find_and_reply') {
    const { tabId, searchQuery, replyBody } = request.data;

    if (!tabId) return { success: false, error: 'No tab ID provided.' };

    // Step 1: Inject content_gmail.js if not already present, then search
    try {
      // Use Gmail's search to navigate to the right thread
      // We encode the query and navigate to Gmail search
      const searchUrl = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(searchQuery)}`;

      // Navigate the tab to the Gmail search results
      await chrome.tabs.update(tabId, { url: searchUrl });

      // Wait for the search results to load
      await waitForTabLoad(tabId, 10000);

      // Extra wait for Gmail's SPA to render results
      await new Promise(r => setTimeout(r, 2000));

      // Step 2: Inject content_gmail.js and click the first result + open reply
      const result = await chrome.tabs.sendMessage(tabId, {
        type: 'gmail_open_first_and_reply',
        data: { replyBody, searchQuery },
      }).catch(() => null);

      if (result?.success) {
        return { success: true };
      }

      // Fallback: if content script not ready, inject it first then retry
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content_gmail.js'] }).catch(() => {});
      await new Promise(r => setTimeout(r, 500));

      const retryResult = await chrome.tabs.sendMessage(tabId, {
        type: 'gmail_open_first_and_reply',
        data: { replyBody, searchQuery },
      }).catch(() => null);

      return retryResult || { success: false, error: 'Could not open the email thread.' };

    } catch (err) {
      return { success: false, error: err.message || 'Gmail find-and-reply failed.' };
    }
  }

  // ── GHOST DRIVE TASK: Delegated from Command Center dashboard ──
  // When user clicks "Delegate" on the dashboard, we inject/show the floating panel
  // on the SAME dashboard tab and auto-fill it with the task prompt.
  if (request.type === 'ghost_drive_task') {
    const payload = request.payload || {};
    const { taskId, taskTitle } = payload;
    console.log('[GhostDrive] Received ghost_drive_task:', { taskId, taskTitle, hasSender: !!sender, senderTabId: sender?.tab?.id });

    if (!taskId || !taskTitle) {
      console.warn('[GhostDrive] Missing taskId or taskTitle in payload');
      return { success: false, error: 'Missing task data for delegation.' };
    }

    try {
      // Open side panel and send delegate auto-fill via runtime message
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const windowId = activeTab?.windowId || sender?.tab?.windowId;
      if (windowId) {
        await chrome.sidePanel.open({ windowId });
        // Small delay for side panel to initialize
        await new Promise(r => setTimeout(r, 500));
      }

      // Send auto-fill via runtime message (side panel listens on chrome.runtime.onMessage)
      let autofillSent = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await chrome.runtime.sendMessage({
            type: 'enh_delegate_autofill',
            payload,
          });
          console.log(`[GhostDrive] Auto-fill sent to side panel (attempt ${attempt + 1})`);
          autofillSent = true;
          break;
        } catch (sendErr) {
          console.warn(`[GhostDrive] Auto-fill attempt ${attempt + 1} failed:`, sendErr.message);
          if (attempt < 2) await new Promise(r => setTimeout(r, 400));
        }
      }

      if (!autofillSent) {
        console.error('[GhostDrive] All auto-fill attempts failed');
        return { success: false, error: 'Side panel opened but auto-fill failed. Try clicking the extension icon.' };
      }

      return { success: true, message: 'Task loaded into side panel.' };
    } catch (err) {
      console.error('[GhostDrive] Failed to open side panel for delegation:', err.message);
      return { success: false, error: 'Could not open side panel.' };
    }
  }

  // ── OPEN SIDE PANEL: Bridge requests panel open ──
  if (request.type === 'inject_panel_here') {
    try {
      const windowId = sender?.tab?.windowId;
      if (windowId) {
        await chrome.sidePanel.open({ windowId });
      } else {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.windowId) {
          await chrome.sidePanel.open({ windowId: activeTab.windowId });
        }
      }
      console.log('[BG] Side panel opened');
      return { success: true };
    } catch (err) {
      console.error('[BG] Side panel open error:', err.message);
      return { success: false, error: err.message };
    }
  }

  // ── GET CURRENT TAB (for sidepanel.js) ─────────────────
  if (request.type === 'GET_CURRENT_TAB') {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return { success: true, tab: tab ? { id: tab.id, url: tab.url, title: tab.title } : null };
    } catch {
      return { success: false, error: 'Could not query current tab.' };
    }
  }

  // ── OPEN POPUP TAB (auth fallback from floating panel) ─────
  if (request.type === 'open_popup_tab') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') });
    return { success: true };
  }

  return { success: false, error: `Unknown message type: ${request.type}` };
}

// ── Ghost-Driver: Delegated Task Execution ─────────────────────
// Called when the Command Center dashboard delegates a task.
// Flow: get memory → ask AI for execution plan → navigate → scrape → execute

async function handleDelegatedTask(taskId, taskTitle, taskDescription, authToken) {
  console.log(`[GhostDrive] Starting delegation: "${taskTitle}"`);

  const { token } = await chrome.storage.local.get(['token']);
  const activeToken = authToken || token;
  if (!activeToken) throw new Error('Not authenticated');

  // Try to show HUD on the active tab (best-effort — user might be on any page)
  let hudTabId = null;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id) {
      hudTabId = activeTab.id;
      await hudShow(hudTabId, `Delegating: ${taskTitle}`, [
        { id: 'memory', label: 'Loading memory context' },
        { id: 'plan', label: 'AI planning execution' },
        { id: 'execute', label: 'Executing task' },
      ]);
      await hudUpdate(hudTabId, 'memory', 'processing');
    }
  } catch { /* No active tab — skip HUD */ }

  // 1. Gather memory context
  const memory = await getOrRefreshMemory();

  if (hudTabId) await hudUpdate(hudTabId, 'memory', 'success', memory ? 'Memory loaded' : 'No memory available');

  // 2. Ask AI agent for an execution plan
  if (hudTabId) await hudUpdate(hudTabId, 'plan', 'processing');
  const delegateByokConfig = await getByokConfig();
  const agentRes = await fetch(`${API_BASE}/api/agent/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${activeToken}` },
    body: JSON.stringify({
      userMessage: `Complete this delegated task: "${taskTitle}". ${taskDescription || ''}`,
      pageUrl: '',
      pageContent: '',
      siteType: 'delegation',
      ...byokPayload(delegateByokConfig),
    }),
  });

  if (!agentRes.ok) {
    if (hudTabId) await hudUpdate(hudTabId, 'plan', 'error', 'AI planning failed');
    throw new Error('Agent process failed');
  }

  const agentData = await agentRes.json();
  const actionType = agentData.action_type;
  if (hudTabId) await hudUpdate(hudTabId, 'plan', 'success', `Plan: ${actionType}`);

  // 3. Execute based on action type
  if (hudTabId) await hudUpdate(hudTabId, 'execute', 'processing');

  if (actionType === 'NAVIGATE' && agentData.action?.url) {
    // Navigate in the current active tab instead of opening a new one
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let navTabId;
    if (activeTab) {
      await chrome.tabs.update(activeTab.id, { url: agentData.action.url, active: true });
      navTabId = activeTab.id;
    } else {
      const newTab = await chrome.tabs.create({ url: agentData.action.url, active: true });
      navTabId = newTab.id;
    }
    await waitForTabLoad(navTabId, 15000);

    // If there's form filling to do, use stageAction (which has its own HUD)
    if (taskDescription && taskDescription.length > 10) {
      if (hudTabId) await hudUpdate(hudTabId, 'execute', 'success', 'Navigated, filling form...');
      const fillResult = await stageAction(navTabId, `${taskTitle}. ${taskDescription}`, 'delegation', activeToken);
      if (fillResult.success) {
        if (hudTabId) setTimeout(() => hudHide(hudTabId), 2000);
        notifyDashboardTabs('TASK_COMPLETE', {
          taskId,
          summary: `Navigated to ${agentData.action.url} and filled ${fillResult.actionsExecuted || 0} fields.`,
        });
        return;
      }
    }

    if (hudTabId) {
      await hudUpdate(hudTabId, 'execute', 'success', `Opened ${new URL(agentData.action.url).hostname}`);
      setTimeout(() => hudHide(hudTabId), 3000);
    }
    notifyDashboardTabs('TASK_COMPLETE', {
      taskId,
      summary: `Navigated to ${agentData.action.url}. Page is ready for your review.`,
    });

  } else if (actionType === 'ORCHESTRATE' && agentData.action?.search_plan) {
    // Shopping/comparison orchestration
    if (hudTabId) await hudUpdate(hudTabId, 'execute', 'processing', 'Searching multiple sites...');
    const orchestrationResult = await runOrchestration(agentData, activeToken);
    if (hudTabId) {
      await hudUpdate(hudTabId, 'execute', 'success', orchestrationResult?.winner ? `Found: ${orchestrationResult.winner.title}` : 'Search complete');
      setTimeout(() => hudHide(hudTabId), 3000);
    }
    notifyDashboardTabs('TASK_COMPLETE', {
      taskId,
      summary: orchestrationResult?.winner
        ? `Found: ${orchestrationResult.winner.title} at ${orchestrationResult.winner.price}`
        : 'Search completed. Check the extension popup for results.',
    });

  } else if (actionType === 'MULTI_STEP' && agentData.action?.steps) {
    // Multi-step execution
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    const totalSteps = agentData.action.steps.length;

    for (let i = 0; i < totalSteps; i++) {
      const step = agentData.action.steps[i];
      if (hudTabId) await hudUpdate(hudTabId, 'execute', 'processing', `Step ${i + 1}/${totalSteps}: ${step.action || step.type || 'executing'}`);
      await handleMessage({
        type: 'execute_action',
        data: { action: step, tabId: tab.id },
      });
      await new Promise(r => setTimeout(r, 1500));
    }

    if (hudTabId) {
      await hudUpdate(hudTabId, 'execute', 'success', `${totalSteps} steps completed`);
      setTimeout(() => hudHide(hudTabId), 3000);
    }
    notifyDashboardTabs('TASK_COMPLETE', {
      taskId,
      summary: `Executed ${totalSteps} steps for "${taskTitle}".`,
    });

  } else {
    // AI gave a recommendation/info response — no action to execute
    if (hudTabId) {
      await hudUpdate(hudTabId, 'execute', 'success', 'Response received');
      setTimeout(() => hudHide(hudTabId), 3000);
    }
    notifyDashboardTabs('TASK_COMPLETE', {
      taskId,
      summary: agentData.response || `Task "${taskTitle}" processed. AI response received.`,
    });
  }
}

// Notify all enhancivity.com tabs (where the dashboard bridge runs)
async function notifyDashboardTabs(type, payload) {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://enhancivity.com/*', 'https://*.enhancivity.com/*', 'http://localhost:3001/*', 'http://localhost:3002/*'] });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type, payload }).catch(() => {});
    }
  } catch {
    // No dashboard tabs open — that's fine
  }
}

// ── Side Panel: Icon Click → Open Side Panel ─────────────────

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (err) {
    console.warn('[Enhancivity] Side panel open failed:', err.message);
  }
});
