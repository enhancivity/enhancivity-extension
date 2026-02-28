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

const API_BASE = 'https://enhancivity.com';
const MEMORY_TTL_MS = 30 * 60 * 1000; // 30 minutes

// --- URL Allowlist for Navigate Actions (v1 safety) ---

const ALLOWED_DOMAINS = [
  'etsy.com', 'amazon.com', 'ebay.com', 'google.com',
  'mail.google.com', 'slack.com', 'linkedin.com',
  'github.com', 'notion.so', 'trello.com', 'asana.com',
  'indeed.com', 'glassdoor.com', 'monster.com', 'ziprecruiter.com',
  'youtube.com', 'twitter.com', 'x.com', 'reddit.com',
  'expedia.com', 'kayak.com', 'skyscanner.net',
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
  amazon:    (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
  ebay:      (q) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`,
  etsy:      (q) => `https://www.etsy.com/search?q=${encodeURIComponent(q)}`,
  google:    (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&tbm=shop`,
  expedia:   (q) => `https://www.expedia.com/Hotel-Search?destination=${encodeURIComponent(q)}`,
  kayak:     (q) => `https://www.kayak.com/flights?search=${encodeURIComponent(q)}`,
  skyscanner:(q) => `https://www.skyscanner.net/transport/flights/?query=${encodeURIComponent(q)}`,
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
  const urlBuilder = SEARCH_URLS[site];
  if (!urlBuilder) {
    return { site, results: [], error: `No URL builder for site: ${site}` };
  }

  const url = urlBuilder(query);
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
      return { site, results: [], error: 'Semantic map empty' };
    }

    console.log(`[Ghost-Driver] ${site}: mapped ${semanticMap.mappedCount} elements`);

    // Phase 2: Send semantic map to parse-intent for AI interpretation
    const parseRes = await fetch(`${API_BASE}/api/agent/parse-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        semanticMap,
        userGoal: query,
        pageUrl: url,
        category: category || 'shopping',
        mode: 'extract_products',
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
    return { site, results, trustScore, trustRationale };

  } catch (err) {
    console.warn(`[Ghost-Driver] ${site} search failed:`, err.message);
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
    const compareRes = await fetch(`${API_BASE}/api/agent/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        results: allResults,
        criteria: searchPlan.criteria,
        category: searchPlan.category,
        userPrompt,
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
    await hudUpdate(tabId, 'scan', 'error', 'No interactable elements found');
    return { success: false, error: 'Page has no interactable elements.' };
  }
  await hudUpdate(tabId, 'scan', 'success', `${semanticMap.elements.length} elements found`);

  // Step 2: Send to parse-intent in fill_form mode
  await hudUpdate(tabId, 'analyze', 'processing');
  const parseRes = await fetch(`${API_BASE}/api/agent/parse-intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      semanticMap,
      userGoal,
      pageUrl: semanticMap.pageUrl,
      category: category || 'forms',
      mode: 'fill_form',
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
    });
    results.push(result);
    if (!result.success) break;
  }

  const allSuccess = results.every(r => r.success);
  await hudUpdate(tabId, 'execute', allSuccess ? 'success' : 'error',
    allSuccess ? `${results.length} action${results.length > 1 ? 's' : ''} completed` : 'Some actions failed'
  );

  // Auto-hide HUD after 3 seconds on success
  if (allSuccess) {
    setTimeout(() => hudHide(tabId), 3000);
  }

  return {
    success: allSuccess,
    results,
    actionsPlanned: actions.length,
    actionsExecuted: results.length,
  };
}

// --- Central Message Handler ---

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  handleMessage(request)
    .then(sendResponse)
    .catch(err => {
      console.error('Enhancivity background error:', err);
      sendResponse({ success: false, error: err.message || 'Unknown error' });
    });
  return true; // Keep message channel open for async response
});

async function handleMessage(request) {

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
    const { userPrompt, tabId, url, availableTabs } = request.data;

    // Load memory (from cache or fresh fetch)
    const userMemory = await getOrRefreshMemory();

    // Build page context by detecting site and optionally scraping
    const pageContext = { url, site: 'general' };

    // Zero-Token Triage: attach lightweight tab map for spatial awareness
    if (availableTabs && availableTabs.length > 0) {
      pageContext.availableTabs = availableTabs
        .filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'))
        .slice(0, 15) // Cap at 15 tabs to limit payload size
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
      } catch {
        // Content script may not be ready on this specific tab — proceed without scrape
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
      } catch {
        // Proceed without scrape
      }

    } else if (tabId) {
      // Universal scrape — inject on-demand for ALL other sites
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
      } catch {
        // Some pages block injection (chrome://, extension pages, etc.) — proceed without
      }
    }

    // Send enriched payload to backend agent endpoint
    const res = await fetch(`${API_BASE}/api/agent/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userPrompt, pageContext, userMemory })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, error: err.error || `Server error (${res.status})` };
    }

    const data = await res.json();
    return { success: true, data };
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
      return { success: true, tabId: tab.id };
    }

    // semantic_fill: Ghost-Driver AI form filling
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

      const parseRes = await fetch(`${API_BASE}/api/agent/parse-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          semanticMap,
          userGoal: userGoal || '',
          pageUrl: semanticMap.pageUrl,
          category: category || 'general',
          mode: mode || 'extract_products',
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
        const parseRes = await fetch(`${API_BASE}/api/agent/parse-intent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            semanticMap,
            userGoal: 'Find the Add to Cart or Buy button',
            pageUrl: url,
            category: 'shopping',
            mode: 'find_element',
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

  // ── GHOST DRIVE TASK: Delegated from Command Center dashboard ──
  if (request.type === 'ghost_drive_task') {
    const { taskId, taskTitle, taskDescription, priority, dueDate } = request.payload || {};

    if (!taskId || !taskTitle) {
      return { success: false, error: 'Missing task data for delegation.' };
    }

    // Run the delegation asynchronously and notify the dashboard on completion
    handleDelegatedTask(taskId, taskTitle, taskDescription, token).catch((err) => {
      console.error('[GhostDrive] Delegation failed:', err.message);
      notifyDashboardTabs('TASK_FAILED', { taskId, error: err.message });
    });

    return { success: true, message: 'Task accepted for delegation.' };
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
  const memoryContext = memory
    ? [
        memory.tier1 ? `Identity: ${JSON.stringify(memory.tier1).substring(0, 300)}` : '',
        memory.tier2?.length ? `Goals: ${memory.tier2.map(g => g.name).join(', ')}` : '',
      ].filter(Boolean).join('\n')
    : '';

  if (hudTabId) await hudUpdate(hudTabId, 'memory', 'success', memory ? 'Memory loaded' : 'No memory available');

  // 2. Ask AI agent for an execution plan
  if (hudTabId) await hudUpdate(hudTabId, 'plan', 'processing');
  const agentRes = await fetch(`${API_BASE}/api/agent/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${activeToken}` },
    body: JSON.stringify({
      userMessage: `Complete this delegated task: "${taskTitle}". ${taskDescription || ''}`,
      pageUrl: '',
      pageContent: '',
      siteType: 'delegation',
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
    const tabs = await chrome.tabs.query({ url: ['https://enhancivity.com/*', 'https://*.enhancivity.com/*', 'http://localhost:3001/*'] });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type, payload }).catch(() => {});
    }
  } catch {
    // No dashboard tabs open — that's fine
  }
}
