// ============================================================
// Enhancivity Background Service Worker — Grand Extension v4.2 (variable-by-default)
// VERSION MARKER: If you see this in service worker console, the latest code is loaded.
console.log('[BG] ===== BACKGROUND v4.2 (variable-by-default) LOADED =====');
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
  // Shopping (+ regional TLDs)
  'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.ca', 'amazon.com.au',
  'amazon.it', 'amazon.es', 'amazon.co.jp', 'amazon.in', 'amazon.com.br', 'amazon.nl',
  'amazon.sg', 'amazon.se', 'amazon.pl', 'amazon.com.mx', 'amazon.ae', 'amazon.sa',
  'ebay.com', 'ebay.co.uk', 'ebay.de', 'ebay.fr', 'ebay.ca', 'ebay.com.au', 'ebay.it', 'ebay.es',
  'etsy.com', 'walmart.com', 'target.com', 'bestbuy.com', 'costco.com', 'newegg.com',
  'aliexpress.com', 'wayfair.com', 'overstock.com', 'zappos.com', 'nordstrom.com', 'macys.com',
  'ikea.com', 'homedepot.com',
  // Travel (+ regional TLDs)
  'expedia.com', 'expedia.de', 'expedia.co.uk', 'expedia.fr',
  'kayak.com', 'kayak.de', 'kayak.co.uk', 'kayak.fr',
  'skyscanner.net', 'skyscanner.de', 'skyscanner.com',
  'booking.com', 'airbnb.com', 'hotels.com', 'priceline.com', 'tripadvisor.com',
  // Jobs
  'indeed.com', 'indeed.de', 'indeed.co.uk', 'indeed.fr',
  'linkedin.com', 'glassdoor.com', 'glassdoor.de', 'monster.com', 'ziprecruiter.com',
  // Freelance
  'fiverr.com', 'upwork.com',
  // Real estate
  'zillow.com', 'rightmove.co.uk', 'redfin.com', 'realtor.com',
  // Cars
  'autotrader.com', 'cargurus.com', 'carmax.com',
  // Productivity & communication
  'mail.google.com', 'slack.com', 'notion.so', 'trello.com', 'asana.com',
  'docs.google.com', 'drive.google.com', 'calendar.google.com',
  'sheets.google.com', 'slides.google.com',
  'outlook.live.com', 'outlook.office.com',
  'excel.cloud.microsoft.com', 'word.new', 'powerpoint.new',
  'office.com', 'office.live.com',
  'github.com', 'youtube.com', 'twitter.com', 'x.com', 'reddit.com',
  // Finance & payments
  'wise.com', 'paypal.com', 'stripe.com', 'dashboard.stripe.com',
  // Dev & infra
  'platform.openai.com', 'openai.com', 'vercel.com', 'netlify.com', 'aws.amazon.com',
  // Search
  'google.com', 'google.de', 'google.co.uk', 'google.fr', 'bing.com',
  // Social & marketplace
  'craigslist.org', 'mercari.com', 'poshmark.com', 'depop.com', 'vinted.com', 'vinted.de', 'vinted.fr',
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
  const { userApiKey, userApiKeyProvider, userIntent, userSelectedModel, userCustomModel, apiMode } = await chrome.storage.local.get([
    'userApiKey', 'userApiKeyProvider', 'userIntent', 'userSelectedModel', 'userCustomModel', 'apiMode'
  ]);
  // If user is on Enhancivity-provided mode, don't send BYOK key even if one is stored
  const isByok = apiMode === 'byok' && userApiKey;
  return {
    userApiKey: isByok ? userApiKey : null,
    userApiKeyProvider: isByok ? (userApiKeyProvider || null) : null,
    userIntent: userIntent || 'balanced',
    userSelectedModel: isByok ? (userSelectedModel || null) : null,
    userCustomModel: isByok ? (userCustomModel || null) : null,
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

      if (snapshot._tabClosed) {
        console.warn('[AuthBridge] Tab closed during login watch — aborting auto-resume');
        watcherCleanedUp = true;
        chrome.webNavigation.onCompleted.removeListener(loginWatcher);
        return;
      }

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

// ── SiteMap Seed: load initial site fingerprints on first install ──
// Runs once per seed version. Sends the static JSON bundle to the backend
// so the SiteMap DB has structure for the Top 100 sites from day one.
async function seedSiteMapIfNeeded() {
  try {
    const SEED_VERSION = '1.0.0';
    const { siteMapSeedVersion } = await chrome.storage.local.get(['siteMapSeedVersion']);
    if (siteMapSeedVersion === SEED_VERSION) return; // Already seeded this version

    const { token } = await chrome.storage.local.get(['token']);
    if (!token) return; // Not logged in yet — will retry on next startup

    // Fetch the seed bundle from the extension package
    const seedUrl = chrome.runtime.getURL('data/sitemap_seed_v1.json');
    const seedRes = await fetch(seedUrl);
    if (!seedRes.ok) { console.warn('[SiteMap] Seed file not found'); return; }
    const seedData = await seedRes.json();

    // Combine entries and platform templates
    const allEntries = [...(seedData.entries || []), ...(seedData.platformTemplates || [])];
    if (allEntries.length === 0) return;

    const res = await fetch(`${API_BASE}/api/sitemap/seed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ entries: allEntries, version: SEED_VERSION }),
    });

    if (res.ok) {
      const result = await res.json();
      console.log(`[SiteMap] Seed v${SEED_VERSION} completed:`, result);
      await chrome.storage.local.set({ siteMapSeedVersion: SEED_VERSION });
    } else {
      console.warn('[SiteMap] Seed API call failed:', res.status);
    }
  } catch (e) {
    console.warn('[SiteMap] Seed failed (non-blocking):', e.message);
  }
}

// Trigger seed check on startup (non-blocking)
setTimeout(seedSiteMapIfNeeded, 5000);

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

// ─── Learning Mode: Navigation Resilience ──────────────────
// Cleanup function for recording nav listeners + keepAlive.
// Set when recording starts, called on stop/cancel.
let learningNavCleanup = null;
let learningPendingSwitch = null;

// ─── Tab Readiness Helper ──────────────────────────────────
// Chrome locks tab APIs during tab drag, tab switch animation, and other
// transient states. This helper polls until the tab is accessible.
// Uses chrome.tabs.get() as a lightweight probe — if it succeeds,
// the tab is ready for scripting/messaging.
async function waitForTabReady(tabId, maxWaitMs = 10000, { requireComplete = false } = {}) {
  const start = Date.now();
  const pollInterval = 500; // check every 500ms
  while (Date.now() - start < maxWaitMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (requireComplete) {
        // Strict mode: wait for tab.status === 'complete' (use after navigation-triggering clicks)
        if (tab && tab.status === 'complete') return { ready: true };
      } else {
        // Default: tab exists and is not discarded
        if (tab && tab.status !== 'unloaded') return { ready: true };
      }
    } catch (err) {
      const msg = err.message || '';
      // "No tab with id" = tab was closed — this is FATAL, not transient
      if (msg.includes('No tab with id')) {
        console.warn(`[waitForTabReady] Tab ${tabId} no longer exists (closed).`);
        return { ready: false, reason: 'TAB_CLOSED' };
      }
      if (msg.includes('cannot be edited') || msg.includes('dragging')) {
        // Transient — wait and retry
        await new Promise(r => setTimeout(r, pollInterval));
        continue;
      }
      // Non-transient error — give up
      return { ready: false, reason: 'TAB_ERROR' };
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }
  console.warn(`[waitForTabReady] Tab ${tabId} not ready after ${maxWaitMs}ms`);
  return { ready: false, reason: 'TIMEOUT' };
}

const PRODUCT_CATEGORY_GROUPS = {
  desktop: ['desktop', 'desktop pc', 'desktop computer', 'tower', 'workstation', 'mini pc', 'all-in-one', 'aio', 'pc', 'computer'],
  laptop: ['laptop', 'notebook', 'ultrabook', 'macbook', 'chromebook'],
};

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectProductCategory(value) {
  const text = normalizeSearchText(value);
  if (!text) return null;

  for (const [name, aliases] of Object.entries(PRODUCT_CATEGORY_GROUPS)) {
    for (const alias of aliases) {
      if (new RegExp(`\\b${escapeRegex(normalizeSearchText(alias))}\\b`, 'i').test(text)) {
        return name;
      }
    }
  }

  return null;
}

function parseNumericPrice(text) {
  if (!text) return null;
  let candidate = String(text).replace(/\s/g, '');
  const match = candidate.match(/(\d[\d.,]*)/);
  if (!match) return null;

  candidate = match[1];
  const lastComma = candidate.lastIndexOf(',');
  const lastDot = candidate.lastIndexOf('.');

  if (lastComma > -1 && lastDot > -1) {
    candidate = lastComma > lastDot
      ? candidate.replace(/\./g, '').replace(',', '.')
      : candidate.replace(/,/g, '');
  } else if (lastComma > -1) {
    const decimalDigits = candidate.length - lastComma - 1;
    candidate = decimalDigits === 2
      ? candidate.replace(/\./g, '').replace(',', '.')
      : candidate.replace(/,/g, '');
  } else {
    candidate = candidate.replace(/,/g, '');
  }

  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBudgetValue(text) {
  if (!text) return null;

  const match = String(text).match(
    /(?:under|below|less than|up to|max(?:imum)?(?: price)?|budget(?: of)?)\s*[:=-]?\s*([$€£]?\s*\d[\d.,]*|\d[\d.,]*\s*(?:usd|eur|gbp|dollars?|euros?|pounds?))/i
  );
  if (match) return parseNumericPrice(match[1]);

  if (/[$€£]|\b(?:usd|eur|gbp|dollars?|euros?|pounds?)\b/i.test(String(text))) {
    return parseNumericPrice(text);
  }

  return null;
}

function inferRequestedObject(searchPlan, userPrompt) {
  if (searchPlan?.object && String(searchPlan.object).trim()) return String(searchPlan.object).trim();

  const sources = [
    userPrompt,
    ...Object.values(searchPlan?.queries || {}),
  ];

  for (const source of sources) {
    const category = detectProductCategory(source);
    if (category) return category;
  }

  return '';
}

function extractBudgetLimit(searchPlan, userPrompt) {
  const sources = [
    searchPlan?.constraints?.maxPrice,
    ...Object.values(searchPlan?.queries || {}),
    userPrompt,
  ];

  for (const source of sources) {
    const parsed = parseBudgetValue(source);
    if (parsed !== null) return parsed;
  }

  return null;
}

function normalizeProductSearchPlan(searchPlan, userPrompt) {
  const normalized = {
    ...searchPlan,
    queries: { ...(searchPlan?.queries || {}) },
    constraints: { ...(searchPlan?.constraints || {}) },
  };

  const requestedObject = inferRequestedObject(normalized, userPrompt);
  if (requestedObject) normalized.object = requestedObject;

  const requestedCategory = detectProductCategory(requestedObject || userPrompt);
  const replacement = requestedObject || requestedCategory || '';

  for (const [site, query] of Object.entries(normalized.queries)) {
    let updated = String(query || '').trim();
    const queryCategory = detectProductCategory(updated);

    if (requestedCategory && queryCategory && queryCategory !== requestedCategory) {
      for (const alias of PRODUCT_CATEGORY_GROUPS[queryCategory]) {
        updated = updated.replace(new RegExp(`\\b${escapeRegex(alias)}\\b`, 'ig'), replacement);
      }
    }

    if (requestedCategory && !detectProductCategory(updated) && replacement) {
      updated = `${replacement} ${updated}`.trim();
    }

    normalized.queries[site] = updated.replace(/\s+/g, ' ').trim();
  }

  if (!normalized.constraints.maxPrice) {
    const budget = extractBudgetLimit(normalized, userPrompt);
    if (budget !== null) normalized.constraints.maxPrice = String(budget);
  }

  return normalized;
}

function resultMatchesRequestedProduct(title, searchPlan, userPrompt) {
  const requestedCategory = detectProductCategory(searchPlan?.object || userPrompt);
  if (!requestedCategory) return true;

  const titleCategory = detectProductCategory(title);
  if (titleCategory && titleCategory !== requestedCategory) return false;

  const normalizedTitle = normalizeSearchText(title);
  return PRODUCT_CATEGORY_GROUPS[requestedCategory].some(alias => normalizedTitle.includes(normalizeSearchText(alias)));
}

function filterSearchResults(siteResults, searchPlan, userPrompt) {
  const budgetLimit = extractBudgetLimit(searchPlan, userPrompt);

  return (siteResults || []).filter((item) => {
    if (budgetLimit !== null) {
      const parsedPrice = parseNumericPrice(item?.price);
      if (parsedPrice !== null && parsedPrice > budgetLimit) return false;
    }

    return resultMatchesRequestedProduct(item?.title || '', searchPlan, userPrompt);
  });
}

async function waitForReplayReady(tabId, maxWaitMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'ping_replay' });
      if (response?.alive) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

async function ensureReplayScriptReady(tabId, { forceReinject = false, waitMs = 2000 } = {}) {
  if (!forceReinject) {
    try {
      const existing = await chrome.tabs.sendMessage(tabId, { type: 'ping_replay' });
      if (existing?.alive) return { success: true, reused: true };
    } catch {}
  }

  try {
    if (forceReinject) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { window.__enhReplayInjected = false; },
      }).catch(() => {});
    }

    // Inject shared consequential actions module first (dependency)
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['consequential_actions.js'],
    }).catch(() => {}); // Non-fatal — content_replay.js has inline fallback
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content_replay.js'],
    });
  } catch (injectErr) {
    return { success: false, error: injectErr.message };
  }

  const ready = await waitForReplayReady(tabId, waitMs);
  if (!ready) {
    return { success: false, error: 'Replay engine did not become ready on this page.' };
  }

  return { success: true, reused: false };
}

async function resolveReplayStartTab(recipe, fallbackTabId = null) {
  const startUrl = recipe?.startUrl || recipe?.urlPattern;
  if (!startUrl) {
    if (fallbackTabId) return { tabId: fallbackTabId, navigated: false };
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return activeTab?.id ? { tabId: activeTab.id, navigated: false } : { tabId: null, navigated: false };
  }

  let startDomain = '';
  let startPath = '';
  try {
    const parsed = new URL(startUrl);
    startDomain = parsed.hostname.replace(/^www\./, '').toLowerCase();
    startPath = parsed.pathname;
  } catch {
    return fallbackTabId ? { tabId: fallbackTabId, navigated: false } : { tabId: null, navigated: false };
  }

  let targetTabId = fallbackTabId;
  let targetTab = null;

  if (targetTabId) {
    try {
      targetTab = await chrome.tabs.get(targetTabId);
    } catch {
      targetTab = null;
    }
  }

  const currentDomain = targetTab?.url ? (() => {
    try { return new URL(targetTab.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
  })() : '';

  if (!targetTab || currentDomain !== startDomain) {
    targetTabId = await findTabByDomain(startDomain, startUrl);
    if (!targetTabId) return { tabId: null, navigated: false };
    targetTab = await chrome.tabs.get(targetTabId).catch(() => null);
  }

  if (!targetTab) return { tabId: null, navigated: false };

  await chrome.tabs.update(targetTabId, { active: true });
  if (targetTab.windowId) {
    await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {});
  }

  let navigated = false;
  try {
    const currentUrl = targetTab.url || '';
    const currentParsed = new URL(currentUrl);
    const currentTabDomain = currentParsed.hostname.replace(/^www\./, '').toLowerCase();
    const currentTabPath = currentParsed.pathname;

    if (currentTabDomain !== startDomain) {
      // Completely different domain — navigate immediately, no probe
      console.log('[Learning] Different domain — navigating to:', startUrl);
      await chrome.tabs.update(targetTabId, { url: startUrl });
      await waitForTabLoad(targetTabId, 10000, 400);
      await new Promise(r => setTimeout(r, 350));
      navigated = true;
    } else if (currentTabPath !== startPath || currentUrl !== startUrl) {
      // Same domain, different path (SPA case) — probe first
      // If the first step's element already exists on this page, skip navigation entirely
      const probe = await probeFirstStepElement(targetTabId, recipe);
      if (probe.found) {
        console.log('[Learning] Probe found first step element on current page — skipping navigation');
        // Element exists here — no navigation needed, saves 1-2 seconds
      } else {
        console.log('[Learning] Probe: element not found — navigating to startUrl:', startUrl);
        await chrome.tabs.update(targetTabId, { url: startUrl });
        await waitForTabLoad(targetTabId, 10000, 400);
        await new Promise(r => setTimeout(r, 350));
        navigated = true;
      }
    }
  } catch {}

  return { tabId: targetTabId, navigated };
}

// ─── Probe: check if the first step's element exists on the current page ──
// Used by resolveReplayStartTab to skip unnecessary navigation on SPAs.
// Returns { found: true/false }. Never executes any action.
async function probeFirstStepElement(tabId, recipe) {
  // Find the first real DOM action (skip navigate, wait, scroll)
  const firstActionStep = recipe.steps?.find(s =>
    s.action?.type !== 'navigate' && s.action?.type !== 'wait' && s.action?.type !== 'scroll'
  );
  if (!firstActionStep?.action?.selectors?.length) return { found: false };

  // Ensure content_replay.js is injected (reuses existing helper)
  const readyResult = await ensureReplayScriptReady(tabId, { waitMs: 1500 });
  if (!readyResult.success) return { found: false };

  // Send probe with 2-second cap
  try {
    const result = await Promise.race([
      chrome.tabs.sendMessage(tabId, {
        type: 'replay_probe',
        selectors: firstActionStep.action.selectors,
        description: firstActionStep.action.description,
        semanticContext: firstActionStep.action.semanticContext,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('probe_timeout')), 2000))
    ]);
    return { found: !!result?.found };
  } catch {
    return { found: false };
  }
}

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
  // Route consent through chrome.storage.session instead of chrome.tabs.sendMessage.
  // Reason: the exploration loop awaits this function while the user decides. Chrome
  // MV3 suspends service workers during inactivity — a sendMessage-based Promise is
  // dropped silently when the SW is suspended, so the loop never resumes after the
  // user clicks "Approve". chrome.storage.onChanged WAKES a suspended SW, making
  // the consent handshake lifecycle-safe regardless of how long the user takes.
  const requestId = `consent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const resultKey = `hudConsentResult_${requestId}`;

  // 1. Write pending request — content script reads this to show the overlay
  await chrome.storage.session.set({
    hudConsentPending: { tabId, message, targetSelector, requestId, ts: Date.now() },
  }).catch(() => {});

  // 2. Notify the content script (fire-and-forget — no response needed)
  chrome.tabs.sendMessage(tabId, { type: 'hud_consent', message, targetSelector, requestId }).catch(() => {});

  // 3. Wait for the result via storage.onChanged — wakes the SW even if suspended
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve({ approved: false, reason: 'timeout' });
    }, 120000); // 2-minute safety timeout

    function cleanup() {
      clearTimeout(timer);
      chrome.storage.onChanged.removeListener(listener);
      chrome.storage.session.remove(['hudConsentPending', resultKey]).catch(() => {});
    }

    function listener(changes, area) {
      if (area !== 'session' || !changes[resultKey]) return;
      cleanup();
      resolve(changes[resultKey].newValue || { approved: false });
    }

    chrome.storage.onChanged.addListener(listener);

    // Race-condition guard: result may already be written before listener attached
    chrome.storage.session.get([resultKey]).then(d => {
      if (d[resultKey]) { cleanup(); resolve(d[resultKey]); }
    }).catch(() => {});
  });
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

// ── DOM Stability Check ──────────────────────────────────────
// Polls the content script for a lightweight DOM fingerprint every
// `intervalMs`. Resolves as soon as two consecutive fingerprints
// match (page stopped changing) or `maxWaitMs` is exceeded.
// Falls back to a fixed delay if fingerprinting fails (e.g. page
// blocks script injection). Much faster than hardcoded waits on
// fast pages, and more reliable on slow SPA pages.
async function waitForDomStable(tabId, maxWaitMs = 3000, intervalMs = 300) {
  const minWaitMs = 150; // always wait at least this long
  await new Promise(r => setTimeout(r, minWaitMs));

  let prevFingerprint = null;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const fp = await chrome.tabs.sendMessage(tabId, {
        type: 'explore_action',
        actionType: 'dom_fingerprint',
      });

      if (fp?.success && fp.fingerprint) {
        if (prevFingerprint !== null && fp.fingerprint === prevFingerprint) {
          return; // DOM is stable — done
        }
        prevFingerprint = fp.fingerprint;
      }
    } catch {
      // Content script not available (page navigated, restricted page, etc.)
      // Fall through to fixed delay below
      break;
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }

  // If we broke out early (script unavailable), wait remaining time as fixed delay
  const remaining = deadline - Date.now();
  if (remaining > 0) {
    await new Promise(r => setTimeout(r, remaining));
  }
}

// ── Post-Click DOM Change Detection ─────────────────────────
// Polls dom_fingerprint every intervalMs until it DIFFERS from baseline.
// Called after click_element to detect that the page has actually responded.
// CSS-only clicks (spinner added, class toggled) leave the fingerprint
// identical — waitForDomStable would exit immediately at ~450ms, causing the
// next snapshot to capture the spinner state instead of loaded content.
// Once the fingerprint shifts, waitForDomStable (inside takePageSnapshot)
// takes over to wait for full stability.
async function waitForDomChange(tabId, baseline, maxWaitMs = 2000, intervalMs = 100) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const result = await chrome.tabs.sendMessage(tabId, {
        type: 'explore_action',
        actionType: 'dom_fingerprint',
      });
      if (result?.fingerprint && result.fingerprint !== baseline) {
        console.log('[Explore] waitForDomChange: DOM responded after click (fingerprint shifted)');
        return { changed: true };
      }
    } catch (_) {
      // Content script dead — treat as changed (SPA nav probably fired)
      return { changed: true };
    }
  }
  console.log('[Explore] waitForDomChange: no DOM change within', maxWaitMs, 'ms — CSS-only click or slow page');
  return { changed: false };
}

// ── Response Timeout ────────────────────────────────────────
// Wraps chrome.tabs.sendMessage in Promise.race against a timeout.
// Prevents orphaned async handlers (type_text, press_key, wait) from
// hanging forever when a SPA re-render kills the content script mid-execution.
const RESPONSE_TIMEOUT_MS = 15000; // 15s — covers type_text 3-tier cascade + wait action

async function sendWithTimeout(tabId, message, timeoutMs = RESPONSE_TIMEOUT_MS) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('RESPONSE_TIMEOUT')), timeoutMs)
    ),
  ]);
}

// ── Ping-Confirmed Readiness ────────────────────────────────
// Replaces fixed 400ms waits. Polls explore_ping every 100ms until
// the content script confirms { alive: true } or maxWaitMs expires.
// On stable sites (Facebook), first ping returns instantly (faster than 400ms).
// On aggressive SPAs (Reddit), waits up to 3s for React hydration.
async function waitForPing(tabId, maxWaitMs = 3000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { type: 'explore_ping' });
      if (pong?.alive) return true;
    } catch {
      // Script not ready yet — keep polling
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

// ── Injection Guard ─────────────────────────────────────────
// Prevents redundant chrome.scripting.executeScript calls when multiple
// callers (SPA nav listener + ensureContentScriptReady) try to inject
// into the same tab concurrently. Second caller awaits the first's result.
const _pendingInjections = new Map(); // tabId → Promise<boolean>

// Scripts that depend on the shared consequential_actions.js module.
// When injecting these, we inject the dependency first.
const _CONSEQUENTIAL_DEPENDENTS = new Set(['content_explore.js', 'content_replay.js', 'content_learning.js']);

async function injectAndConfirm(tabId, scriptFile = 'content_explore.js') {
  const existing = _pendingInjections.get(tabId);
  if (existing) {
    console.log(`[safeSendMessage] Injection already in-flight for tab ${tabId}, awaiting...`);
    return existing;
  }

  const injectionPromise = (async () => {
    try {
      // Inject shared consequential actions module first if this script depends on it
      if (_CONSEQUENTIAL_DEPENDENTS.has(scriptFile)) {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['consequential_actions.js'],
        }).catch(() => {}); // Non-fatal — content scripts have inline fallbacks
      }
      // Inject Universal Interaction Engine before content scripts that use it
      // (content_explore.js type_text, content_actions.js fill_field).
      // Has double-injection guard — safe to inject multiple times.
      if (scriptFile === 'content_explore.js') {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['interaction-engine.js'],
        }).catch(() => {}); // Non-fatal — content scripts fall through to legacy code
      }
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [scriptFile],
      });
    } catch (injectErr) {
      console.warn(`[safeSendMessage] Cannot inject ${scriptFile} into tab ${tabId}: ${injectErr.message}`);
      return false;
    }
    const ready = await waitForPing(tabId, 3000, 100);
    if (!ready) {
      console.warn(`[safeSendMessage] ${scriptFile} injected but never responded to ping on tab ${tabId}`);
    }
    return ready;
  })();

  _pendingInjections.set(tabId, injectionPromise);
  try {
    return await injectionPromise;
  } finally {
    _pendingInjections.delete(tabId);
  }
}

// ── Safe Message Sender ─────────────────────────────────────
// Wraps chrome.tabs.sendMessage with timeout protection, automatic
// re-injection via injectAndConfirm (ping-confirmed readiness), and retry.
// If the content script's async handler dies mid-execution (orphaned promise),
// the timeout fires, triggers re-injection, and re-dispatches the same action.
async function safeSendMessage(tabId, message, scriptFile = 'content_explore.js') {
  const CHANNEL_DEAD_ERRORS = [
    'Could not establish connection',
    'Receiving end does not exist',
    'message port closed',
    'Message Channel Closed',
    'Extension context invalidated',
  ];

  function isChannelDead(err) {
    const msg = err?.message || String(err);
    return CHANNEL_DEAD_ERRORS.some(e => msg.includes(e));
  }

  function isTimeout(err) {
    return (err?.message || '').includes('RESPONSE_TIMEOUT');
  }

  // Attempt 1: send with timeout protection (prevents orphaned async handler hangs)
  try {
    const result = await sendWithTimeout(tabId, message);
    if (result !== undefined) return result;
    // undefined = no listener caught it — fall through to re-inject
  } catch (err) {
    if (isTimeout(err)) {
      console.warn(`[safeSendMessage] Response timeout on tab ${tabId} for ${message.actionType || message.type}. Re-injecting...`);
    } else if (isChannelDead(err)) {
      console.warn(`[safeSendMessage] Channel dead on tab ${tabId}: ${err.message}. Re-injecting ${scriptFile}...`);
    } else {
      throw err; // Non-channel, non-timeout error — bubble up
    }
  }

  // Re-inject with ping-confirmed readiness (replaces fixed 400ms wait)
  const ready = await injectAndConfirm(tabId, scriptFile);
  if (!ready) {
    return {
      success: false,
      error: `Cannot inject or confirm ${scriptFile} on tab ${tabId}`,
      errorType: 'INJECTION_FAILED',
    };
  }

  // Attempt 2: retry with timeout protection
  try {
    const result = await sendWithTimeout(tabId, message);
    if (result !== undefined) return result;
    return { success: false, error: 'No response after re-injection', errorType: 'NO_RESPONSE' };
  } catch (retryErr) {
    if (isTimeout(retryErr)) {
      return {
        success: false,
        error: `Response timeout after re-injection (tab ${tabId}, action: ${message.actionType || message.type})`,
        errorType: 'RESPONSE_TIMEOUT',
      };
    }
    return {
      success: false,
      error: `Message failed after re-injection: ${retryErr.message}`,
      errorType: 'CHANNEL_DEAD',
    };
  }
}

/**
 * Proactive readiness check: pings content_explore.js on a tab.
 * If the script isn't alive, injects it via injectAndConfirm (ping-confirmed).
 * Returns true if the script is ready, false if injection failed.
 */
async function ensureContentScriptReady(tabId) {
  // Step 1: Ping the existing script (with short timeout — ping should be instant)
  try {
    const pong = await sendWithTimeout(tabId, { type: 'explore_ping' }, 2000);
    if (pong?.alive) return true;
  } catch {
    // No listener, timeout, or channel dead — need injection
  }

  // Step 2: Inject and confirm via ping loop (replaces fixed 400ms wait)
  return injectAndConfirm(tabId, 'content_explore.js');
}

async function updateOrchestrationProgress(phase, detail) {
  await chrome.storage.local.set({
    orchestrationProgress: { phase, detail, timestamp: Date.now() }
  });
}

// ── Self-Healing: Homepage Probe ─────────────────────────────
// When a skill-based search fails repeatedly, this function:
//   1. Opens the site's homepage in a hidden tab
//   2. Injects the semantic scraper to find search-related elements
//   3. Discovers the real search URL from form actions or search inputs
//   4. Sends the verified URL to the backend to overwrite the broken skill
//
// Runs asynchronously (fire-and-forget) so it never blocks the current search.
// The NEXT search on this site will use the healed URL.

async function probeAndHealSkill(skillId, domain, token) {
  const TAG = `[SELF-HEAL] ${domain}`;
  let probeTab = null;

  try {
    console.log(`${TAG} Starting homepage probe...`);
    const homepageUrl = `https://www.${domain}`;

    // Open hidden tab to the homepage
    probeTab = await chrome.tabs.create({ url: homepageUrl, active: false });
    await waitForTabLoad(probeTab.id, 12000);

    // Inject a lightweight probe script that finds search-related DOM elements
    const probeResult = await chrome.scripting.executeScript({
      target: { tabId: probeTab.id },
      func: () => {
        // ── Discovery Strategy (runs in page context) ──
        // Look for search forms, search inputs, and search-related links
        // to discover the site's actual search URL pattern.

        const discoveries = [];

        // Strategy 1: Find <form> elements with search-related attributes
        const forms = document.querySelectorAll('form');
        for (const form of forms) {
          const action = form.getAttribute('action') || '';
          const role = form.getAttribute('role') || '';
          const id = (form.id || '').toLowerCase();
          const cls = (form.className || '').toLowerCase();

          const isSearchForm = role === 'search'
            || id.includes('search') || cls.includes('search')
            || action.includes('search') || action.includes('/s?')
            || action.includes('/s/')
            || id.includes('query') || cls.includes('query');

          if (isSearchForm && action) {
            // Find the search input name within this form
            const inputs = form.querySelectorAll('input[type="text"], input[type="search"], input:not([type])');
            for (const inp of inputs) {
              const name = inp.getAttribute('name');
              if (name) {
                discoveries.push({
                  method: 'probe_form_action',
                  formAction: action,
                  paramName: name,
                  formRole: role,
                  formId: form.id || '',
                });
              }
            }
          }
        }

        // Strategy 2: Find standalone search inputs (not inside a form with action)
        const searchInputs = document.querySelectorAll(
          'input[type="search"], input[name*="search"], input[name*="query"], input[name="q"], input[name="k"], input[name="keyword"], input[name="keywords"], input[aria-label*="search" i], input[placeholder*="search" i]'
        );
        for (const inp of searchInputs) {
          const name = inp.getAttribute('name');
          const form = inp.closest('form');
          const formAction = form?.getAttribute('action') || '';
          if (name) {
            discoveries.push({
              method: formAction ? 'probe_search_input' : 'probe_input_no_form',
              formAction,
              paramName: name,
              inputType: inp.type || 'text',
              placeholder: (inp.placeholder || '').substring(0, 50),
            });
          }
        }

        // Strategy 3: Find search-related links in the page (e.g., "search?q=" in href)
        const links = document.querySelectorAll('a[href*="search"], a[href*="/s?"], a[href*="query="]');
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          if (href.includes('=')) {
            discoveries.push({
              method: 'probe_link_pattern',
              href: href.substring(0, 200),
              text: (link.textContent || '').trim().substring(0, 50),
            });
          }
        }

        // Return final URL of the page (in case of redirects) + discoveries
        return {
          finalUrl: window.location.href,
          origin: window.location.origin,
          discoveries,
        };
      },
    });

    const probe = probeResult?.[0]?.result;
    if (!probe || !probe.discoveries || probe.discoveries.length === 0) {
      console.log(`${TAG} No search elements found on homepage. Probe failed gracefully.`);
      return false;
    }

    console.log(`${TAG} Found ${probe.discoveries.length} search-related elements`);

    // Pick the best discovery and build a verified search URL template
    let verifiedUrl = null;
    let method = 'probe_unknown';

    for (const d of probe.discoveries) {
      if (d.method === 'probe_form_action' && d.formAction && d.paramName) {
        // Best signal: a form with role="search" or search-related action
        let base = d.formAction;
        // Handle relative URLs
        if (base.startsWith('/')) {
          base = probe.origin + base;
        } else if (!base.startsWith('http')) {
          base = probe.origin + '/' + base;
        }
        // Build template: replace or append the query parameter
        const url = new URL(base);
        url.searchParams.set(d.paramName, '{query}');
        verifiedUrl = decodeURIComponent(url.toString());
        method = d.method;
        break;
      }

      if (d.method === 'probe_search_input' && d.formAction && d.paramName) {
        let base = d.formAction;
        if (base.startsWith('/')) base = probe.origin + base;
        else if (!base.startsWith('http')) base = probe.origin + '/' + base;
        const url = new URL(base);
        url.searchParams.set(d.paramName, '{query}');
        verifiedUrl = decodeURIComponent(url.toString());
        method = d.method;
        break;
      }
    }

    // Fallback: if we found inputs with names but no form action, try common patterns
    if (!verifiedUrl) {
      const inputDiscovery = probe.discoveries.find(d => d.paramName);
      if (inputDiscovery) {
        verifiedUrl = `${probe.origin}/search?${inputDiscovery.paramName}={query}`;
        method = 'probe_fallback_input';
      }
    }

    if (!verifiedUrl) {
      console.log(`${TAG} Could not construct verified URL from discoveries. Probe inconclusive.`);
      return false;
    }

    console.log(`${TAG} Discovered verified URL: ${verifiedUrl} (method: ${method})`);

    // Send the verified URL to the backend to overwrite the broken skill
    const regenRes = await fetch(`${API_BASE}/api/skills/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ skillId, verifiedSearchUrl: verifiedUrl, method }),
    });

    if (!regenRes.ok) {
      const err = await regenRes.json().catch(() => ({}));
      console.warn(`${TAG} Backend rejected regeneration:`, err.error);
      return false;
    }

    const result = await regenRes.json();
    console.log(`${TAG} SELF-HEALED! New URL: ${result.skill?.searchUrl} (confidence: ${result.skill?.confidence})`);
    return true;

  } catch (err) {
    console.warn(`${TAG} Probe failed (non-fatal):`, err.message);
    return false;
  } finally {
    // Always clean up the probe tab
    if (probeTab?.id) {
      await chrome.tabs.remove(probeTab.id).catch(() => {});
    }
  }
}

/**
 * Check if a failed skill should be self-healed, and trigger probe if yes.
 * Fire-and-forget — never blocks the caller.
 *
 * @param {string} skillId - The skill that just failed
 * @param {string} domain - Domain for logging
 * @param {string} token - Auth token for API calls
 */
function triggerSelfHealingCheck(skillId, domain, token) {
  // Entire flow is async and non-blocking
  (async () => {
    try {
      const checkRes = await fetch(`${API_BASE}/api/skills/should-regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ skillId }),
      });

      if (!checkRes.ok) return;
      const check = await checkRes.json();

      if (!check.shouldRegenerate) {
        console.log(`[SELF-HEAL] ${domain}: no regen needed (${check.reason})`);
        return;
      }

      console.log(`[SELF-HEAL] ${domain}: regeneration triggered (${check.reason})`);
      const healed = await probeAndHealSkill(skillId, check.domain || domain, token);
      if (healed) {
        console.log(`[SELF-HEAL] ${domain}: healed successfully — next search will use verified URL`);
      }
    } catch (err) {
      console.warn(`[SELF-HEAL] ${domain}: check failed (non-fatal):`, err.message);
    }
  })();
}

// --- Semantic Search Tab: inject semantic scraper → parse-intent API ---

async function spawnSearchTab(site, query, category, token) {
  let url;
  let skillId = null; // Track for Skill Engine outcome recording

  const urlBuilder = SEARCH_URLS[site];
  if (urlBuilder) {
    // Known site — use hardcoded builder (fast path)
    url = urlBuilder(query);

    // ── Regional Domain Detection ──
    // For sites with regional variants (amazon.com.be, amazon.de, ebay.co.uk, etc.),
    // detect the user's actual regional domain from their open tabs and swap the URL.
    // This prevents redirect loops and country-picker interstitials.
    if (site === 'amazon' || site === 'ebay') {
      try {
        const regionPattern = site === 'amazon'
          ? /amazon\.(com\.be|com\.au|co\.uk|co\.jp|de|fr|it|es|ca|com\.mx|com\.br|nl|pl|se|sg|in|sa|ae|com)/
          : /ebay\.(com\.au|co\.uk|de|fr|it|es|ca|com)/;
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) {
          if (!t.url) continue;
          const match = t.url.match(regionPattern);
          if (match) {
            const regionalDomain = `${site}.${match[1]}`;
            const originalDomain = site === 'amazon' ? 'www.amazon.com' : 'www.ebay.com';
            url = url.replace(originalDomain, `www.${regionalDomain}`);
            console.log(`[Ghost-Driver] ${site}: regional domain detected from open tab → ${regionalDomain}`);
            break;
          }
        }
      } catch (e) {
        // Non-blocking — fall back to default .com URL
        console.warn(`[Ghost-Driver] ${site}: regional detection failed, using .com`);
      }
    }
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
        // Self-healing: check if this skill needs regeneration (fire-and-forget)
        triggerSelfHealingCheck(skillId, site, token);
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
      const searchSucceeded = results.length > 0;
      fetch(`${API_BASE}/api/skills/record-outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ skillId, success: searchSucceeded }),
      }).catch(err => console.warn(`[Ghost-Driver] Failed to record skill outcome:`, err.message));
      // Self-healing: if search returned 0 results, check if skill needs regeneration
      if (!searchSucceeded) {
        triggerSelfHealingCheck(skillId, site, token);
      }
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
      // Self-healing: check if this skill needs regeneration (fire-and-forget)
      triggerSelfHealingCheck(skillId, site, token);
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
    const normalizedPlan = normalizeProductSearchPlan(searchPlan, userPrompt);
    await updateOrchestrationProgress('searching', `Searching ${normalizedPlan.sites.length} sites...`);

    // Parallel search across all sites (now using semantic scraper)
    const searchPromises = normalizedPlan.sites.map(site => {
      const query = normalizedPlan.queries[site] || normalizedPlan.queries.default || userPrompt;
      return spawnSearchTab(site, query, normalizedPlan.category, token);
    });

    const searchResults = await Promise.allSettled(searchPromises);

    // Collect successful results
    const allResults = searchResults
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      .map(r => ({
        ...r,
        results: filterSearchResults(r.results || [], normalizedPlan, userPrompt),
      }))
      .filter(r => r.results && r.results.length > 0);

    if (allResults.length === 0) {
      await updateOrchestrationProgress('error', 'No matching products stayed within the requested constraints.');
      return { success: false, error: 'No products matched your requested type and budget. Try raising the budget or broadening the search.' };
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
        criteria: normalizedPlan.criteria,
        category: normalizedPlan.category,
        userPrompt,
        searchPlan: normalizedPlan,
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

// --- PARALLEL_EXPLORE: Multi-tab orchestration loop ---
// Switches between visible tabs to type input, polls for completion, collects results, synthesizes.

async function updateParallelExploreProgress(phase, tabStates) {
  const tabs = tabStates.map(s => ({
    label: s.label, status: s.status, tabId: s.tabId || null,
  }));
  await chrome.storage.session.set({
    parallelExploreProgress: { phase, tabs, timestamp: Date.now() },
  });
}

async function updateReplayActivity(activity = {}) {
  await chrome.storage.session.set({
    replayActivity: {
      active: true,
      mode: 'recipe_replay',
      ...activity,
      timestamp: Date.now(),
    },
  });
}

async function clearReplayActivity(status = 'idle') {
  await chrome.storage.session.set({
    replayActivity: {
      active: false,
      status,
      timestamp: Date.now(),
    },
  });
}

// Simple string hash for content comparison (not cryptographic — just for change detection)
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash;
}

async function runParallelExplore(parallelPlan, userPrompt, token) {
  const startedAt = Date.now();
  let creditsUsed = 0;

  // Service worker keepalive (prevents Chrome from killing us)
  const keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);

  try {
    // ── Phase 1: Resolve Tabs ──────────────────────────────────
    console.log('[ParallelExplore] Phase 1: Resolving tabs...');
    await updateParallelExploreProgress('resolving', []);

    const allTabs = await chrome.tabs.query({});
    const tabStates = [];

    for (const entry of parallelPlan.tabs) {
      let match = null;

      // forceNewChat: skip tab matching entirely — always open fresh tab
      if (entry.forceNewChat && entry.url) {
        try {
          match = await chrome.tabs.create({ url: entry.url, active: false });
          await waitForTabLoad(match.id, 15000);
          console.log(`[ParallelExplore] Opened NEW CHAT tab for "${entry.label}": ${entry.url} (forceNewChat=true)`);
        } catch (tabErr) {
          console.warn(`[ParallelExplore] Failed to open new chat tab for "${entry.label}":`, tabErr.message);
        }
      } else {
        // Find by URL substring or title match
        match = allTabs.find(t => t.url && t.url.includes(entry.tabHint));
        if (!match) {
          match = allTabs.find(t => t.title && t.title.toLowerCase().includes(entry.tabHint.toLowerCase()));
        }
        // Fallback: open new tab if URL provided
        if (!match && entry.url) {
          try {
            match = await chrome.tabs.create({ url: entry.url, active: false });
            await waitForTabLoad(match.id, 15000);
            console.log(`[ParallelExplore] Opened new tab for "${entry.label}": ${entry.url}`);
          } catch (tabErr) {
            console.warn(`[ParallelExplore] Failed to open tab for "${entry.label}":`, tabErr.message);
          }
        }
      }

      if (!match) {
        tabStates.push({
          label: entry.label, status: 'error', error: `Tab not found (hint: "${entry.tabHint}")`,
          tabId: null, input: entry.input, inputTarget: entry.inputTarget,
          fingerprint: null, stableCount: 0, result: null, url: null,
        });
        console.warn(`[ParallelExplore] Tab not found for "${entry.label}" (hint: "${entry.tabHint}")`);
        continue;
      }

      tabStates.push({
        label: entry.label, status: 'pending', error: null,
        tabId: match.id, input: entry.input, inputTarget: entry.inputTarget,
        fingerprint: null, baselineFingerprint: null, baselineContentHash: null,
        stableCount: 0, result: null, url: match.url || entry.url || '',
      });
      console.log(`[ParallelExplore] Resolved "${entry.label}" → tabId ${match.id} (${match.url})`);
    }

    const pendingTabs = tabStates.filter(s => s.status === 'pending');
    if (pendingTabs.length < 2) {
      const found = pendingTabs.map(s => s.label).join(', ') || 'none';
      const missing = tabStates.filter(s => s.status === 'error').map(s => `${s.label} (${s.error})`).join(', ');
      clearInterval(keepAlive);
      return {
        success: false,
        error: `Need at least 2 tabs but only found: ${found}. Missing: ${missing}. Please open the missing tabs and try again.`,
      };
    }

    await updateParallelExploreProgress('dispatching', tabStates);

    // ── Phase 2: Dispatch Input ────────────────────────────────
    // Sequential — typing requires the active tab
    console.log(`[ParallelExplore] Phase 2: Dispatching input to ${pendingTabs.length} tabs...`);

    for (const state of tabStates) {
      if (state.status !== 'pending') continue;

      try {
        // Activate the tab
        await chrome.tabs.update(state.tabId, { active: true });
        await waitForTabReady(state.tabId, 15000);
        await waitForDomStable(state.tabId, 2000, 300);

        // Inject content_explore.js
        await injectAndConfirm(state.tabId, 'content_explore.js');

        // Capture baseline fingerprint BEFORE typing (for false-ready detection)
        try {
          const baselineFp = await safeSendMessage(state.tabId, {
            type: 'explore_action', actionType: 'dom_fingerprint',
          }).catch(() => null);
          if (baselineFp?.fingerprint) {
            state.baselineFingerprint = baselineFp.fingerprint;
          }
          // Hash the main content to detect if it changes after submission
          const baselineSnap = await takePageSnapshot(state.tabId);
          if (baselineSnap?.mainContent) {
            state.baselineContentHash = simpleHash(baselineSnap.mainContent.slice(0, 4000));
          }
        } catch (bErr) {
          console.warn(`[ParallelExplore] Baseline capture failed for "${state.label}":`, bErr.message);
        }

        // Take snapshot to find input field
        const snapshot = await takePageSnapshot(state.tabId);
        if (snapshot._tabClosed) {
          state.status = 'error';
          state.error = 'Tab was closed';
          await updateParallelExploreProgress('dispatching', tabStates);
          continue;
        }

        // Call explore-step to figure out where to type and how to submit
        const stepByokConfig = await getByokConfig();
        const stepGoal = `Type the following text into the main input field and submit it: "${state.input}"${state.inputTarget ? `. The input field hint: "${state.inputTarget}"` : ''}. After typing, press Enter or click the submit/send button.`;

        const stepRes = await fetch(`${API_BASE}/api/agent/explore-step`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            goal: stepGoal,
            strategy: 'Find the main text input, type the question, and submit.',
            stepNumber: 1,
            maxSteps: 4,
            previousActions: [],
            currentPageState: snapshot,
            ...byokPayload(stepByokConfig),
          }),
        });

        if (!stepRes.ok) {
          console.warn(`[ParallelExplore] Explore-step failed for "${state.label}": HTTP ${stepRes.status}`);
          state.status = 'error';
          state.error = `AI step failed (HTTP ${stepRes.status})`;
          creditsUsed += 0.3;
          await updateParallelExploreProgress('dispatching', tabStates);
          continue;
        }

        const stepData = await stepRes.json();
        creditsUsed += 0.3; // PARALLEL_EXPLORE_STEP

        // Execute up to 4 micro-steps (type + enter + maybe dismiss dialog)
        let actionsExecuted = 0;
        let currentAction = stepData.nextAction;

        for (let microStep = 0; microStep < 4 && currentAction; microStep++) {
          console.log(`[ParallelExplore] "${state.label}" micro-step ${microStep}: ${currentAction.type} ${currentAction.target || ''}`);

          const actionResult = await executeExploreActionWithHistory(state.tabId, currentAction, token, microStep + 1);
          actionsExecuted++;

          if (!actionResult.success) {
            console.warn(`[ParallelExplore] "${state.label}" action failed:`, actionResult.error);
            break;
          }

          // If AI said goal is complete after this action, stop
          if (stepData.isGoalComplete) break;

          // For the first step (usually type_text), follow up with press_key Enter
          if (microStep === 0 && currentAction.type === 'type_text') {
            currentAction = { type: 'press_key', value: 'Enter', description: 'Submit the input' };
          } else if (microStep === 1 && currentAction.type === 'press_key') {
            // After pressing Enter, we're done dispatching to this tab
            break;
          } else {
            // Get next action from AI if needed
            const nextSnapshot = await takePageSnapshot(state.tabId);
            const nextStepRes = await fetch(`${API_BASE}/api/agent/explore-step`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({
                goal: stepGoal,
                strategy: 'Continue: type the question and submit.',
                stepNumber: microStep + 2,
                maxSteps: 4,
                previousActions: [{ step: microStep, action: currentAction, result: { success: actionResult.success } }],
                currentPageState: nextSnapshot,
                ...byokPayload(stepByokConfig),
              }),
            });
            if (nextStepRes.ok) {
              const nextData = await nextStepRes.json();
              creditsUsed += 0.3;
              currentAction = nextData.nextAction;
              if (nextData.isGoalComplete) break;
            } else {
              break;
            }
          }
        }

        state.status = actionsExecuted > 0 ? 'dispatched' : 'error';
        if (state.status === 'error') state.error = 'No actions executed';
        state.url = snapshot.url;

        console.log(`[ParallelExplore] "${state.label}" dispatched (${actionsExecuted} actions)`);
        await updateParallelExploreProgress('dispatching', tabStates);

        // Brief pause before switching to next tab
        await new Promise(r => setTimeout(r, 500));

      } catch (dispatchErr) {
        console.error(`[ParallelExplore] Dispatch error for "${state.label}":`, dispatchErr);
        state.status = 'error';
        state.error = dispatchErr.message || 'Dispatch failed';
        await updateParallelExploreProgress('dispatching', tabStates);
      }
    }

    // Check we still have enough dispatched tabs
    const dispatchedTabs = tabStates.filter(s => s.status === 'dispatched');
    if (dispatchedTabs.length < 2) {
      const dispatched = dispatchedTabs.map(s => s.label).join(', ') || 'none';
      const errors = tabStates.filter(s => s.status === 'error').map(s => `${s.label}: ${s.error}`).join('; ');
      clearInterval(keepAlive);
      return {
        success: false,
        error: `Only ${dispatchedTabs.length} tab(s) dispatched successfully (${dispatched}). Errors: ${errors}`,
        creditsUsed,
      };
    }

    // ── Phase 3: Poll for Completion ───────────────────────────
    // Round-robin DOM fingerprint checks (works on non-active tabs)
    // ANTI-FABRICATION: Require DOM to actually CHANGE from baseline before marking ready.
    console.log(`[ParallelExplore] Phase 3: Polling ${dispatchedTabs.length} tabs for response completion...`);
    await updateParallelExploreProgress('polling', tabStates);

    // Minimum wait before polling — chatbots need time to start generating
    const MIN_WAIT_BEFORE_POLL = 5000;
    await new Promise(r => setTimeout(r, MIN_WAIT_BEFORE_POLL));

    const MAX_WAIT = (parallelPlan.maxWaitPerTab || 60) * 1000;
    const POLL_INTERVAL = 3000;    // 3s between checks per tab
    const STABLE_THRESHOLD = 3;    // 3 consecutive stable reads = 9s of no DOM change
    const pollStart = Date.now();

    while (Date.now() - pollStart < MAX_WAIT) {
      let allDone = true;

      for (const state of tabStates) {
        if (state.status !== 'dispatched') continue;
        allDone = false;

        try {
          const fp = await safeSendMessage(state.tabId, {
            type: 'explore_action',
            actionType: 'dom_fingerprint',
          }).catch(() => null);

          if (fp?.fingerprint) {
            // ANTI-FABRICATION CHECK: If fingerprint matches baseline, the page
            // hasn't changed since before we typed — the chatbot hasn't responded yet.
            // Do NOT count stable reads if the DOM is still the same as pre-dispatch.
            const matchesBaseline = state.baselineFingerprint && fp.fingerprint === state.baselineFingerprint;

            if (matchesBaseline) {
              // Page unchanged from baseline — still waiting for response
              state.stableCount = 0;
              state.fingerprint = fp.fingerprint;
            } else if (state.fingerprint && state.fingerprint === fp.fingerprint) {
              state.stableCount++;
              if (state.stableCount >= STABLE_THRESHOLD) {
                state.status = 'ready';
                console.log(`[ParallelExplore] "${state.label}" response is ready (DOM changed from baseline AND stable for ${STABLE_THRESHOLD * POLL_INTERVAL / 1000}s)`);
                await updateParallelExploreProgress('polling', tabStates);
              }
            } else {
              state.fingerprint = fp.fingerprint;
              state.stableCount = 0;
            }
          }
        } catch (pollErr) {
          console.warn(`[ParallelExplore] Poll error for "${state.label}":`, pollErr.message);
        }
      }

      if (allDone || tabStates.filter(s => s.status === 'dispatched').length === 0) break;

      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    // Mark remaining dispatched tabs as timeout (still try to collect partial)
    for (const state of tabStates) {
      if (state.status === 'dispatched') {
        state.status = 'timeout';
        console.log(`[ParallelExplore] "${state.label}" timed out after ${MAX_WAIT / 1000}s — will collect partial result`);
      }
    }
    await updateParallelExploreProgress('collecting', tabStates);

    // ── Phase 4: Collect Results ───────────────────────────────
    console.log('[ParallelExplore] Phase 4: Collecting results from all tabs...');

    for (const state of tabStates) {
      if (state.status !== 'ready' && state.status !== 'timeout') continue;

      try {
        await injectAndConfirm(state.tabId, 'content_explore.js');
        const snapshot = await takePageSnapshot(state.tabId);

        if (snapshot._tabClosed) {
          state.status = 'error';
          state.error = 'Tab was closed before collection';
          continue;
        }

        // Capture visible text content (up to 4000 chars)
        const content = (snapshot.mainContent || '').slice(0, 4000);

        // ANTI-FABRICATION: Verify content actually changed from pre-dispatch
        if (state.baselineContentHash !== null) {
          const currentHash = simpleHash(content);
          if (currentHash === state.baselineContentHash) {
            console.warn(`[ParallelExplore] "${state.label}" content UNCHANGED from baseline — chatbot likely didn't respond. Marking as no-response.`);
            state.status = 'error';
            state.error = 'No response detected — page content unchanged after submission';
            continue;
          }
        }

        state.result = content;
        state.url = snapshot.url || state.url;
        console.log(`[ParallelExplore] "${state.label}" collected ${content.length} chars`);
      } catch (collectErr) {
        console.warn(`[ParallelExplore] Collect error for "${state.label}":`, collectErr.message);
        state.status = 'error';
        state.error = 'Collection failed';
      }
    }

    // Build results for synthesis
    const collectedResults = tabStates
      .filter(s => s.result && s.result.length > 0)
      .map(s => ({ label: s.label, url: s.url, content: s.result }));

    if (collectedResults.length < 2) {
      const collected = collectedResults.map(r => r.label).join(', ') || 'none';
      clearInterval(keepAlive);
      return {
        success: false,
        error: `Only ${collectedResults.length} tab(s) returned results (${collected}). Need at least 2 for synthesis.`,
        creditsUsed,
        tabStates: tabStates.map(s => ({ label: s.label, status: s.status, error: s.error })),
      };
    }

    // ── Phase 5: Synthesize ────────────────────────────────────
    console.log(`[ParallelExplore] Phase 5: Synthesizing ${collectedResults.length} results...`);
    await updateParallelExploreProgress('synthesizing', tabStates);

    try {
      const synthByokConfig = await getByokConfig();
      const synthRes = await fetch(`${API_BASE}/api/agent/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          results: collectedResults,
          synthesisPrompt: parallelPlan.synthesisPrompt,
          userPrompt,
          ...byokPayload(synthByokConfig),
        }),
      });

      creditsUsed += 0.5; // PARALLEL_EXPLORE_SYNTH

      if (!synthRes.ok) {
        const errBody = await synthRes.json().catch(() => ({}));
        clearInterval(keepAlive);
        return {
          success: false,
          error: errBody.error || `Synthesis failed (HTTP ${synthRes.status})`,
          creditsUsed,
          rawResults: collectedResults,
        };
      }

      const synthesis = await synthRes.json();
      const durationMs = Date.now() - startedAt;

      console.log(`[ParallelExplore] ✓ Complete! ${collectedResults.length} sources, ${creditsUsed.toFixed(1)} EU, ${durationMs}ms`);

      await updateParallelExploreProgress('done', tabStates);
      clearInterval(keepAlive);

      return {
        success: true,
        data: synthesis,
        tabCount: collectedResults.length,
        creditsUsed,
        durationMs,
        tabStates: tabStates.map(s => ({ label: s.label, status: s.status, error: s.error })),
      };

    } catch (synthErr) {
      console.error('[ParallelExplore] Synthesis error:', synthErr);
      clearInterval(keepAlive);
      return {
        success: false,
        error: `Synthesis failed: ${synthErr.message}`,
        creditsUsed,
        rawResults: collectedResults,
      };
    }

  } catch (err) {
    console.error('[ParallelExplore] Unhandled error:', err);
    clearInterval(keepAlive);
    return { success: false, error: err.message || 'Parallel exploration failed.', creditsUsed };
  }
}

// --- EXPLORE: Multi-step agentic exploration loop ---

async function updateExplorationProgress(step, total, description, status, phase = 1) {
  await chrome.storage.local.set({
    explorationProgress: { step, total, description, status, phase, timestamp: Date.now() },
  });
}

async function takePageSnapshot(tabId) {
  // Wait for tab to be accessible (user may be switching tabs)
  const tabStatus = await waitForTabReady(tabId, 8000);
  if (tabStatus.reason === 'TAB_CLOSED') {
    return {
      url: 'unknown', title: 'unknown',
      mainContent: '(Tab was closed)',
      semanticElements: [],
      _tabClosed: true,  // Signal to callers that tab is gone
    };
  }

  // If tab is still loading (e.g., click triggered navigation), wait for full load
  // before attempting snapshot — content script can't produce reliable results mid-load
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.status === 'loading') {
      console.log(`[Snapshot] Tab ${tabId} still loading — waiting for complete...`);
      await waitForTabReady(tabId, 8000, { requireComplete: true });
    }
  } catch {}

  // Wait for DOM to stabilize (SPAs may still be rendering after tab load)
  await waitForDomStable(tabId, 3000, 300);

  try {
    // Request a snapshot via safeSendMessage (auto re-injects if channel is dead)
    const result = await safeSendMessage(tabId, {
      type: 'explore_action',
      actionType: 'take_snapshot',
    }, 'content_explore.js');

    if (result?.success && result.snapshot) {
      return result.snapshot;
    }

    // Fallback: just get basic page info
    const tab = await chrome.tabs.get(tabId);
    return {
      url: tab.url || 'unknown',
      title: tab.title || 'unknown',
      mainContent: result?.error ? `(Snapshot failed: ${result.error})` : '(Could not extract page content)',
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

async function executeExploreAction(tabId, action, token, _retryCount = 0) {
  // WAIT FOR TAB: Ensure tab is accessible before any operation.
  // This prevents "Tabs cannot be edited right now" when user is switching tabs.
  const tabStatus = await waitForTabReady(tabId, 8000);
  if (tabStatus.reason === 'TAB_CLOSED') {
    return { success: false, error: `Target tab ${tabId} was closed.`, errorType: 'TAB_CLOSED' };
  }

  // PROACTIVE READINESS: Ensure content_explore.js is alive before sending commands.
  // This eliminates "Receiving end does not exist" errors at the source.
  if (action.type !== 'navigate') {
    await ensureContentScriptReady(tabId);
  }

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

      // ── TAB SWIPE SYSTEM ──────────────────────────────────────
      // Instead of always overwriting the current tab, check if this is
      // a cross-domain navigation. If so, preserve the current tab and
      // either switch to an existing tab with that domain or open a new one.
      // This prevents losing the source page (e.g., Gmail) when navigating
      // to a target page (e.g., Excel Online) during data transfer tasks.
      let targetTabId = tabId;
      let currentHost = '';
      let targetHost = '';
      try {
        const currentTab = await chrome.tabs.get(tabId);
        currentHost = new URL(currentTab.url || '').hostname.toLowerCase();
        targetHost = new URL(url).hostname.toLowerCase();
      } catch {}

      const isCrossDomain = currentHost && targetHost && currentHost !== targetHost;

      if (isCrossDomain) {
        // Cross-domain: look for an existing tab with the target domain
        const allTabs = await chrome.tabs.query({ currentWindow: true });
        const existingTab = allTabs.find(t => {
          if (t.id === tabId) return false; // Don't match the source tab
          try { return new URL(t.url).hostname.toLowerCase() === targetHost; } catch { return false; }
        });

        if (existingTab) {
          // Tab with target domain already open — switch to it and navigate
          await chrome.tabs.update(existingTab.id, { active: true, url });
          targetTabId = existingTab.id;
          console.log(`[Explore] Tab Swipe: reused existing tab ${targetTabId} for ${targetHost} (source tab ${tabId} preserved)`);
        } else {
          // No existing tab — open a new one, preserve the source tab
          const newTab = await chrome.tabs.create({ url, active: true });
          targetTabId = newTab.id;
          console.log(`[Explore] Tab Swipe: created new tab ${targetTabId} for ${targetHost} (source tab ${tabId} preserved)`);
        }
      } else {
        // Same domain or unknown: navigate within the same tab (existing behavior)
        await chrome.tabs.update(tabId, { url });
      }

      await waitForTabLoad(targetTabId, 15000, 500); // 500ms after load for SPA rendering

      // Get the ACTUAL loaded URL (chrome.tabs.update returns before navigation)
      const loadedTab = await chrome.tabs.get(targetTabId);
      const actualUrl = loadedTab.url || url;

      // Re-inject DOM interaction scripts with retry (Reddit/SPAs may need a moment)
      // Side panel UI persists — only content scripts need re-injection
      const scriptsToInject = ['content_explore.js', HUD_SCRIPT];
      for (const script of scriptsToInject) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: targetTabId },
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
        // Signal the exploration loop that the active tab changed
        newTabId: isCrossDomain ? targetTabId : undefined,
      };
    }

    // resolve_element: multi-signal element resolution, returns best match SID
    if (action.type === 'resolve_element') {
      try {
        const result = await safeSendMessage(tabId, {
          type: 'explore_action',
          actionType: 'resolve_element',
          target: action.target,
          value: action.value,
        }, 'content_explore.js');
        return result || { success: false, error: 'No response from resolve_element' };
      } catch (err) {
        return { success: false, error: `resolve_element failed: ${err.message}` };
      }
    }

    // fill_field: route through content_explore.js type_text (supports Shadow DOM, rich editors)
    // The old stageAction/Ghost-Driver path fails on Shadow DOM sites (Reddit, etc.)
    if (action.type === 'fill_field') {
      if (!action.target && !action.value) {
        return { success: false, error: 'No fill target or value provided' };
      }
      // If we have a semantic ID target, use type_text via content_explore.js directly
      if (action.target) {
        const result = await safeSendMessage(tabId, {
          type: 'explore_action',
          actionType: 'type_text',
          target: action.target,
          value: action.value || '',
          consentApproved: action.consentApproved || false,
        }, 'content_explore.js');
        return result || { success: false, error: 'No response from type_text' };
      }
      // Fallback: no target SID — use old stageAction path
      const goal = action.value || action.description || '';
      const result = await stageAction(tabId, goal, 'forms', token);
      return {
        success: result?.success || false,
        observation: result?.success
          ? 'Form fields filled successfully'
          : (result?.error || 'Form filling failed'),
      };
    }

    // For all other actions, send to content script via safeSendMessage
    // (auto re-injects content_explore.js if channel is dead)
    const result = await safeSendMessage(tabId, {
      type: 'explore_action',
      actionType: action.type,
      target: action.target,
      value: action.value,
      consentApproved: action.consentApproved || false,
    }, 'content_explore.js');

    return result || { success: false, error: 'No response from content script' };

  } catch (err) {
    // TRANSIENT CHROME API ERRORS: Retry automatically.
    // "Tabs cannot be edited right now" happens when user is switching tabs, dragging tabs,
    // or Chrome is in a transient animation state. These resolve on their own after a brief wait.
    // Also handles "Could not establish connection" (content script not yet loaded after navigation).
    const transientErrors = [
      'cannot be edited',
      'dragging a tab',
      'Could not establish connection',
      'Receiving end does not exist',
      'message port closed',
    ];
    const isTransient = transientErrors.some(msg => (err.message || '').includes(msg));
    if (isTransient && _retryCount < 3) {
      const delay = (_retryCount + 1) * 1000; // 1s, 2s, 3s backoff
      console.warn(`[Explore] Transient Chrome error: "${err.message}". Retrying in ${delay}ms (attempt ${_retryCount + 1}/3)...`);
      await new Promise(r => setTimeout(r, delay));
      return executeExploreAction(tabId, action, token, _retryCount + 1);
    }
    return { success: false, error: err.message || 'Action execution failed' };
  }
}

// Global abort flag — set by explore_cancel handler, checked by the step loop
let explorationAborted = false;

// Generation counter — incremented on every new process_request.
// Each request captures its own generation number. When the chain loop
// checks this, a mismatch means a newer request arrived and the old
// chain must abort (ghost-chain prevention).
let currentRequestGeneration = 0;

const SESSION_ACTION_HISTORY_KEY = 'sessionActionHistory';
const MAX_SESSION_ACTION_HISTORY = 20;
let sessionActionHistory = [];

function normalizeSessionActionHistoryEntry(entry = {}) {
  return {
    step: Number.isFinite(entry.step) ? entry.step : null,
    action: entry.action || 'unknown',
    target: entry.target || null,
    result: entry.result || 'unknown',
    error: entry.error || null,
    pageUrl: entry.pageUrl || null,
  };
}

async function syncSessionActionHistoryStorage() {
  try {
    await chrome.storage.session.set({
      [SESSION_ACTION_HISTORY_KEY]: sessionActionHistory.slice(),
    });
  } catch (err) {
    console.warn('[Explore] Could not sync session action history:', err.message);
  }
}

async function mirrorSessionActionHistoryToTab(tabId, mode, entry = null) {
  if (!tabId) return;
  try {
    await safeSendMessage(tabId, {
      type: 'explore_action',
      actionType: mode === 'reset' ? 'history_reset' : 'history_append',
      entry,
    }, 'content_explore.js');
  } catch (err) {
    console.warn(`[Explore] Could not ${mode} content action history on tab ${tabId}:`, err.message);
  }
}

async function resetSessionActionHistory(tabId = null) {
  sessionActionHistory = [];
  await syncSessionActionHistoryStorage();
  if (tabId) {
    await mirrorSessionActionHistoryToTab(tabId, 'reset');
  }
}

async function appendSessionActionHistory(entry, tabId = null) {
  const normalized = normalizeSessionActionHistoryEntry(entry);
  sessionActionHistory.push(normalized);
  if (sessionActionHistory.length > MAX_SESSION_ACTION_HISTORY) {
    sessionActionHistory = sessionActionHistory.slice(-MAX_SESSION_ACTION_HISTORY);
  }
  await syncSessionActionHistoryStorage();
  if (tabId) {
    await mirrorSessionActionHistoryToTab(tabId, 'append', normalized);
  }
  return normalized;
}

async function resolveSessionActionHistoryUrl(tabId, actionResult) {
  if (actionResult?.newUrl) return actionResult.newUrl;
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url || null;
  } catch {
    return null;
  }
}

function getRecentSessionActionHistory(limit = 5) {
  if (!limit || limit < 1) return [];
  return sessionActionHistory.slice(-limit);
}

function shouldTrackSessionActionHistory(action) {
  const skippedActionTypes = new Set(['take_snapshot', 'dom_fingerprint', 'auth_check', 'session_context']);
  return !!action?.type && !skippedActionTypes.has(action.type);
}

async function executeExploreActionWithHistory(tabId, action, token, step = null) {
  const actionResult = await executeExploreAction(tabId, action, token);
  if (!shouldTrackSessionActionHistory(action)) {
    return actionResult;
  }
  const historyTabId = actionResult?.newTabId || tabId;
  const pageUrl = await resolveSessionActionHistoryUrl(historyTabId, actionResult);
  await appendSessionActionHistory({
    step,
    action: action?.type || 'unknown',
    target: action?.target || null,
    result: actionResult?.success ? 'success' : 'failure',
    error: actionResult?.success ? null : (actionResult?.error || null),
    pageUrl,
  }, historyTabId);
  return actionResult;
}

// Helper: mark exploration as finished and store result for panel recovery
async function finishExploration(result) {
  // Only reset abort flag if the user did NOT cancel. If they cancelled,
  // the chain loop needs to read the flag and break before starting the next sub-task.
  // The flag gets reset at the START of the next explore_start instead (line ~6905).
  if (!explorationAborted) explorationAborted = false;
  // Set result first, THEN remove active flag — so listener sees result when it checks
  try {
    await chrome.storage.session.set({ explorationResult: { ...result, finishedAt: Date.now() } });
    await chrome.storage.session.remove('explorationActive');
  } catch (e) {
    console.warn('[Explore] finishExploration storage write failed:', e.message);
  }
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

// ── LAYER 2: Heuristic Completion Detector ──
// Detects goal-completion signals from page state changes WITHOUT relying on the AI.
// Returns a hint string if strong signals detected, null otherwise.
// NEVER force-stops — only hints to the AI. No false-positive risk.
function detectGoalCompletionSignals(goal, preActionSnapshot, postActionSnapshot, lastAction) {
  if (!postActionSnapshot || !lastAction) return null;
  const signals = [];

  const postUrl = (postActionSnapshot.url || '').toLowerCase();
  const postContent = (postActionSnapshot.mainContent || '').toLowerCase();
  const goalLower = (goal || '').toLowerCase();

  // Signal 1: URL changed to a success/confirmation pattern
  const successUrlPatterns = ['/success', '/confirmation', '/confirm', '/complete', '/thank', '/done', '/created', '/scheduled', '/submitted', '/receipt'];
  if (preActionSnapshot?.url && postUrl !== preActionSnapshot.url.toLowerCase()) {
    for (const pattern of successUrlPatterns) {
      if (postUrl.includes(pattern)) {
        signals.push(`URL contains "${pattern}"`);
        break;
      }
    }
    // Meeting link patterns (Google Meet, Zoom, Teams)
    if (postUrl.match(/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/)) signals.push('Google Meet link created');
    if (postUrl.match(/zoom\.us\/j\/\d+/)) signals.push('Zoom meeting link created');
    if (postUrl.match(/teams\.microsoft\.com\/.*meetup/)) signals.push('Teams meeting created');
  }

  // Signal 2: Page content contains success keywords
  const successPhrases = [
    'successfully created', 'has been scheduled', 'has been created', 'meeting is ready',
    'your meeting', 'meeting link', 'has been saved', 'successfully saved',
    'order confirmed', 'booking confirmed', 'reservation confirmed',
    'has been submitted', 'successfully submitted', 'successfully sent',
    'was sent', 'message sent', 'email sent', 'has been deleted',
    'successfully updated', 'changes saved', 'settings updated',
    'copied to clipboard', 'link copied', 'download started',
    'task created', 'event created', 'document created',
  ];
  for (const phrase of successPhrases) {
    if (postContent.includes(phrase)) {
      signals.push(`Page says "${phrase}"`);
      break; // One is enough
    }
  }

  // Signal 3: Goal-action semantic match
  // If goal is "create/schedule/send/submit" and the action was a click that succeeded
  const createVerbs = ['create', 'schedule', 'start', 'new', 'set up', 'make', 'add', 'send', 'submit', 'post', 'publish'];
  const goalHasCreateVerb = createVerbs.some(v => goalLower.includes(v));
  const actionWasClick = lastAction.type === 'click_element';
  const actionSucceeded = true; // caller only calls this on success

  if (goalHasCreateVerb && actionWasClick && preActionSnapshot?.url &&
      postUrl !== preActionSnapshot.url.toLowerCase()) {
    signals.push('Create/schedule action caused page navigation (likely confirmation)');
  }

  // Signal 4: Dramatic content change after click (new content appeared)
  if (preActionSnapshot?.mainContent && actionWasClick) {
    const preLen = (preActionSnapshot.mainContent || '').length;
    const postLen = (postActionSnapshot.mainContent || '').length;
    // If page content changed by >50% and URL changed, something significant happened
    if (Math.abs(postLen - preLen) > preLen * 0.5 &&
        preActionSnapshot.url && postUrl !== preActionSnapshot.url.toLowerCase()) {
      signals.push('Page content changed dramatically after action');
    }
  }

  // Return hint only if 2+ signals (high confidence) to avoid false positives
  if (signals.length >= 2) {
    return `The page shows strong completion signals: ${signals.join('; ')}. If the goal is achieved, set isGoalComplete=true immediately.`;
  }
  // Return weaker hint for 1 signal
  if (signals.length === 1) {
    return `Possible completion signal detected: ${signals[0]}. Check if the goal is already achieved.`;
  }
  return null;
}

// ── LAYER 4: Phase Completion Evidence Scanner ──
// Scans a phase's stepLog for evidence that the goal was achieved,
// even if the AI never set isGoalComplete=true.
// Used as a gate before auto-continuation to prevent wasting phases.
function phaseContainsCompletionEvidence(stepLog, goal) {
  if (!stepLog || stepLog.length === 0) return false;
  const goalLower = (goal || '').toLowerCase();

  // Check observations for success language
  const successKeywords = [
    'successfully', 'created', 'scheduled', 'confirmed', 'saved', 'sent',
    'completed', 'done', 'finished', 'meeting is ready', 'meeting link',
    'has been', 'was created', 'submitted', 'published', 'posted',
  ];

  let evidenceCount = 0;

  for (const entry of stepLog) {
    if (!entry.observation || entry.result?.success === false) continue;
    const obs = entry.observation.toLowerCase();

    for (const kw of successKeywords) {
      if (obs.includes(kw)) {
        evidenceCount++;
        break; // one keyword per entry is enough
      }
    }

    // Strong signal: if observation contains the URL pattern of a created resource
    if (obs.match(/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/) ||
        obs.match(/zoom\.us\/j\/\d+/) ||
        obs.includes('/confirmation') || obs.includes('/success') ||
        obs.includes('/thank-you') || obs.includes('/created')) {
      evidenceCount += 2; // strong signal counts double
    }
  }

  // Also check: did a click on a "create/new/schedule/submit" button succeed?
  const actionButtons = stepLog.filter(s =>
    s.action?.type === 'click_element' && s.result?.success !== false &&
    /(create|new|schedule|submit|send|post|publish|start|confirm)/i.test(s.action?.description || '')
  );
  if (actionButtons.length > 0) evidenceCount++;

  // Threshold: 2+ evidence signals = likely completed
  return evidenceCount >= 2;
}

// ── Auto-Continuation Constants ──
const MAX_PHASES = 3;         // Max 3 phases × 30 steps = 90 steps total
const PHASE_TIMEOUT_MS = 480000; // 8 minutes per phase (accounts for slow connections + observe→plan call)

/**
 * Modal dismissal subroutine — tries Escape → close button → overlay click.
 * Extracted so it can be called from both the 2x and 3x repeat handlers.
 * Returns { dismissed: boolean, method: string|null }
 */
async function tryDismissModal(snapshot, tabId, token) {
  let dismissed = false;
  let method = null;

  // Strategy 1: Press Escape
  try {
    await executeExploreAction(tabId, {
      type: 'press_key', value: 'Escape',
      description: 'Pressing Escape to dismiss modal',
    }, token);
    await new Promise(r => setTimeout(r, 600));
    const postEsc = await takePageSnapshot(tabId);
    if (!postEsc.hasOpenModal) {
      dismissed = true;
      method = 'escape';
      console.log('[Explore] Modal dismissed via Escape key');
      return { dismissed, method };
    }
  } catch (e) {
    console.warn('[Explore] Modal dismiss: Escape failed:', e.message);
  }

  // Strategy 2: Find close/dismiss button — search inModal elements first, then ALL elements
  const elements = snapshot.semanticElements || [];
  const isCloseButton = (el) => {
    const text = (el.text || '').toLowerCase();
    const ariaLabel = (el.attrs?.ariaLabel || '').toLowerCase();
    const iconMeaning = (el.attrs?.iconMeaning || '').toLowerCase();
    return (
      text === 'close' || text === 'cancel' || text === 'dismiss' || text === '×' || text === 'x' ||
      ariaLabel.includes('close') || ariaLabel.includes('dismiss') || ariaLabel.includes('cancel') ||
      iconMeaning.includes('close') || iconMeaning.includes('dismiss')
    );
  };

  // Prefer inModal buttons, but fall back to ANY close button on the page
  const closeBtn = elements.find(el => el.inModal && isCloseButton(el))
    || elements.find(el => isCloseButton(el));

  if (closeBtn) {
    try {
      console.log(`[Explore] Modal dismiss: clicking close button ${closeBtn.sid} ("${closeBtn.text}")`);
      await executeExploreAction(tabId, {
        type: 'click_element', target: closeBtn.sid,
        description: `Clicking modal close button: "${closeBtn.text}"`,
      }, token);
      await new Promise(r => setTimeout(r, 600));
      const postClick = await takePageSnapshot(tabId);
      if (!postClick.hasOpenModal) {
        dismissed = true;
        method = 'close_button';
        console.log(`[Explore] Modal dismissed via click on ${closeBtn.sid}`);
        return { dismissed, method };
      }
    } catch (e) {
      console.warn('[Explore] Modal dismiss: click-close failed:', e.message);
    }
  } else {
    console.warn('[Explore] Modal dismiss: no close/cancel button found');
  }

  // Strategy 3: Click outside the modal (overlay click)
  // Find the dialog/modal element itself and try to click its parent overlay
  try {
    const dialogEl = elements.find(el => {
      const role = (el.attrs?.role || '').toLowerCase();
      return role === 'dialog' || role === 'alertdialog';
    });
    if (dialogEl) {
      // Use executeScript to click at position (0,0) of the viewport overlay area
      // which is outside the modal box but inside the overlay
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // Find the overlay/backdrop behind the dialog
          const dialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
          for (const d of dialogs) {
            const parent = d.parentElement;
            if (parent && parent !== document.body) {
              // Click the parent overlay at its top-left corner (outside the modal box)
              parent.click();
            }
          }
        },
      });
      await new Promise(r => setTimeout(r, 600));
      const postOverlay = await takePageSnapshot(tabId);
      if (!postOverlay.hasOpenModal) {
        dismissed = true;
        method = 'overlay_click';
        console.log('[Explore] Modal dismissed via overlay click');
        return { dismissed, method };
      }
    }
  } catch (e) {
    console.warn('[Explore] Modal dismiss: overlay click failed:', e.message);
  }

  return { dismissed, method };
}

// ── Structured step helpers (multi-step mode) ──

/**
 * Check if all machine-verifiable success signals for a step are satisfied.
 * Returns true if all signals pass (or if no machine signals are defined).
 */
function checkMachineSignals(step, currentPageState, structuredData) {
  if (!step?.successSignals?.machine?.length) return true; // No signals = vacuous truth
  return step.successSignals.machine.every(signal => {
    if (signal.startsWith('extractedData.')) {
      const key = signal.replace('extractedData.', '').split(' ')[0];
      return structuredData[key] != null && structuredData[key] !== '';
    }
    if (signal.startsWith('URL contains ')) {
      const fragment = signal.replace('URL contains ', '');
      return (currentPageState?.url || '').includes(fragment);
    }
    return false; // Unknown signal type — don't block on it
  });
}

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
  let consecutiveScrapeDecisions = 0; // circuit breaker: counts consecutive AI-initiated scrape_page decisions
  const startStep = resumeState?.nextStep || 1;

  // ── Structured step tracking state (multi-step mode) ──
  let isStructuredMode = false;
  let structuredSteps = null;
  let currentStepIndex = 0;
  let stepAttemptCount = 0;
  let stepStartTime = null;
  let structuredData = {};
  const MAX_ATTEMPTS_PER_STEP = 5;
  const STEP_TIMEOUT_MS = 45000; // 45 seconds per step

  // Restore structured mode from continuation context (phase transitions)
  if (continuationContext?.remainingSteps?.length > 0) {
    isStructuredMode = true;
    structuredSteps = continuationContext.remainingSteps;
    structuredData = continuationContext.structuredData || {};
    stepStartTime = Date.now();
    console.log(`[Explore] Phase continuation: resuming structured mode with ${structuredSteps.length} remaining steps`);
  }

  // Auto-continuation context
  const currentPhase = continuationContext?.phase || 1;
  const previousPhases = continuationContext?.previousPhases || [];
  const originalPrompt = continuationContext?.originalPrompt || null;
  const totalStepsAcrossPhases = continuationContext?.totalSteps || 0;

  // Data Scratchpad: persists extracted data across steps AND phases.
  // The AI writes to this via `extractedData` field in its response.
  // This survives history compression (always injected in full) and phase transitions.
  // Increased to 64KB to support large data transfer tasks (Notion → Excel, etc.)
  const DATA_BUFFER_MAX = 64000;
  let dataBuffer = continuationContext?.dataBuffer || '';

  // Mark exploration as in-progress (so re-injected panel can detect it)
  try {
    await chrome.storage.session.set({
      explorationActive: { goal, maxSteps, tabId: currentTabId, startedAt: Date.now(), phase: currentPhase },
    });
  } catch (e) {
    console.warn('[Explore] Could not set explorationActive:', e.message);
  }

  // Auto-inject panel + explore + HUD when the explore tab navigates (backup for executeExploreAction injection)
  // Re-inject content scripts on FULL page loads (traditional navigation)
  const navListener = (details) => {
    if (details.tabId !== currentTabId || details.frameId !== 0) return;
    console.log('[Explore] webNavigation.onCompleted — re-injecting DOM scripts on', details.url);
    injectAndConfirm(currentTabId, 'content_explore.js').catch(() => {});
    chrome.scripting.executeScript({ target: { tabId: currentTabId }, files: [HUD_SCRIPT] }).catch(() => {});
  };
  chrome.webNavigation.onCompleted.addListener(navListener);

  // Re-inject content scripts on SPA SOFT navigations (pushState/replaceState).
  // Reddit, Gmail, YouTube, Amazon, etc. change URLs via History API without a
  // full page load — onCompleted never fires, so the content script goes stale.
  // This listener catches those soft navigations and re-injects immediately.

  // ── SPA Staleness Flag ───────────────────────────────────────
  // Set to true whenever onHistoryStateUpdated fires mid-step.
  // The main loop checks this just before executing any SID-targeted action.
  // Cleared immediately after the guard acts on it.
  let sidsStale = false;

  const spaNavListener = (details) => {
    if (details.tabId !== currentTabId || details.frameId !== 0) return;
    console.log('[Explore] SPA navigation (onHistoryStateUpdated) — re-injecting DOM scripts on', details.url);
    injectAndConfirm(currentTabId, 'content_explore.js').catch(() => {});
    chrome.scripting.executeScript({ target: { tabId: currentTabId }, files: [HUD_SCRIPT] }).catch(() => {});
    sidsStale = true;
  };
  chrome.webNavigation.onHistoryStateUpdated.addListener(spaNavListener);

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
    chrome.webNavigation.onHistoryStateUpdated.removeListener(spaNavListener);
  }

  try {
    // WAIT FOR TAB before any DOM operations (user may be on a different tab)
    const loopTabStatus = await waitForTabReady(currentTabId, 10000);
    if (loopTabStatus.reason === 'TAB_CLOSED') {
      cleanupLoop();
      return finishExploration({
        success: false,
        error: 'The target tab was closed before exploration could start. Please reopen the page and try again.',
        stepsUsed: 0,
        creditsUsed: 0,
        stepLog: [],
      });
    }

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

      const startResult = await executeExploreActionWithHistory(currentTabId, startAction, token, null);
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
            isMultiStep: explorePlan.isMultiStep || undefined,
            // Structured mode refinement context (phase transitions)
            ...(isStructuredMode && structuredSteps ? {
              isRefinement: true,
              completedSteps: structuredSteps.slice(0, currentStepIndex),
              remainingSteps: structuredSteps.slice(currentStepIndex),
            } : {}),
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
            console.log(`[Explore] ★ PLANNER RESPONSE: hasSteps=${!!(planData.steps && planData.steps.length)} | stepsCount=${planData.steps?.length || 0} | hasStrategy=${!!(planData.strategy && planData.strategy.length > 10)} | hasInstantAnswer=${!!planData.instantAnswer} | maxSteps=${planData.maxSteps}`);

            // ── INSTANT ANSWER: planner determined answer is already on the page ──
            // Skip the entire exploration loop — return the answer directly.
            if (planData.instantAnswer && planData.instantAnswer.length > 5) {
              console.log('[Explore] INSTANT ANSWER — skipping exploration loop:', planData.instantAnswer.slice(0, 200));
              creditsUsed += 0.5; // EXPLORE_PLAN cost only
              stepLog.push({
                step: 0,
                action: { type: 'instant_answer', description: 'Answer found on visible page' },
                result: { success: true },
                observation: `Planner found the answer directly: ${planData.instantAnswer.slice(0, 300)}`,
              });
              await hudUpdate(currentTabId, 'explore-0', 'success', 'Answer found on page!');
              await updateExplorationProgress(0, maxSteps, 'Answer found on page!', 'complete');
              cleanupLoop();
              return finishExploration({
                success: true,
                goalResult: planData.instantAnswer,
                stepsUsed: 0,
                creditsUsed,
                stepLog,
              });
            }

            // ── Detect structured mode from planner response ──
            // Source of truth: actual planner output (steps array), NOT the isMultiStep hint.
            if (planData.steps && Array.isArray(planData.steps) && planData.steps.length > 0) {
              isStructuredMode = true;
              structuredSteps = planData.steps;
              stepStartTime = Date.now();
              console.log(`[Explore] STRUCTURED MODE activated: ${structuredSteps.length} steps — ${structuredSteps.map(s => `${s.id}:${s.goal.slice(0,40)}`).join(' → ')}`);
            }

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
      // User cancelled exploration
      if (explorationAborted) {
        console.log('[Explore] Aborted by user at step', step);
        cleanupLoop();
        return finishExploration({ success: false, error: 'Exploration cancelled by user.', stepsUsed: step - 1, creditsUsed, stepLog });
      }

      // Frustration failsafe: 5 consecutive failures → stop (increased from 3 to handle transient rate limits)
      if (consecutiveFailures >= 5) {
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

      // TAB CLOSED: If snapshot signals tab is gone, abort immediately
      if (snapshot._tabClosed) {
        console.error(`[Explore] Step ${step}: target tab ${currentTabId} was closed. Aborting.`);
        stepLog.push({
          step,
          action: { type: 'tab_lost', description: `Tab ${currentTabId} closed during snapshot` },
          result: { success: false, failureReason: 'TAB_CLOSED' },
          observation: 'The target tab was closed. Exploration cannot continue.',
        });
        cleanupLoop();
        return finishExploration({
          success: false,
          error: 'The target tab was closed. Please reopen the page and try again.',
          stepsUsed: step,
          creditsUsed,
          stepLog,
        });
      }

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

      // ── SITEMAP PHASE 1: Fingerprint check (for confidence tracking) ──
      let siteMapMatch = null;
      try {
        const lookupUrl = `${API_BASE}/api/sitemap/lookup?url=${encodeURIComponent(snapshot.url)}`;
        const lookupRes = await fetch(lookupUrl, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (lookupRes.ok) {
          const lookupData = await lookupRes.json();
          if (lookupData.found && lookupData.canUseDeterministic) {
            siteMapMatch = lookupData.siteMap;
            console.log(`[SiteMap] Fingerprint available for ${lookupData.siteMap.domain} (confidence: ${lookupData.siteMap.confidence}, freshness: ${lookupData.siteMap.freshnessTier})`);
          }
        }
      } catch (siteMapErr) {
        console.warn('[SiteMap] Lookup failed (non-blocking):', siteMapErr.message);
      }

      // ── SITEMAP PHASE 2: Deterministic action check ──
      // "AI explores once, code repeats forever"
      // Check if we have a stored goal→action mapping for this page.
      // If yes AND the target element still exists on the page → skip AI call entirely.
      let siteActionMatch = null;
      let usedDeterministic = false;
      try {
        const actionLookupRes = await fetch(`${API_BASE}/api/sitemap/lookup-action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            url: snapshot.url,
            goal,
            snapshot: { semanticElements: snapshot.semanticElements },
          }),
        });
        if (actionLookupRes.ok) {
          const actionData = await actionLookupRes.json();
          if (actionData.found && actionData.siteAction?.matchedElement?.sid) {
            siteActionMatch = actionData.siteAction;
            console.log(`[SiteAction] ⚡ Deterministic match! goal="${actionData.siteAction.goalPattern}" → ${actionData.siteAction.actionType} on "${actionData.siteAction.matchedElement.text}" (sid: ${actionData.siteAction.matchedElement.sid}, confidence: ${actionData.siteAction.confidence}, matchScore: ${actionData.siteAction.matchedElement.score.toFixed(2)})`);
          }
        }
      } catch (actionErr) {
        console.warn('[SiteAction] Lookup failed (non-blocking):', actionErr.message);
      }

      // THINK: either use deterministic action or call backend AI
      const exploreStepUrl = `${API_BASE}/api/agent/explore-step`;
      await updateExplorationProgress(step, maxSteps, siteActionMatch ? '⚡ Replaying known action...' : 'Deciding next action...', 'running');

      let decision;

      // ── DETERMINISTIC PATH: Skip AI call if we have a confident match ──
      if (siteActionMatch && siteActionMatch.confidence >= 0.6 && siteActionMatch.matchedElement?.sid) {
        usedDeterministic = true;
        console.log(`[SiteAction] ⚡ SKIPPING AI CALL — using deterministic action: ${siteActionMatch.actionType} on sid=${siteActionMatch.matchedElement.sid}`);

        // Build a synthetic decision object matching the AI response format
        decision = {
          nextAction: {
            type: siteActionMatch.actionType,
            target: siteActionMatch.matchedElement.sid,
            value: siteActionMatch.actionValue || undefined,
            description: `⚡ Deterministic: ${siteActionMatch.actionType} "${siteActionMatch.matchedElement.text}"`,
          },
          isGoalComplete: false,
          reasoning: `Deterministic replay — this action (${siteActionMatch.goalPattern}) has succeeded ${siteActionMatch.confidence >= 0.9 ? 'many' : 'several'} times on this page type with ${(siteActionMatch.confidence * 100).toFixed(0)}% confidence.`,
          // No credits used for deterministic actions!
        };

        // NOTE: We do NOT increment creditsUsed here — deterministic actions are FREE
      }

      if (!usedDeterministic) {
      // ── FAILURE MEMORY: Fetch past failures so AI avoids repeating mistakes ──
      let failedActions = [];
      try {
        const failRes = await fetch(`${API_BASE}/api/sitemap/lookup-failures`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ url: snapshot.url, goal: originalPrompt || goal }),
        });
        if (failRes.ok) {
          const failData = await failRes.json();
          if (failData.success && failData.failures?.length > 0) {
            failedActions = failData.failures;
            console.log(`[SiteAction] 🧠 Found ${failedActions.length} past failures for this goal on ${snapshot.url}`);
          }
        }
      } catch (failErr) {
        console.warn('[SiteAction] Failure lookup failed (non-blocking):', failErr.message);
      }

      // ── NORMAL AI PATH: Call backend for next action ──
      try {
        console.log(`[Explore] Step ${step}: calling ${exploreStepUrl}`);
        console.log(`[Explore] Step ${step}: snapshot url=${snapshot.url}, elements=${snapshot.semanticElements?.length || 0}, content=${(snapshot.mainContent || '').length} chars`);
        const exploreByokConfig = await getByokConfig();
        const recentActionHistory = getRecentSessionActionHistory(5);
        const stepPayload = {
          goal,
          strategy: currentStrategy,
          stepNumber: step,
          maxSteps,
          previousActions: stepLog,
          currentPageState: snapshot,
          previousPhases: previousPhases.length > 0 ? previousPhases : undefined,
          originalPrompt: originalPrompt || undefined,
          dataBuffer: dataBuffer || undefined,
          failedActions: failedActions.length > 0 ? failedActions : undefined,
          recentActionHistory: recentActionHistory.length > 0 ? recentActionHistory : undefined,
          completionHint: stepLog._completionHint || undefined,
          // Structured step context (only in multi-step mode)
          ...(isStructuredMode && structuredSteps ? {
            currentStep: structuredSteps[currentStepIndex],
            currentStepIndex,
            totalStructuredSteps: structuredSteps.length,
            nextStepPreview: structuredSteps[currentStepIndex + 1]?.goal || null,
            structuredDataKeys: Object.keys(structuredData),
            allSteps: structuredSteps.map((s, i) => ({
              id: s.id, goal: s.goal,
              status: i < currentStepIndex ? 'completed' : i === currentStepIndex ? 'current' : 'pending',
            })),
          } : {}),
          ...byokPayload(exploreByokConfig),
        };

        // Retry logic for network resilience + rate limit handling (up to 3 retries)
        let thinkRes = null;
        let lastFetchErr = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            thinkRes = await fetch(exploreStepUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify(stepPayload),
            });

            // Handle HTTP 429 (rate limit) with exponential backoff
            if (thinkRes.status === 429) {
              const retryAfter = parseInt(thinkRes.headers.get('Retry-After') || '0', 10);
              const backoffMs = retryAfter > 0 ? retryAfter * 1000 : Math.min((attempt + 1) * 5000, 20000);
              console.warn(`[Explore] Step ${step}: rate limited (429), waiting ${backoffMs}ms before retry ${attempt + 1}/3...`);
              await hudUpdate(currentTabId, `explore-${step}`, 'running', `Rate limited — waiting ${Math.round(backoffMs / 1000)}s...`);
              await new Promise(r => setTimeout(r, backoffMs));
              thinkRes = null; // Reset to retry
              continue;
            }

            lastFetchErr = null;
            break; // Success — exit retry loop
          } catch (fetchErr) {
            lastFetchErr = fetchErr;
            const isTransient = (fetchErr.message || '').match(/Failed to fetch|NetworkError|ERR_CONNECTION|ECONNRESET|ETIMEDOUT/);
            if (isTransient && attempt < 3) {
              console.warn(`[Explore] Step ${step}: fetch attempt ${attempt + 1} failed (${fetchErr.message}), retrying in ${(attempt + 1) * 2}s...`);
              await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
            } else {
              break; // Non-transient error or max retries — stop
            }
          }
        }

        if (lastFetchErr) throw lastFetchErr;
        if (!thinkRes) throw new Error('Rate limit exceeded after 4 attempts');

        if (!thinkRes.ok) {
          const err = await thinkRes.json().catch(() => ({}));
          if (err.errorType === 'INSUFFICIENT_CREDITS') {
            await hudUpdate(currentTabId, `explore-${step}`, 'error', 'Insufficient credits');
            break;
          }
          // Detect rate limit errors passed through from backend
          const errMsg = err.error || `explore-step failed (HTTP ${thinkRes.status})`;
          if (errMsg.toLowerCase().includes('too many') || errMsg.toLowerCase().includes('rate limit') || thinkRes.status === 429) {
            console.warn(`[Explore] Step ${step}: backend rate limit error, waiting 10s...`);
            await hudUpdate(currentTabId, `explore-${step}`, 'running', 'Rate limited — waiting 10s...');
            await new Promise(r => setTimeout(r, 10000));
            // Don't throw — mark as rate-limit failure so failsafe doesn't count it
            consecutiveFailures = Math.max(0, consecutiveFailures - 1); // Undo the increment that will happen
            throw new Error(`__RATE_LIMITED__: ${errMsg}`);
          }
          throw new Error(errMsg);
        }

        decision = await thinkRes.json();
        creditsUsed += 0.3;
        console.log(`[Explore] Step ${step}: FULL decision object:`, JSON.stringify(decision, null, 2));
        console.log(`[Explore] Step ${step}: AI decided action=${decision.nextAction?.type}, desc="${decision.nextAction?.description}", goalComplete=${decision.isGoalComplete}`);

        // ── Data Scratchpad: capture extractedData from AI response ──
        if (decision.extractedData && typeof decision.extractedData === 'string') {
          const newData = decision.extractedData.trim();
          if (newData) {
            // Append new data (AI is instructed to append, but guard against duplicates)
            if (dataBuffer && !dataBuffer.includes(newData.slice(0, 100))) {
              dataBuffer = (dataBuffer + '\n' + newData).slice(0, DATA_BUFFER_MAX);
            } else if (!dataBuffer) {
              dataBuffer = newData.slice(0, DATA_BUFFER_MAX);
            }
            console.log(`[Explore] Step ${step}: Data buffer updated (${dataBuffer.length} chars)`);
          }
        }
      } catch (err) {
        const errMsg = err.message || 'Unknown error';
        const isNetworkError = errMsg.includes('Failed to fetch') || errMsg.includes('NetworkError') || errMsg.includes('ERR_CONNECTION');
        const isRateLimited = errMsg.includes('__RATE_LIMITED__') || errMsg.toLowerCase().includes('too many') || errMsg.toLowerCase().includes('rate limit');
        const userMsg = isNetworkError
          ? `Backend unreachable (${API_BASE}) — is the server running? (retried 3 times)`
          : isRateLimited
            ? 'Rate limited — will retry shortly'
            : `AI error: ${errMsg}`;
        console.error(`[Explore] Think step ${step} failed:`, errMsg);
        // Rate limit errors do NOT count toward frustration failsafe
        if (!isRateLimited) {
          consecutiveFailures++;
        } else {
          console.log(`[Explore] Step ${step}: rate limit error — NOT counting toward failure threshold`);
        }
        stepLog.push({
          step,
          action: { type: 'think', description: 'AI decision' },
          result: { success: false, isRateLimited, failureReason: isRateLimited ? 'RATE_LIMITED' : isNetworkError ? 'NETWORK_ERROR' : 'AI_ERROR' },
          observation: `Think failed: ${userMsg}`,
        });
        await hudUpdate(currentTabId, `explore-${step}`, isRateLimited ? 'running' : 'error', userMsg);
        await updateExplorationProgress(step, maxSteps, userMsg, 'running');
        continue;
      }
      } // end if (!usedDeterministic)

      // ── Loop Detection: stop the AI from repeating the same action ──
      if (decision.nextAction && stepLog.length > 0) {
        const currType = decision.nextAction.type;
        const currTarget = decision.nextAction.target;

        // ── LAYER 3: Success-then-repeat circuit breaker ──
        // If the LAST action SUCCEEDED and the page changed (URL or content shift),
        // and the AI wants to repeat the same action TYPE — it likely already achieved the goal.
        // Example: clicked "New meeting" → meeting was created → AI wants to click "New meeting" again
        if (currType !== 'scrape_page' && currType !== 'scroll' && currType !== 'wait' && stepLog.length >= 1) {
          const lastEntry = stepLog[stepLog.length - 1];
          const lastSucceeded = lastEntry.result?.success !== false;
          const lastType = lastEntry.action?.type;
          const lastTarget = lastEntry.action?.target;

          if (!isStructuredMode && lastSucceeded && lastType === currType && lastTarget === currTarget) {
            // Exact same action+target after success — very likely the goal is done
            // (Disabled in structured mode — step advancement system handles completion)
            // Check if there's a completion hint already detected
            if (stepLog._completionHint) {
              console.warn(`[Explore] Step ${step}: SUCCESS-THEN-REPEAT detected: ${currType}(${currTarget}) after success + completion hint. Forcing goal completion check.`);
              // Force isGoalComplete — the AI is clearly confused
              decision.isGoalComplete = true;
              decision.goalResult = stepLog._completionHint.includes('Page says')
                ? `The action was completed successfully. ${lastEntry.observation || ''}`
                : `The action "${lastEntry.action?.description || lastType}" was completed successfully. ${lastEntry.observation || ''}`;
              decision.nextAction = null;
            }
          }
        }

        // Skip loop detection for non-interactive actions
        if (currType !== 'scrape_page' && currType !== 'scrape_table' && currType !== 'scroll' && currType !== 'wait' && currType !== 'resolve_element' && currType !== 'paste_tsv') {
          // Count consecutive repeats of the exact same action+target
          let repeatCount = 0;
          for (let ri = stepLog.length - 1; ri >= 0; ri--) {
            if (stepLog[ri].action?.type === currType && stepLog[ri].action?.target === currTarget) repeatCount++;
            else break;
          }
          repeatCount++; // include current attempt

          if (repeatCount >= 3) {
            console.warn(`[Explore] Step ${step}: LOOP DETECTED — ${currType}(${currTarget}) repeated ${repeatCount} times`);

            // ── CONTEXT-AWARE RECOVERY: Branch based on WHY we're stuck ──

            // BRANCH 1: Tab is dead/closed — fatal, don't retry
            let tabAlive = true;
            try {
              await chrome.tabs.get(currentTabId);
            } catch (tabErr) {
              const msg = tabErr.message || '';
              if (msg.includes('No tab with id')) {
                tabAlive = false;
              }
            }

            if (!tabAlive) {
              console.error(`[Explore] Step ${step}: TAB CLOSED — target tab ${currentTabId} no longer exists. Aborting.`);
              stepLog.push({
                step,
                action: { type: 'tab_lost', description: `Tab ${currentTabId} closed during exploration` },
                result: { success: false, failureReason: 'TAB_CLOSED' },
                observation: 'The target tab was closed or navigated away. Exploration cannot continue.',
              });
              cleanupLoop();
              return finishExploration({
                success: false,
                error: 'The target tab was closed. Please reopen the page and try again.',
                stepsUsed: step,
                creditsUsed,
                stepLog,
              });
            }

            // BRANCH 2: Modal is blocking — try Escape → click close → overlay click
            if (snapshot.hasOpenModal) {
              console.warn(`[Explore] Step ${step}: MODAL STUCK — attempting modal dismissal subroutine`);
              const { dismissed: modalDismissed, method: dismissMethod } = await tryDismissModal(snapshot, currentTabId, token);

              stepLog.push({
                step,
                action: { type: 'modal_break', description: `Modal stuck: ${currType}(${currTarget}) x${repeatCount}, dismissed=${modalDismissed} via ${dismissMethod}` },
                result: { success: modalDismissed, failureReason: modalDismissed ? null : 'MODAL_STUCK' },
                observation: modalDismissed
                  ? `Modal dismissed via ${dismissMethod}. Re-scanning page.`
                  : 'Modal could not be dismissed via Escape, close button, or overlay click.',
              });

              if (modalDismissed && snapshot?.url) {
                fetch(`${API_BASE}/api/sitemap/capture-action`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                  body: JSON.stringify({
                    url: snapshot.url, goal: 'dismiss_modal',
                    actionType: dismissMethod === 'escape' ? 'press_key' : 'click_element',
                    targetText: dismissMethod === 'escape' ? 'Escape' : 'Close',
                    targetRole: 'modal-dismiss',
                  }),
                }).catch(() => {});
              }

              decision.nextAction = {
                type: 'scrape_page',
                description: `Re-scanning after modal ${modalDismissed ? 'dismissal' : 'break attempt'}`,
              };
              decision.revisedStrategy = modalDismissed
                ? `Modal has been closed. Continue with the original goal. Do NOT re-open the same modal.`
                : `A modal/dialog is blocking the page and could not be dismissed. Navigate to a different URL or try a completely different approach to achieve the goal.`;
              if (!modalDismissed) consecutiveFailures++;
              continue;
            }

            // BRANCH 3: Default — no modal, tab alive. Original behavior: scroll + scrape.
            stepLog.push({
              step,
              action: { type: 'loop_break', description: `Loop detected: ${currType}(${currTarget}) x${repeatCount}` },
              result: { success: false, failureReason: 'ACTION_LOOP' },
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

          if (repeatCount >= 2 && currType !== 'type_text') {
            // EXCEPTION: type_text is allowed to retry — the AI may click first then re-type
            console.warn(`[Explore] Step ${step}: Blocked repeated ${currType}(${currTarget}), forcing scrape_page`);

            // If a modal is open, try to dismiss it NOW instead of just rescanning.
            // This saves 4+ steps compared to waiting for the 3x handler.
            if (snapshot.hasOpenModal) {
              console.log(`[Explore] Step ${step}: 2x repeat + modal detected — attempting early modal dismissal`);
              const { dismissed, method } = await tryDismissModal(snapshot, currentTabId, token);
              stepLog.push({
                step,
                action: { type: 'modal_break', description: `Early modal dismiss (2x repeat): ${dismissed ? method : 'failed'}` },
                result: { success: dismissed, failureReason: dismissed ? null : 'MODAL_STUCK' },
                observation: dismissed
                  ? `Modal dismissed via ${method} (caught at 2x repeat). Re-scanning.`
                  : 'Modal could not be dismissed. Re-scanning page.',
              });
              if (dismissed) {
                decision.revisedStrategy = `Modal has been closed. Continue with the original goal. Do NOT re-open the same modal.`;
              }
            }

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

          // Detect repeated type_text failures — tracked PER TARGET, not globally.
          // Failing on field A should NOT count against field B.
          // After 2 failures on SAME target: inject hint to click first
          // After 3 failures on SAME target: try splitting text into smaller chunks
          // After 5 failures on SAME target: give up and present text for copy-paste
          if (currType === 'type_text') {
            const targetId = currTarget || 'unknown';
            const targetFailures = stepLog.filter(s =>
              s.action?.type === 'type_text' && s.action?.target === targetId && s.result?.success === false
            ).length;
            const totalTypeFailures = stepLog.filter(s =>
              s.action?.type === 'type_text' && s.result?.success === false
            ).length;

            if (targetFailures >= 5 || totalTypeFailures >= 8) {
              // Per-target: 5 failures = this specific field is truly resistant
              // Global: 8 failures across ALL fields = the whole page is problematic
              const failMsg = targetFailures >= 5
                ? `type_text failed ${targetFailures} times on "${targetId}"`
                : `type_text failed ${totalTypeFailures} times total across fields`;
              console.warn(`[Explore] Step ${step}: ${failMsg} — forcing goal complete with copy-paste fallback.`);
              const textValue = decision.nextAction.value || '';
              decision.isGoalComplete = true;
              decision.goalResult = `This page uses a rich text editor that blocks programmatic text input. Here is the content I prepared for you to copy and paste:\n\n${textValue || '(The text was not available — please type your content manually.)'}`;
              decision.nextAction = null;
            } else if (targetFailures >= 3) {
              // After 3 failures on same target: suggest trying a different element or splitting text
              console.warn(`[Explore] Step ${step}: type_text failed ${targetFailures} times on "${targetId}" — injecting alternative-approach hint`);
              decision.revisedStrategy = (decision.revisedStrategy || currentStrategy) +
                ` IMPORTANT: type_text has failed ${targetFailures} times on "${targetId}". Try these alternatives: (1) use click_element to click DIRECTLY inside the editor body, wait, then retry type_text. (2) Try targeting a DIFFERENT element — look for the actual contentEditable div or ProseMirror surface instead of the container. (3) Try typing a SHORT test string first (e.g., just "test") to verify the field accepts input at all.`;
            } else if (targetFailures >= 2) {
              // After 2 failures: inject click-first hint
              console.warn(`[Explore] Step ${step}: type_text failed twice on "${targetId}" — injecting click-first hint`);
              decision.revisedStrategy = (decision.revisedStrategy || currentStrategy) +
                ' IMPORTANT: type_text has failed twice on this target. Before retrying, use click_element on the exact target field to activate the editor cursor, wait a moment, then try type_text again with the same content.';
            }
          }
        }
      }

      // ── ENHANCED CYCLE DETECTION (Layer 3) ──
      // Detect cross-target cycles: A→B→C→A patterns (not just A→A repeats).
      // Also detect no-progress states where interactive actions don't change the page.
      if (decision.nextAction && stepLog.length >= 4) {
        // NOTE: 'navigate' intentionally excluded — multi-site workflows (e.g., Gmail→Excel→Gmail→Excel)
        // legitimately revisit the same URLs. Navigate is still protected by Layer 2 (3+ consecutive
        // repeats at line ~3529) and the frustration failsafe.
        const interactiveTypes = new Set(['click_element', 'type_text', 'select_option', 'fill_field', 'press_key']);
        const recentInteractive = stepLog
          .filter(s => interactiveTypes.has(s.action?.type))
          .slice(-6);

        if (recentInteractive.length >= 4) {
          // Build a signature sequence from recent interactive actions
          const signatures = recentInteractive.map(s => `${s.action.type}:${s.action.target || ''}`);
          const currentSig = `${decision.nextAction.type}:${decision.nextAction.target || ''}`;

          // Check for A→B→A→B or A→B→C→A cycles (look for current signature repeating in recent history)
          const cycleWindow = signatures.slice(-4);
          const matchesInWindow = cycleWindow.filter(s => s === currentSig).length;

          if (matchesInWindow >= 2) {
            // Current action appeared 2+ times in last 4 interactive steps = cross-target cycle
            console.warn(`[Explore] Step ${step}: CROSS-TARGET CYCLE detected — "${currentSig}" appeared ${matchesInWindow}x in last 4 interactive steps`);
            console.warn(`[Explore] Cycle pattern: [${cycleWindow.join(' → ')} → ${currentSig}]`);

            // Count total cycle blocks this phase
            const cycleBlocks = stepLog.filter(s => s.action?.type === 'cycle_break').length;

            if (cycleBlocks >= 3) {
              // Hard circuit breaker: 3 cycle blocks → force complete with partial answer
              console.warn(`[Explore] Step ${step}: HARD CIRCUIT BREAKER — ${cycleBlocks} cycle blocks, forcing goal complete`);
              const partialResults = stepLog
                .filter(s => s.observation && s.result?.success !== false)
                .map(s => s.observation)
                .slice(-3)
                .join(' | ');

              decision.isGoalComplete = true;
              const scratchpadSummary = dataBuffer ? `\n\nCollected data:\n${dataBuffer.slice(0, 2000)}` : '';
              decision.goalResult = `I was unable to fully complete this task due to a navigation cycle on this page. Here is what I found so far: ${partialResults || 'No data collected yet. The page may require manual interaction.'}${scratchpadSummary}`;
              decision.nextAction = null;
            } else {
              // Soft break: inject cycle-break step, force navigate or scrape
              stepLog.push({
                step,
                action: { type: 'cycle_break', description: `Cross-target cycle: ${currentSig} (block #${cycleBlocks + 1})` },
                result: { success: false, failureReason: 'CYCLE_DETECTED' },
                observation: `CYCLE BREAK: Agent is cycling between targets without progress. Pattern: [${cycleWindow.join(' → ')}]. Forcing fresh approach.`,
              });
              decision.nextAction = {
                type: 'scrape_page',
                description: `Re-scanning after cycle break (pattern: ${cycleWindow.slice(-2).join('→')})`,
              };
              // Build explicit list of cycling elements so AI knows exactly what to avoid
              const cycleAvoidList = [];
              for (const sig of [...new Set(cycleWindow)]) {
                const [, ...targetParts] = sig.split(':');
                const targetSid = targetParts.join(':');
                if (targetSid) {
                  const el = snapshot?.semanticElements?.find(e => e.sid === targetSid);
                  const elText = el?.text || el?.attrs?.ariaLabel || targetSid;
                  cycleAvoidList.push(`"${elText}" (${targetSid})`);
                }
              }
              const avoidStr = cycleAvoidList.length > 0
                ? ` DO NOT click any of these elements again: ${cycleAvoidList.join(', ')}.`
                : '';

              decision.revisedStrategy = (decision.revisedStrategy || currentStrategy) +
                ` CRITICAL: You are cycling between the same elements.${avoidStr} Take a COMPLETELY different approach — navigate to a different URL, scroll to find new elements, or mark the goal complete with what you have.`;
              consecutiveFailures++;

              // ── NEGATIVE SIGNAL: Record ALL elements in the cycle as failures ──
              // The cycle means these elements don't achieve the goal, even though
              // the clicks technically "succeeded". This teaches the SiteMap to
              // avoid these elements for this goal on future visits.
              if (snapshot?.url) {
                const cycleElements = new Set();
                for (const sig of cycleWindow) {
                  const target = sig.split(':').slice(1).join(':');
                  if (target) cycleElements.add(target);
                }
                // Also add the current action that triggered the cycle detection
                if (decision.nextAction?.target) cycleElements.add(currentSig.split(':').slice(1).join(':'));

                for (const targetSid of cycleElements) {
                  const targetEl = snapshot.semanticElements?.find(el => el.sid === targetSid);
                  const cycleTargetText = targetEl?.text || targetEl?.attrs?.ariaLabel || targetSid || '';
                  if (cycleTargetText) {
                    fetch(`${API_BASE}/api/sitemap/capture-action`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                      body: JSON.stringify({
                        url: snapshot.url,
                        goal: originalPrompt || goal,
                        actionType: 'click_element',
                        targetText: cycleTargetText.slice(0, 60),
                        targetRole: targetEl?.attrs?.role || targetEl?.type || null,
                        targetSection: targetEl?.section || null,
                        targetXPct: targetEl?.xPct ?? null,
                        targetYPct: targetEl?.yPct ?? null,
                        actionValue: null,
                        failed: true,
                      }),
                    }).then(r => {
                      if (r.ok) console.log(`[SiteAction] Negative signal from CYCLE: "${cycleTargetText.slice(0, 40)}" doesn't achieve goal`);
                    }).catch(() => {});
                  }
                }
              }
            }
          }
        }

        // No-change detector: if last 3 interactive actions all succeeded but page content
        // hash stayed the same (snapshot URL + element count), the agent is spinning in place
        if (decision.nextAction && recentInteractive.length >= 3) {
          const recentSuccessful = recentInteractive.filter(s => s.result?.success !== false).slice(-3);
          if (recentSuccessful.length >= 3) {
            // Check if all recent successful steps had similar page states
            const pageStates = recentSuccessful
              .map(s => s.observation || '')
              .filter(obs => !obs.includes('Navigated') && !obs.includes('new content'));
            if (pageStates.length >= 3) {
              // 3 actions without any navigation or new content = spinning
              const noChangeBlocks = stepLog.filter(s => s.action?.type === 'no_change_break').length;
              if (noChangeBlocks === 0) {
                // First time: warn and inject hint
                console.warn(`[Explore] Step ${step}: NO-CHANGE detected — 3 successful actions with no page state change`);
                stepLog.push({
                  step: -1,
                  action: { type: 'no_change_break', description: 'Page not changing despite actions' },
                  result: { success: false, failureReason: 'NO_PAGE_CHANGE' },
                  observation: 'WARNING: Multiple actions executed but page state unchanged. The information may already be visible, or a different approach is needed.',
                });
                decision.revisedStrategy = (decision.revisedStrategy || currentStrategy) +
                  ' The page is not changing despite your actions. CHECK: is the answer already visible in the page text? If yes, set isGoalComplete=true. If not, navigate to a different page.';
              }
            }
          }
        }
      }

      // ── STRUCTURED MODE: Capture structuredOutput and check step advancement ──
      if (isStructuredMode && structuredSteps && decision) {
        // Capture structuredOutput from AI response (key-value data for machine signals)
        if (decision.structuredOutput && typeof decision.structuredOutput === 'object' && decision.structuredOutput !== null) {
          structuredData = { ...structuredData, ...decision.structuredOutput };
          console.log(`[Explore] Step ${step}: structuredData updated — keys: [${Object.keys(structuredData).join(', ')}]`);
        }

        const currentStep = structuredSteps[currentStepIndex];
        if (currentStep) {
          const machineOk = checkMachineSignals(currentStep, snapshot, structuredData);
          const aiDone = decision.stepCompleted === true || decision.stepStatus === 'completed';
          const noAiSignals = !currentStep.successSignals?.ai?.length;

          console.log(`[Explore] ★ STEP ${currentStepIndex + 1}/${structuredSteps.length} CHECK: machineOk=${machineOk} | aiDone=${aiDone} | noAiSignals=${noAiSignals} | stepAttempts=${stepAttemptCount} | structuredDataKeys=[${Object.keys(structuredData)}] | currentURL=${(snapshot?.url || '').slice(0, 80)} | stepGoal="${currentStep.goal.slice(0, 50)}"`);

          // DUAL-SIGNAL: advance only when both agree (or no AI signals defined)
          if (machineOk && (aiDone || noAiSignals)) {
            // POST-CONDITION: verify declared outputs actually exist in structuredData
            const missingOutputs = (currentStep.outputs || []).filter(k => structuredData[k] == null || structuredData[k] === '');
            if (missingOutputs.length > 0) {
              console.warn(`[Explore] Step ${currentStepIndex + 1}: signals pass but outputs missing: [${missingOutputs}] — not advancing`);
              stepAttemptCount++;
            } else {
              console.log(`[Explore] Step ${currentStepIndex + 1}/${structuredSteps.length} COMPLETED: "${currentStep.goal}"`);
              currentStepIndex++;
              stepAttemptCount = 0;
              stepStartTime = Date.now();
              if (currentStepIndex >= structuredSteps.length) {
                decision.isGoalComplete = true;
                decision.goalResult = decision.goalResult || `All ${structuredSteps.length} steps completed successfully.`;
              }
            }
          } else if (aiDone && !machineOk) {
            // AI hallucinating completion — post-condition guard rejects
            console.warn(`[Explore] Step ${currentStepIndex + 1}: AI says complete but machine signals FAIL — continuing step`);
            stepAttemptCount++;
          } else {
            // Normal in-progress — check step-level timeout
            if (stepStartTime && (Date.now() - stepStartTime) > STEP_TIMEOUT_MS) {
              console.warn(`[Explore] Step ${currentStepIndex + 1} TIMEOUT (${STEP_TIMEOUT_MS}ms)`);
              stepAttemptCount = MAX_ATTEMPTS_PER_STEP; // Force bailout
            }
          }

          // Bailout logic: too many attempts on this step
          if (stepAttemptCount >= MAX_ATTEMPTS_PER_STEP && currentStepIndex < structuredSteps.length) {
            // Check if outputs already satisfied despite "failure"
            const alreadySatisfied = (currentStep.outputs || []).every(k => structuredData[k] != null && structuredData[k] !== '');
            if (alreadySatisfied) {
              console.log(`[Explore] Step ${currentStepIndex + 1}: outputs already satisfied despite attempts — advancing`);
              currentStepIndex++;
              stepAttemptCount = 0;
              stepStartTime = Date.now();
            } else {
              // Dependency-aware skip-or-stop
              const futureNeedsThis = structuredSteps.slice(currentStepIndex + 1)
                .some(s => (s.inputs || []).some(i => (currentStep.outputs || []).includes(i)));
              if (futureNeedsThis) {
                console.error(`[Explore] Step ${currentStepIndex + 1} STUCK — future steps depend on its outputs. Stopping.`);
                decision.isGoalComplete = true;
                decision.goalResult = `I got stuck on step ${currentStepIndex + 1}: "${currentStep.goal}". Future steps need data from this step, so I can't skip it.`;
              } else {
                console.warn(`[Explore] Step ${currentStepIndex + 1} STUCK — no dependencies, skipping to next step`);
                currentStepIndex++;
                stepAttemptCount = 0;
                stepStartTime = Date.now();
              }
            }
            // Check if all steps now complete after bailout advancement
            if (currentStepIndex >= structuredSteps.length && !decision.isGoalComplete) {
              decision.isGoalComplete = true;
              decision.goalResult = decision.goalResult || `All ${structuredSteps.length} steps completed.`;
            }
          }

          // Override premature goal completion: if AI sets isGoalComplete but we're not on the final step
          if (decision.isGoalComplete && currentStepIndex < structuredSteps.length) {
            console.warn(`[Explore] AI set isGoalComplete=true but only on step ${currentStepIndex + 1}/${structuredSteps.length} — overriding to false`);
            decision.isGoalComplete = false;
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

        // Non-login consent (e.g., posting, submitting, sending) — show consent card
        // The One-Inch Rule: agent does 99% of the work, user approves the final action
        await updateExplorationProgress(step, maxSteps,
          `Awaiting approval: ${decision.consentReason || 'Action requires approval'}`, 'consent');

        const consent = await hudConsent(currentTabId,
          decision.consentReason || 'The agent wants to perform an action. Approve to continue.');

        if (consent?.approved) {
          // User approved — tag the action so click_by_sid bypasses isDangerousClick
          console.log('[Explore] Consent approved for step', step, '— executing action');
          decision.nextAction.consentApproved = true;
          decision.needsConsent = false; // Clear so normal execution proceeds
          await hudUpdate(currentTabId, `explore-${step}`, 'processing',
            decision.nextAction?.description || 'Executing approved action...');

          // Fall through to normal action execution below
        } else {
          // User declined — skip this action and mark goal complete with current progress
          console.log('[Explore] Consent declined for step', step);
          stepLog.push({
            step,
            action: decision.nextAction,
            reasoning: decision.reasoning,
            result: { success: false, failureReason: 'CONSENT_DECLINED' },
            observation: `User declined consent: ${decision.consentReason}`,
          });
          await hudUpdate(currentTabId, `explore-${step}`, 'error',
            `Declined: ${decision.consentReason || 'Action not approved'}`);

          // End exploration — user chose not to proceed
          cleanupLoop();
          return finishExploration({
            success: true,
            goalResult: `Action paused by user. The form has been filled and is ready for manual submission. Reason for pause: ${decision.consentReason || 'User declined'}`,
            stepsUsed: step,
            creditsUsed,
            stepLog,
          });
        }
      }

      // Update strategy if revised (disabled in structured mode — step array is the authority)
      if (decision.revisedStrategy && !isStructuredMode) {
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
          result: { success: false, failureReason: 'NO_ACTION' },
          observation: 'AI did not provide a nextAction. Goal may need rephrasing.',
        });
        await hudUpdate(currentTabId, `explore-${step}`, 'error', 'No action from AI');
        await updateExplorationProgress(step, maxSteps, 'AI returned no action', 'running');
        continue;
      }

      // ── Scratchpad substitution: inject full dataBuffer for paste_tsv ──
      if (decision.nextAction?.type === 'paste_tsv' &&
          (!decision.nextAction?.value || decision.nextAction?.value === '__USE_SCRATCHPAD__')) {
        decision.nextAction.value = dataBuffer || '';
        console.log(`[Explore] Step ${step}: paste_tsv — substituted scratchpad data (${(dataBuffer || '').length} chars)`);
      }

      // ── SCRAPE-PAGE LOOP CIRCUIT BREAKER ─────────────────────────────────────
      // If the AI requests scrape_page 3+ consecutive times it is stuck in a defensive
      // loop (stale-element history makes it think re-scanning helps). It does NOT help:
      // takePageSnapshot() already runs at the top of every step, so element IDs are
      // always fresh when the AI receives them. Stop here to prevent unbounded credit burn.
      if (decision.nextAction.type === 'scrape_page') {
        consecutiveScrapeDecisions++;
      } else {
        consecutiveScrapeDecisions = 0;
      }
      if (consecutiveScrapeDecisions >= 3) {
        console.warn(`[Explore] Step ${step}: SCRAPE_LOOP — AI requested scrape_page ${consecutiveScrapeDecisions}× in a row. Stopping phase.`);
        await hudUpdate(currentTabId, `explore-${step}`, 'error', 'Stuck re-scanning — stopping');
        stepLog.push({
          step,
          action: { type: 'scrape_loop_break', description: `Consecutive scrape_page loop (${consecutiveScrapeDecisions}×)` },
          result: { success: false, failureReason: 'SCRAPE_LOOP' },
          observation: 'Agent requested scrape_page repeatedly without progress. Element IDs are already fresh each step via takePageSnapshot(). The page may need a different approach, a navigation to a new URL, or the task may be ambiguous.',
        });
        // Set consecutiveFailures ≥ 5 so stoppedDueToFailures=true after the loop,
        // which prevents auto-continuation into additional phases.
        consecutiveFailures = 5;
        break;
      }

      // ── STALE SID GUARD: Verify target element exists in current snapshot ──
      // If the AI references a SID that's not in the current snapshot, it's using a stale ID
      // from a previous step. Force a re-scrape instead of clicking the wrong element.
      const sidTargetActions = new Set(['click_element', 'type_text', 'read_element', 'select_option', 'press_key']);
      if (decision.nextAction.target && sidTargetActions.has(decision.nextAction.type) &&
          snapshot.semanticElements?.length > 0) {
        const targetSid = decision.nextAction.target;
        const matchingEl = snapshot.semanticElements.find(el => el.sid === targetSid);
        if (!matchingEl) {
          console.warn(`[Explore] Step ${step}: STALE SID "${targetSid}" not found in current snapshot (${snapshot.semanticElements.length} elements). Forcing scrape_page.`);
          stepLog.push({
            step,
            action: { type: 'stale_sid_guard', description: `Blocked stale SID: ${targetSid} for ${decision.nextAction.type}` },
            result: { success: false, failureReason: 'STALE_SID' },
            observation: `Element "${targetSid}" does not exist in the current page snapshot. The page likely changed since the last observation. Re-scanning the page.`,
          });
          decision.nextAction = {
            type: 'scrape_page',
            description: `Re-scanning after stale SID detection (${targetSid} not found)`,
          };
          decision.revisedStrategy = (decision.revisedStrategy || currentStrategy) +
            ` CRITICAL: You used a stale element ID "${targetSid}" that no longer exists. Use ONLY IDs from the CURRENT "Interactable Elements" list below. Never reuse IDs from previous steps.`;
          consecutiveFailures++;
          continue;
        }
      }

      // ── SPA STALENESS GUARD ──────────────────────────────────────
      // If onHistoryStateUpdated fired since the snapshot was taken, the DOM
      // has re-rendered and all element SIDs are new numbers. The existing
      // stale SID guard above only checks the OLD snapshot — it cannot catch
      // this race. Discard the stale decision and loop back for a fresh snapshot.
      // navigate/scrape_page/scroll/wait/press_key are exempt — they don't use SIDs.
      if (sidsStale &&
          decision.nextAction &&
          !['navigate', 'scrape_page', 'scroll', 'wait', 'press_key'].includes(decision.nextAction.type)) {
        console.warn(`[Explore] Step ${step}: SPA_STALE_GUARD — discarding stale ${decision.nextAction.type}(${decision.nextAction.target}). Retaking snapshot.`);
        sidsStale = false;
        stepLog.push({
          step,
          action: { type: 'spa_stale_guard', description: `SPA re-render: discarded stale ${decision.nextAction.type} on ${decision.nextAction.target}` },
          result: { success: false, failureReason: 'SPA_STALE' },
          observation: 'SPA navigation fired between snapshot and action. Element IDs were regenerated. Re-scanning page.',
        });
        continue; // loop back → takePageSnapshot() runs at top → fresh SIDs → new AI decision
      }

      // ── STEP-LOCK GUARDRAIL: Block actions that obviously belong to a future step ──
      if (isStructuredMode && structuredSteps && decision.nextAction) {
        const currentStep = structuredSteps[currentStepIndex];
        if (currentStep) {
          const goalText = (currentStep.goal || '').toLowerCase();
          const actionDesc = (decision.nextAction.description || '').toLowerCase();
          const isCreateStep = ['meeting', 'create', 'schedule', 'generate'].some(k => goalText.includes(k));
          const isCommsAction = ['compose', 'send email', 'write email', 'email body', 'to field', 'recipient'].some(k => actionDesc.includes(k));
          const isEmailStep = goalText.includes('email') || goalText.includes('compose') || goalText.includes('send');
          const isMeetingAction = actionDesc.includes('new meeting') || actionDesc.includes('create meeting') || actionDesc.includes('schedule meeting');

          if ((isCreateStep && isCommsAction) || (isEmailStep && isMeetingAction)) {
            console.warn(`[Explore] Step ${step}: STEP-LOCK — blocked "${actionDesc}" during step "${currentStep.goal.slice(0, 50)}"`);
            stepAttemptCount++;
            stepLog.push({
              step,
              action: { type: 'step_lock', description: `Blocked cross-step action: ${decision.nextAction.type}` },
              result: { success: false, failureReason: 'STEP_LOCK' },
              observation: `Action "${actionDesc}" blocked — it belongs to a future step. Current step: "${currentStep.goal}".`,
            });
            continue;
          }
        }
      }

      // ── PRE-SWITCH CAPTURE: Save current page content before navigating away ──
      // Safety net: if the AI issues a navigate action without setting extractedData,
      // and dataBuffer is empty, auto-capture the current page mainContent.
      // Prevents data loss for deictic prompts ("this email", "this page") where the
      // AI navigates to the target app before extracting the referenced content.
      if (decision.nextAction?.type === 'navigate' && !dataBuffer && snapshot?.mainContent?.trim()) {
        dataBuffer = `[Pre-switch capture from: ${snapshot.url || 'current page'}]\n${snapshot.mainContent}`.slice(0, DATA_BUFFER_MAX);
        console.log(`[Explore] Step ${step}: Pre-switch capture — ${dataBuffer.length} chars from ${snapshot.url || 'current page'}`);
      }

      const actionDesc = decision.nextAction.description || decision.nextAction.type || 'Action';
      await hudUpdate(currentTabId, `explore-${step}`, 'processing', actionDesc);
      await updateExplorationProgress(step, maxSteps, actionDesc, 'running');

      // ── LAYER 2: Capture pre-action snapshot for heuristic completion detection ──
      const preActionSnapshot = { url: snapshot.url, mainContent: snapshot.mainContent };

      // ── POST-CLICK DOM CHANGE: Capture baseline fingerprint for click_element actions ──
      // CSS-only clicks (spinner added, class toggled) produce an identical fingerprint
      // before and after the click. waitForDomStable would exit immediately (~450ms),
      // causing postActionSnapshot to capture the spinner state, not the loaded content.
      // Capture baseline now so waitForDomChange can poll until the fingerprint shifts.
      let preClickFingerprint = null;
      if (decision.nextAction?.type === 'click_element') {
        try {
          const fpMsg = await chrome.tabs.sendMessage(currentTabId, { type: 'explore_action', actionType: 'dom_fingerprint' });
          preClickFingerprint = fpMsg?.fingerprint || null;
        } catch (_) { /* non-blocking — fall through, waitForDomChange will be skipped */ }
      }

      const actionResult = await executeExploreActionWithHistory(currentTabId, decision.nextAction, token, step);

      // ── TAB SWIPE: Update currentTabId if navigate opened/switched to a different tab ──
      if (actionResult.newTabId && actionResult.newTabId !== currentTabId) {
        const oldTabId = currentTabId;
        currentTabId = actionResult.newTabId;
        console.log(`[Explore] Tab Swipe: exploration now tracking tab ${currentTabId} (was ${oldTabId})`);

        // Update webNavigation listeners to watch the new tab
        chrome.webNavigation.onCompleted.removeListener(navListener);
        chrome.webNavigation.onHistoryStateUpdated.removeListener(spaNavListener);

        // Re-create listeners with closure over the (now-updated) currentTabId
        // We need to use the variable directly since it's mutable
        const newNavListener = (details) => {
          if (details.tabId !== currentTabId || details.frameId !== 0) return;
          console.log('[Explore] webNavigation.onCompleted — re-injecting DOM scripts on', details.url);
          injectAndConfirm(currentTabId, 'content_explore.js').catch(() => {});
          chrome.scripting.executeScript({ target: { tabId: currentTabId }, files: [HUD_SCRIPT] }).catch(() => {});
        };
        const newSpaNavListener = (details) => {
          if (details.tabId !== currentTabId || details.frameId !== 0) return;
          console.log('[Explore] SPA navigation (onHistoryStateUpdated) — re-injecting DOM scripts on', details.url);
          injectAndConfirm(currentTabId, 'content_explore.js').catch(() => {});
          chrome.scripting.executeScript({ target: { tabId: currentTabId }, files: [HUD_SCRIPT] }).catch(() => {});
          sidsStale = true;
        };
        chrome.webNavigation.onCompleted.addListener(newNavListener);
        chrome.webNavigation.onHistoryStateUpdated.addListener(newSpaNavListener);

        // Patch cleanupLoop to remove the new listeners
        const origCleanup = cleanupLoop;
        cleanupLoop = function() {
          origCleanup();
          chrome.webNavigation.onCompleted.removeListener(newNavListener);
          chrome.webNavigation.onHistoryStateUpdated.removeListener(newSpaNavListener);
        };

        // Update explorationActive storage with new tabId
        try {
          await chrome.storage.session.set({
            explorationActive: { goal, maxSteps, tabId: currentTabId, startedAt: Date.now(), phase: currentPhase },
          });
        } catch (e) {
          console.warn('[Explore] Could not update explorationActive with new tabId:', e.message);
        }
      }

      // If navigation happened (explicit navigate OR click that triggered page change),
      // re-inject all scripts and restore HUD
      let clickCausedNavigation = false;
      if (decision.nextAction?.type === 'click_element' && actionResult.success) {
        try {
          // Wait for tab to finish loading after click (catches link clicks that trigger navigation)
          await waitForTabReady(currentTabId, 5000, { requireComplete: true });
          const postClickTab = await chrome.tabs.get(currentTabId);
          const preClickUrl = snapshot.url || '';
          const postClickUrl = postClickTab.url || '';
          // Compare origins + pathnames (ignore hash/query changes — those are SPA, not full nav)
          try {
            const pre = new URL(preClickUrl);
            const post = new URL(postClickUrl);
            clickCausedNavigation = (pre.origin + pre.pathname) !== (post.origin + post.pathname);
          } catch {
            clickCausedNavigation = preClickUrl !== postClickUrl;
          }
          if (clickCausedNavigation) {
            console.log(`[Explore] Step ${step}: click_element caused navigation: ${preClickUrl} → ${postClickUrl}`);
          }
        } catch {}
      }
      if ((decision.nextAction?.type === 'navigate' || clickCausedNavigation) && actionResult.success) {
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
        result: {
          success: actionResult.success,
          ...(actionResult.success ? {} : {
            failureReason: actionResult.blocked ? 'SECURITY_BLOCK'
              : actionResult.authGate ? 'AUTH_GATE'
              : (actionResult.errorType || 'ACTION_FAILED'),
          }),
        },
        observation: actionResult.observation || actionResult.error || '',
      });

      // ── SITEMAP: Capture fingerprint regardless of action outcome ──
      // The page structure is valid whether the action succeeded or failed.
      // Without this, the SiteMap never learns page layouts for sites where
      // the agent consistently struggles (icon-only buttons, shadow DOM, etc.).
      // Fires every 3 steps, non-blocking.
      if (step % 3 === 0 && snapshot?.semanticElements?.length > 0) {
        try {
          fetch(`${API_BASE}/api/sitemap/capture`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              url: snapshot.url,
              snapshot: {
                semanticElements: snapshot.semanticElements,
                mainContent: (snapshot.mainContent || '').slice(0, 500),
                title: snapshot.title,
                url: snapshot.url,
              },
              viewportWidth: snapshot.viewportWidth || 1920,
              viewportHeight: snapshot.viewportHeight || 1080,
              platformHints: snapshot.platformHints || {},
            }),
          }).then(r => {
            if (r.ok) console.log(`[SiteMap] Fingerprint captured for ${snapshot.url}`);
          }).catch(e => console.warn('[SiteMap] Capture failed (non-blocking):', e.message));
        } catch {}
      }

      if (actionResult.success) {
        consecutiveFailures = 0;
        await hudUpdate(currentTabId, `explore-${step}`, 'success', actionDesc);
        await updateExplorationProgress(step, maxSteps, `Done: ${actionDesc}`, 'running');

        // ── POST-CLICK DOM CHANGE: Wait for page to respond before snapshotting ──
        // If the click caused full navigation, waitForTabReady above already handled it.
        // For in-page responses (CSS spinner → content loads), poll until fingerprint shifts.
        if (preClickFingerprint && !clickCausedNavigation) {
          await waitForDomChange(currentTabId, preClickFingerprint);
        }

        // ── LAYER 2: Run heuristic completion detector after successful action ──
        // Takes a quick post-action snapshot and checks for completion signals.
        // The hint is passed to the next AI step call (Layer 1 STOP CHECK amplifies it).
        try {
          const postActionSnapshot = await takePageSnapshot(currentTabId);
          const hint = isStructuredMode ? null : detectGoalCompletionSignals(goal, preActionSnapshot, postActionSnapshot, decision.nextAction);
          if (hint) {
            // Store hint — it will be sent with the next explore-step API call
            stepLog._completionHint = hint;
            console.log(`[Explore] Step ${step}: COMPLETION HINT detected: ${hint}`);
          } else {
            stepLog._completionHint = null;
          }
        } catch (hintErr) {
          console.warn('[Explore] Completion hint check failed (non-blocking):', hintErr.message);
        }

        // ── SITEMAP: Record match outcome if we used deterministic path ──
        if (siteMapMatch?.id) {
          try {
            fetch(`${API_BASE}/api/sitemap/record-match`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ siteMapId: siteMapMatch.id, success: true }),
            }).catch(() => {});
          } catch {}
        }

        // ── SITEACTION PHASE 2: Capture successful goal→action mapping ──
        // Every successful interactive action gets recorded for future deterministic replay.
        // Non-interactive actions (scrape_page, scroll, wait) are excluded — they don't help with replay.
        const captureableActions = ['click_element', 'type_text', 'navigate', 'select_option', 'press_key'];
        if (decision.nextAction && captureableActions.includes(decision.nextAction.type) && snapshot?.url) {
          try {
            // Find the target element's details from the snapshot for richer matching
            const targetSid = decision.nextAction.target;
            const targetEl = snapshot.semanticElements?.find(el => el.sid === targetSid);
            const targetText = targetEl?.text || targetEl?.attrs?.ariaLabel || decision.nextAction.target || '';

            if (targetText) {
              fetch(`${API_BASE}/api/sitemap/capture-action`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({
                  url: snapshot.url,
                  goal: originalPrompt || goal,
                  actionType: decision.nextAction.type,
                  targetText: targetText.slice(0, 60),
                  targetRole: targetEl?.attrs?.role || targetEl?.type || null,
                  targetSection: targetEl?.section || null,
                  targetXPct: targetEl?.xPct ?? null,
                  targetYPct: targetEl?.yPct ?? null,
                  actionValue: decision.nextAction.value || null,
                }),
              }).then(r => {
                if (r.ok) console.log(`[SiteAction] Captured: ${decision.nextAction.type} on "${targetText.slice(0, 40)}" for goal="${(originalPrompt || goal).slice(0, 40)}"`);
              }).catch(e => console.warn('[SiteAction] Capture failed (non-blocking):', e.message));
            }
          } catch {}
        }

        // ── SITEACTION PHASE 2: Record deterministic replay success ──
        if (usedDeterministic && siteActionMatch?.id) {
          try {
            fetch(`${API_BASE}/api/sitemap/record-action`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ siteActionId: siteActionMatch.id, success: true }),
            }).catch(() => {});
          } catch {}
        }
      } else {
        consecutiveFailures++;

        // TAB CLOSED during action: abort immediately, don't waste iterations
        if (actionResult.errorType === 'TAB_CLOSED') {
          console.error(`[Explore] Step ${step}: tab closed during action execution. Aborting.`);
          cleanupLoop();
          return finishExploration({
            success: false,
            error: 'The target tab was closed. Please reopen the page and try again.',
            stepsUsed: step,
            creditsUsed,
            stepLog,
          });
        }

        await hudUpdate(currentTabId, `explore-${step}`, 'error',
          `Failed: ${actionResult.error || 'unknown error'}`);
        await updateExplorationProgress(step, maxSteps, `Failed: ${actionResult.error || actionDesc}`, 'running');

        // Record SiteMap match failure if deterministic path was used
        if (siteMapMatch?.id) {
          try {
            fetch(`${API_BASE}/api/sitemap/record-match`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ siteMapId: siteMapMatch.id, success: false }),
            }).catch(() => {});
          } catch {}
        }

        // ── SITEACTION PHASE 2: Record deterministic replay failure ──
        // If deterministic action failed, record it so confidence drops and we fall back to AI next time
        if (usedDeterministic && siteActionMatch?.id) {
          try {
            fetch(`${API_BASE}/api/sitemap/record-action`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ siteActionId: siteActionMatch.id, success: false }),
            }).catch(() => {});
          } catch {}
        }

        // ── NEGATIVE SIGNAL: Record failed AI-directed actions ──
        // Even when the AI picks an element and it fails, capture this as a negative signal.
        // This way the SiteMap learns "this element doesn't work for this goal" and future
        // visits can avoid the same mistake. Without this, persistent failures are invisible.
        if (!usedDeterministic && decision.nextAction && snapshot?.url) {
          const failCaptureActions = ['click_element', 'type_text', 'select_option', 'press_key'];
          if (failCaptureActions.includes(decision.nextAction.type)) {
            try {
              const targetSid = decision.nextAction.target;
              const targetEl = snapshot.semanticElements?.find(el => el.sid === targetSid);
              const failTargetText = targetEl?.text || targetEl?.attrs?.ariaLabel || decision.nextAction.target || '';
              if (failTargetText) {
                fetch(`${API_BASE}/api/sitemap/capture-action`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                  body: JSON.stringify({
                    url: snapshot.url,
                    goal: originalPrompt || goal,
                    actionType: decision.nextAction.type,
                    targetText: failTargetText.slice(0, 60),
                    targetRole: targetEl?.attrs?.role || targetEl?.type || null,
                    targetSection: targetEl?.section || null,
                    targetXPct: targetEl?.xPct ?? null,
                    targetYPct: targetEl?.yPct ?? null,
                    actionValue: decision.nextAction.value || null,
                    failed: true,
                  }),
                }).then(r => {
                  if (r.ok) console.log(`[SiteAction] Negative signal: ${decision.nextAction.type} on "${failTargetText.slice(0, 40)}" FAILED`);
                }).catch(() => {});
              }
            } catch {}
          }
        }
      }

      // Dynamic pause between steps — use DOM stability detection for clicks
      const wasClick = decision.nextAction?.type === 'click_element';
      if (wasClick && actionResult.success) {
        // After a click, wait for DOM to stabilize (dropdowns/menus may render with animation)
        await waitForDomStable(currentTabId, 2500, 300);
      } else {
        // Non-click actions: brief fixed pause
        await new Promise(r => setTimeout(r, 800));
      }
    }

    // Max steps reached or stopped
    cleanupLoop();

    const stoppedDueToFailures = consecutiveFailures >= 5;

    // ── LAYER 4: Auto-continuation gate ──
    // Before auto-continuing, check if the phase's step log contains evidence
    // that the goal was already achieved (even though isGoalComplete was never set).
    // This prevents wasting entire phases on goals that were done mid-phase.
    if (!stoppedDueToFailures && !isStructuredMode && phaseContainsCompletionEvidence(stepLog, goal)) {
      console.log('[Explore] LAYER 4 GATE: Phase contains completion evidence — NOT auto-continuing.');
      cleanupLoop();
      const successObservations = stepLog
        .filter(s => s.observation && s.result?.success)
        .map(s => s.observation)
        .join('\n');
      await updateExplorationProgress(maxSteps, maxSteps, 'Goal likely achieved — stopping.', 'complete');
      return finishExploration({
        success: true,
        goalResult: successObservations || 'The task appears to have been completed successfully.',
        stepsUsed: totalStepsAcrossPhases + stepLog.length,
        creditsUsed,
        stepLog,
      });
    }

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
        dataBuffer: dataBuffer || undefined,
        // Structured mode: carry remaining steps and data across phases
        ...(isStructuredMode && structuredSteps ? {
          remainingSteps: structuredSteps.slice(currentStepIndex),
          completedSteps: structuredSteps.slice(0, currentStepIndex),
          structuredData,
        } : {}),
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

  // Fetch Tier 1 memory so the AI knows who to fill the form for.
  // Converts [{ key, value }] array to a flat { name, email, ... } object.
  const memory = await getOrRefreshMemory().catch(() => null);
  const userProfile = {};
  if (memory?.tier1 && Array.isArray(memory.tier1)) {
    for (const fact of memory.tier1) {
      if (fact.key && fact.value != null) userProfile[fact.key] = fact.value;
    }
  }

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
      userProfile,
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
    await waitForDomStable(tabId, 3000); // Dynamic wait — resolves when DOM stops changing
    pageStateAfter = await scrapePageState(tabId);
    setTimeout(() => hudHide(tabId), 1500);
  }

  // Step 5: Read-back verification — compare actual DOM values against intended
  // Builds a per-field report so callers know exactly what landed vs what was asked.
  const fillActions = resolvedActions.filter(a => a.action === 'fill_field');
  let fillReport = [];
  if (fillActions.length > 0) {
    const readBack = await chrome.scripting.executeScript({
      target: { tabId },
      func: (fillSteps) => {
        return fillSteps.map(step => {
          const el = document.querySelector(step.selector);
          if (!el) return { selector: step.selector, intended: step.value || '', actual: null, matched: false };
          let actual;
          if (el.isContentEditable) {
            actual = (el.innerText || el.textContent || '').trim();
          } else if (el.type === 'checkbox' || el.type === 'radio') {
            actual = el.checked ? 'true' : 'false';
          } else {
            actual = (el.value || '').trim();
          }
          const intended = (step.value || '').trim();
          return { selector: step.selector, intended, actual, matched: actual === intended };
        });
      },
      args: [fillActions],
    }).catch(() => null);
    fillReport = readBack?.[0]?.result || [];
  }

  return {
    success: allSuccess,
    results,
    actionsPlanned: actions.length,
    actionsExecuted: results.length,
    fillReport,
    pageStateAfter,
  };
}

// ── Build Recipe from Centralized Session ─────────────────────
// Called when recording stops. Transforms the raw step log into
// a clean recipe ready for review and saving.

function normalizeRecipeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Variable-by-Default classification for recipe type steps.
 * ALL short typed values are dynamic variables by default.
 * Only narrow exclusions: password/hidden fields stay fixed.
 *
 * Returns: 'email_variable' | 'search_variable' | 'llm_fill' | 'fixed' | 'skip'
 */
function classifyTypeStep(step) {
  const action = step?.action || {};
  if (action.type !== 'type') return 'skip';
  if (action.inputType !== 'fixed' && action.inputType !== undefined) return 'skip';

  const value = normalizeRecipeText(action.fixedValue);
  if (!value) return 'skip';

  // 1. Password or hidden fields: NEVER substitute
  const fieldType = (action.semanticContext?.type || '').toLowerCase();
  if (fieldType === 'password' || fieldType === 'hidden') return 'fixed';

  // 2. Value contains @: email recipient variable
  if (value.includes('@')) return 'email_variable';

  // 3. ContentEditable fields: always LLM fill (rich text editors like Gmail compose)
  const isContentEditable = action.semanticContext?.contentEditable === true ||
    /contenteditable/i.test(JSON.stringify(action.semanticContext || {}));
  if (isContentEditable) return 'llm_fill';

  // 4. Short plain text (<=6 words): search query variable — UNCONDITIONALLY
  const wordCount = value.split(/\s+/).length;
  if (wordCount <= 6) return 'search_variable';

  // 5. Long text (>6 words): LLM fill
  return 'llm_fill';
}

function buildLlmPromptForStep(step) {
  const action = step.action || {};
  const sample = normalizeRecipeText(action.fixedValue).slice(0, 240);
  const label = normalizeRecipeText(
    action.semanticContext?.label ||
    action.semanticContext?.ariaLabel ||
    action.semanticContext?.placeholder ||
    action.description ||
    'this field'
  );
  const lower = label.toLowerCase();

  if (/(subject|headline|title)/i.test(lower)) {
    return `Write a concise ${label}. Follow the current task context first. Keep it short and natural. Ignore the original example if it conflicts with the current task. Original example style only: "${sample}"`;
  }

  if (/(message body|body|reply|comment|description|summary|post|caption|content|notes?|prompt|email)/i.test(lower)) {
    return `Write the ${label}. Follow the current task context first and use visible page context only as secondary reference. Ignore the original example if it conflicts with the current task. Original example style only: "${sample}"`;
  }

  return `Generate text for ${label}. Follow the current task context first. Use the original example only as a loose style hint, never as the source of facts or topic: "${sample}"`;
}

function upgradeRecipeStepForReplay(step, stepNumber) {
  const upgraded = {
    ...step,
    action: step?.action ? { ...step.action } : step.action,
    stepNumber: stepNumber || step.stepNumber,
  };

  const classification = classifyTypeStep(upgraded);

  if (classification !== 'skip' && classification !== 'fixed') {
    const normalizedValue = normalizeRecipeText(upgraded.action.fixedValue);
    if (!normalizedValue) return null;
    upgraded.action.fixedValue = normalizedValue;

    switch (classification) {
      case 'email_variable':
        upgraded.action = {
          ...upgraded.action,
          inputType: 'variable',
          variableName: '__recipient_email',
          originalFixedValue: normalizedValue,
        };
        delete upgraded.action.fixedValue;
        break;

      case 'search_variable':
        upgraded.action = {
          ...upgraded.action,
          inputType: 'variable',
          variableName: '__search_query',
          originalFixedValue: normalizedValue,
        };
        delete upgraded.action.fixedValue;
        break;

      case 'llm_fill': {
        const llmPrompt = buildLlmPromptForStep(upgraded);
        upgraded.action = {
          ...upgraded.action,
          type: 'llm_fill',
          llmPrompt,
          variableDescription: llmPrompt,
          contextVariables: ['__task_context', '__workflow_name'],
        };
        delete upgraded.action.fixedValue;
        delete upgraded.action.inputType;
        delete upgraded.action.variableName;
        break;
      }
    }
  }

  if (upgraded.action?.type === 'llm_fill') {
    const existing = Array.isArray(upgraded.action.contextVariables) ? upgraded.action.contextVariables : [];
    upgraded.action.contextVariables = [...new Set([...existing, '__task_context', '__workflow_name'])];
  }

  return upgraded;
}

function upgradeRecipeForReplay(recipe) {
  if (!recipe || !Array.isArray(recipe.steps)) return recipe;

  const upgradedSteps = recipe.steps
    .map((step, index) => upgradeRecipeStepForReplay(step, index + 1))
    .filter(Boolean)
    .map((step, index) => ({ ...step, stepNumber: index + 1 }));

  return {
    ...recipe,
    steps: upgradedSteps,
    stepCount: upgradedSteps.length,
  };
}

function hasOpaqueUrlParts(urlString) {
  try {
    const url = new URL(urlString);
    const combined = `${url.pathname} ${url.search} ${url.hash}`;
    return /[A-Za-z0-9_-]{20,}/.test(combined);
  } catch {
    return false;
  }
}

function getNormalizedPathSignature(urlString) {
  try {
    const url = new URL(urlString);
    const params = Array.from(url.searchParams.keys()).sort().join('&');
    return `${url.pathname}${params ? '?' + params : ''}${url.hash || ''}`;
  } catch {
    return urlString || '';
  }
}

function shouldKeepSameDomainNavigate(step, session, previousKeptStep) {
  if (step?.action?.type !== 'navigate' || !step.action.url || !session?.startDomain) {
    return true;
  }

  try {
    const navUrl = new URL(step.action.url);
    const navDomain = navUrl.hostname.replace(/^www\./, '').toLowerCase();
    const startDomain = session.startDomain.replace(/^www\./, '').toLowerCase();
    if (navDomain !== startDomain) return true;

    const currentSignature = getNormalizedPathSignature(step.action.url);
    const startSignature = getNormalizedPathSignature(session.startUrl || '');
    const previousSignature = previousKeptStep?.action?.url
      ? getNormalizedPathSignature(previousKeptStep.action.url)
      : null;

    const meaningfulPathChange = currentSignature && currentSignature !== startSignature;
    const changedSincePrevious = currentSignature && currentSignature !== previousSignature;
    const volatileUrl = hasOpaqueUrlParts(step.action.url);
    const samePageNoise = !meaningfulPathChange || !changedSincePrevious;

    // Keep stable intra-app routes (e.g. /settings/usage), but drop
    // volatile draft/token URLs and duplicate same-page SPA churn.
    if (volatileUrl && samePageNoise) return false;
    if (volatileUrl && step.action.autoDetected && previousKeptStep?.action?.type === 'click') return false;
    if (!meaningfulPathChange && step.action.autoDetected) return false;

    return true;
  } catch {
    return true;
  }
}

function buildRecipeFromSession(session) {
  const steps = session.steps;

  // Extract variable declarations
  const variables = [];
  const seenVars = new Set();

  for (const step of steps) {
    if (step.action.inputType === 'variable' && step.action.variableName) {
      if (!seenVars.has(step.action.variableName)) {
        seenVars.add(step.action.variableName);
        variables.push({
          name: step.action.variableName,
          description: step.action.variableDescription || `Value for ${step.action.variableName}`,
          fieldType: 'text',
        });
      }
    }
  }

  // Clean up steps: remove redundant consecutive scrolls, strip internals,
  // filter out same-domain SPA navigations (e.g., Gmail compose URL change), reindex
  const cleanedSteps = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Skip consecutive scroll events (keep only the last one)
    if (step.action.type === 'scroll' && i + 1 < steps.length && steps[i + 1].action.type === 'scroll') {
      continue;
    }

    const previousKeptStep = cleanedSteps[cleanedSteps.length - 1];

    if (step.action.type === 'navigate' && step.action.url && session.startDomain) {
      if (!shouldKeepSameDomainNavigate(step, session, previousKeptStep)) {
        console.log('[Learning] Skipping volatile same-domain SPA navigate step:', step.action.url);
        continue;
      }

      if (previousKeptStep?.action?.type === 'navigate' && previousKeptStep.action.url === step.action.url) {
        console.log('[Learning] Skipping duplicate navigate step:', step.action.url);
        continue;
      }
    }

    // Strip internal tracking fields
    const { _elementKey, tabId, ...cleanStep } = step;

    if (cleanStep.action?.type === 'type' && cleanStep.action?.inputType === 'fixed') {
      const normalizedValue = normalizeRecipeText(cleanStep.action.fixedValue);
      if (!normalizedValue) {
        continue;
      }
      cleanStep.action.fixedValue = normalizedValue;

      const classification = classifyTypeStep(cleanStep);
      if (classification !== 'fixed' && classification !== 'skip') {
        const upgradedStep = upgradeRecipeStepForReplay(cleanStep, cleanedSteps.length + 1);
        if (!upgradedStep) continue;
        cleanStep.action = upgradedStep.action;
      }
    }

    cleanedSteps.push({
      ...cleanStep,
      stepNumber: cleanedSteps.length + 1,
    });
  }

  // After cleanup, collect any new variables introduced by auto-upgrade (e.g., __search_query)
  for (const step of cleanedSteps) {
    if (step.action?.inputType === 'variable' && step.action.variableName) {
      if (!seenVars.has(step.action.variableName)) {
        seenVars.add(step.action.variableName);
        variables.push({
          name: step.action.variableName,
          description: step.action.variableDescription || `Value for ${step.action.variableName}`,
          fieldType: 'text',
        });
      }
    }
  }

  // Collect all unique domains touched
  const allDomains = [...new Set(Object.values(session.tabDomains))];

  // Ensure the recipe always starts with a navigate step so replay knows WHERE to go.
  // If the user started recording while already on a page (not from empty tab),
  // the first step is an action (click/type), not a navigate. Add an implicit one.
  if (session.startUrl && cleanedSteps.length > 0 && cleanedSteps[0].action?.type !== 'navigate') {
    cleanedSteps.unshift({
      stepNumber: 0,
      action: {
        type: 'navigate',
        url: session.startUrl,
        waitFor: 'load',
        description: `Navigate to ${session.startDomain || 'start page'}`,
        isImplicit: true, // System-generated, not user-recorded
      },
      url: session.startUrl,
      timestamp: session.startedAt,
    });
    // Re-number all steps
    cleanedSteps.forEach((step, idx) => { step.stepNumber = idx + 1; });
  }

  return {
    workflowName: session.workflowName,
    siteDomain: session.startDomain,
    siteDomains: allDomains,
    isMultiTab: allDomains.length > 1,
    startUrl: session.startUrl,
    contractVersion: '1.0',
    steps: cleanedSteps,
    variables,
    metadata: {
      totalSteps: cleanedSteps.length,
      trainedAt: new Date().toISOString(),
      estimatedDuration: cleanedSteps.length > 0
        ? cleanedSteps[cleanedSteps.length - 1].timestamp - cleanedSteps[0].timestamp
        : 0,
    },
  };
}

// ── Multi-Tab Replay Helpers ──────────────────────────────────

// Split recipe steps into segments by switch_tab boundaries.
// Each segment has: { switchTo: { domain, url } | null, steps: [...] }
// The first segment has switchTo: null (runs on the current tab).
function splitIntoSegments(steps) {
  const segments = [];
  let currentSegment = { switchTo: null, steps: [] };

  for (const step of steps) {
    if (step.action.type === 'switch_tab') {
      // End current segment (if it has steps), start a new one
      if (currentSegment.steps.length > 0) {
        segments.push(currentSegment);
      }
      currentSegment = {
        switchTo: {
          domain: step.action.targetDomain,
          url: step.action.targetUrl,
        },
        steps: [],
      };
    } else {
      const previousStep = currentSegment.steps[currentSegment.steps.length - 1];
      if (previousStep?.action?.type === 'navigate' && step.action.type === 'navigate') {
        currentSegment.steps[currentSegment.steps.length - 1] = step;
      } else {
        currentSegment.steps.push(step);
      }
    }
  }

  // Push the last segment
  if (currentSegment.steps.length > 0) {
    segments.push(currentSegment);
  }

  return segments;
}

function getLearningTabUrl(tab) {
  return tab?.pendingUrl || tab?.url || '';
}

function isInjectableLearningUrl(url) {
  return !!url &&
    !url.startsWith('chrome://') &&
    !url.startsWith('chrome-extension://') &&
    !url.startsWith('about:');
}

function hasRecentLearningSwitch(session, tabId, url) {
  const lastStep = session?.steps?.[session.steps.length - 1];
  return lastStep?.action?.type === 'switch_tab' &&
    lastStep.tabId === tabId &&
    lastStep.action.targetUrl === url &&
    Date.now() - lastStep.timestamp < 3000;
}

async function waitForInjectableLearningUrl(tabId, maxWaitMs = 4000) {
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const url = getLearningTabUrl(tab);
      if (isInjectableLearningUrl(url)) {
        return { tab, url };
      }
    } catch {
      return null;
    }

    await new Promise(r => setTimeout(r, 200));
  }

  return null;
}

async function resumeLearningOnTab(tabId, stepCount) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content_learning.js'],
  });
  await new Promise(r => setTimeout(r, 200));

  let statusRes;
  try {
    statusRes = await chrome.tabs.sendMessage(tabId, { type: 'learning_status' });
  } catch {
    statusRes = null;
  }

  if (statusRes?.isRecording) {
    console.log('[Learning] Content script already active on tab', tabId);
    return true;
  }

  await chrome.tabs.sendMessage(tabId, { type: 'learning_resume', stepCount });
  console.log('[Learning] Recorder injected and resumed on tab', tabId);
  return true;
}

async function finalizeLearningTabSwitch(session, oldTabId, newTabId, newUrl, source = 'tabs.onActivated') {
  if (!session?.active || !newTabId || !isInjectableLearningUrl(newUrl)) return false;

  if (newTabId === oldTabId && session.activeTabId === newTabId) {
    return false;
  }

  if (hasRecentLearningSwitch(session, newTabId, newUrl)) {
    session.activeTabId = newTabId;
    session.tabDomains[newTabId] = new URL(newUrl).hostname.replace(/^www\./, '').toLowerCase();
    await chrome.storage.session.set({ learningSession: session });
    learningPendingSwitch = null;
    return true;
  }

  console.log('[Learning] Tab switch detected via', source + ':', oldTabId, '→', newTabId, '(', newUrl, ')');

  if (oldTabId) {
    try {
      await chrome.tabs.sendMessage(oldTabId, { type: 'learning_pause' });
    } catch {
      // Old tab may have been closed or navigated away
    }
  }

  const newDomain = new URL(newUrl).hostname.replace(/^www\./, '').toLowerCase();
  session.steps.push({
    stepNumber: ++session.stepCounter,
    action: {
      type: 'switch_tab',
      targetUrl: newUrl,
      targetDomain: newDomain,
      matchStrategy: 'domain',
      description: `Switch to ${newDomain}`,
    },
    url: newUrl,
    timestamp: Date.now(),
    tabId: newTabId,
  });

  session.activeTabId = newTabId;
  session.tabDomains[newTabId] = newDomain;
  await chrome.storage.session.set({ learningSession: session });
  learningPendingSwitch = null;

  try {
    await resumeLearningOnTab(newTabId, session.stepCounter);
  } catch (err) {
    console.warn('[Learning] Failed to inject into new tab:', err.message);
  }

  return true;
}

// Find an existing tab by domain, or create a new one.
// Returns tabId or null.
async function findTabByDomain(domain, fallbackUrl) {
  try {
    const allTabs = await chrome.tabs.query({ currentWindow: true });

    // Pass 1: exact URL match (best case — tab already has the right page)
    if (fallbackUrl) {
      for (const tab of allTabs) {
        if (!tab.url) continue;
        try {
          if (new URL(tab.url).href === new URL(fallbackUrl).href) {
            console.log('[Learning] Found exact URL match for', fallbackUrl, '→ tab', tab.id);
            return tab.id;
          }
        } catch {}
      }
    }

    // Pass 2: domain match (good enough — recipe will navigate within the site)
    for (const tab of allTabs) {
      if (!tab.url) continue;
      try {
        const tabDomain = new URL(tab.url).hostname.replace(/^www\./, '').toLowerCase();
        if (tabDomain === domain) {
          // Skip tabs that are on login/auth pages — they need fresh navigation
          const tabPath = new URL(tab.url).pathname.toLowerCase();
          const isAuthPage = /\/(signin|sign-in|login|log-in|register|signup|sign-up|auth|oauth|sso)\b/.test(tabPath);
          if (isAuthPage) {
            console.log('[Learning] Skipping auth-page tab for', domain, '→ tab', tab.id);
            continue;
          }
          console.log('[Learning] Found domain match for', domain, '→ tab', tab.id);
          return tab.id;
        }
      } catch {}
    }

    // Pass 3: no existing tab found — open the fallback URL in a new tab
    if (fallbackUrl) {
      console.log('[Learning] No tab found for', domain, '— opening:', fallbackUrl);
      const newTab = await chrome.tabs.create({ url: fallbackUrl, active: true });

      // Wait for the tab to finish loading
      await new Promise((resolve) => {
        const checkReady = (tabId, changeInfo) => {
          if (tabId === newTab.id && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(checkReady);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(checkReady);
        // Safety timeout
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(checkReady);
          resolve();
        }, 10000);
      });

      return newTab.id;
    }

    console.warn('[Learning] No tab found for domain:', domain);
    return null;
  } catch (err) {
    console.error('[Learning] findTabByDomain error:', err.message);
    return null;
  }
}

// --- Central Message Handler ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Timeout guard: if handleMessage takes longer than the limit, send an error response
  // so the message channel doesn't hang open indefinitely (causing "message channel closed" warnings).
  let responded = false;
  const safeRespond = (result) => {
    if (responded) return; // Only send once
    responded = true;
    try { sendResponse(result); } catch (_) { /* channel already closed */ }
  };

  // Long-running handlers get extended timeouts
  const LONG_RUNNING_TYPES = [
    'learning_replay_recipe',
    'explore_start',
    'explore_resume',
    'process_request',
    'process_request_skip_recipe',
  ];
  const timeoutMs = LONG_RUNNING_TYPES.includes(request.type) ? 300000 : 30000; // 5 min for replays/explore, 30s for others

  const timeoutId = setTimeout(() => {
    if (!responded) {
      console.warn(`[BG_TIMEOUT] Handler for '${request.type}' exceeded ${timeoutMs / 1000}s — sending timeout response.`);
      safeRespond({
        success: false,
        errorType: 'BACKEND_TIMEOUT',
        error: `Handler for '${request.type}' timed out after ${timeoutMs / 1000} seconds. The operation may still be running in the background.`,
      });
    }
  }, timeoutMs);

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

// ── Personal-info signal detection ───────────────────────────────────────────
// Returns true when the text likely contains personal information worth
// harvesting into Tier 1 memory (name, phone, address, email, location move).
function containsPersonalInfo(text) {
  if (!text || text.length < 8) return false;
  // 7-digit or 10-digit phone number patterns (e.g., 555-9876, 555-867-5309)
  if (/\b\d{3}[-.\s]\d{4}\b|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/.test(text)) return true;
  // "my [optional word] phone/email/address/number/name" — e.g. "my work phone", "my email"
  if (/\bmy\s+(\w+\s+)?(phone|email|address|number|name|mobile|cell|city|location)\b/i.test(text)) return true;
  // Location change signals — e.g. "just moved to Vancouver", "I live in London"
  if (/\b(moved\s+to|just\s+moved|i\s+live\s+in|living\s+in|i'm\s+from|i\s+am\s+from)\b/i.test(text)) return true;
  // Bare email address in text
  if (/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i.test(text)) return true;
  return false;
}

async function handleMessage(request, sender) {

  // ── DELEGATE AUTOFILL RELAY ──────────────────────────────────────────────────
  // Content scripts (dashboard_bridge.js) can only sendMessage to the service worker
  // in MV3 — they cannot reach extension pages (side panel) directly. This handler
  // receives enh_delegate_autofill from the content script and re-sends it from the
  // service worker, which CAN reach the side panel's onMessage listener.
  if (request.type === 'enh_delegate_autofill') {
    let relayed = false;
    try {
      await chrome.runtime.sendMessage({ type: 'enh_delegate_autofill', payload: request.payload });
      relayed = true;
    } catch { /* side panel not open — pendingDelegation in storage handles fallback */ }
    return { success: true, ok: relayed };
  }

  // ── CDP INSERT TEXT: Universal text insertion via Chrome DevTools Protocol ──
  // Used as Tier 3 fallback when DOM-based methods (execCommand, ClipboardEvent)
  // fail on canvas-based editors (Word Online, Google Docs) or heavily sandboxed
  // editors. Generates TRUSTED input events at the browser level.
  // Enhanced: clicks center of text area first to activate focus trap (Word Online).
  if (request.type === 'cdp_insert_text') {
    const tabId = sender?.tab?.id;
    if (!tabId || !request.text) {
      return { success: false, error: 'Missing tabId or text for CDP insertion' };
    }
    try {
      const target = { tabId };
      await chrome.debugger.attach(target, '1.3');

      // ── ELEMENT-SPECIFIC FOCUS ──
      // If the content script passed element coordinates, click that exact position
      // to ensure the correct editor surface has focus before typing.
      // Falls back to viewport center if no coordinates provided (canvas editors).
      try {
        let clickX, clickY;
        if (request.elementRect?.x && request.elementRect?.y) {
          // Click the exact center of the target element
          clickX = request.elementRect.x;
          clickY = request.elementRect.y;
          console.log('[CDP] Clicking element center at', clickX, clickY);
        } else {
          // Fallback: check if anything is focused, click center if not
          const { result: hasFocusedInput } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
            expression: `!!document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.isContentEditable)`,
            returnByValue: true,
          });
          if (hasFocusedInput?.value) {
            clickX = null; // already focused, no click needed
          } else {
            const { result: dims } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
              expression: `JSON.stringify({ w: window.innerWidth, h: window.innerHeight })`,
              returnByValue: true,
            });
            const { w, h } = JSON.parse(dims?.value || '{"w":960,"h":540}');
            clickX = Math.round(w / 2);
            clickY = Math.round(h / 2);
            console.log('[CDP] No focused input — clicking viewport center', clickX, clickY);
          }
        }
        if (clickX != null) {
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1,
          });
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1,
          });
          await new Promise(r => setTimeout(r, 150));
        }
      } catch (focusErr) {
        console.warn('[CDP] Focus detection failed (non-fatal):', focusErr.message);
      }

      await chrome.debugger.sendCommand(target, 'Input.insertText', { text: request.text });
      await chrome.debugger.detach(target);
      return { success: true };
    } catch (err) {
      try { await chrome.debugger.detach({ tabId }); } catch (_) {}
      console.warn('[CDP] Input.insertText failed:', err.message);
      return { success: false, error: err.message };
    }
  }

  // ── CDP PASTE: Trusted Ctrl+V via DevTools Protocol ──
  // Tier 2a: Sends a real Ctrl+V keystroke. The content script writes text to
  // the system clipboard first, then this handler triggers a trusted paste.
  // This is the most reliable method for ProseMirror (Reddit, Notion, TipTap)
  // because the editor sees a real paste event with real clipboard data.
  if (request.type === 'cdp_paste') {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      return { success: false, error: 'Missing tabId for CDP paste' };
    }
    try {
      const target = { tabId };
      await chrome.debugger.attach(target, '1.3');

      // Click the element to ensure focus (if coordinates provided)
      if (request.elementRect?.x && request.elementRect?.y) {
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: request.elementRect.x, y: request.elementRect.y, button: 'left', clickCount: 1,
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: request.elementRect.x, y: request.elementRect.y, button: 'left', clickCount: 1,
        });
        await new Promise(r => setTimeout(r, 150));
      }

      // Send Ctrl+V (trusted keyDown + keyUp)
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86,
        nativeVirtualKeyCode: 86, modifiers: 2, // 2 = Ctrl
      });
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86,
        nativeVirtualKeyCode: 86, modifiers: 2,
      });
      await new Promise(r => setTimeout(r, 200));

      await chrome.debugger.detach(target);
      console.log('[CDP] Ctrl+V paste dispatched successfully');
      return { success: true };
    } catch (err) {
      try { await chrome.debugger.detach({ tabId }); } catch (_) {}
      console.warn('[CDP] Ctrl+V paste failed:', err.message);
      return { success: false, error: err.message };
    }
  }

  // ── CDP TYPE KEYS: Character-by-character key dispatch via DevTools Protocol ──
  // Tier 3b: For editors that ignore Input.insertText but respond to individual
  // key events (Word Online, Google Docs canvas layer). Uses Input.dispatchKeyEvent
  // to send keyDown + char + keyUp per character — generates TRUSTED keyboard events.
  // When initializeBuffer=true, sends Enter then Backspace first to activate Word's
  // text buffer (Word requires these to initialize its input handler).
  if (request.type === 'cdp_type_keys') {
    const tabId = sender?.tab?.id;
    if (!tabId || !request.text) {
      return { success: false, error: 'Missing tabId or text for CDP key dispatch' };
    }
    try {
      const target = { tabId };
      await chrome.debugger.attach(target, '1.3');

      // ── ELEMENT-SPECIFIC FOCUS (same logic as cdp_insert_text) ──
      try {
        let clickX, clickY;
        if (request.elementRect?.x && request.elementRect?.y) {
          clickX = request.elementRect.x;
          clickY = request.elementRect.y;
          console.log('[CDP-KEYS] Clicking element center at', clickX, clickY);
        } else {
          const { result: hasFocus } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
            expression: `!!document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.isContentEditable)`,
            returnByValue: true,
          });
          if (hasFocus?.value) {
            clickX = null;
          } else {
            const { result: dims } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
              expression: `JSON.stringify({ w: window.innerWidth, h: window.innerHeight })`,
              returnByValue: true,
            });
            const { w, h } = JSON.parse(dims?.value || '{"w":960,"h":540}');
            clickX = Math.round(w / 2);
            clickY = Math.round(h / 2);
            console.log('[CDP-KEYS] No focused input — clicking viewport center');
          }
        }
        if (clickX != null) {
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1,
          });
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1,
          });
          await new Promise(r => setTimeout(r, 200));
        }
      } catch (_) { /* non-fatal */ }

      // ── BUFFER INITIALIZATION (Word Online requires this) ──
      // Word's canvas editor needs an Enter then Backspace to activate the text buffer.
      // Without this, subsequent key events are silently ignored.
      if (request.initializeBuffer) {
        console.log('[CDP-KEYS] Initializing text buffer with Enter + Backspace');
        // Enter key
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Enter', code: 'Enter',
          windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Enter', code: 'Enter',
          windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        });
        await new Promise(r => setTimeout(r, 100));

        // Backspace to remove the Enter we just typed
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Backspace', code: 'Backspace',
          windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Backspace', code: 'Backspace',
          windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
        });
        await new Promise(r => setTimeout(r, 100));
      }

      // ── CHARACTER-BY-CHARACTER KEY DISPATCH ──
      const text = request.text;
      console.log('[CDP-KEYS] Typing', text.length, 'characters via dispatchKeyEvent');
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const isNewline = char === '\n';

        if (isNewline) {
          // Enter key — must use keyDown type specifically (Word requires this)
          await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
            type: 'keyDown', key: 'Enter', code: 'Enter',
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
          });
          await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'Enter', code: 'Enter',
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
          });
        } else {
          // Regular character: keyDown → char → keyUp
          const keyCode = char.charCodeAt(0);
          const code = char.match(/[a-zA-Z]/) ? `Key${char.toUpperCase()}` : `Digit${char}`;

          await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
            type: 'keyDown', key: char, code,
            windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
          });
          await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
            type: 'char', key: char, code, text: char,
            windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
          });
          await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
            type: 'keyUp', key: char, code,
            windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
          });
        }

        // 5-10ms jitter between characters (anti-bot safe, fast enough for long text)
        if (i < text.length - 1) {
          await new Promise(r => setTimeout(r, 5 + Math.floor(Math.random() * 5)));
        }
      }

      console.log('[CDP-KEYS] Completed typing', text.length, 'characters');
      await chrome.debugger.detach(target);
      return { success: true };
    } catch (err) {
      try { await chrome.debugger.detach({ tabId }); } catch (_) {}
      console.warn('[CDP-KEYS] dispatchKeyEvent failed:', err.message);
      return { success: false, error: err.message };
    }
  }

  // ── CDP PRESS KEY: Press a single navigation/control key via Chrome DevTools Protocol ──
  // Used as fallback by content_explore.js press_key handler for canvas-based editors
  // (Excel Online, Google Sheets) where DOM KeyboardEvent dispatch is ignored.
  if (request.type === 'cdp_press_key') {
    const tabId = sender?.tab?.id;
    if (!tabId || !request.key) {
      return { success: false, error: 'Missing tabId or key for CDP key press' };
    }
    try {
      const target = { tabId };
      await chrome.debugger.attach(target, '1.3');

      const keyCode = request.keyCode || 0;
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: request.key, code: request.code || request.key,
        windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
      });
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: request.key, code: request.code || request.key,
        windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
      });

      await chrome.debugger.detach(target);
      console.log(`[CDP-PRESS-KEY] Pressed ${request.key} on tab ${tabId}`);
      return { success: true };
    } catch (err) {
      try { await chrome.debugger.detach({ tabId }); } catch (_) {}
      console.warn('[CDP-PRESS-KEY] Failed:', err.message);
      return { success: false, error: err.message };
    }
  }

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
    const res = await fetch(`http://localhost:3002/api/auth/extension/login`, {
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

    const res = await fetch(`http://localhost:3002/api/auth/extension/google`, {
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
  // Note: 'process_request_skip_recipe' kept for backward compat but behaves identically
  // now that recipe selection is automatic (no user choice UI).
  if (request.type === 'process_request' || request.type === 'process_request_skip_recipe') {
    const skipRecipeCheck = request.type === 'process_request_skip_recipe';
    const { userPrompt, tabId, url, availableTabs, conversationHistory, siteHint } = request.data;
    // Capture generation number before any awaits. If a newer request arrives
    // while this one is awaiting (memory fetch, chain plan, etc.), the counter
    // advances and the old chain detects the mismatch and aborts.
    const thisRequestGeneration = ++currentRequestGeneration;
    // Tracks recipe IDs attempted in this request — prevents the same recipe from
    // replaying multiple times (e.g., once in the main check, again in last-chance chain).
    const triedRecipeIds = new Set();

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
          if (scraped.formFields) pageContext.formFields = scraped.formFields;
        }
      } catch { /* Some pages block injection — proceed without */ }
    }

    // ── Multi-site detection: skip single-recipe replay for chained requests ──
    // If the prompt references multiple sites (e.g., "search Amazon then email"),
    // the chain system should handle it, not a single recipe replay.
    const isMultiSitePrompt = (() => {
      const lower = (userPrompt || '').toLowerCase();
      const SITE_KEYWORDS = ['amazon', 'ebay', 'walmart', 'etsy', 'gmail', 'outlook', 'yahoo',
        'linkedin', 'twitter', 'reddit', 'facebook', 'instagram', 'youtube', 'google',
        'slack', 'discord', 'zillow', 'airbnb', 'indeed',
        'chatgpt', 'gemini', 'claude', 'notion', 'trello', 'github', 'stackoverflow', 'figma'];
      let siteCount = 0;
      const found = new Set();
      for (const kw of SITE_KEYWORDS) {
        if (new RegExp(`\\b${kw}\\b`, 'i').test(lower) && !found.has(kw)) {
          found.add(kw);
          siteCount++;
        }
      }
      if (siteCount >= 2) return true;
      // Chain verbs: "search X and/then email Y"
      if (/\b(search|find|look)\b.*\b(and|then)\b.*\b(email|send|post|share|message|forward)\b/i.test(lower)) return true;
      if (/\b(email|send|post|share)\b.*\b(and|then)\b.*\b(search|find|buy|order)\b/i.test(lower)) return true;
      if (/\b(buy|order|purchase)\b.*\b(and|then)\b.*\b(email|send|share)\b/i.test(lower)) return true;
      // From non-mail domain + email intent
      const siteDomain = url ? new URL(url).hostname.toLowerCase() : '';
      const isOnMailSite = /mail\.google|gmail|outlook|yahoo/i.test(siteDomain);
      if (!isOnMailSite && /\b(email|compose|write|send|reply|forward|message)\b/i.test(lower)) return true;

      // ── Fallback: detect multi-task language for sites NOT in the dictionary ──
      // If the user uses sequential/parallel language, let the AI decomposer (Tier 3) decide.
      // Sequential: "then", "after that", "followed by", "once done", "afterwards"
      const hasSequentialLanguage = /\bthen\b|\bafter that\b|\band then\b|\bfollowed by\b|\bonce (done|finished)\b|\bwhen (done|finished)\b|\bafterwards?\b/i.test(lower);
      // Parallel: "ask X and Y and Z", "both", "all three/four/five", "each one/site/platform"
      const hasParallelLanguage = /\b(ask|check|query|search|open)\b.+\band\b.+\band\b/i.test(lower) ||
        /\bboth\b/i.test(lower) ||
        /\ball\s+(three|four|five|six)\b/i.test(lower) ||
        /\beach\s+(one|site|platform|app)\b/i.test(lower);
      // Require at least one action verb alongside sequential/parallel language
      // to avoid false positives on normal sentences containing "then"
      const hasMultipleActionVerbs = (lower.match(/\b(search|find|send|email|compose|post|buy|open|check|ask|go|navigate|create|fill|submit|upload|write|order|browse|visit|schedule)\b/gi) || []).length >= 2;
      if ((hasSequentialLanguage || hasParallelLanguage) && hasMultipleActionVerbs) return true;

      return false;
    })();

    // Tracks partial recipe completion for chain handoff.
    // If a recipe partially replays (e.g., search done but content script died),
    // the chain system uses this to skip the already-completed sub-task.
    let recipePartialContext = null;

    // ── LEARNING MODE: Auto-replay matching recipe (zero-token, silent) ──
    // If a learned recipe exists for this site + task, replay it automatically
    // without asking the user. If replay fails, silently fall through to AI.
    //
    // MAIL-DOMAIN GUARD: When the user is on a mail domain (Gmail, Outlook, etc.)
    // AND the prompt is a multi-site chain, the mail action is the LAST sub-task —
    // NOT the first. Replaying the Gmail recipe here would execute it BEFORE the
    // chain's first sub-task (e.g., Google Meet), inverting the order.
    // Skip pre-chain recipe match and let the chain system handle everything in order.
    const _siteDomainForGuard = url ? new URL(url).hostname : '';
    const _isMailDomain = /mail\.google\.com|outlook\.live\.com|mail\.yahoo\.com/i.test(_siteDomainForGuard);
    if (!skipRecipeCheck && !(isMultiSitePrompt && _isMailDomain)) try {
      const siteDomain = _siteDomainForGuard;
      if (siteDomain && userPrompt) {
        const recipeRes = await fetch(
          `${API_BASE}/api/recipes/match?siteDomain=${encodeURIComponent(siteDomain)}&task=${encodeURIComponent(userPrompt)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const recipeMatch = await recipeRes.json();
        if (recipeMatch?.success && recipeMatch?.found && recipeMatch?.recipe) {
          const recipe = recipeMatch.recipe;
          const matchScore = recipeMatch.score || 0;
          console.log(`[BG] Recipe auto-match: "${recipe.workflowName}" (score=${matchScore}, confidence=${recipe.confidence})`);

          if (matchScore < 50) {
            console.log(`[BG] Recipe score ${matchScore} below threshold (50) — skipping auto-replay, falling through to AI`);
          } else {

          // Try to auto-fill recipe variables from the user's prompt
          const variables = Array.isArray(recipe.variables) ? recipe.variables : [];
          const filledVars = {};
          if (variables.length > 0) {
            // Extract values from the user prompt to fill recipe variables
            const promptLower = userPrompt.toLowerCase();

            // Extract email addresses
            const emailMatch = userPrompt.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);

            // Extract quoted strings (explicit values)
            const quotedMatches = userPrompt.match(/"([^"]+)"|'([^']+)'/g);
            const quotedValues = quotedMatches ? quotedMatches.map(q => q.replace(/['"]/g, '')) : [];

            // Extract search query: for compound prompts like "find X then email Y about Z",
            // capture only the first clause so the entire second clause is dropped.
            const compoundSplitAuto = userPrompt.match(
              /^([\s\S]+?)\b(?:and\s+then|then|after\s+that)\s+(?:write|send|email|compose|reply|message|forward|call|book|order|buy|purchase|post|tweet|slack|notify|tell)\b/i
            );
            const promptForSearch = compoundSplitAuto ? compoundSplitAuto[1].trim() : userPrompt.trim();
            const searchQuery = promptForSearch
              .replace(/\b(search|find|look\s*for|browse|shop|buy|purchase|order|email|compose|write|send|reply|message|forward|then|and|on|in|at|the|a|an|for|to|from|my|me|please|can|you|i|want|need|what|which|who|when|where|how|got|bought|found|used)\b/gi, ' ')
              .replace(/\b(amazon|ebay|walmart|etsy|gmail|outlook|yahoo|linkedin|twitter|reddit|facebook|instagram|youtube|google|slack|discord|zillow|airbnb|indeed)\b/gi, ' ')
              .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, ' ')
              .replace(/[^\w\s\-]/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();

            for (const v of variables) {
              const nameLower = (v.name || '').toLowerCase();
              const descLower = (v.description || '').toLowerCase();

              if (/email|recipient|to_address/.test(nameLower) || /email|recipient/.test(descLower)) {
                if (emailMatch) filledVars[v.name] = emailMatch[0];
              } else if (/search|query|keyword|product|item/.test(nameLower) || /search|query|what.*find/.test(descLower)) {
                if (quotedValues.length > 0) {
                  filledVars[v.name] = quotedValues[0];
                } else if (searchQuery) {
                  filledVars[v.name] = searchQuery;
                }
              } else if (/subject/.test(nameLower)) {
                if (quotedValues.length > 1) filledVars[v.name] = quotedValues[1];
                else if (searchQuery) filledVars[v.name] = searchQuery;
              } else if (/url|link/.test(nameLower)) {
                const urlMatch = userPrompt.match(/https?:\/\/[^\s]+/);
                if (urlMatch) filledVars[v.name] = urlMatch[0];
              } else {
                // Generic fallback: use quoted value or search query
                if (quotedValues.length > 0) filledVars[v.name] = quotedValues.shift();
                else if (searchQuery) filledVars[v.name] = searchQuery;
              }
            }

            const unfilledCount = variables.filter(v => !filledVars[v.name]).length;
            if (unfilledCount > 0) {
              console.log(`[BG] Recipe has ${unfilledCount}/${variables.length} unfilled variable(s) after extraction, skipping auto-replay — AI will handle`);
            } else {
              console.log(`[BG] Auto-filled ${Object.keys(filledVars).length} variable(s) from prompt:`, Object.keys(filledVars));
            }
          }

          // Replay if no variables or all variables were filled from the prompt
          const unfilledVarCount = variables.filter(v => !filledVars[v.name]).length;
          if (unfilledVarCount === 0) {
            // Auto-replay: dispatch internally to the replay handler
            triedRecipeIds.add(recipe.id); // Mark as attempted before replay
            try {
              const replayResult = await handleMessage({
                type: 'learning_replay_recipe',
                data: {
                  recipe,
                  variables: filledVars,
                  taskContext: userPrompt,
                  originalPrompt: userPrompt,
                },
              }, {} /* no sender — internal call */);

              if (replayResult?.success && !replayResult?.partial) {
                // Replay succeeded — record outcome
                try {
                  await fetch(`${API_BASE}/api/recipes/${recipe.id}/validate`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ durationMs: replayResult.durationMs }),
                  });
                } catch { /* non-critical */ }

                // If this is a multi-site prompt, the recipe only handled the FIRST part.
                // Don't return yet — fall through to the chain system to handle remaining sub-tasks (e.g., email).
                if (isMultiSitePrompt) {
                  console.log('[BG] Recipe succeeded for first site — continuing to chain system for remaining sub-tasks');
                  // Skip the chain's first sub-task (already done via recipe) by marking it
                  // The chain system will see this and handle remaining sub-tasks
                } else {
                  return {
                    success: true,
                    data: {
                      action_type: 'RECIPE_REPLAY_COMPLETE',
                      headline: `Done! Used workflow "${recipe.autoDescription || recipe.workflowName}"`,
                      primary_content: `Completed ${replayResult.completedSteps}/${replayResult.totalSteps} steps in ${((replayResult.durationMs || 0) / 1000).toFixed(1)}s — 0 credits used.`,
                      recipe_used: { id: recipe.id, name: recipe.autoDescription || recipe.workflowName, confidence: recipe.confidence },
                      consent_level: 'none',
                    },
                  };
                }
              }

              // Replay failed or partial — check if the search goal was already achieved.
              // When the recipe types a search query + hits Enter, the page navigates to
              // results. The content script dies during navigation, so the replay reports
              // "partial failure" — but the SEARCH IS DONE. The URL proves it.
              const partialSteps = replayResult?.completedSteps || 0;
              if (partialSteps >= 2) {
                try {
                  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                  const tabUrl = activeTab?.url || '';
                  // Detect search results pages: URL contains query params like ?k=, ?q=, ?query=, /s?, /search?
                  const looksLikeSearchResults = /[?&](k|q|query|search|keyword|search_query|field-keywords)=/i.test(tabUrl) ||
                    /\/(s|search|results)\?/i.test(tabUrl);

                  if (looksLikeSearchResults) {
                    console.log(`[BG] Recipe partial success: search completed (${partialSteps} steps). URL confirms results: ${tabUrl.slice(0, 120)}`);

                    // Capture context for the chain system (multi-site prompts)
                    recipePartialContext = {
                      completedSteps: partialSteps,
                      totalSteps: replayResult?.totalSteps || 0,
                      domain: new URL(tabUrl).hostname.toLowerCase(),
                      pageUrl: tabUrl,
                      pageTitle: activeTab.title || '',
                    };

                    // Validate recipe (it DID work — the search completed)
                    try {
                      await fetch(`${API_BASE}/api/recipes/${recipe.id}/validate`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                        body: JSON.stringify({ durationMs: replayResult?.durationMs || 0 }),
                      });
                    } catch { /* non-critical */ }

                    // Route through the SUCCESS path:
                    // - Single-task: returns RECIPE_REPLAY_COMPLETE (done, no further action)
                    // - Multi-task: falls through to chain system for remaining sub-tasks
                    if (isMultiSitePrompt) {
                      console.log('[BG] Recipe search done — continuing to chain system for remaining sub-tasks');
                    } else {
                      return {
                        success: true,
                        data: {
                          action_type: 'RECIPE_REPLAY_COMPLETE',
                          headline: `Done! Searched "${recipe.autoDescription || recipe.workflowName}"`,
                          primary_content: `Search completed (${partialSteps} steps) — results are showing. 0 credits used.`,
                          recipe_used: { id: recipe.id, name: recipe.autoDescription || recipe.workflowName, confidence: recipe.confidence },
                          consent_level: 'none',
                        },
                      };
                    }
                  }
                } catch { /* non-critical — fall through to normal failure path */ }
              }

              // Genuine failure — search didn't complete or page isn't showing results.
              // Don't penalize recipes that partially succeeded (search results visible).
              if (!recipePartialContext) {
                console.warn('[BG] Recipe auto-replay failed, falling through:', replayResult?.error || replayResult?.failReason || 'unknown');
                try {
                  const isPageMismatch = replayResult?.failedAtStep === 1 && (replayResult?.failReason || '').includes('Element not found');
                  if (!isPageMismatch) {
                    await fetch(`${API_BASE}/api/recipes/${recipe.id}/fail`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    });
                  }
                } catch { /* non-critical */ }
              }
            } catch (replayErr) {
              console.warn('[BG] Recipe auto-replay threw, falling through to AI:', replayErr.message);
            }
          }
          } // end else (matchScore >= 50)
        }
      }
    } catch (recipeErr) {
      // Non-critical — fall through to normal AI flow
      console.warn('[BG] Recipe check failed (non-fatal):', recipeErr.message);
    }

    // ── CHAIN EXECUTION: Multi-site request decomposition ──
    // If the user's request involves multiple sites (e.g., "search Amazon and email the link"),
    // ask the backend to decompose it and execute sub-tasks sequentially.
    if (!skipRecipeCheck) try {
      const chainAbort = new AbortController();
      const chainTimeout = setTimeout(() => chainAbort.abort(), 20000); // 20s safety net
      const chainPlanRes = await fetch(`${API_BASE}/api/agent/chain/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userRequest: userPrompt, currentDomain: url ? new URL(url).hostname : null }),
        signal: chainAbort.signal,
      });
      clearTimeout(chainTimeout);
      const chainPlan = await chainPlanRes.json();

      // Ghost-chain guard (pre-loop): if a newer request arrived while we were
      // waiting for the chain plan, this request is stale — skip its chain entirely.
      if (chainPlan?.success && chainPlan?.isChain && chainPlan.subTasks?.length > 1 &&
          thisRequestGeneration === currentRequestGeneration) {
        // Sort sub-tasks by order to guarantee correct execution sequence
        // (backend may return them out of order in edge cases)
        chainPlan.subTasks.sort((a, b) => a.order - b.order);
        console.log(`[BG] Chain detected: ${chainPlan.totalSteps} sub-tasks (${chainPlan.recipeCount} recipes, ${chainPlan.aiCount} AI)`);

        const chainResults = [];
        const outputStore = {};
        let chainSuccess = true;
        let composeOpened = false; // Guard: track if email compose was already opened
        const totalSubTasks = chainPlan.subTasks.length;

        // Broadcast chain progress to all UI surfaces (panel, sidepanel, popup)
        function broadcastChainProgress(step, total, description, nextStep) {
          const payload = { type: 'chain_progress', data: { step, total, description, nextStep } };
          // Reach popup + sidepanel
          try { chrome.runtime.sendMessage(payload).catch(() => {}); } catch {}
          // Reach content scripts (panel)
          chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
            if (tab?.id) try { chrome.tabs.sendMessage(tab.id, payload).catch(() => {}); } catch {}
          }).catch(() => {});
        }

        for (const subTask of chainPlan.subTasks) {
          // ── CANCELLATION CHECK: user clicked X/Cancel OR a newer request arrived ──
          if (explorationAborted || thisRequestGeneration !== currentRequestGeneration) {
            const reason = explorationAborted ? 'user cancelled' : 'superseded by newer request';
            console.log(`[BG] Chain: aborting at sub-task ${subTask.order} — ${reason}`);
            chainSuccess = false;
            break;
          }

          // ── Skip sub-task 1 if the search is already done ──
          // Detect TWO scenarios:
          // A) Recipe partially replayed the search (recipePartialContext set)
          // B) User is ALREADY on the search results page for sub-task 1's domain
          //    (e.g., they searched before sending the compound prompt, or the recipe
          //    is deprecated but a previous attempt already loaded results)
          if (subTask.order === 1 && subTask.category === 'search') {
            let shouldSkip = false;
            let skipReason = '';

            // Scenario A: recipe partial context
            if (recipePartialContext) {
              const partialDomain = recipePartialContext.domain || '';
              const subTaskDomain = (subTask.domain || '').toLowerCase();
              const domainMatch = partialDomain.includes(subTaskDomain) ||
                subTaskDomain.includes(partialDomain.split('.').slice(-2, -1)[0] || '');
              if (domainMatch) {
                shouldSkip = true;
                skipReason = `recipe already completed ${recipePartialContext.completedSteps} steps`;
              }
            }

            // Scenario B: current page is already showing search results on the target domain
            if (!shouldSkip) {
              try {
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                const tabUrl = activeTab?.url || '';
                const tabHost = tabUrl ? new URL(tabUrl).hostname.toLowerCase() : '';
                const subTaskDomain = (subTask.domain || '').toLowerCase();
                const subTaskFamily = subTaskDomain.split('.').slice(-2, -1)[0] || '';
                const tabFamily = tabHost.split('.').slice(-2, -1)[0] || '';
                // Both families must be non-empty and ≥3 chars to avoid false positives
                const onTargetDomain = subTaskFamily.length >= 3 && tabFamily.length >= 3 &&
                  (tabHost.includes(subTaskFamily) || subTaskDomain.includes(tabFamily));
                const hasSearchResults = /[?&](k|q|query|search|keyword|search_query|field-keywords)=/i.test(tabUrl) ||
                  /\/(s|search|results)\?/i.test(tabUrl);

                // Query relevance: verify the URL's search query matches what the sub-task needs.
                // Without this, a stale Amazon tab with "t-shirt" results would skip a "laptop" search.
                let queryRelevant = true; // default true if we can't extract either query
                if (hasSearchResults) {
                  try {
                    const urlParams = new URL(tabUrl).searchParams;
                    const currentQuery = (urlParams.get('k') || urlParams.get('q') || urlParams.get('query') ||
                      urlParams.get('search') || urlParams.get('keyword') || '').toLowerCase();
                    const expectedQuery = (subTask.resolvedInputs?.search_query ||
                      (subTask.inputs || []).find(i => i.name === 'search_query')?.value || '').toLowerCase();

                    if (currentQuery && expectedQuery) {
                      const expectedWords = expectedQuery.split(/\s+/).filter(w => w.length >= 3);
                      queryRelevant = expectedWords.length === 0 ||
                        expectedWords.some(w => currentQuery.includes(w));
                      if (!queryRelevant) {
                        console.log(`[BG] Chain: skip blocked — URL query "${currentQuery}" does not match expected "${expectedQuery}"`);
                      }
                    }
                  } catch { /* URL parsing failed — keep queryRelevant=true */ }
                }

                if (onTargetDomain && hasSearchResults && queryRelevant) {
                  shouldSkip = true;
                  skipReason = `already on search results page (${tabHost})`;
                }
              } catch { /* non-critical */ }
            }

            if (shouldSkip) {
              console.log(`[BG] Chain: skipping sub-task 1 — ${skipReason}`);
              try {
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                outputStore[subTask.order] = {
                  page_url: activeTab?.url || recipePartialContext?.pageUrl || '',
                  page_title: activeTab?.title || recipePartialContext?.pageTitle || '',
                };
                if (activeTab?.id) {
                  const [scraped] = await chrome.scripting.executeScript({
                    target: { tabId: activeTab.id },
                    func: () => (document.body?.innerText || '').slice(0, 3000),
                  });
                  if (scraped?.result) outputStore[subTask.order].page_content = scraped.result;
                }
              } catch { /* page may block injection */ }
              chainResults.push({
                order: subTask.order,
                intent: subTask.intent,
                domain: subTask.domain,
                method: recipePartialContext ? 'recipe_partial' : 'page_detected',
                success: true,
                duration: 0,
                error: null,
              });
              broadcastChainProgress(
                subTask.order, totalSubTasks,
                `Done: ${subTask.intent}`,
                chainPlan.subTasks[1]?.intent || 'Finishing up...'
              );
              continue; // Skip to sub-task 2
            }
          }

          // Notify UI about current sub-task
          const nextSubTask = chainPlan.subTasks.find(st => st.order === subTask.order + 1);
          broadcastChainProgress(
            subTask.order, totalSubTasks,
            `Working on: ${subTask.intent}`,
            nextSubTask ? nextSubTask.intent : 'Finishing up...'
          );

          // Resolve pending inputs (previous_step references + AI-generated content)
          let resolvedInputs = { ...subTask.resolvedInputs };
          if (subTask.pendingInputs && subTask.pendingInputs.length > 0 && Object.keys(outputStore).length > 0) {
            try {
              const resolveRes = await fetch(`${API_BASE}/api/agent/chain/resolve-inputs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ subTask, outputStore }),
              });
              const resolved = await resolveRes.json();
              if (resolved?.success) {
                resolvedInputs = { ...resolvedInputs, ...resolved.resolvedInputs };
              }
            } catch { /* use what we have */ }

            // Validate subject was resolved — fallback if missing/sentinel/empty
            if (subTask.pendingInputs?.some(i => i.name === 'subject')) {
              const subj = resolvedInputs.subject;
              if (!subj || /^__UNRESOLVED__/.test(subj) || subj.length < 3) {
                const fallbackTitle = outputStore[1]?.page_title || subTask.intent || 'Your request';
                resolvedInputs.subject = `Re: ${fallbackTitle}`.slice(0, 80);
                console.log(`[BG] Chain subject fallback applied: "${resolvedInputs.subject}"`);
              }
            }
          }

          let stepResult;

          // ── Navigate to the target domain if not already there ──
          // Chain sub-tasks span different sites (Amazon → Gmail).
          // Before executing EACH sub-task (including #1), ensure we're on the right domain.
          if (subTask.domain) {
            try {
              let [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
              const currentHost = currentTab?.url ? new URL(currentTab.url).hostname.toLowerCase() : '';
              const targetDomain = subTask.domain.toLowerCase();

              // Check if we need to navigate (different domain family)
              const currentFamily = currentHost.split('.').slice(-2, -1)[0] || currentHost;
              const targetFamily = targetDomain.split('.').slice(-2, -1)[0] || targetDomain;
              const needsNavigation = currentFamily !== targetFamily &&
                !currentHost.includes(targetDomain) && !targetDomain.includes(currentHost);

              if (needsNavigation && currentTab) {
                console.log(`[BG] Chain: navigating from "${currentHost}" to "${targetDomain}" for sub-task ${subTask.order}`);

                // Try to find an existing tab on the target domain.
                // For search sub-tasks, also verify the tab has relevant content
                // (prevents reusing a stale Amazon tab with "t-shirt" results for a "laptop" search).
                const expectedQuery = (subTask.resolvedInputs?.search_query ||
                  (subTask.inputs || []).find(i => i.name === 'search_query')?.value || '').toLowerCase();
                const allTabs = await chrome.tabs.query({ currentWindow: true });
                const existingTab = allTabs.find(t => {
                  try {
                    const tUrl = new URL(t.url);
                    const host = tUrl.hostname.toLowerCase();
                    const domainMatch = host.includes(targetDomain) || targetDomain.includes(host.split('.').slice(-2, -1)[0]);
                    if (!domainMatch) return false;

                    // For search sub-tasks: verify the tab's search query matches
                    if (subTask.category === 'search' && expectedQuery) {
                      const tabQuery = (tUrl.searchParams.get('k') || tUrl.searchParams.get('q') ||
                        tUrl.searchParams.get('query') || tUrl.searchParams.get('search') || '').toLowerCase();
                      if (tabQuery) {
                        const queryWords = expectedQuery.split(/\s+/).filter(w => w.length >= 3);
                        const relevant = queryWords.length === 0 || queryWords.some(w => tabQuery.includes(w));
                        if (!relevant) {
                          console.log(`[BG] Chain: skipping stale tab (query "${tabQuery}" doesn't match "${expectedQuery}")`);
                          return false;
                        }
                      }
                    }
                    return true;
                  } catch { return false; }
                });

                // Rich web apps (Gmail, Outlook) need more settle time for JS frameworks to initialize
                const isRichApp = /mail\.google|gmail|outlook|facebook|linkedin|slack/i.test(targetDomain);
                const settleTimeMs = isRichApp ? 3000 : 1500;

                if (existingTab) {
                  // Switch to existing tab
                  await chrome.tabs.update(existingTab.id, { active: true });
                  await new Promise(r => setTimeout(r, settleTimeMs)); // Let tab re-activate and re-render
                  console.log(`[BG] Chain: switched to existing tab on ${targetDomain} (settled ${settleTimeMs}ms)`);
                } else {
                  // Open a NEW tab for the target domain — never overwrite the user's current tab
                  const targetUrl = targetDomain.includes('mail.google') ? 'https://mail.google.com' :
                                    targetDomain.includes('outlook') ? 'https://outlook.live.com' :
                                    `https://${targetDomain}`;
                  const newTab = await chrome.tabs.create({ url: targetUrl, active: true });
                  // Wait for page to load
                  await new Promise((resolve) => {
                    const onLoad = (tabId, changeInfo) => {
                      if (tabId === newTab.id && changeInfo.status === 'complete') {
                        chrome.tabs.onUpdated.removeListener(onLoad);
                        resolve();
                      }
                    };
                    chrome.tabs.onUpdated.addListener(onLoad);
                    setTimeout(() => { chrome.tabs.onUpdated.removeListener(onLoad); resolve(); }, 15000);
                  });
                  await new Promise(r => setTimeout(r, settleTimeMs)); // Extra settle time for JS apps
                  // Update currentTab reference so subsequent chain steps target the new tab
                  currentTab = newTab;
                  console.log(`[BG] Chain: opened new tab for ${targetUrl} (tab ${newTab.id}, settled ${settleTimeMs}ms)`);
                }
              }
            } catch (navErr) {
              console.warn(`[BG] Chain: domain navigation failed for sub-task ${subTask.order}:`, navErr.message);
              // Continue anyway — the sub-task execution will handle being on the wrong page
            }
          }

          if (subTask.executionMethod === 'recipe_replay' && subTask.recipe) {
            // RECIPE REPLAY — free, deterministic
            // Map resolved inputs to recipe variable names (decomposer uses names like
            // 'search_query' but recipe variables may have different names set by user)
            const recipeVars = Array.isArray(subTask.recipe.variables) ? subTask.recipe.variables : [];
            const mappedVars = { ...resolvedInputs };
            if (recipeVars.length > 0 && Object.keys(resolvedInputs).length > 0) {
              for (const rv of recipeVars) {
                if (mappedVars[rv.name]) continue; // already matched by name
                const rvNameLower = (rv.name || '').toLowerCase();
                const rvDescLower = (rv.description || '').toLowerCase();
                // Try to map by semantic type
                for (const [inputName, inputValue] of Object.entries(resolvedInputs)) {
                  if (mappedVars[rv.name]) break;
                  const inLower = inputName.toLowerCase();
                  // Mutually exclusive mapping — search_query must NOT leak into subject/body vars
                  if (/search|query|keyword|product/.test(inLower) && /search|query|keyword|product|item/.test(rvNameLower + ' ' + rvDescLower) && !/subject|body|content|message/.test(rvNameLower)) {
                    mappedVars[rv.name] = inputValue;
                  } else if (/email|recipient/.test(inLower) && /email|recipient|to/.test(rvNameLower + ' ' + rvDescLower)) {
                    mappedVars[rv.name] = inputValue;
                  } else if (/subject/.test(inLower) && /subject/.test(rvNameLower + ' ' + rvDescLower) && !/search|query/.test(inLower)) {
                    mappedVars[rv.name] = inputValue;
                  } else if (/body|content|message/.test(inLower) && /body|content|message|text/.test(rvNameLower + ' ' + rvDescLower) && !/search|query/.test(inLower)) {
                    mappedVars[rv.name] = inputValue;
                  }
                }
              }
            }
            // Inject __recipient_email from resolvedInputs or user prompt.
            // Accept email addresses AND contact names — email clients autocomplete names.
            if (!mappedVars.__recipient_email) {
              for (const [key, val] of Object.entries(resolvedInputs)) {
                if (/^(recipient|email|to|recipient_email|send_to|recipient_name|contact)$/i.test(key) && typeof val === 'string' && val.trim()) {
                  mappedVars.__recipient_email = val.trim();
                  break;
                }
              }
            }
            // Fallback: extract email address or contact name from the user's original prompt
            if (!mappedVars.__recipient_email) {
              const emailMatch = userPrompt.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
              if (emailMatch) {
                mappedVars.__recipient_email = emailMatch[0];
              } else {
                // Extract contact name: "email to kibromamaniel" → "kibromamaniel"
                const nameMatch = userPrompt.match(
                  /\b(?:write|send|email|message|compose)(?:\s+(?:an?\s+)?(?:email|message))?\s+to\s+([\w][\w.\-]*)/i
                );
                if (nameMatch?.[1]) mappedVars.__recipient_email = nameMatch[1];
              }
            }

            try {
              // Build rich task context: user's original prompt + sub-task intent + previous steps + AI-generated content
              // The original prompt is CRITICAL — it contains the user's specific content instructions
              // (e.g., "tell them I will deploy the code asap") that llm_fill needs to follow.
              const contextParts = [];

              // 1. User's original prompt — highest priority for content generation
              contextParts.push(`User's request: ${userPrompt}`);

              // 2. Sub-task intent — what this specific step should accomplish
              contextParts.push(`Current task: ${subTask.intent}`);

              // 3. AI-generated content from chain resolver — if the backend already generated
              //    body/subject text via ai_generate, include it so llm_fill can use or refine it
              const aiGeneratedFields = [];
              for (const [key, val] of Object.entries(resolvedInputs)) {
                if (typeof val === 'string' && val.length > 10 && /body|content|message|subject/i.test(key)) {
                  aiGeneratedFields.push(`Pre-generated ${key}: ${val}`);
                }
              }
              if (aiGeneratedFields.length > 0) {
                contextParts.push(`AI-generated content (use as primary reference):\n${aiGeneratedFields.join('\n')}`);
              }

              // 4. Data from previous steps (URLs, page content, etc.)
              if (Object.keys(outputStore).length > 0) {
                const prevStepSummaries = Object.entries(outputStore)
                  .map(([stepOrder, data]) => {
                    const parts = [`Step ${stepOrder}: ${data.page_title || 'completed'}`];
                    if (data.page_url) parts.push(`URL: ${data.page_url}`);
                    if (data.page_content) parts.push(`Content:\n${data.page_content.slice(0, 2000)}`);
                    return parts.join('\n');
                  })
                  .join('\n\n');
                contextParts.push(`Data from previous steps:\n${prevStepSummaries}`);
              }

              const richTaskContext = contextParts.join('\n\n');

              stepResult = await handleMessage({
                type: 'learning_replay_recipe',
                data: {
                  recipe: subTask.recipe,
                  variables: mappedVars,
                  taskContext: richTaskContext,
                  originalPrompt: userPrompt, // Original user prompt for search query extraction (not enriched context)
                },
              }, {});

              if (stepResult?.success && !stepResult?.partial) {
                // Check if replay stopped at a consequential action (Send, Buy, Delete)
                if (stepResult.skippedConsequential) {
                  console.log(`[BG] Chain sub-task ${subTask.order} stopped at consequential action: "${stepResult.consequentialStep}"`);
                  // Record as success with awaiting flag — chain continues to next sub-task
                  chainResults.push({
                    order: subTask.order,
                    intent: subTask.intent,
                    domain: subTask.domain,
                    method: subTask.executionMethod,
                    recipeName: subTask.recipe?.autoDescription || subTask.recipe?.workflowName || null,
                    success: true,
                    awaitingUserAction: true,
                    consequentialStep: stepResult.consequentialStep,
                    duration: stepResult?.durationMs || 0,
                    error: null,
                  });
                  // Capture page outputs for downstream steps before continuing
                  try {
                    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    outputStore[subTask.order] = {
                      page_url: activeTab?.url || '',
                      page_title: activeTab?.title || '',
                    };
                  } catch { outputStore[subTask.order] = {}; }
                  continue; // Move to next sub-task — user will click the button manually
                }
                // Record success
                try {
                  await fetch(`${API_BASE}/api/recipes/${subTask.recipe.id}/validate`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ durationMs: stepResult.durationMs }),
                  });
                } catch { /* non-critical */ }
              } else {
                // Recipe failed — mark for AI fallback reporting
                stepResult = { success: false, error: stepResult?.error || 'Recipe replay failed' };
                // Report failure to backend so confidence updates (mirrors auto-replay at line ~6055)
                try {
                  await fetch(`${API_BASE}/api/recipes/${subTask.recipe.id}/fail`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                  });
                } catch { /* non-critical */ }
              }
            } catch (replayErr) {
              stepResult = { success: false, error: replayErr.message };
              // Report failure for exception path too
              try {
                await fetch(`${API_BASE}/api/recipes/${subTask.recipe.id}/fail`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                });
              } catch { /* non-critical */ }
            }
          } else {
            // LAST-CHANCE RECIPE CHECK: The chain planner may have mislabeled the category.
            // Try a domain-only recipe lookup before falling to expensive AI reasoning.
            if (subTask.domain) {
              try {
                const lastChanceRes = await fetch(
                  `${API_BASE}/api/recipes/match?siteDomain=${encodeURIComponent(subTask.domain)}&task=${encodeURIComponent(subTask.intent || userPrompt)}`,
                  { headers: { Authorization: `Bearer ${token}` } }
                );
                const lastChance = await lastChanceRes.json();
                if (lastChance?.success && lastChance?.found && lastChance?.recipe) {
                  const lastChanceScore = lastChance.score || 0;
                  const lcRecipe = lastChance.recipe;
                  if (lastChanceScore < 50) {
                    console.log(`[BG] Chain sub-task ${subTask.order}: last-chance recipe score ${lastChanceScore} below threshold — skipping, falling to AI`);
                  } else if (triedRecipeIds.has(lcRecipe.id)) {
                    console.log(`[BG] Chain sub-task ${subTask.order}: last-chance recipe "${lcRecipe.id}" already attempted this request — skipping duplicate`);
                  } else {
                  triedRecipeIds.add(lcRecipe.id);
                  console.log(`[BG] Chain sub-task ${subTask.order}: last-chance recipe found! "${lastChance.recipe.autoDescription || lastChance.recipe.workflowName}" (score=${lastChanceScore})`);
                  // Replay this recipe instead of falling through to AI
                  const lcVars = { ...resolvedInputs };
                  // Map variables like the normal chain replay path
                  const lcRecipeVars = Array.isArray(lcRecipe.variables) ? lcRecipe.variables : [];
                  for (const rv of lcRecipeVars) {
                    if (lcVars[rv.name]) continue;
                    const rvLower = ((rv.name || '') + ' ' + (rv.description || '')).toLowerCase();
                    for (const [inName, inVal] of Object.entries(resolvedInputs)) {
                      if (lcVars[rv.name]) break;
                      const inLower = inName.toLowerCase();
                      if (/search|query/.test(inLower) && /search|query/.test(rvLower)) lcVars[rv.name] = inVal;
                      else if (/email|recipient/.test(inLower) && /email|recipient|to/.test(rvLower)) lcVars[rv.name] = inVal;
                    }
                  }
                  try {
                    stepResult = await handleMessage({
                      type: 'learning_replay_recipe',
                      data: { recipe: lcRecipe, variables: lcVars, taskContext: userPrompt, originalPrompt: userPrompt },
                    }, {});
                    if (stepResult?.success && !stepResult?.partial) {
                      // Record validation
                      try {
                        await fetch(`${API_BASE}/api/recipes/${lcRecipe.id}/validate`, {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                          body: JSON.stringify({ durationMs: stepResult.durationMs }),
                        });
                      } catch { /* non-critical */ }
                    }
                  } catch (lcErr) {
                    console.warn(`[BG] Chain sub-task ${subTask.order}: last-chance recipe replay failed:`, lcErr.message);
                    stepResult = null; // Fall through to AI below
                  }
                  } // end else (score >= 50 && not already tried)
                }
              } catch { /* last-chance lookup failed — continue to AI */ }
            }

            // AI REASONING — no recipe available, use the full AI agent for this sub-task
            if (!stepResult || !stepResult.success) {
            // Compose guard: if email compose was already opened by a prior sub-task or recipe,
            // skip this sub-task to avoid duplicate compose windows
            if (composeOpened && /compose|email|send|write/i.test(subTask.category || subTask.intent || '')) {
              console.log(`[BG] Chain sub-task ${subTask.order}: skipping — compose already opened`);
              stepResult = { success: true, durationMs: 0, skippedDuplicate: true };
            } else {
            console.log(`[BG] Chain sub-task ${subTask.order} ("${subTask.intent}") has no recipe — falling through to AI`);
            // Build a focused prompt for just this sub-task, incorporating resolved inputs + previous step data
            const inputContext = Object.entries(resolvedInputs)
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ');
            // Include previous step outputs so AI knows what was found (e.g., product details for email)
            const prevStepData = Object.entries(outputStore)
              .map(([stepOrder, data]) => {
                const parts = [`Step ${stepOrder}: ${data.page_title || 'completed'}`];
                if (data.page_url) parts.push(`URL: ${data.page_url}`);
                if (data.page_content) parts.push(data.page_content.slice(0, 1500));
                return parts.join(' | ');
              })
              .join('\n');
            const contextParts = [`Current task: ${subTask.intent}`];
            contextParts.push(`Original request: ${userPrompt}`);
            if (inputContext) contextParts.push(`Inputs: ${inputContext}`);
            if (prevStepData) contextParts.push(`Data from previous steps:\n${prevStepData}`);
            const focusedPrompt = contextParts.join('\n');

            try {
              // Get current tab context for the AI
              const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
              const currentUrl = currentTab?.url || `https://${subTask.domain}`;

              // Scrape page context for AI
              let aiPageContext = { url: currentUrl, siteHint: null };
              try {
                const [scraped] = await chrome.scripting.executeScript({
                  target: { tabId: currentTab.id },
                  func: () => ({
                    title: document.title,
                    text: document.body?.innerText?.slice(0, 3000) || '',
                  }),
                });
                if (scraped?.result) {
                  aiPageContext.title = scraped.result.title;
                  aiPageContext.visibleText = scraped.result.text;
                }
              } catch { /* page may block injection */ }

              const aiRes = await fetch(`${API_BASE}/api/agent/process`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({
                  userPrompt: focusedPrompt,
                  pageContext: aiPageContext,
                  userMemory: userMemory || null,
                  conversationHistory: [],
                }),
              });
              if (aiRes.ok) {
                const aiData = await aiRes.json();

                // If AI returned EXPLORE, run a mini exploration for this chain sub-task
                if (aiData.action_type === 'EXPLORE' && aiData.explore_plan) {
                  console.log(`[BG] Chain sub-task ${subTask.order}: AI returned EXPLORE — running mini exploration`);
                  try {
                    const exploreResult = await runExplorationLoop(
                      aiData.explore_plan,
                      currentTab.id,
                      token,
                      null, // no resume state
                      { originalPrompt: userPrompt, phase: 1, previousPhases: [], totalSteps: 0, dataBuffer: '' }
                    );
                    stepResult = {
                      success: exploreResult.success,
                      durationMs: 0,
                      error: exploreResult.error || null,
                      exploreGoalResult: exploreResult.goalResult || null,
                    };
                  } catch (exploreErr) {
                    console.warn(`[BG] Chain sub-task ${subTask.order}: mini-exploration failed:`, exploreErr.message);
                    stepResult = { success: false, error: `Exploration failed: ${exploreErr.message}` };
                  }
                } else if (aiData.action_type === 'NAVIGATE' && aiData.navigate_url) {
                  // Simple navigation — execute it
                  try {
                    await chrome.tabs.update(currentTab.id, { url: aiData.navigate_url });
                    await new Promise(r => setTimeout(r, 3000)); // Wait for page load
                    stepResult = { success: true, aiAction: aiData, durationMs: 0 };
                  } catch (navErr) {
                    stepResult = { success: false, error: `Navigation failed: ${navErr.message}` };
                  }
                } else {
                  // Other action types (RECOMMENDATION, etc.) — mark as success, capture outputs
                  stepResult = { success: true, aiAction: aiData, durationMs: 0 };
                }
              } else {
                stepResult = { success: false, error: 'AI reasoning failed for chain sub-task' };
              }
            } catch (aiErr) {
              stepResult = { success: false, error: `AI fallback error: ${aiErr.message}` };
            }
            } // end else (compose guard)
            } // end if (!stepResult || !stepResult.success) — last-chance recipe may have succeeded
          }

          // Track compose opens to prevent duplicate compose windows
          if (stepResult?.success && /compose|email|send|write/i.test(subTask.category || subTask.intent || '')) {
            composeOpened = true;
          }

          // Capture page outputs after this sub-task (URL + title + visible content from active tab)
          // The visible content is critical for cross-step context (e.g., search results → email body)
          if (stepResult?.success) {
            try {
              const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
              const capturedOutput = {
                page_url: activeTab?.url || '',
                page_title: activeTab?.title || '',
              };

              // Capture visible page content for downstream steps (e.g., product details for email)
              try {
                const [scraped] = await chrome.scripting.executeScript({
                  target: { tabId: activeTab.id },
                  func: () => {
                    // Extract meaningful content: product info, search results, article text
                    const body = document.body?.innerText || '';
                    // Trim to 3000 chars to keep context manageable
                    return body.slice(0, 3000);
                  },
                });
                if (scraped?.result) {
                  capturedOutput.page_content = scraped.result;
                }
              } catch { /* page may block injection — continue without content */ }

              outputStore[subTask.order] = capturedOutput;
            } catch {
              outputStore[subTask.order] = {};
            }
          }

          chainResults.push({
            order: subTask.order,
            intent: subTask.intent,
            domain: subTask.domain,
            method: subTask.executionMethod,
            recipeName: subTask.recipe?.autoDescription || subTask.recipe?.workflowName || null,
            success: !!stepResult?.success,
            duration: stepResult?.durationMs || 0,
            error: stepResult?.error || null,
          });

          // Notify UI that this sub-task completed
          broadcastChainProgress(
            subTask.order, totalSubTasks,
            stepResult?.success
              ? `Done: ${subTask.intent}`
              : `Failed: ${subTask.intent}`,
            nextSubTask ? `Next: ${nextSubTask.intent}` : 'Finishing up...'
          );

          // If a critical sub-task failed, stop the chain
          if (!stepResult?.success) {
            chainSuccess = false;
            break;
          }
        }

        // If all recipe sub-tasks succeeded, return the chain result
        if (chainSuccess) {
          const totalDuration = chainResults.reduce((sum, r) => sum + (r.duration || 0), 0);
          const recipesUsed = chainResults.filter(r => r.method === 'recipe_replay' && r.success).length;
          const awaitingActions = chainResults.filter(r => r.awaitingUserAction);
          const headline = awaitingActions.length > 0
            ? `Chain complete! ${chainResults.length} tasks done — ${awaitingActions.length} awaiting your click`
            : `Chain complete! ${chainResults.length} tasks done`;
          return {
            success: true,
            data: {
              action_type: 'RECIPE_REPLAY_COMPLETE',
              headline,
              primary_content: chainResults.map(r => {
                const status = r.awaitingUserAction
                  ? `Awaiting your click on "${r.consequentialStep}"`
                  : r.success ? 'Done' : 'Failed';
                return `${r.order}. ${r.intent} (${r.domain}) — ${status}${r.recipeName ? ' via "' + r.recipeName + '"' : ''}`;
              }).join('\n'),
              chain_results: chainResults,
              consent_level: 'none',
            },
          };
        }
        // If chain failed partway, fall through to AI for the remaining request
        console.log('[BG] Chain execution incomplete, falling through to AI');
      }
    } catch (chainErr) {
      // Non-critical — fall through to normal AI flow
      console.warn('[BG] Chain execution check failed (non-fatal):', chainErr.message);
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

    // ── Chat-to-memory: harvest personal info from chat messages ─────────────
    // Fire-and-forget — does not delay the AI response. The fetch() call itself
    // is synchronous in terms of initiating the request, so the URL is captured
    // by any fetch interceptor (e.g. tests) before this function returns.
    if (containsPersonalInfo(userPrompt)) {
      fetch(`${API_BASE}/api/memory/harvest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ source: 'chat', text: userPrompt }),
      }).catch(() => {});
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

      // Retry wrapper for transient Chrome errors ("Tabs cannot be edited right now")
      const MAX_NAV_RETRIES = 3;
      for (let attempt = 0; attempt < MAX_NAV_RETRIES; attempt++) {
        try {
          // Check if the target URL is already open in an existing tab
          const allTabs = await chrome.tabs.query({ currentWindow: true });
          const targetHost = new URL(action.value).hostname;
          const existingTab = allTabs.find(t => {
            try { return new URL(t.url).hostname === targetHost; } catch { return false; }
          });

          let navTabId;
          if (existingTab) {
            // Site already open — switch to it AND navigate to the new URL
            await chrome.tabs.update(existingTab.id, { active: true, url: action.value });
            navTabId = existingTab.id;
            await waitForTabLoad(navTabId, 10000);
          } else {
            // Open in a NEW tab so the current page is preserved
            const newTab = await chrome.tabs.create({ url: action.value, active: true });
            navTabId = newTab.id;
            await waitForTabLoad(navTabId, 10000);
          }
          return { success: true, tabId: navTabId };
        } catch (navErr) {
          const msg = (navErr.message || '').toLowerCase();
          if ((msg.includes('cannot be edited') || msg.includes('dragging')) && attempt < MAX_NAV_RETRIES - 1) {
            await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
            continue;
          }
          return { success: false, error: navErr.message || 'Navigation failed.' };
        }
      }
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

      // If the step was a navigation, update tabId and wait for DOM to stabilize
      if (step.action === 'navigate' && stepResult.tabId) {
        currentTabId = stepResult.tabId;
        await waitForDomStable(currentTabId, 4000); // navigation needs longer max
      }

      // If the step was semantic_fill, wait for fields/validation to settle
      if (step.action === 'semantic_fill') {
        await waitForDomStable(currentTabId, 2000);
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
  if (request.type === 'explore_cancel') {
    console.log('[BG] Exploration cancel requested by user');
    explorationAborted = true;
    // Clean up storage immediately so panel recovery doesn't re-trigger
    try {
      await chrome.storage.session.remove(['explorationActive', 'explorationResult', 'explorationProgress']);
    } catch {}
    return { success: true, cancelled: true };
  }

  if (request.type === 'explore_start') {
    explorationAborted = false; // Reset abort flag for new exploration
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

    await resetSessionActionHistory(tabId);

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
    // Retry wrapper for transient Chrome errors ("Tabs cannot be edited right now")
    // that can kill the loop when user switches tabs during exploration.
    (async () => {
      const TRANSIENT_PATTERNS = ['cannot be edited', 'dragging a tab'];
      const MAX_LOOP_RETRIES = 2;
      for (let loopAttempt = 0; loopAttempt <= MAX_LOOP_RETRIES; loopAttempt++) {
        try {
          const result = await runExplorationLoop(explorePlan, tabId, token, null, initialContinuationContext);
          chrome.storage.session.set({ explorationResult: result }).catch(() => {});
          console.log(`[Explore] Loop completed in background (${result.phasesUsed || 1} phase(s), ${result.stepsUsed || 0} steps). Result stored.`);
          return; // success — exit retry loop
        } catch (err) {
          const isTransient = TRANSIENT_PATTERNS.some(p => (err.message || '').includes(p));
          if (isTransient && loopAttempt < MAX_LOOP_RETRIES) {
            const delay = (loopAttempt + 1) * 2000;
            console.warn(`[Explore] Transient error killed loop: "${err.message}". Retrying in ${delay}ms (attempt ${loopAttempt + 1}/${MAX_LOOP_RETRIES})...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          console.error('[Explore] Background loop error:', err);
          chrome.storage.session.set({ explorationResult: { success: false, error: err.message } }).catch(() => {});
          return;
        }
      }
    })();
    return { success: true, async: true, message: 'Exploration started. Progress updates will arrive separately.' };
  }

  // ── PARALLEL_EXPLORE: Multi-tab orchestration ───────────────
  // Fire-and-forget: return immediately, results come via chrome.storage.session
  if (request.type === 'parallel_explore_start') {
    const { parallelPlan, userPrompt } = request.data;
    if (!parallelPlan || !parallelPlan.tabs || parallelPlan.tabs.length < 2) {
      return { success: false, error: 'Invalid parallel plan: need at least 2 tabs.' };
    }

    await resetSessionActionHistory();

    // Clear stale result before starting
    await chrome.storage.session.remove(['parallelExploreResult']).catch(() => {});

    // Run in background — don't await
    (async () => {
      try {
        const result = await runParallelExplore(parallelPlan, userPrompt, token);
        chrome.storage.session.set({ parallelExploreResult: result }).catch(() => {});
        console.log(`[ParallelExplore] Loop completed. ${result.tabCount || 0} tabs, ${result.creditsUsed?.toFixed(1) || '?'} EU. Result stored.`);
      } catch (err) {
        console.error('[ParallelExplore] Background loop error:', err);
        chrome.storage.session.set({ parallelExploreResult: { success: false, error: err.message } }).catch(() => {});
      }
    })();
    return { success: true, async: true, message: 'Parallel exploration started. Progress updates will arrive separately.' };
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
    const { userGoal, category, mode } = request.data || {};
    const tabId = request.data?.tabId || sender?.tab?.id;

    if (!tabId) {
      return { success: false, error: 'Could not determine which tab to semantically analyze.' };
    }

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
  // When user clicks "Delegate" on the dashboard, open the Side Panel and auto-fill
  // it with the task prompt.
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

  // ══════════════════════════════════════════════════════════════
  // ── LEARNING MODE: Centralized Recording Session ──
  // Background.js is the central coordinator for recording.
  // Content scripts report steps individually; we accumulate here.
  // This enables multi-tab recording in Phase 2.
  // ══════════════════════════════════════════════════════════════

  if (request.type === 'learning_session_start') {
    // Initialize a new recording session (called from sidepanel)
    // Recording can start on ANY page, including chrome://newtab and empty tabs.
    // When tabUrl is empty, startUrl/startDomain stay empty until the user navigates
    // to a real website — the webNavigation listener captures that as step 1.
    const { workflowName, tabId, tabUrl } = request.data;
    let startDomain = '';
    try {
      if (tabUrl) startDomain = new URL(tabUrl).hostname.replace(/^www\./, '').toLowerCase();
    } catch { /* empty or invalid URL — that's fine */ }
    const session = {
      active: true,
      workflowName,
      steps: [],
      stepCounter: 0,
      startUrl: tabUrl || '',
      startDomain,
      startedFromEmpty: !tabUrl, // Flag: recording started on non-injectable page
      activeTabId: tabId,
      tabDomains: {},
      startedAt: Date.now(),
    };
    learningPendingSwitch = null;
    if (tabUrl && startDomain) {
      session.tabDomains[tabId] = startDomain;
    }
    await chrome.storage.session.set({ learningSession: session });
    console.log('[Learning] Session started:', workflowName, 'on tab', tabId);

    // ── Navigation Resilience: re-inject content_learning.js on page loads ──
    // Mirrors the EXPLORE pattern (webNavigation listeners + keepAlive).
    // Without this, full page navigations destroy the content script and
    // recording silently dies.

    // Clean up any stale listeners from a previous session
    if (learningNavCleanup) {
      learningNavCleanup();
      learningNavCleanup = null;
    }

    const recordingNavListener = async (details) => {
      if (details.frameId !== 0) return; // ignore iframes
      // Skip chrome:// and extension:// URLs — can't inject content scripts there
      if (details.url.startsWith('chrome://') || details.url.startsWith('chrome-extension://')) return;

      const { learningSession: ls } = await chrome.storage.session.get('learningSession');
      if (!ls?.active) return;
      if (ls.activeTabId !== details.tabId) return; // wrong tab

      // If recording started from an empty/chrome tab, this is the first real navigation.
      // Set the session's startUrl and startDomain now.
      if (ls.startedFromEmpty && !ls.startDomain) {
        try {
          const domain = new URL(details.url).hostname.replace(/^www\./, '').toLowerCase();
          ls.startUrl = details.url;
          ls.startDomain = domain;
          ls.tabDomains[details.tabId] = domain;
          ls.startedFromEmpty = false; // Only set once
          console.log('[Learning] First navigation from empty tab — setting startUrl:', details.url);
        } catch { /* invalid URL — skip */ }
      }

      // Deduplicate: skip if last step is a navigate to the same URL within 2s
      const lastStep = ls.steps[ls.steps.length - 1];
      if (lastStep?.action?.type === 'navigate' &&
          lastStep.action.url === details.url &&
          Date.now() - lastStep.timestamp < 2000) {
        console.log('[Learning] Nav dedup — skipping duplicate navigate to', details.url);
        return;
      }

      console.log('[Learning] webNavigation.onCompleted — re-injecting recorder on', details.url);

      // Auto-insert navigate step into centralized session
      ls.steps.push({
        stepNumber: ++ls.stepCounter,
        action: {
          type: 'navigate',
          url: details.url,
          waitFor: 'load',
          description: `Navigate to ${new URL(details.url).hostname}`,
          autoDetected: true,
          isStartingNavigation: ls.steps.length === 0, // True if this is the very first step
        },
        url: details.url,
        timestamp: Date.now(),
        tabId: details.tabId,
      });
      await chrome.storage.session.set({ learningSession: ls });

      // Re-inject content_learning.js on the new page
      try {
        await chrome.scripting.executeScript({
          target: { tabId: details.tabId },
          func: () => { window.__enhLearningInjected = false; },
        });
        await chrome.scripting.executeScript({
          target: { tabId: details.tabId },
          files: ['content_learning.js'],
        });
        await new Promise(r => setTimeout(r, 300));
        await chrome.tabs.sendMessage(details.tabId, {
          type: 'learning_resume',
          stepCount: ls.stepCounter,
        });
        console.log('[Learning] Recorder re-injected and resumed on', details.url);
      } catch (err) {
        console.warn('[Learning] Re-injection failed (restricted page?):', err.message);
      }
    };

    const recordingSpaNavListener = async (details) => {
      if (details.frameId !== 0) return;
      const { learningSession: ls } = await chrome.storage.session.get('learningSession');
      if (!ls?.active) return;
      if (ls.activeTabId !== details.tabId) return;

      // Deduplicate: skip if last step is a navigate to the same URL within 2s
      const lastStep = ls.steps[ls.steps.length - 1];
      if (lastStep?.action?.type === 'navigate' &&
          lastStep.action.url === details.url &&
          Date.now() - lastStep.timestamp < 2000) {
        return;
      }

      console.log('[Learning] SPA navigation (onHistoryStateUpdated) — re-injecting recorder on', details.url);

      // Auto-insert navigate step
      ls.steps.push({
        stepNumber: ++ls.stepCounter,
        action: {
          type: 'navigate',
          url: details.url,
          waitFor: 'load',
          description: `Navigate to ${new URL(details.url).hostname}`,
          autoDetected: true,
        },
        url: details.url,
        timestamp: Date.now(),
        tabId: details.tabId,
      });
      await chrome.storage.session.set({ learningSession: ls });

      // SPA navigations don't destroy the content script, but re-inject anyway
      // to ensure the URL observer picks up the new URL correctly
      try {
        await chrome.scripting.executeScript({
          target: { tabId: details.tabId },
          func: () => { window.__enhLearningInjected = false; },
        });
        await chrome.scripting.executeScript({
          target: { tabId: details.tabId },
          files: ['content_learning.js'],
        });
        await new Promise(r => setTimeout(r, 300));
        await chrome.tabs.sendMessage(details.tabId, {
          type: 'learning_resume',
          stepCount: ls.stepCounter,
        });
      } catch (err) {
        console.warn('[Learning] SPA re-injection failed:', err.message);
      }
    };

    chrome.webNavigation.onCompleted.addListener(recordingNavListener);
    chrome.webNavigation.onHistoryStateUpdated.addListener(recordingSpaNavListener);

    // Service worker keepalive during recording
    const recordingKeepAlive = setInterval(() => {
      chrome.runtime.getPlatformInfo(() => {});
    }, 20000);

    // Store cleanup function
    learningNavCleanup = () => {
      chrome.webNavigation.onCompleted.removeListener(recordingNavListener);
      chrome.webNavigation.onHistoryStateUpdated.removeListener(recordingSpaNavListener);
      clearInterval(recordingKeepAlive);
      console.log('[Learning] Navigation listeners + keepAlive cleaned up');
    };

    return { success: true };
  }

  if (request.type === 'learning_step_recorded') {
    // A content script reported a new step — append to centralized log
    const { learningSession } = await chrome.storage.session.get('learningSession');
    if (!learningSession?.active) return { success: false };

    const step = request.data;
    step.stepNumber = ++learningSession.stepCounter;
    step.tabId = sender?.tab?.id || learningSession.activeTabId;

    learningSession.steps.push(step);
    await chrome.storage.session.set({ learningSession });
    return { success: true };
  }

  if (request.type === 'learning_step_update') {
    // Update an existing type step's fixedValue (debounce — same element, new value)
    const { learningSession } = await chrome.storage.session.get('learningSession');
    if (!learningSession?.active) return { success: false };

    const { elementKey, fixedValue } = request.data;

    // Search backward for matching type step
    for (let i = learningSession.steps.length - 1; i >= 0; i--) {
      const s = learningSession.steps[i];
      if (s.action.type !== 'type' && s.action.type !== 'wait') break;
      if (s.action.type === 'type' && s._elementKey === elementKey) {
        if (s.action.inputType === 'fixed') {
          s.action.fixedValue = fixedValue;
        }
        break;
      }
    }

    await chrome.storage.session.set({ learningSession });
    return { success: true };
  }

  if (request.type === 'learning_session_stop') {
    // Content script clicked Done — build recipe and forward to sidepanel
    const { learningSession } = await chrome.storage.session.get('learningSession');
    if (!learningSession) return { success: false };

    // Clean up navigation listeners + keepAlive
    if (learningNavCleanup) { learningNavCleanup(); learningNavCleanup = null; }
    learningPendingSwitch = null;

    const recipe = buildRecipeFromSession(learningSession);
    console.log('[Learning] Session stopped. Built recipe:', recipe.metadata.totalSteps, 'steps');

    // Clear session
    await chrome.storage.session.remove('learningSession');

    // Forward to sidepanel for review
    try {
      await chrome.runtime.sendMessage({
        type: 'learning_recipe_recorded',
        data: recipe,
      });
    } catch {
      await chrome.storage.session.set({ pendingRecipe: recipe });
    }
    return { success: true };
  }

  if (request.type === 'learning_session_cancel') {
    // Clean up navigation listeners + keepAlive
    if (learningNavCleanup) { learningNavCleanup(); learningNavCleanup = null; }
    learningPendingSwitch = null;

    await chrome.storage.session.remove('learningSession');
    console.log('[Learning] Session cancelled');
    return { success: true };
  }

  if (request.type === 'learning_session_status') {
    // Sidepanel polls this for step count
    const { learningSession } = await chrome.storage.session.get('learningSession');
    if (!learningSession?.active) {
      return { success: true, active: false, stepCount: 0 };
    }
    const actionSteps = learningSession.steps.filter(s => s.action.type !== 'wait');
    const domains = [...new Set(Object.values(learningSession.tabDomains))];
    return {
      success: true,
      active: true,
      stepCount: actionSteps.length,
      domains,
      workflowName: learningSession.workflowName,
    };
  }

  // ── LEARNING MODE: Save recorded recipe to backend ──
  if (request.type === 'learning_save_recipe') {
    const { token } = await chrome.storage.local.get(['token']);
    if (!token) return { success: false, error: 'Not authenticated. Please sign in again.' };

    // Pre-validate before sending to backend
    const recipe = request.data;
    if (!recipe || !Array.isArray(recipe.steps) || recipe.steps.length === 0) {
      console.warn('[Learning] Save blocked: recipe has no steps after filtering.');
      return { success: false, error: 'Recording produced no usable steps. Try recording a longer workflow with clicks and typing.' };
    }
    if (!recipe.workflowName || !recipe.siteDomain) {
      return { success: false, error: 'Recipe is missing a name or site domain.' };
    }

    try {
      const response = await fetch(`${API_BASE}/api/recipes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(recipe),
      });

      let result;
      try {
        result = await response.json();
      } catch (parseErr) {
        console.error('[Learning] Save recipe: non-JSON response, status:', response.status);
        return { success: false, error: `Server error (HTTP ${response.status}). Backend may be down.` };
      }

      if (!response.ok) {
        console.error('[Learning] Save recipe failed:', response.status, result?.error);
        return { success: false, error: result?.error || `Server rejected recipe (HTTP ${response.status}).` };
      }

      return result;
    } catch (err) {
      console.error('[Learning] Save recipe error:', err.message);
      return { success: false, error: 'Failed to save recipe to server. Check your connection.' };
    }
  }

  // ── LEARNING MODE: Get user's recipes ──
  if (request.type === 'learning_get_recipes') {
    const { token } = await chrome.storage.local.get(['token']);
    if (!token) return { success: false, error: 'Not authenticated. Please sign in again.' };

    try {
      const response = await fetch(`${API_BASE}/api/recipes/mine`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      let result;
      try {
        result = await response.json();
      } catch (parseErr) {
        console.error('[Learning] Get recipes: non-JSON response, status:', response.status);
        return { success: false, error: `Server error (HTTP ${response.status}). Backend may be down.` };
      }

      if (!response.ok) {
        console.error('[Learning] Get recipes failed:', response.status, result?.error);
        return { success: false, error: result?.error || `Failed to fetch recipes (HTTP ${response.status}).` };
      }

      return result;
    } catch (err) {
      console.error('[Learning] Get recipes error:', err.message);
      return { success: false, error: 'Failed to fetch recipes. Check your connection.' };
    }
  }

  // ── LEARNING MODE: Delete recipe ──
  if (request.type === 'learning_delete_recipe') {
    const { token } = await chrome.storage.local.get(['token']);
    if (!token) return { success: false, error: 'Not authenticated.' };

    try {
      const response = await fetch(`${API_BASE}/api/recipes/${request.data.recipeId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      let result;
      try {
        result = await response.json();
      } catch {
        return { success: false, error: `Server error (HTTP ${response.status}).` };
      }

      if (!response.ok) {
        return { success: false, error: result?.error || `Delete failed (HTTP ${response.status}).` };
      }

      return result;
    } catch (err) {
      console.error('[Learning] Delete recipe error:', err.message);
      return { success: false, error: 'Failed to delete recipe.' };
    }
  }

  // ── LEARNING MODE: Recipe completed from content script ──
  if (request.type === 'learning_recipe_complete') {
    // Forward recipe data to the side panel for review
    try {
      await chrome.runtime.sendMessage({
        type: 'learning_recipe_recorded',
        data: request.data,
      });
    } catch {
      // Side panel may not be listening — store in session for later pickup
      await chrome.storage.session.set({ pendingRecipe: request.data });
    }
    return { success: true };
  }

  // ── LEARNING MODE: Replay a recipe on active tab ──
  if (request.type === 'learning_replay_recipe') {
    const { recipe, variables, taskContext, originalPrompt } = request.data;
    const runtimeRecipe = upgradeRecipeForReplay(recipe);

    // Use originalPrompt (the user's raw input) for search query extraction.
    // taskContext may contain enriched data from previous chain steps — don't use it for search.
    const promptForSearch = originalPrompt || taskContext || '';

    // Extract recipient: prefer explicit email address; fall back to contact name.
    // Email clients (Gmail, Outlook, etc.) resolve contact names to email via autocomplete.
    const emailsInPrompt = promptForSearch.match(/[^\s@]+@[^\s@]+\.[^\s@]+/g) || [];
    const recipientNameMatch = promptForSearch.match(
      /\b(?:write|send|email|message|compose)(?:\s+(?:an?\s+)?(?:email|message))?\s+to\s+([\w][\w.\-]*)/i
    );
    const recipientEmail = emailsInPrompt[0] || variables?.__recipient_email || recipientNameMatch?.[1] || '';

    // For compound prompts like "find X then write email to Y about Z", extract only the
    // first clause (the search term). Match everything BEFORE "then/and then + action-verb"
    // so the entire second clause — including "email to kibromamaniel..." — is dropped.
    const compoundSplit = promptForSearch.match(
      /^([\s\S]+?)\b(?:and\s+then|then|after\s+that)\s+(?:write|send|email|compose|reply|message|forward|call|book|order|buy|purchase|post|tweet|slack|notify|tell)\b/i
    );
    const promptForSearchTrimmed = compoundSplit ? compoundSplit[1].trim() : promptForSearch.trim();

    const searchQueryFromPrompt = promptForSearchTrimmed
      .replace(/\b(search|find|look\s*for|browse|shop|buy|purchase|order|get|show|display|email|compose|write|send|reply|message|forward|then|and|on|in|at|the|a|an|for|to|from|my|me|please|can|you|i|want|need|under|over|below|above|less\s*than|more\s*than|cheaper\s*than|about|tell|compile|what|which|who|when|where|how|got|bought|found|used)\b/gi, ' ')
      .replace(/\b(amazon|ebay|walmart|etsy|gmail|outlook|yahoo|linkedin|twitter|reddit|facebook|instagram|youtube|google|slack|discord|zillow|airbnb|indeed|circlenomy)\b/gi, ' ')
      .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, ' ') // Remove emails
      .replace(/[^\w\s\-]/g, ' ')                 // Remove special chars (URLs, punctuation)
      .replace(/\s+/g, ' ')
      .trim();

    const runtimeVariables = {
      ...(variables || {}),
      __task_context: taskContext || runtimeRecipe?.workflowName || '',
      __workflow_name: runtimeRecipe?.workflowName || '',
      __search_query: searchQueryFromPrompt || variables?.__search_query || '',
      __recipient_email: recipientEmail,
    };
    const hasSwitchTab = runtimeRecipe.steps.some(s => s.action.type === 'switch_tab');

    try {
      await updateReplayActivity({
        mode: hasSwitchTab ? 'multi_tab_replay' : 'recipe_replay',
        workflowName: runtimeRecipe?.workflowName || '',
        stepNumber: 0,
        totalSteps: runtimeRecipe?.steps?.length || 0,
        description: hasSwitchTab ? 'Preparing multi-tab action...' : 'Preparing action...',
        phase: 'preparing',
      });

      if (!hasSwitchTab) {
        // ── Single-tab replay ──
        let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return { success: false, error: 'No active tab for replay.' };

        const startResolution = await resolveReplayStartTab(runtimeRecipe, tab.id);
        if (startResolution?.tabId) {
          tab = await chrome.tabs.get(startResolution.tabId).catch(() => tab);
        }

        // Inject and run — if a navigate step triggers mid-replay, the content
        // script returns partial:true. We re-inject on the new page and continue
        // with remaining steps (up to 5 continuation attempts to prevent infinite loops).
        //
        // NAVIGATION RESILIENCE: Also detect click-triggered navigations via
        // webNavigation.onCompleted — if the content script dies before returning
        // partial:true (race condition), we catch it here and continue.
        let completedSoFar = 0;
        let allResults = [];
        let remainingRecipe = { ...runtimeRecipe, steps: [...runtimeRecipe.steps] };
        const totalSteps = runtimeRecipe.steps.length;
        const replayStartTime = Date.now();
        const MAX_CONTINUATIONS = 3;

        // Navigation detection via webNavigation (catches click-triggered page loads)
        let replayNavDetected = false;
        const replayNavListener = (details) => {
          if (details.tabId !== tab.id || details.frameId !== 0) return;
          replayNavDetected = true;
          console.log('[Learning] Replay: navigation detected via webNavigation:', details.url);
        };
        chrome.webNavigation.onCompleted.addListener(replayNavListener);

        // Track step progress via replay_progress messages
        let lastReplayProgressStep = 0;
        const replayProgressTracker = (request) => {
          if (request.type === 'replay_progress' && request.data?.stepNumber) {
            lastReplayProgressStep = Math.max(lastReplayProgressStep, request.data.stepNumber);
          }
        };
        chrome.runtime.onMessage.addListener(replayProgressTracker);

        // KeepAlive to prevent service worker death during long replays
        const replayKeepAlive = setInterval(() => {
          chrome.runtime.getPlatformInfo(() => {});
        }, 20000);

        const cleanupReplay = () => {
          chrome.webNavigation.onCompleted.removeListener(replayNavListener);
          chrome.runtime.onMessage.removeListener(replayProgressTracker);
          clearInterval(replayKeepAlive);
        };

        try {
        for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
          replayNavDetected = false;

          // Reset the injection flag so content_replay.js can re-inject on new pages
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => { window.__enhReplayInjected = false; },
            });
          } catch {}

          // Inject content_replay.js — may fail on restricted pages (chrome://, edge://, etc.)
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content_replay.js'],
            });
          } catch (injectErr) {
            cleanupReplay();
            return {
              success: false,
              error: `Cannot inject replay engine into this page: ${injectErr.message}`,
              completedSteps: completedSoFar,
              totalSteps,
            };
          }
          const replayReady = await waitForReplayReady(tab.id, 5000);
          if (!replayReady) {
            cleanupReplay();
            return {
              success: false,
              error: 'Replay engine did not become ready on this page.',
              completedSteps: completedSoFar,
              totalSteps,
            };
          }

          // Send replay command — .catch() prevents hang if content script is dead/unresponsive
          let result = await chrome.tabs.sendMessage(tab.id, {
            type: 'replay_recipe',
            recipe: remainingRecipe,
            variables: runtimeVariables,
          }).catch(err => {
            console.error('[Learning] sendMessage failed:', err.message);
            return null;
          });

          if (!result && !replayNavDetected) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => { window.__enhReplayInjected = false; },
              });
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content_replay.js'],
              });
            } catch {}

            if (await waitForReplayReady(tab.id, 3000)) {
              result = await chrome.tabs.sendMessage(tab.id, {
                type: 'replay_recipe',
                recipe: remainingRecipe,
                variables: runtimeVariables,
              }).catch(() => null);
            }
          }

          if (!result) {
            // Content script died — check if a click-triggered navigation caused it
            if (replayNavDetected) {
              // Navigation killed the content script before it could return partial:true.
              // Use lastReplayProgressStep as best estimate of completed steps.
              completedSoFar = Math.max(completedSoFar, lastReplayProgressStep);
              console.log(`[Learning] Click-triggered navigation detected. ~${completedSoFar}/${totalSteps} steps done. Continuing...`);

              // Wait for the new page to settle
              await new Promise(r => setTimeout(r, 1500));

              // Refresh tab reference
              [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
              if (!tab) {
                cleanupReplay();
                return { success: false, error: 'Tab closed during navigation.', completedSteps: completedSoFar, totalSteps };
              }

              // Safety: check if we navigated to an auth/login page — stop immediately
              try {
                const [authCheck] = await chrome.scripting.executeScript({
                  target: { tabId: tab.id },
                  func: () => {
                    const url = window.location.href.toLowerCase();
                    const AUTH_PATTERNS = [
                      /\/signin\b/, /\/sign-in\b/, /\/login\b/, /\/log-in\b/,
                      /\/register\b/, /\/signup\b/, /\/sign-up\b/, /\/createaccount\b/,
                      /\/ap\/signin/, /\/ap\/register/,
                      /\/auth\//, /\/oauth\//, /\/sso\//,
                    ];
                    return AUTH_PATTERNS.some(p => p.test(url));
                  },
                });
                if (authCheck?.result) {
                  console.warn('[Learning] Replay navigated to auth/login page — stopping to prevent unintended actions.');
                  cleanupReplay();
                  return {
                    success: false,
                    error: 'Recipe navigated to a login/authentication page. Replay stopped for safety.',
                    completedSteps: completedSoFar,
                    totalSteps,
                    results: allResults,
                    durationMs: Date.now() - replayStartTime,
                  };
                }
              } catch { /* page may be restricted — continue cautiously */ }

              // Build remaining steps and continue
              const remaining = runtimeRecipe.steps.slice(completedSoFar);
              if (remaining.length === 0) {
                cleanupReplay();
                return { success: true, partial: false, completedSteps: completedSoFar, totalSteps, results: allResults, durationMs: Date.now() - replayStartTime };
              }
              remainingRecipe = { ...runtimeRecipe, steps: remaining.map((s, idx) => ({ ...s, stepNumber: idx + 1 })) };
              continue;
            }
            cleanupReplay();
            return { success: false, error: 'No response from replay engine — content script may have crashed or page is restricted.', completedSteps: completedSoFar, totalSteps };
          }

          allResults.push(...(result.results || []));
          completedSoFar += result.completedSteps || 0;

          // Full completion or failure — return immediately
          if (!result.partial) {
            cleanupReplay();
            return {
              ...result,
              completedSteps: completedSoFar,
              totalSteps,
              results: allResults,
              durationMs: Date.now() - replayStartTime,
            };
          }

          // Partial — navigate step triggered page change. Wait for new page to load,
          // then continue with remaining steps.
          console.log(`[Learning] Partial replay: ${completedSoFar}/${totalSteps} done. Waiting for page load to continue...`);

          // Wait for the tab to finish loading
          await new Promise((resolve) => {
            const onLoad = (tabId, changeInfo) => {
              if (tabId === tab.id && changeInfo.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(onLoad);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(onLoad);
            setTimeout(() => { chrome.tabs.onUpdated.removeListener(onLoad); resolve(); }, 10000);
          });
          await new Promise(r => setTimeout(r, 1000)); // SPA render delay

          // Refresh tab reference (URL may have changed)
          [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab) {
            cleanupReplay();
            return { success: false, error: 'Tab closed during navigation.', completedSteps: completedSoFar, totalSteps };
          }

          // Slice remaining steps and rebuild recipe for continuation
          const remaining = runtimeRecipe.steps.slice(completedSoFar);
          if (remaining.length === 0) {
            cleanupReplay();
            return { success: true, partial: false, completedSteps: completedSoFar, totalSteps, results: allResults, durationMs: Date.now() - replayStartTime };
          }
          remainingRecipe = { ...runtimeRecipe, steps: remaining.map((s, idx) => ({ ...s, stepNumber: idx + 1 })) };
        }

        // Exhausted continuation attempts
        cleanupReplay();
        return {
          success: false,
          error: `Recipe navigated too many times (${MAX_CONTINUATIONS} continuations). ${completedSoFar}/${totalSteps} steps completed.`,
          completedSteps: completedSoFar,
          totalSteps,
          results: allResults,
          durationMs: Date.now() - replayStartTime,
        };
        } finally {
          cleanupReplay();
        }
      }

      // ── Multi-tab replay: orchestrate across tabs ──
      console.log('[Learning] Multi-tab replay starting:', runtimeRecipe.workflowName);

      // Split steps into segments by switch_tab boundaries
      const segments = splitIntoSegments(runtimeRecipe.steps);
      console.log('[Learning] Recipe split into', segments.length, 'segments');

      const allResults = [];
      let totalCompleted = 0;
      const totalSteps = runtimeRecipe.steps.length;
      const startTime = Date.now();
      const initialStartTab = await resolveReplayStartTab(runtimeRecipe);

      // Navigation detection for multi-tab replay (same pattern as single-tab)
      let mtNavDetected = false;
      let mtLastProgressStep = 0;
      let mtCurrentTabId = null;

      const mtNavListener = (details) => {
        if (details.frameId !== 0) return;
        if (mtCurrentTabId && details.tabId !== mtCurrentTabId) return;
        mtNavDetected = true;
        console.log('[Learning] Multi-tab replay: navigation detected via webNavigation:', details.url);
      };
      const mtProgressTracker = (request) => {
        if (request.type === 'replay_progress' && request.data?.stepNumber) {
          mtLastProgressStep = Math.max(mtLastProgressStep, request.data.stepNumber);
        }
      };
      chrome.webNavigation.onCompleted.addListener(mtNavListener);
      chrome.runtime.onMessage.addListener(mtProgressTracker);
      const mtKeepAlive = setInterval(() => { chrome.runtime.getPlatformInfo(() => {}); }, 20000);

      const cleanupMultiTab = () => {
        chrome.webNavigation.onCompleted.removeListener(mtNavListener);
        chrome.runtime.onMessage.removeListener(mtProgressTracker);
        clearInterval(mtKeepAlive);
      };

        try {
      for (let segIdx = 0; segIdx < segments.length; segIdx++) {
        const segment = segments[segIdx];

        let targetTabId = null;

        // If this segment starts with a tab switch, handle it
        if (segment.switchTo) {
          console.log('[Learning] Switching to:', segment.switchTo.domain);
          await updateReplayActivity({
            mode: 'multi_tab_replay',
            workflowName: runtimeRecipe?.workflowName || '',
            stepNumber: Math.min(totalCompleted + 1, totalSteps),
            totalSteps,
            description: `Switching to ${segment.switchTo.domain}...`,
            phase: 'switching_tab',
          });

          targetTabId = await findTabByDomain(
            segment.switchTo.domain,
            segment.switchTo.url
          );

          if (!targetTabId) {
            cleanupMultiTab();
            return {
              success: false,
              failedAtStep: segment.steps[0]?.stepNumber || totalCompleted + 1,
              failReason: `Could not find or open tab for ${segment.switchTo.domain}`,
              results: allResults,
              durationMs: Date.now() - startTime,
            };
          }

          // Activate the tab and wait for it to be ready
          await chrome.tabs.update(targetTabId, { active: true });
          await new Promise(r => setTimeout(r, 500));

          // Count the switch_tab step itself as completed (it's included in totalSteps now)
          totalCompleted += 1;
        } else if (segIdx === 0 && initialStartTab?.tabId) {
          targetTabId = initialStartTab.tabId;
          await chrome.tabs.update(targetTabId, { active: true });
          const startTab = await chrome.tabs.get(targetTabId).catch(() => null);
          if (startTab?.windowId) {
            await chrome.windows.update(startTab.windowId, { focused: true }).catch(() => {});
          }
        }

        // Get the current active tab (should be the right one after switch/start resolution)
        let activeTab = null;
        if (targetTabId) {
          activeTab = await chrome.tabs.get(targetTabId).catch(() => null);
        }
        if (!activeTab) {
          [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        }
        if (!activeTab) {
          cleanupMultiTab();
          return {
            success: false,
            failedAtStep: totalCompleted + 1,
            failReason: 'No active tab found for segment ' + (segIdx + 1),
            results: allResults,
            durationMs: Date.now() - startTime,
          };
        }

        mtCurrentTabId = activeTab.id;
        mtNavDetected = false;
        await updateReplayActivity({
          mode: 'multi_tab_replay',
          workflowName: runtimeRecipe?.workflowName || '',
          stepNumber: Math.min(totalCompleted + 1, totalSteps),
          totalSteps,
          description: `Working in ${segment.switchTo?.domain || new URL(activeTab.url || runtimeRecipe.startUrl || 'https://example.com').hostname}...`,
          phase: 'running_segment',
        });

        // Inject replay engine into this tab
        try {
          await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            func: () => { window.__enhReplayInjected = false; },
          });
          await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            files: ['content_replay.js'],
          });
        } catch (injectErr) {
          cleanupMultiTab();
          return {
            success: false,
            failedAtStep: totalCompleted + 1,
            failReason: `Cannot inject into tab: ${injectErr.message}`,
            results: allResults,
            durationMs: Date.now() - startTime,
          };
        }
        const segmentReady = await waitForReplayReady(activeTab.id, 5000);
        if (!segmentReady) {
          cleanupMultiTab();
          return {
            success: false,
            failedAtStep: totalCompleted + 1,
            failReason: 'Replay engine did not become ready on the target tab.',
            results: allResults,
            durationMs: Date.now() - startTime,
          };
        }

        // Tag each step with total steps count for progress reporting
        const stepsWithTotal = segment.steps.map(s => ({ ...s, _totalSteps: totalSteps }));

        // Send this segment's steps to the content script
        let segResult = await chrome.tabs.sendMessage(activeTab.id, {
          type: 'replay_steps',
          steps: stepsWithTotal,
          variables: runtimeVariables,
        }).catch(err => {
          console.error('[Learning] sendMessage to segment failed:', err.message);
          return null;
        });

        if (!segResult && !mtNavDetected) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: activeTab.id },
              func: () => { window.__enhReplayInjected = false; },
            });
            await chrome.scripting.executeScript({
              target: { tabId: activeTab.id },
              files: ['content_replay.js'],
            });
          } catch {}

          if (await waitForReplayReady(activeTab.id, 3000)) {
            segResult = await chrome.tabs.sendMessage(activeTab.id, {
              type: 'replay_steps',
              steps: stepsWithTotal,
              variables: runtimeVariables,
            }).catch(() => null);
          }
        }

        if (!segResult) {
          // Content script died — check if navigation caused it
          if (mtNavDetected) {
            const stepsInSegment = mtLastProgressStep > 0 ? mtLastProgressStep : 0;
            totalCompleted += stepsInSegment;
            console.log(`[Learning] Multi-tab: click-triggered nav in segment ${segIdx + 1}. ~${totalCompleted}/${totalSteps} done.`);

            // Wait for new page to settle, then let the loop continue to next segment
            await new Promise(r => setTimeout(r, 1500));
            continue;
          }

          cleanupMultiTab();
          return {
            success: false,
            failedAtStep: totalCompleted + 1,
            failReason: 'No response from replay engine on segment ' + (segIdx + 1) + ' — content script may have crashed.',
            results: allResults,
            durationMs: Date.now() - startTime,
          };
        }

        allResults.push(...(segResult.results || []));
        totalCompleted += segResult.completedSteps || 0;

        if (!segResult.success) {
          cleanupMultiTab();
          return {
            success: false,
            failedAtStep: segResult.failedAtStep,
            failReason: segResult.failReason,
            results: allResults,
            durationMs: Date.now() - startTime,
          };
        }
      }

      cleanupMultiTab();
      return {
        success: true,
        partial: false,
        completedSteps: totalCompleted,
        totalSteps,
        results: allResults,
        durationMs: Date.now() - startTime,
      };
      } finally {
        cleanupMultiTab();
      }
    } catch (err) {
      console.error('[Learning] Replay error:', err.message);
      return { success: false, error: err.message };
    } finally {
      await clearReplayActivity('done');
    }
  }

  // ── LEARNING MODE: Record replay outcome ──
  if (request.type === 'learning_record_outcome') {
    const { token } = await chrome.storage.local.get(['token']);
    if (!token) return { success: false };

    const { recipeId, success, durationMs } = request.data;
    const endpoint = success ? 'validate' : 'fail';

    try {
      await fetch(`${API_BASE}/api/recipes/${recipeId}/${endpoint}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ durationMs }),
      });
    } catch {}
    return { success: true };
  }

  // ── LEARNING MODE: Check for matching recipe before AI call ──
  if (request.type === 'learning_check_recipe') {
    const { token } = await chrome.storage.local.get(['token']);
    if (!token) return { success: false };

    const { siteDomain, task } = request.data;
    try {
      const response = await fetch(
        `${API_BASE}/api/recipes/match?siteDomain=${encodeURIComponent(siteDomain)}&task=${encodeURIComponent(task)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const result = await response.json();
      return result;
    } catch {
      return { success: false };
    }
  }

  // ── RECIPE LLM FILL: Generate text via AI during recipe replay ──
  // The replay navigator pauses while this runs. No timeout pressure —
  // the content script has its own 3-minute safety cap.
  if (request.type === 'recipe_llm_fill') {
    const { prompt, pageContext, extraContext, fieldDescription } = request.data;
    const { token } = await chrome.storage.local.get(['token']);

    if (!token) return { success: false, error: 'Not authenticated' };

    try {
      const taskContext = extraContext?.taskContext || '';
      const workflowName = extraContext?.workflowName || '';

      const buildRecipeFillRequest = (strict = false) => {
        // Extract the user's original request from task context (first line after "User's request:")
        const userRequestMatch = taskContext.match(/User's request:\s*(.+?)(?:\n|$)/i);
        const userOriginalRequest = userRequestMatch ? userRequestMatch[1].trim() : '';

        // Extract any pre-generated content from task context
        const preGenMatch = taskContext.match(/Pre-generated (?:body|content|message):\s*(.+?)(?:\n\n|$)/is);
        const preGeneratedContent = preGenMatch ? preGenMatch[1].trim() : '';

        const systemPrompt = [
          'You are a text generation assistant embedded in a browser automation workflow.',
          'The user is replaying a recipe and needs you to generate text to fill into a form field.',
          'PRIORITY ORDER for content generation:',
          '1. If pre-generated content is provided below, use it as-is or refine it slightly.',
          '2. If the user\'s original request specifies what to write, follow that instruction exactly.',
          '3. Use task context and page context only as supporting reference.',
          'NEVER use example text from recipe recordings. NEVER use placeholder or test content.',
          'Generate ONLY the text content for the target field.',
          'Do not return JSON, markdown, labels, commentary, or explanation.',
          strict ? 'This is a retry because the previous output was invalid. Return plain natural language text only.' : '',
          fieldDescription ? `Field: ${fieldDescription}` : '',
          workflowName ? `Workflow: ${workflowName}` : '',
          userOriginalRequest ? `User's original request: "${userOriginalRequest}"` : '',
          preGeneratedContent ? `Pre-generated content (use this as primary source):\n${preGeneratedContent}` : '',
          taskContext ? `Full task context:\n${taskContext}` : '',
          pageContext ? `Visible page context (secondary reference only):\n${pageContext.slice(0, 1200)}` : '',
        ].filter(Boolean).join('\n');

        const userPrompt = [
          prompt,
          userOriginalRequest ? `The user said: "${userOriginalRequest}" — follow this instruction for content.` : '',
          preGeneratedContent ? `Use this pre-generated content: "${preGeneratedContent}"` : '',
          taskContext && !userOriginalRequest ? `Current task: ${taskContext}` : '',
          strict ? 'Return only the final text that should be typed into the field.' : '',
        ].filter(Boolean).join('\n\n');

        return { systemPrompt, userPrompt };
      };

      const looksBadOutput = (text) => {
        const trimmed = String(text || '').trim();
        if (!trimmed) return true;
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) return true;
        if (/"title"\s*:|"description"\s*:|"dueDate"\s*:|"priority"\s*:/i.test(trimmed)) return true;
        if (/^action_type\s*:|^headline\s*:/i.test(trimmed)) return true;

        // Use taskContext for relevance check, but only extract keywords from the FIRST LINE
        // (the sub-task intent), not from enriched previous-step data which may contain
        // irrelevant content from prior pages
        if (taskContext) {
          // Take only the first line (sub-task intent) to avoid false positives from enriched context
          const intentLine = taskContext.split('\n')[0] || taskContext;
          const taskWords = intentLine.toLowerCase().match(/[a-z]{4,}/g) || [];
          const stopWords = ['that', 'with', 'then', 'check', 'write', 'email', 'launching', 'search',
            'find', 'about', 'compile', 'tell', 'from', 'into', 'steps', 'data', 'previous', 'content'];
          const distinctiveWords = [...new Set(taskWords)].filter(w => !stopWords.includes(w)).slice(0, 4);
          if (distinctiveWords.length > 0) {
            const lower = trimmed.toLowerCase();
            const hitCount = distinctiveWords.filter(w => lower.includes(w)).length;
            if (hitCount === 0 && trimmed.length > 30) return true;
          }
        }

        return false;
      };

      const callRecipeFill = async (strict = false) => {
        const payload = buildRecipeFillRequest(strict);
        const response = await fetch(`${API_BASE}/api/agent/recipe-fill`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          return { success: false, error: `Backend returned ${response.status}` };
        }

        const data = await response.json();
        const text = data.text || data.content || '';
        return { success: true, text, source: strict ? 'recipe-fill-retry' : 'recipe-fill' };
      };

      let result = await callRecipeFill(false);
      if (!result.success) return result;

      if (looksBadOutput(result.text)) {
        result = await callRecipeFill(true);
      }

      if (!result.success || looksBadOutput(result.text)) {
        return { success: false, error: 'AI generated invalid text for this field.' };
      }

      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ── LEARNING MODE: Forward replay progress to side panel ──
  if (request.type === 'replay_progress') {
    try {
      await updateReplayActivity({
        mode: 'recipe_replay',
        ...(request.data || {}),
        phase: request.data?.isLlmStep ? 'generating' : 'running_step',
      });
      await chrome.runtime.sendMessage({
        type: 'replay_progress',
        data: request.data,
      });
    } catch {}
    return { success: true };
  }

  // ── LEARNING MODE: Forward consequential action consent to side panel / floating panel ──
  if (request.type === 'replay_consent_required') {
    try {
      chrome.runtime.sendMessage({
        type: 'replay_consent_notify',
        data: request.data,
      }).catch(() => {});
    } catch {}
    return { received: true };
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
    return;
  }

  // If there is a pending delegation (user clicked Delegate on dashboard then opened panel),
  // relay it to the panel after a short delay for sidepanel.js to finish initialising.
  try {
    const { pendingDelegation } = await chrome.storage.local.get('pendingDelegation');
    if (pendingDelegation?.taskTitle) {
      await new Promise(r => setTimeout(r, 600));
      await chrome.runtime.sendMessage({ type: 'enh_delegate_autofill', payload: pendingDelegation });
    }
  } catch { /* panel not ready or no pending delegation */ }
});

// ══════════════════════════════════════════════════════════════
// ── LEARNING MODE: Multi-Tab Recording (Phase 2) ─────────────
// Detects tab switches during recording, pauses the old tab's
// recorder, injects into the new tab, and inserts switch_tab steps.
// ══════════════════════════════════════════════════════════════

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const { learningSession } = await chrome.storage.session.get('learningSession');
    if (!learningSession?.active) return;

    const newTabId = activeInfo.tabId;
    const oldTabId = learningSession.activeTabId;

    // Same tab — ignore
    if (newTabId === oldTabId) return;

    // Get new tab's info
    let newTab;
    try {
      newTab = await chrome.tabs.get(newTabId);
    } catch {
      return; // Tab doesn't exist or was closed
    }

    // Skip non-injectable pages
    const newUrl = getLearningTabUrl(newTab);
    if (!newUrl || newUrl.startsWith('chrome://') || newUrl.startsWith('chrome-extension://') || newUrl.startsWith('about:')) {
      console.log('[Learning] Tab switch to non-injectable page, ignoring:', newUrl);
      return;
    }

    console.log('[Learning] Tab switch detected:', oldTabId, '→', newTabId, '(', newUrl, ')');

    // Step 1: Pause recording on the old tab
    try {
      await chrome.tabs.sendMessage(oldTabId, { type: 'learning_pause' });
    } catch {
      // Old tab may have been closed or navigated away
    }

    // Step 2: Insert a switch_tab step into the centralized log
    const newDomain = new URL(newUrl).hostname.replace(/^www\./, '').toLowerCase();
    learningSession.steps.push({
      stepNumber: ++learningSession.stepCounter,
      action: {
        type: 'switch_tab',
        targetUrl: newUrl,
        targetDomain: newDomain,
        matchStrategy: 'domain', // Phase 2: match by domain during replay
        description: `Switch to ${newDomain}`,
      },
      url: newUrl,
      timestamp: Date.now(),
      tabId: newTabId,
    });

    // Step 3: Update session state
    learningSession.activeTabId = newTabId;
    learningSession.tabDomains[newTabId] = newDomain;
    await chrome.storage.session.set({ learningSession });

    // Step 4: Inject content_learning.js into the new tab and start recording
    try {
      await chrome.scripting.executeScript({
        target: { tabId: newTabId },
        files: ['content_learning.js'],
      });
      await new Promise(r => setTimeout(r, 200));

      // Check if the content script is already recording (re-injection case)
      let statusRes;
      try {
        statusRes = await chrome.tabs.sendMessage(newTabId, { type: 'learning_status' });
      } catch {
        statusRes = null;
      }

      if (statusRes?.isRecording) {
        // Already recording — just resume
        console.log('[Learning] Content script already active on tab', newTabId);
      } else {
        // Start or resume recording on the new tab
        await chrome.tabs.sendMessage(newTabId, { type: 'learning_resume', stepCount: learningSession.stepCounter });
        console.log('[Learning] Recorder injected and resumed on tab', newTabId);
      }
    } catch (err) {
      console.warn('[Learning] Failed to inject into new tab:', err.message);
    }
  } catch (err) {
    console.error('[Learning] Tab switch handler error:', err.message);
  }
});

// Detect tab closure during recording — note it but don't crash
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    const { learningSession } = await chrome.storage.session.get('learningSession');
    if (!learningSession?.active) return;

    const candidateUrl = changeInfo.url || getLearningTabUrl(tab);
    if (!isInjectableLearningUrl(candidateUrl)) return;

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id || activeTab.id !== tabId) return;
    if (tabId === learningSession.activeTabId) return;

    await finalizeLearningTabSwitch(
      learningSession,
      learningSession.activeTabId,
      tabId,
      candidateUrl,
      'tabs.onUpdated-active'
    );
  } catch (err) {
    console.error('[Learning] Active tab update handler error:', err.message);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const { learningSession } = await chrome.storage.session.get('learningSession');
    if (!learningSession?.active) return;

    // If the closed tab was the active recording tab, pause recording
    if (tabId === learningSession.activeTabId) {
      console.log('[Learning] Active recording tab was closed:', tabId);
      // Don't end the session — user might switch back to another tab
      // Just note the tab is gone
      delete learningSession.tabDomains[tabId];
      await chrome.storage.session.set({ learningSession });
    }
  } catch {}
});
