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
  // Auth pages
  'accounts.google.com', 'login.microsoftonline.com', 'auth0.com',
  // Payment processors
  'paypal.com', 'venmo.com', 'zelle.com',
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
  }).catch(() => null);
}

async function hudUpdate(tabId, stepId, status, detail, label) {
  return chrome.tabs.sendMessage(tabId, {
    type: 'hud_update',
    stepId,
    status,
    detail,
    label,
  }).catch(() => null);
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

function waitForTabLoad(tabId, timeout = 15000) {
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
        setTimeout(resolve, 2000);
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

async function updateExplorationProgress(step, total, description, status) {
  await chrome.storage.local.set({
    explorationProgress: { step, total, description, status, timestamp: Date.now() },
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

async function executeExploreAction(tabId, action) {
  try {
    if (action.type === 'navigate') {
      // Navigate to URL
      const url = action.target || action.value;
      if (!url) return { success: false, error: 'No URL provided for navigate' };
      if (!isAllowedForExplore(url)) {
        return { success: false, error: `BLOCKED: Domain not allowed for exploration: ${url}` };
      }

      const tab = await chrome.tabs.update(tabId, { url });
      await waitForTabLoad(tabId);

      // Re-inject explore script after navigation
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content_explore.js'],
        });
      } catch {}

      return {
        success: true,
        observation: `Navigated to ${tab.url || url}`,
        newUrl: tab.url || url,
      };
    }

    // For all other actions, send to content script
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content_explore.js'],
    });

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

async function runExplorationLoop(explorePlan, tabId, token, resumeState = null) {
  const { goal, strategy, maxSteps, creditBudget, startAction } = explorePlan;

  const stepLog = resumeState?.stepLog || [];
  let currentStrategy = resumeState?.currentStrategy || strategy;
  let creditsUsed = resumeState?.creditsUsed || 0;
  let currentTabId = resumeState?.tabId || tabId;
  let consecutiveFailures = resumeState?.consecutiveFailures || 0;
  const startStep = resumeState?.nextStep || 1;

  // Service worker keepalive during exploration
  const keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);

  // Total exploration timeout (120 seconds)
  const explorationTimeout = setTimeout(() => {
    clearInterval(keepAlive);
  }, 120000);

  try {
    // Show HUD on the page
    const hudSteps = [];
    for (let i = 0; i <= Math.min(maxSteps, 12); i++) {
      hudSteps.push({ id: `explore-${i}`, label: i === 0 ? 'Start' : `Step ${i}` });
    }
    await hudShow(currentTabId, `Exploring: ${goal.slice(0, 60)}`, hudSteps);

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

      const startResult = await executeExploreAction(currentTabId, startAction);
      stepLog.push({
        step: 0,
        action: startAction,
        result: { success: startResult.success },
        observation: startResult.observation || startResult.error || '',
      });

      await hudUpdate(currentTabId, 'explore-0', startResult.success ? 'success' : 'error',
        startAction.description);

      if (!startResult.success) consecutiveFailures++;

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

      // PROACTIVE LOGIN CHECK — save an explore-step API call + 0.3 EU
      if (snapshot.isLoginPage) {
        const stateKey = `exploreResume_${Date.now()}`;
        await chrome.storage.session.set({
          [stateKey]: {
            stepLog, currentStrategy, creditsUsed,
            consecutiveFailures, nextStep: step,
            explorePlan, tabId: currentTabId,
          },
        });

        await updateExplorationProgress(step, maxSteps,
          'Login required \u2014 please sign in to continue', 'login_required');

        clearInterval(keepAlive);
        clearTimeout(explorationTimeout);

        return {
          success: false, paused: true,
          pauseReason: 'This page requires you to log in before I can continue.',
          resumeStateKey: stateKey,
          creditsUsed, stepLog,
        };
      }

      // THINK: call backend for next action
      await updateExplorationProgress(step, maxSteps, 'Deciding next action...', 'running');

      let decision;
      try {
        const exploreByokConfig = await getByokConfig();
        const thinkRes = await fetch(`${API_BASE}/api/agent/explore-step`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            goal,
            strategy: currentStrategy,
            stepNumber: step,
            maxSteps,
            previousActions: stepLog,
            currentPageState: snapshot,
            ...byokPayload(exploreByokConfig),
          }),
        });

        if (!thinkRes.ok) {
          const err = await thinkRes.json().catch(() => ({}));
          if (err.errorType === 'INSUFFICIENT_CREDITS') {
            await hudUpdate(currentTabId, `explore-${step}`, 'error', 'Insufficient credits');
            break;
          }
          throw new Error(err.error || `explore-step failed (${thinkRes.status})`);
        }

        decision = await thinkRes.json();
        creditsUsed += 0.3;
      } catch (err) {
        console.error('[Explore] Think step failed:', err.message);
        consecutiveFailures++;
        stepLog.push({
          step,
          action: { type: 'think', description: 'AI decision' },
          result: { success: false },
          observation: `Think failed: ${err.message}`,
        });
        await hudUpdate(currentTabId, `explore-${step}`, 'error', `AI error: ${err.message}`);
        continue;
      }

      // Check if goal is complete
      if (decision.isGoalComplete) {
        await hudUpdate(currentTabId, `explore-${step}`, 'success', 'Goal achieved!');
        await updateExplorationProgress(step, maxSteps, 'Goal achieved!', 'complete');

        // Hide remaining HUD steps
        for (let i = step + 1; i <= maxSteps; i++) {
          // Don't update steps that don't exist in HUD
        }

        clearInterval(keepAlive);
        clearTimeout(explorationTimeout);

        return {
          success: true,
          goalResult: decision.goalResult || 'Exploration complete.',
          stepsUsed: step,
          creditsUsed,
          stepLog,
        };
      }

      // Check if consent is needed
      if (decision.needsConsent) {
        const reason = (decision.consentReason || '').toLowerCase();
        const isLoginRequired = reason.includes('login') || reason.includes('sign in') || reason.includes('log in');

        if (isLoginRequired) {
          // Pause the loop and let the user log in manually
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

          clearInterval(keepAlive);
          clearTimeout(explorationTimeout);

          return {
            success: false, paused: true,
            pauseReason: decision.consentReason || 'This page requires you to log in.',
            resumeStateKey: stateKey,
            creditsUsed, stepLog,
          };
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
      const actionDesc = decision.nextAction?.description || decision.nextAction?.type || 'Action';
      await hudUpdate(currentTabId, `explore-${step}`, 'processing', actionDesc);
      await updateExplorationProgress(step, maxSteps, actionDesc, 'running');

      const actionResult = await executeExploreAction(currentTabId, decision.nextAction);

      // If navigation happened, update tab context
      if (decision.nextAction.type === 'navigate' && actionResult.success) {
        // Tab may have changed URL — re-inject script
        try {
          await chrome.scripting.executeScript({
            target: { tabId: currentTabId },
            files: ['content_explore.js'],
          });
        } catch {}
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
      } else {
        consecutiveFailures++;
        await hudUpdate(currentTabId, `explore-${step}`, 'error',
          `Failed: ${actionResult.error || 'unknown error'}`);
      }

      // Brief pause between steps for page rendering
      await new Promise(r => setTimeout(r, 500));
    }

    // Max steps reached or stopped
    clearInterval(keepAlive);
    clearTimeout(explorationTimeout);

    // Build partial result from observations
    const observations = stepLog
      .filter(s => s.observation && s.result?.success)
      .map(s => s.observation)
      .join('\n');

    await updateExplorationProgress(maxSteps, maxSteps,
      consecutiveFailures >= 3 ? 'Stopped after repeated failures' : 'Max steps reached',
      'partial');

    return {
      success: false,
      goalResult: observations
        ? `I explored ${stepLog.length} steps but couldn't fully complete the goal. Here's what I found:\n\n${observations}`
        : 'I tried to explore but couldn\'t gather enough information. Try rephrasing your request.',
      stepsUsed: stepLog.length,
      creditsUsed,
      stepLog,
      partial: true,
    };

  } catch (err) {
    clearInterval(keepAlive);
    clearTimeout(explorationTimeout);
    console.error('[Explore] Loop error:', err);
    return { success: false, error: err.message || 'Exploration loop failed.', stepLog };
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
  handleMessage(request, sender)
    .then(result => {
      // Ensure we ALWAYS send a valid response object
      const safeResult = (result && typeof result === 'object')
        ? result
        : { success: false, errorType: 'EMPTY_HANDLER', error: `Handler for '${request.type}' returned no data.` };
      try { sendResponse(safeResult); } catch (_) { /* channel closed */ }
    })
    .catch(err => {
      console.error(`[BG_ERROR] ${request.type}:`, err);
      const errorObj = {
        success: false,
        errorType: 'HANDLER_CRASH',
        error: (err && err.message) || 'Background handler crashed unexpectedly.',
      };
      try { sendResponse(errorObj); } catch (_) { /* channel closed */ }
    });
  return true; // Keep message channel open for async response
});

async function handleMessage(request, sender) {

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
      // Fallback: open the URL in a new tab
      const newTab = await chrome.tabs.create({ url: targetTabUrl, active: true });
      return { success: true, tabId: newTab.id, opened: true, message: 'Tab not found — opened in new tab.' };
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
      const tab = await chrome.tabs.create({ url: action.value, active: true });
      await waitForTabLoad(tab.id, 10000);
      const pageStateAfter = await scrapePageState(tab.id);
      return { success: true, tabId: tab.id, pageStateAfter };
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
  if (request.type === 'orchestrate_search') {
    const { searchPlan, userPrompt } = request.data;

    if (!searchPlan || !searchPlan.sites || searchPlan.sites.length === 0) {
      return { success: false, error: 'Invalid search plan: no sites specified.' };
    }

    return await runOrchestration(userPrompt, searchPlan, token);
  }

  // ── OPEN SETTINGS: Open popup in a new tab at #settings ────
  if (request.type === 'open_settings') {
    const popupUrl = chrome.runtime.getURL('popup/popup.html#settings');
    await chrome.tabs.create({ url: popupUrl });
    return { success: true };
  }

  // ── EXPLORE: Multi-step agentic exploration loop ────────────
  if (request.type === 'explore_start') {
    const { explorePlan, tabId } = request.data;
    if (!explorePlan || !explorePlan.goal) {
      return { success: false, error: 'Invalid explore plan: no goal specified.' };
    }
    return await runExplorationLoop(explorePlan, tabId, token);
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
        data: { replyBody },
      }).catch(() => null);

      if (result?.success) {
        return { success: true };
      }

      // Fallback: if content script not ready, inject it first then retry
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content_gmail.js'] }).catch(() => {});
      await new Promise(r => setTimeout(r, 500));

      const retryResult = await chrome.tabs.sendMessage(tabId, {
        type: 'gmail_open_first_and_reply',
        data: { replyBody },
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
      // Get the tab to inject into — prefer sender tab, fall back to active tab
      let tabId = sender?.tab?.id;
      if (!tabId) {
        console.log('[GhostDrive] No sender tab, querying active tab...');
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = activeTab?.id;
      }
      if (!tabId) throw new Error('No tab available for panel injection');
      console.log('[GhostDrive] Target tab:', tabId);

      // Check if panel already exists on the tab
      let panelExists = false;
      try {
        const pong = await chrome.tabs.sendMessage(tabId, { type: 'enh_panel_ping' });
        panelExists = !!pong?.ok;
        console.log('[GhostDrive] Panel ping result:', pong);
      } catch (pingErr) {
        console.log('[GhostDrive] Panel not found, will inject:', pingErr.message);
      }

      if (!panelExists) {
        console.log('[GhostDrive] Injecting panel JS into tab', tabId);
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content_panel.js'] });
        // Wait for panel to initialize (init() is async — does storage + network calls)
        await new Promise(r => setTimeout(r, 600));
        console.log('[GhostDrive] Panel injected, waited 600ms');
      }

      // Send auto-fill with retry — panel listener may need a moment
      let autofillSent = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await chrome.tabs.sendMessage(tabId, {
            type: 'enh_delegate_autofill',
            payload,
          });
          console.log(`[GhostDrive] Auto-fill sent (attempt ${attempt + 1}):`, result);
          autofillSent = true;
          break;
        } catch (sendErr) {
          console.warn(`[GhostDrive] Auto-fill attempt ${attempt + 1} failed:`, sendErr.message);
          if (attempt < 2) await new Promise(r => setTimeout(r, 400));
        }
      }

      if (!autofillSent) {
        console.error('[GhostDrive] All auto-fill attempts failed');
        return { success: false, error: 'Panel injected but auto-fill failed. Try clicking the extension icon.' };
      }

      return { success: true, message: 'Task loaded into extension panel.' };
    } catch (err) {
      console.error('[GhostDrive] Failed to inject panel for delegation:', err.message);
      return { success: false, error: 'Could not open extension panel on this page.' };
    }
  }

  // ── INJECT PANEL HERE: Bridge requests panel injection on its own tab ──
  if (request.type === 'inject_panel_here') {
    const tabId = sender?.tab?.id;
    console.log('[BG] inject_panel_here requested, sender tab:', tabId);
    if (!tabId) {
      // Fallback: find active tab
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id) {
          await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ['content_panel.js'] });
          console.log('[BG] Panel injected into active tab:', activeTab.id);
          return { success: true };
        }
      } catch (err) {
        console.error('[BG] Fallback injection failed:', err.message);
      }
      return { success: false, error: 'No tab to inject into' };
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content_panel.js'] });
      console.log('[BG] Panel injected into sender tab:', tabId);
      return { success: true };
    } catch (err) {
      console.error('[BG] Panel injection error:', err.message);
      return { success: false, error: err.message };
    }
  }

  // ── GET CURRENT TAB (for content_panel.js) ─────────────────
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
    // Simple navigation task — HUD moves to the new tab
    const tab = await chrome.tabs.create({ url: agentData.action.url, active: false });
    await waitForTabLoad(tab.id, 15000);

    // If there's form filling to do, use stageAction (which has its own HUD)
    if (taskDescription && taskDescription.length > 10) {
      if (hudTabId) await hudUpdate(hudTabId, 'execute', 'success', 'Navigated, filling form...');
      const fillResult = await stageAction(tab.id, `${taskTitle}. ${taskDescription}`, 'delegation', activeToken);
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

// ── Floating Panel: Icon Click → Inject/Toggle ─────────────────

// List of restricted URL prefixes where content scripts cannot be injected
const RESTRICTED_URL_PREFIXES = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'devtools://'];

function isRestrictedUrl(url) {
  return !url || RESTRICTED_URL_PREFIXES.some(p => url.startsWith(p));
}

chrome.action.onClicked.addListener(async (tab) => {
  // If the tab is restricted (chrome://, about:, etc.), open a new tab and inject panel there
  if (isRestrictedUrl(tab.url)) {
    const newTab = await chrome.tabs.create({ url: 'https://www.google.com', active: true });
    const injectOnLoad = (tabId, changeInfo) => {
      if (tabId === newTab.id && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(injectOnLoad);
        chrome.scripting.executeScript({ target: { tabId: newTab.id }, files: ['content_panel.js'] }).catch(() => {});
      }
    };
    chrome.tabs.onUpdated.addListener(injectOnLoad);
    return;
  }

  try {
    // Try toggling — if panel is already injected, it will respond with {ok: true}
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'enh_panel_toggle' });
    if (response?.ok) {
      // Panel handled the toggle
      return;
    }
  } catch {
    // No listener at all — expected when panel not yet injected
  }

  // Panel not injected yet (or other scripts swallowed the message) — inject it
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content_panel.js'],
    });
  } catch (err) {
    console.warn('[Enhancivity] Panel injection failed:', err.message);
    // Last-resort fallback: open popup.html in a new tab
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') });
  }
});

// ── Re-inject panel when user switches tabs (if panel was open) ──

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const { enhPanelState } = await chrome.storage.session.get('enhPanelState');
    // Re-inject if panel was open OR minimized (so data is ready when user clicks icon)
    if (!enhPanelState?.isOpen && !enhPanelState?.isMinimized) return;

    const tab = await chrome.tabs.get(tabId);
    if (isRestrictedUrl(tab.url)) return;

    // Check if panel already exists — must verify response
    let panelExists = false;
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { type: 'enh_panel_ping' });
      panelExists = !!pong?.ok;
    } catch { /* no listener at all */ }

    if (!panelExists) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content_panel.js'],
      });
    }
  } catch {
    // Non-fatal — tab might not support injection
  }
});
