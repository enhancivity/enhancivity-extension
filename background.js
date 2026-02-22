// ============================================================
// Enhancivity Background Service Worker — Grand Extension v2.0
// Responsibilities:
//   1. Auth (email/password + Google OAuth)
//   2. 3-Tier Memory caching (30-min TTL)
//   3. Message routing (popup → Gmail/Amazon scripts → backend)
//   4. API orchestration with memory-enriched payloads
// ============================================================

const API_BASE = 'https://enhancivity.com';
const MEMORY_TTL_MS = 30 * 60 * 1000; // 30 minutes

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
    const { userPrompt, tabId, url } = request.data;

    // Load memory (from cache or fresh fetch)
    const userMemory = await getOrRefreshMemory();

    // Build page context by detecting site and optionally scraping
    const pageContext = { url, site: 'general' };

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

  return { success: false, error: `Unknown message type: ${request.type}` };
}
