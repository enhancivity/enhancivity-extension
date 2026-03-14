// ============================================================
// Enhancivity Floating Panel — Content Script Overlay
// Injected by background.js on icon click
// Replaces popup for persistent, draggable interaction
// ============================================================

(() => {
  'use strict';

  // Truncate long text for display (e.g., exploration results with raw page content)
  function truncateForDisplay(text, maxLen = 500) {
    if (!text || text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '... [see full results]';
  }

  // Double-injection guard — but allow re-init if DOM was removed (SPA navigation)
  if (window.__enhPanelLoaded) {
    const hostStillInDom = document.getElementById('enh-panel-host');
    if (hostStillInDom) {
      // Panel still exists — just toggle visibility
      window.__enhPanelToggle?.();
      return;
    }
    // Panel DOM was removed (SPA page swap) — remove old message listener, re-initialize
    if (window.__enhPanelMessageListener) {
      chrome.runtime.onMessage.removeListener(window.__enhPanelMessageListener);
    }
    window.__enhPanelLoaded = false;
  }
  window.__enhPanelLoaded = true;

  // ── Constants ────────────────────────────────────────────────

  const PIPELINE_TIMEOUT_MS = 30000;

  const PLACEHOLDERS = {
    gmail:   'Analyze this email...',
    amazon:  'Evaluate this product...',
    global:  'Search across the web...',
    general: 'Command Enhancivity...',
  };

  const BADGE_CONFIG = {
    gmail:   { label: 'Gmail',   color: '#ef4444' },
    amazon:  { label: 'Amazon',  color: '#f59e0b' },
    global:  { label: 'Global',  color: '#6366f1' },
    general: { label: 'General', color: '' },
  };

  const STAGE_LABELS = {
    STAGE_TRIAGE:    'Scanning your tabs...',
    STAGE_BACKEND:   'Thinking with your memory...',
    STAGE_PARSING:   'Validating response...',
    STAGE_EXECUTION: 'Executing action...',
  };

  // ── State ────────────────────────────────────────────────────

  let currentTabId = null;
  let currentTabUrl = window.location.href;
  let currentSite = detectSite(currentTabUrl);
  let orchestrationListener = null;
  let explorationListener = null;
  let conversationMessages = []; // { role: 'user'|'assistant', content: string, data?: object, timestamp: number }
  let lastUserPrompt = ''; // Track last prompt for clarification re-submission

  // ── Conversation Helpers ───────────────────────────────────────

  // Conversation key is per-tab so multiple tabs never overwrite each other
  function convKey() {
    return currentTabId ? `enhConversation_${currentTabId}` : 'enhConversation_global';
  }

  async function saveConversation() {
    try {
      let msgs = conversationMessages;
      // Trim to stay under 5MB
      while (JSON.stringify(msgs).length > 5_000_000 && msgs.length > 2) {
        msgs = msgs.slice(2);
      }
      conversationMessages = msgs;
      await chrome.storage.session.set({ [convKey()]: msgs });
    } catch { /* non-critical */ }
  }

  function rebuildChatThread() {
    resultsArea.innerHTML = '';
    if (conversationMessages.length === 0) return;

    resultsArea.classList.remove('enh-hidden');
    if (greeting) greeting.style.display = 'none';

    for (const msg of conversationMessages) {
      if (msg.role === 'user') {
        const bubble = document.createElement('div');
        bubble.className = 'enh-msg enh-msg-user';
        bubble.textContent = msg.content;
        resultsArea.appendChild(bubble);
      } else {
        const wrapper = document.createElement('div');
        wrapper.className = 'enh-msg enh-msg-assistant';
        if (msg.data) {
          renderResultsInto(wrapper, msg.data);
        } else {
          const p = document.createElement('p');
          p.className = 'enh-text-result';
          p.textContent = msg.content;
          wrapper.appendChild(p);
        }
        resultsArea.appendChild(wrapper);
      }
    }

    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function extractSiteHint(prompt) {
    const lower = prompt.toLowerCase();
    const sites = ['amazon', 'ebay', 'etsy', 'google', 'expedia', 'kayak', 'skyscanner'];
    const mentioned = sites.filter(s => lower.includes(s));
    if (mentioned.length > 0) return { explicitSites: mentioned, onlyThese: true };
    return null;
  }

  // ── Shadow DOM Setup ─────────────────────────────────────────

  const host = document.createElement('div');
  host.id = 'enh-panel-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;pointer-events:none;';

  const shadow = host.attachShadow({ mode: 'closed' });

  // Inject styles
  const styleEl = document.createElement('link');
  styleEl.rel = 'stylesheet';
  styleEl.href = chrome.runtime.getURL('content_panel.css');
  shadow.appendChild(styleEl);

  // ── Build Panel HTML ─────────────────────────────────────────

  const panel = document.createElement('div');
  panel.className = 'enh-panel';
  panel.style.pointerEvents = 'auto';

  panel.innerHTML = `
    <!-- Drag Header -->
    <div class="enh-drag-header" id="enh-drag-header">
      <div class="enh-header-left">
        <span class="enh-brand">Enhancivity</span>
        <div class="enh-memory-indicator enh-hidden" id="enh-memory-indicator">
          <span class="enh-memory-pulse"></span>
          <span class="enh-memory-text">MEMORY</span>
        </div>
        <div class="enh-byok-badge enh-hidden" id="enh-byok-badge">
          <span class="enh-byok-text">BYOK</span>
        </div>
      </div>
      <div class="enh-header-right">
        <button class="enh-icon-btn" id="enh-settings-btn" title="Settings">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
        <button class="enh-icon-btn enh-signout-btn" id="enh-signout-btn" title="Sign Out">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
        </button>
        <button class="enh-icon-btn enh-minimize-btn" id="enh-minimize-btn" title="Minimize">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
        <button class="enh-icon-btn enh-close-btn" id="enh-close-btn" title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Context Strip -->
    <div class="enh-context-strip">
      <span class="enh-context-badge" id="enh-context-badge">General</span>
    </div>

    <!-- Chat Area -->
    <div class="enh-chat-area" id="enh-chat-area">
      <div class="enh-chat-greeting" id="enh-chat-greeting">
        <div class="enh-greeting-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 16v-4"/>
            <path d="M12 8h.01"/>
          </svg>
        </div>
        <p class="enh-greeting-text">Ready when you are.</p>
      </div>

      <!-- Results -->
      <div class="enh-results-area enh-hidden" id="enh-results-area"></div>

      <!-- Loading — sits BELOW results so it's always visible at the bottom of chat -->
      <div class="enh-loading-bar enh-hidden" id="enh-loading-bar">
        <div class="enh-loading-glow"></div>
        <div class="enh-loading-content">
          <div class="enh-loading-spinner"></div>
          <span class="enh-loading-label">Thinking with your memory...</span>
        </div>
      </div>

      <!-- Error -->
      <p class="enh-error-message" id="enh-main-error"></p>
    </div>

    <!-- Input Area -->
    <div class="enh-input-area">
      <div class="enh-input-pill">
        <textarea
          class="enh-prompt-field"
          id="enh-prompt-input"
          placeholder="Command Enhancivity..."
          autocomplete="off"
          rows="1"
        ></textarea>
        <button class="enh-send-btn" id="enh-submit-btn" title="Send" disabled>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="19" x2="12" y2="5"/>
            <polyline points="5 12 12 5 19 12"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Auth fallback (shown if no token) -->
    <div class="enh-auth-fallback enh-hidden" id="enh-auth-fallback">
      <p class="enh-auth-fallback-text" id="enh-auth-title">Sign in to Enhancivity</p>
      <form id="enh-auth-form">
        <input type="text" id="enh-auth-name" class="enh-auth-input enh-hidden" placeholder="Full name" autocomplete="name" />
        <input type="email" id="enh-auth-email" class="enh-auth-input" placeholder="Email" autocomplete="email" required />
        <input type="password" id="enh-auth-password" class="enh-auth-input" placeholder="Password" autocomplete="current-password" required />
        <input type="password" id="enh-auth-new-password" class="enh-auth-input enh-hidden" placeholder="New password (min 6 characters)" autocomplete="new-password" />
        <button type="submit" class="enh-btn enh-btn-primary" id="enh-auth-submit">Sign In</button>
      </form>
      <p class="enh-auth-error enh-hidden" id="enh-auth-error"></p>
      <p class="enh-auth-success enh-hidden" id="enh-auth-success"></p>
      <div class="enh-auth-links">
        <span class="enh-auth-link" id="enh-auth-toggle-signup">Create account</span>
        <span class="enh-auth-link-sep" id="enh-auth-link-sep">|</span>
        <span class="enh-auth-link" id="enh-auth-toggle-forgot">Forgot password?</span>
      </div>
    </div>
  `;

  shadow.appendChild(panel);
  document.body.appendChild(host);

  // ── DOM Refs (inside shadow) ─────────────────────────────────

  const $ = (sel) => shadow.querySelector(sel);
  const dragHeader   = $('#enh-drag-header');
  const closeBtn     = $('#enh-close-btn');
  const minimizeBtn  = $('#enh-minimize-btn');
  const signOutBtn   = $('#enh-signout-btn');
  const contextBadge = $('#enh-context-badge');
  const chatArea     = $('#enh-chat-area');
  const greeting     = $('#enh-chat-greeting');
  const loadingBar   = $('#enh-loading-bar');
  const resultsArea  = $('#enh-results-area');
  const mainError    = $('#enh-main-error');
  const promptInput  = $('#enh-prompt-input');
  const submitBtn    = $('#enh-submit-btn');
  const memoryInd    = $('#enh-memory-indicator');
  const settingsBtn  = $('#enh-settings-btn');
  const byokBadge    = $('#enh-byok-badge');
  const authFallback = $('#enh-auth-fallback');

  // ── Init ─────────────────────────────────────────────────────

  async function init() {
    const { token } = await chrome.storage.local.get(['token']);
    if (!token) {
      // Show auth fallback, hide main UI
      authFallback.classList.remove('enh-hidden');
      chatArea.classList.add('enh-hidden');
      $('#enh-context-strip')?.classList.add('enh-hidden');
      $('.enh-input-area')?.classList.add('enh-hidden');
      return;
    }

    // Get current tab info
    try {
      const response = await sendToBackground('GET_CURRENT_TAB', {}, 3000);
      if (response?.success && response.tab) {
        currentTabId = response.tab.id;
        currentTabUrl = response.tab.url || window.location.href;
      }
    } catch {
      // Fallback: use window.location
    }
    currentSite = detectSite(currentTabUrl);
    applyContext(currentSite);

    // Memory indicator
    const { userMemory } = await chrome.storage.local.get(['userMemory']);
    if (userMemory) memoryInd.classList.remove('enh-hidden');

    // BYOK badge
    const { userApiKey } = await chrome.storage.local.get(['userApiKey']);
    if (userApiKey) byokBadge.classList.remove('enh-hidden');

    // Restore state if available
    await restoreState();

    // Ensure panel state is persisted (so navigation re-injection knows panel is open)
    await saveState();

    promptInput.focus();
  }

  // ── Context Detection ────────────────────────────────────────

  function detectSite(url) {
    if (!url) return 'global';
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url === 'about:blank') return 'global';
    if (url.includes('mail.google.com')) return 'gmail';
    if (/amazon\.(com|co\.uk|de|fr|ca|com\.au)/.test(url)) return 'amazon';
    return 'general';
  }

  function applyContext(site) {
    const config = BADGE_CONFIG[site] || BADGE_CONFIG.general;
    contextBadge.textContent = config.label;
    if (config.color) {
      contextBadge.style.background = config.color;
      contextBadge.style.color = '#fff';
    }
    promptInput.placeholder = PLACEHOLDERS[site] || PLACEHOLDERS.general;
  }

  // ── Delegate Auto-Fill (removed — now handled via chrome.runtime.onMessage below) ──

  // ── Drag Logic ───────────────────────────────────────────────

  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  dragHeader.addEventListener('mousedown', (e) => {
    if (e.target.closest('.enh-icon-btn')) return; // Don't drag when clicking buttons
    isDragging = true;
    dragOffsetX = e.clientX - panel.getBoundingClientRect().left;
    dragOffsetY = e.clientY - panel.getBoundingClientRect().top;
    e.preventDefault();
  });

  // Drag move — listen on BOTH document and shadow root to handle
  // cases where mouse leaves the shadow DOM (iframes, cross-origin elements)
  function onDragMove(e) {
    if (!isDragging) return;
    let newLeft = e.clientX - dragOffsetX;
    let newTop = e.clientY - dragOffsetY;

    // Clamp to viewport
    const maxLeft = window.innerWidth - 60;
    const maxTop = window.innerHeight - 40;
    newLeft = Math.max(-panel.offsetWidth + 60, Math.min(newLeft, maxLeft));
    newTop = Math.max(0, Math.min(newTop, maxTop));

    panel.style.left = newLeft + 'px';
    panel.style.top = newTop + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    saveState();
  }

  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
  // Shadow root listeners — catch events that don't reach outer document
  shadow.addEventListener('mousemove', onDragMove);
  shadow.addEventListener('mouseup', onDragEnd);

  // Safety: if mouse re-enters the panel after a lost mouseup (e.g. mouse left
  // the browser window or crossed an iframe), reset isDragging on next mousedown
  // inside the panel so buttons aren't stuck.
  panel.addEventListener('mousedown', () => {
    // If we somehow still think we're dragging but the user clicked inside
    // the panel again (not on the header), force-end the drag.
    // Header mousedown has its own handler that fires first (bubbling).
  });
  document.addEventListener('mouseenter', () => {
    // Mouse re-entered the page — if no button is held, end any stuck drag
    // (mouseenter fires even if mouseup was missed)
  });
  window.addEventListener('blur', () => {
    // Window lost focus (user alt-tabbed, clicked iframe, etc.) — end drag
    if (isDragging) {
      isDragging = false;
      saveState();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (isDragging) {
      isDragging = false;
      saveState();
    }
  });

  // ── Panel Visibility ────────────────────────────────────────

  function togglePanel() {
    if (panel.classList.contains('enh-hidden')) {
      panel.classList.remove('enh-hidden');
      promptInput.focus();
    } else {
      panel.classList.add('enh-hidden');
    }
    saveState();
  }

  function closePanel() {
    // Hide immediately — never block the UI on async storage writes
    panel.classList.add('enh-hidden');
    clearResults();
    if (greeting) greeting.style.display = '';
    mainError.textContent = '';
    promptInput.value = '';
    submitBtn.disabled = true;
    submitBtn.classList.remove('active');
    // Clear this tab's conversation only — other tabs are unaffected
    conversationMessages = [];
    Promise.all([
      saveConversation(),  // writes empty array to enhConversation_<tabId>
      chrome.storage.session.remove(convKey()).catch(() => {}), // clean up the key entirely
      saveState(),
    ]).catch(() => {});
  }

  // Expose toggle for re-injection calls
  window.__enhPanelToggle = togglePanel;

  // Close/minimize: use pointerdown so they fire even if isDragging is stuck
  // (click can be swallowed when drag state is confused). Force-reset drag first.
  closeBtn.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    isDragging = false;
    closePanel();
  });
  minimizeBtn.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    isDragging = false;
    togglePanel();
  });
  signOutBtn?.addEventListener('click', async () => {
    await chrome.storage.local.clear();
    // Reload panel to show auth fallback
    authFallback.classList.remove('enh-hidden');
    chatArea.classList.add('enh-hidden');
    $('#enh-context-strip')?.classList.add('enh-hidden');
    $('.enh-input-area')?.classList.add('enh-hidden');
  });
  settingsBtn?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'open_settings' });
  });

  // ── Communication ────────────────────────────────────────────

  function sendToBackground(type, data, timeoutMs = PIPELINE_TIMEOUT_MS) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          success: false,
          errorType: 'BACKEND_TIMEOUT',
          error: `Request timed out after ${timeoutMs / 1000}s. The server may be busy — try again.`,
        });
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage({ type, data }, (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            resolve({
              success: false,
              errorType: 'EXTENSION_ERROR',
              error: chrome.runtime.lastError.message,
            });
          } else if (response === undefined || response === null) {
            resolve({
              success: false,
              errorType: 'NO_RESPONSE',
              error: 'Background returned no response. Try reloading the extension.',
            });
          } else {
            resolve(response);
          }
        });
      } catch (err) {
        clearTimeout(timer);
        resolve({
          success: false,
          errorType: 'SEND_FAILED',
          error: err.message || 'Failed to reach background script.',
        });
      }
    });
  }

  // ── Keyboard Isolation ─────────────────────────────────────
  // Gmail and other apps use document-level keyboard listeners that
  // intercept keystrokes (e.g., 'e' for archive, 'a' for reply-all).
  // We block these from firing when our input is focused by intercepting
  // at the document level in the capture phase. We also handle Enter
  // here since shadow DOM events don't propagate to the document normally.

  function isEnhInputFocused() {
    return document.activeElement === host;
  }

  document.addEventListener('keydown', (e) => {
    if (!isEnhInputFocused()) return;
    // Enter = submit, Shift+Enter = new line
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      handleSubmit();
      return;
    }
    // Block host page from seeing this keystroke
    e.stopImmediatePropagation();
  }, true);

  document.addEventListener('keyup', (e) => {
    if (isEnhInputFocused()) e.stopImmediatePropagation();
  }, true);

  document.addEventListener('keypress', (e) => {
    if (isEnhInputFocused()) e.stopImmediatePropagation();
  }, true);

  // ── Submit & Process ─────────────────────────────────────────

  promptInput.addEventListener('input', () => {
    const hasText = promptInput.value.trim().length > 0;
    submitBtn.disabled = !hasText;
    submitBtn.classList.toggle('active', hasText);
    // Auto-resize textarea (up to max-height set in CSS)
    promptInput.style.height = 'auto';
    promptInput.style.height = promptInput.scrollHeight + 'px';
  });

  submitBtn.addEventListener('click', () => handleSubmit());

  async function handleSubmit() {
    const userPrompt = promptInput.value.trim();
    if (!userPrompt) return;
    lastUserPrompt = userPrompt;

    // Hide greeting on first submit
    if (greeting) greeting.style.display = 'none';

    // Append user bubble
    const userBubble = document.createElement('div');
    userBubble.className = 'enh-msg enh-msg-user';
    userBubble.textContent = userPrompt;
    resultsArea.appendChild(userBubble);
    resultsArea.classList.remove('enh-hidden');
    chatArea.scrollTop = chatArea.scrollHeight;

    // Track in conversation
    conversationMessages.push({ role: 'user', content: userPrompt, timestamp: Date.now() });
    saveConversation();

    promptInput.value = '';
    promptInput.style.height = 'auto';
    submitBtn.disabled = true;
    submitBtn.classList.remove('active');

    setLoading(true);

    // STAGE 1: Tab Triage
    setStage('STAGE_TRIAGE');
    let availableTabs = [];
    try {
      const triageRes = await sendToBackground('GET_TAB_TRIAGE_MAP', {}, 5000);
      if (triageRes?.success) availableTabs = triageRes.tabs;
    } catch { /* proceed without tab context */ }

    // Extract site hint from user prompt
    const siteHint = extractSiteHint(userPrompt);

    // STAGE 2: Backend AI Call
    setStage('STAGE_BACKEND');
    const res = await sendToBackground('process_request', {
      userPrompt,
      tabId: currentTabId,
      url: currentTabUrl,
      availableTabs,
      conversationHistory: conversationMessages.slice(-10).map(m => ({ role: m.role, content: m.content })),
      siteHint,
    });

    // STAGE 3: Parse & Validate
    setStage('STAGE_PARSING');
    setLoading(false);

    if (!res?.success) {
      const errLabel = res?.errorType ? `[${res.errorType}] ` : '';
      showError(errLabel + (res?.error || 'Something went wrong. Please try again.'));
      return;
    }

    // Track assistant response
    const assistantContent = res.data?.primary_content || res.data?.headline || res.data?.message || 'Response received';
    conversationMessages.push({ role: 'assistant', content: assistantContent, data: res.data, timestamp: Date.now() });
    saveConversation();

    // FETCH_TASKS: pull from API and render inline (no consent needed)
    if (res.data?.action_type === 'FETCH_TASKS') {
      await handleFetchTasks(res.data);
      return;
    }

    // ORCHESTRATE: auto-start immediately (non-consequential search)
    if (res.data?.action_type === 'ORCHESTRATE' && res.data?.search_plan) {
      if (res.data.consent_level === 'auto') {
        // Show plan preview first (site badges), then auto-start after 800ms
        renderOrchestratePlan(res.data, /* autoStart= */ true);
      } else {
        renderOrchestratePlan(res.data, /* autoStart= */ false);
      }
      return;
    }

    // EXPLORE: multi-step agentic exploration loop
    if (res.data?.action_type === 'EXPLORE' && res.data?.explore_plan) {
      renderExplorePlan(res.data, /* autoStart= */ res.data.consent_level === 'auto');
      return;
    }

    // FIND_AND_REPLY: auto-execute (searches inbox + pre-fills reply)
    if (res.data?.action_type === 'FIND_AND_REPLY') {
      await handleFindAndReply(res.data);
      return;
    }

    // CLARIFY: present clarification options to user
    if (res.data?.action_type === 'CLARIFY' && res.data?.clarification) {
      renderClarification(res.data);
      return;
    }

    renderResults(res.data);
    saveState();
  }

  // ── FETCH_TASKS Handler ──────────────────────────────────────

  async function handleFetchTasks(data) {
    resultsArea.classList.remove('enh-hidden');

    setStage('STAGE_EXECUTION');
    setLoading(true);

    const period = data.task_period || '';
    const fetchRes = await sendToBackground('fetch_todos', { period });

    setLoading(false);

    const wrapper = document.createElement('div');
    wrapper.className = 'enh-msg enh-msg-assistant';

    if (!fetchRes?.success) {
      const errP = document.createElement('p');
      errP.className = 'enh-error-message';
      errP.textContent = fetchRes?.error || 'Failed to fetch tasks.';
      wrapper.appendChild(errP);
      resultsArea.appendChild(wrapper);
      return;
    }

    const todos = fetchRes.todos || [];
    const periodLabel = period ? ` for ${period.charAt(0).toUpperCase() + period.slice(1)}` : '';

    if (todos.length === 0) {
      const emptyCard = document.createElement('div');
      emptyCard.className = 'enh-action-card';
      emptyCard.innerHTML = `<p class="enh-action-headline">No Tasks Found${periodLabel}</p><p class="enh-action-summary">There are no tasks${periodLabel} in your Enhancivity account.</p>`;
      wrapper.appendChild(emptyCard);
      resultsArea.appendChild(wrapper);
      chatArea.scrollTop = chatArea.scrollHeight;
      return;
    }

    const header = document.createElement('p');
    header.className = 'enh-results-header';
    header.textContent = `${todos.length} task${todos.length !== 1 ? 's' : ''}${periodLabel}`;
    wrapper.appendChild(header);

    const list = document.createElement('div');
    list.className = 'enh-task-list';

    todos.forEach(todo => {
      const row = document.createElement('div');
      row.className = 'enh-task-row';

      const statusDot = document.createElement('span');
      statusDot.style.cssText = `width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:5px;background:${
        todo.status === 'COMPLETED' ? '#34d399' :
        todo.status === 'IN_PROGRESS' ? '#6366f1' : '#fbbf24'
      }`;

      const info = document.createElement('div');
      info.className = 'enh-task-info';

      const title = document.createElement('span');
      title.className = 'enh-task-title';
      title.textContent = todo.title;

      const meta = document.createElement('span');
      meta.className = 'enh-task-meta';
      const parts = [];
      if (todo.status) parts.push(todo.status.replace('_', ' '));
      if (todo.priority) parts.push(todo.priority);
      if (todo.dueDate) {
        const d = new Date(todo.dueDate);
        parts.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      }
      meta.textContent = parts.join(' · ');

      info.appendChild(title);
      info.appendChild(meta);
      row.appendChild(statusDot);
      row.appendChild(info);
      list.appendChild(row);
    });

    wrapper.appendChild(list);
    resultsArea.appendChild(wrapper);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  // ── FIND_AND_REPLY Handler ───────────────────────────────────
  // Agentic: searches Gmail for the email, opens it, pre-fills reply.
  // User only clicks Send — that's the 1% mile.

  async function handleFindAndReply(data) {
    resultsArea.classList.remove('enh-hidden');

    const wrapper = document.createElement('div');
    wrapper.className = 'enh-msg enh-msg-assistant';

    const card = document.createElement('div');
    card.className = 'enh-action-card enh-consent-soft';

    const headline = document.createElement('p');
    headline.className = 'enh-action-headline';
    headline.textContent = data.headline || 'Finding email & drafting reply…';
    card.appendChild(headline);

    const statusEl = document.createElement('p');
    statusEl.className = 'enh-action-summary';
    statusEl.textContent = 'Searching your inbox…';
    card.appendChild(statusEl);

    wrapper.appendChild(card);
    resultsArea.appendChild(wrapper);
    chatArea.scrollTop = chatArea.scrollHeight;

    // Parse FIND_AND_REPLY payload from primary_content (may be object or JSON string)
    let payload = {};
    if (typeof data.primary_content === 'object' && data.primary_content !== null) {
      payload = data.primary_content;
    } else {
      try {
        payload = JSON.parse(data.primary_content);
      } catch {
        payload = { replyBody: data.primary_content };
      }
    }

    const { searchQuery, replyBody, subject } = payload;

    // BUG 2 FIX: Validate searchQuery before proceeding
    if (!searchQuery || !searchQuery.trim()) {
      statusEl.textContent = 'Cannot search: no sender or search query provided. Please specify who to reply to.';
      statusEl.style.color = '#f87171';
      return;
    }

    // Step 1: If we're already on Gmail, search for the email
    if (!currentTabUrl.includes('mail.google.com')) {
      // Navigate to Gmail first
      statusEl.textContent = 'Opening Gmail…';
      const navRes = await sendToBackground('switch_tab', { targetTabUrl: 'https://mail.google.com' });
      if (!navRes?.success) {
        statusEl.textContent = 'Could not open Gmail. Please navigate there manually.';
        statusEl.style.color = '#f87171';
        return;
      }
      // BUG 1 FIX: Update currentTabId so gmail_find_and_reply targets the correct Gmail tab
      if (navRes.tabId) {
        currentTabId = navRes.tabId;
      }
      // Update our tab reference
      currentTabUrl = 'https://mail.google.com/mail/';
      await new Promise(r => setTimeout(r, 2000));
    }

    statusEl.textContent = `Searching for emails from "${searchQuery}"…`;

    // Step 2: Send search + reply request to Gmail content script via background
    const res = await sendToBackground('gmail_find_and_reply', {
      tabId: currentTabId,
      searchQuery: searchQuery || '',
      replyBody: replyBody || '',
      subject: subject || '',
    });

    if (res?.success) {
      card.innerHTML = '';
      const successHeadline = document.createElement('p');
      successHeadline.className = 'enh-action-headline';
      successHeadline.textContent = 'Reply ready — click Send when you\'re done';
      card.appendChild(successHeadline);

      const successNote = document.createElement('p');
      successNote.className = 'enh-action-summary';
      successNote.textContent = `Found email from "${searchQuery}". Reply pre-filled. Review and click Send in Gmail.`;
      card.appendChild(successNote);
    } else {
      statusEl.textContent = res?.error || 'Could not find the email or fill the reply.';
      statusEl.style.color = '#f87171';
    }

    chatArea.scrollTop = chatArea.scrollHeight;
  }

  // ── Results Rendering ────────────────────────────────────────

  function renderBillingBlocked(container, data) {
    const card = document.createElement('div');
    card.className = 'enh-action-card';
    card.style.borderColor = 'rgba(239, 68, 68, 0.3)';

    if (data.headline) {
      const headline = document.createElement('p');
      headline.className = 'enh-action-headline';
      headline.textContent = data.headline;
      card.appendChild(headline);
    }

    const msg = document.createElement('p');
    msg.className = 'enh-action-rationale';
    msg.style.color = '#fca5a5';
    msg.textContent = data._billing.message || `This action costs ${data._billing.requiredEU} EU but you have ${data._billing.balance.toFixed(1)} EU.`;
    card.appendChild(msg);

    const btn = document.createElement('button');
    btn.className = 'enh-action-btn enh-approve';
    btn.style.background = 'linear-gradient(135deg, #FDBBF5, #897DF0)';
    btn.textContent = 'Top Up Energy Units';
    btn.onclick = () => {
      window.open('https://enhancivity.com/dashboard/upgrade', '_blank');
    };
    card.appendChild(btn);

    container.appendChild(card);
  }

  function renderResultsInto(container, data) {
    if (!data) {
      const p = document.createElement('p');
      p.className = 'enh-no-results';
      p.textContent = 'No results returned.';
      container.appendChild(p);
      return;
    }

    // Billing blocked — show top-up prompt instead of action
    if (data._billing?.blocked) {
      renderBillingBlocked(container, data);
      return;
    }

    // TASK_DRAFT: Show editable task preview with Create button
    if (data.action_type === 'TASK_DRAFT') {
      renderTaskDraftPreview(container, data);
      return;
    }

    // EXTRACT_TASKS: JSON array in primary_content → checklist with Create All button
    if (data.action_type === 'EXTRACT_TASKS' && data.primary_content) {
      try {
        const tasks = JSON.parse(data.primary_content);
        if (Array.isArray(tasks) && tasks.length > 0) {
          renderTaskList(container, tasks);
          return;
        }
      } catch { /* fall through to renderTaskDraftPreview */ }
      renderTaskDraftPreview(container, data);
      return;
    }

    // EXPLORE_RESULT: render as formatted card (same layout as showExplorationResult)
    if (data.action_type === 'EXPLORE_RESULT') {
      const card = document.createElement('div');
      card.className = 'enh-action-card';

      const headlineEl = document.createElement('p');
      headlineEl.className = 'enh-action-headline';
      headlineEl.textContent = data.goalResult ? 'Exploration Complete' : 'Exploration Failed';
      card.appendChild(headlineEl);

      const resultEl = document.createElement('div');
      resultEl.className = 'enh-action-rationale';
      resultEl.style.whiteSpace = 'pre-wrap';
      resultEl.textContent = truncateForDisplay(data.goalResult || 'Exploration finished.');
      card.appendChild(resultEl);

      if (data.stepsUsed) {
        const metaEl = document.createElement('p');
        metaEl.style.cssText = 'font-size: 10px; opacity: 0.5; margin-top: 8px;';
        metaEl.textContent = `${data.stepsUsed} steps \u00B7 ${(data.creditsUsed || 0).toFixed(1)} EU`;
        card.appendChild(metaEl);
      }

      container.appendChild(card);
      return;
    }

    // FIND_AND_REPLY: auto-execute the full pipeline (search → open → reply)
    if (data.action_type === 'FIND_AND_REPLY') {
      const findReplyCard = document.createElement('div');
      findReplyCard.className = 'enh-action-card enh-consent-soft';
      const frHeadline = document.createElement('p');
      frHeadline.className = 'enh-action-headline';
      frHeadline.textContent = data.headline || 'Finding email & drafting reply…';
      findReplyCard.appendChild(frHeadline);
      const frStatus = document.createElement('p');
      frStatus.className = 'enh-action-summary';
      frStatus.textContent = 'Searching your inbox…';
      findReplyCard.appendChild(frStatus);
      container.appendChild(findReplyCard);

      // Auto-execute in background
      handleFindAndReply(data).catch(() => {
        frStatus.textContent = 'Could not complete the reply. Please try again.';
        frStatus.style.color = '#f87171';
      });
      return;
    }

    if (data.type === 'tasks') {
      renderTaskList(container, data.items || []);
    } else if (data.type === 'products') {
      renderProductList(container, data.items || []);
    } else if (data.consent_level === 'auto' && data.dom_actions && data.dom_actions.length > 0) {
      // Fully agentic: auto-execute immediately, show a "doing it" status card
      renderAutoExecute(container, data);
    } else if (data.consent_level && data.consent_level !== 'auto' && data.dom_actions) {
      // Consequential action: show consent card
      renderActionPreview(container, data);
    } else if (data.primary_content) {
      renderAgentResponse(container, data);
    } else {
      const msg = document.createElement('p');
      msg.className = 'enh-text-result';
      msg.textContent = data.message || JSON.stringify(data);
      container.appendChild(msg);
    }
  }

  function renderResults(data) {
    const wrapper = document.createElement('div');
    wrapper.className = 'enh-msg enh-msg-assistant';
    renderResultsInto(wrapper, data);
    resultsArea.appendChild(wrapper);
    resultsArea.classList.remove('enh-hidden');
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function renderClarification(data) {
    const clarification = data.clarification;
    const wrapper = document.createElement('div');
    wrapper.className = 'enh-msg enh-msg-assistant';

    // Question text
    const question = document.createElement('p');
    question.style.cssText = 'color: #e2e8f0; font-size: 13px; margin-bottom: 10px;';
    question.textContent = clarification.question;
    wrapper.appendChild(question);

    // Option buttons
    const optionsContainer = document.createElement('div');
    optionsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 6px;';

    clarification.options.forEach(option => {
      if (option.value === 'custom') {
        // "Something else" — show input field when clicked
        const customBtn = document.createElement('button');
        customBtn.style.cssText = 'background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #94a3b8; padding: 8px 12px; cursor: pointer; font-size: 12px; text-align: left; transition: all 0.15s;';
        customBtn.textContent = option.label;
        customBtn.addEventListener('mouseenter', () => { customBtn.style.background = 'rgba(99,102,241,0.15)'; customBtn.style.borderColor = 'rgba(99,102,241,0.3)'; });
        customBtn.addEventListener('mouseleave', () => { customBtn.style.background = 'rgba(255,255,255,0.06)'; customBtn.style.borderColor = 'rgba(255,255,255,0.1)'; });
        customBtn.addEventListener('click', () => {
          // Replace button with input field
          customBtn.style.display = 'none';
          const inputRow = document.createElement('div');
          inputRow.style.cssText = 'display: flex; gap: 6px;';
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.placeholder = 'Type your answer...';
          inp.style.cssText = 'flex: 1; background: rgba(255,255,255,0.06); border: 1px solid rgba(99,102,241,0.3); border-radius: 8px; color: #e2e8f0; padding: 8px 12px; font-size: 12px; outline: none;';
          const sendBtn = document.createElement('button');
          sendBtn.textContent = 'Send';
          sendBtn.style.cssText = 'background: #6366f1; border: none; border-radius: 8px; color: white; padding: 8px 14px; cursor: pointer; font-size: 12px;';
          sendBtn.addEventListener('click', () => {
            if (inp.value.trim()) {
              submitClarification(inp.value.trim());
            }
          });
          inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && inp.value.trim()) {
              submitClarification(inp.value.trim());
            }
          });
          inputRow.appendChild(inp);
          inputRow.appendChild(sendBtn);
          optionsContainer.appendChild(inputRow);
          inp.focus();
        });
        optionsContainer.appendChild(customBtn);
      } else {
        const btn = document.createElement('button');
        btn.style.cssText = 'background: rgba(99,102,241,0.1); border: 1px solid rgba(99,102,241,0.2); border-radius: 8px; color: #e2e8f0; padding: 8px 12px; cursor: pointer; font-size: 12px; text-align: left; transition: all 0.15s;';
        btn.textContent = option.label;
        btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(99,102,241,0.25)'; btn.style.borderColor = 'rgba(99,102,241,0.4)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(99,102,241,0.1)'; btn.style.borderColor = 'rgba(99,102,241,0.2)'; });
        btn.addEventListener('click', () => {
          submitClarification(option.value);
        });
        optionsContainer.appendChild(btn);
      }
    });

    wrapper.appendChild(optionsContainer);
    resultsArea.appendChild(wrapper);
    resultsArea.classList.remove('enh-hidden');
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function submitClarification(answer) {
    // Show user's choice as a chat message
    const userMsg = document.createElement('div');
    userMsg.className = 'enh-msg enh-msg-user';
    userMsg.textContent = answer;
    resultsArea.appendChild(userMsg);
    chatArea.scrollTop = chatArea.scrollHeight;

    // Re-submit the original prompt with the clarification appended
    const originalPrompt = lastUserPrompt || '';
    const clarifiedPrompt = `${originalPrompt} [User clarification: ${answer}]`;
    promptInput.value = clarifiedPrompt;
    handleSubmit();
  }

  function renderTaskList(container, tasks) {
    if (!tasks.length) {
      container.innerHTML = '<p class="enh-no-results">No tasks found.</p>';
      return;
    }

    const header = document.createElement('p');
    header.className = 'enh-results-header';
    header.textContent = `${tasks.length} task${tasks.length > 1 ? 's' : ''} found`;
    container.appendChild(header);

    const list = document.createElement('div');
    list.className = 'enh-task-list';

    tasks.forEach((task, i) => {
      const row = document.createElement('label');
      row.className = 'enh-task-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.dataset.index = i;
      checkbox.className = 'enh-task-checkbox';

      const info = document.createElement('div');
      info.className = 'enh-task-info';

      const title = document.createElement('span');
      title.className = 'enh-task-title';
      title.textContent = task.title;

      const meta = document.createElement('span');
      meta.className = 'enh-task-meta';
      const parts = [];
      if (task.priority) parts.push(task.priority);
      if (task.dueDate) parts.push(task.dueDate);
      meta.textContent = parts.join(' · ');

      info.appendChild(title);
      info.appendChild(meta);
      row.appendChild(checkbox);
      row.appendChild(info);
      list.appendChild(row);
    });

    container.appendChild(list);

    const createBtn = document.createElement('button');
    createBtn.className = 'enh-btn enh-btn-primary enh-create-btn';
    createBtn.textContent = 'Create Selected Tasks';
    createBtn.addEventListener('click', async () => {
      const selected = [...list.querySelectorAll('.enh-task-checkbox:checked')]
        .map(cb => tasks[parseInt(cb.dataset.index)]);
      if (!selected.length) return;

      createBtn.textContent = 'Creating...';
      createBtn.disabled = true;

      const res = await sendToBackground('create_todos_bulk', selected);
      if (res?.success) {
        container.innerHTML = `<p class="enh-success-message">${selected.length} task${selected.length > 1 ? 's' : ''} created in Enhancivity</p>`;
      } else {
        createBtn.textContent = 'Create Selected Tasks';
        createBtn.disabled = false;
        showError('Failed to create tasks. Please try again.');
      }
    });
    container.appendChild(createBtn);
  }

  // ── Task Draft Preview: Editable card for AI-extracted task ──
  function renderTaskDraftPreview(container, data) {
    let taskData;
    try {
      taskData = JSON.parse(data.primary_content);
    } catch {
      taskData = { title: data.headline || '', description: data.primary_content || '' };
    }

    const card = document.createElement('div');
    card.className = 'enh-action-card enh-consent-soft';

    card.innerHTML = `
      <p class="enh-action-headline">New Task</p>
      <div class="enh-task-draft-form">
        <label class="enh-draft-label">Title</label>
        <input type="text" class="enh-draft-input" id="enh-draft-title" value="" placeholder="Task title" />
        <label class="enh-draft-label">Description</label>
        <textarea class="enh-draft-textarea" id="enh-draft-desc" rows="3" placeholder="Optional description"></textarea>
        <div class="enh-draft-row">
          <div class="enh-draft-field">
            <label class="enh-draft-label">Priority</label>
            <select class="enh-draft-select" id="enh-draft-priority">
              <option value="HIGH">High</option>
              <option value="MEDIUM" selected>Medium</option>
              <option value="LOW">Low</option>
            </select>
          </div>
          <div class="enh-draft-field">
            <label class="enh-draft-label">Due Date</label>
            <input type="date" class="enh-draft-input" id="enh-draft-date" />
          </div>
        </div>
      </div>
    `;

    // Set values after innerHTML so special chars are handled safely
    const titleInput = card.querySelector('#enh-draft-title');
    const descInput = card.querySelector('#enh-draft-desc');
    const prioritySelect = card.querySelector('#enh-draft-priority');
    const dateInput = card.querySelector('#enh-draft-date');

    titleInput.value = taskData.title || '';
    descInput.value = taskData.description || '';
    if (taskData.priority && ['HIGH', 'MEDIUM', 'LOW'].includes(taskData.priority)) {
      prioritySelect.value = taskData.priority;
    }
    if (taskData.dueDate) {
      try {
        const d = new Date(taskData.dueDate);
        if (!isNaN(d.getTime())) dateInput.value = d.toISOString().split('T')[0];
      } catch { /* ignore bad date */ }
    }

    const btnRow = document.createElement('div');
    btnRow.className = 'enh-action-btn-row';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'enh-btn enh-consent-btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      container.innerHTML = '';
      container.classList.add('enh-hidden');
    });
    btnRow.appendChild(cancelBtn);

    const createBtn = document.createElement('button');
    createBtn.className = 'enh-btn enh-consent-btn-soft';
    createBtn.textContent = 'Create Task';
    createBtn.addEventListener('click', async () => {
      const title = titleInput.value.trim();
      if (!title) { titleInput.focus(); return; }

      createBtn.textContent = 'Creating...';
      createBtn.disabled = true;

      const todoData = {
        title,
        description: descInput.value.trim() || null,
        priority: prioritySelect.value,
        dueDate: dateInput.value || null,
      };

      const res = await sendToBackground('create_todo', todoData);
      if (res?.success) {
        container.innerHTML = '<p class="enh-success-message">Task created! View it in your dashboard.</p>';
      } else {
        createBtn.textContent = 'Create Task';
        createBtn.disabled = false;
        showError(res?.error || 'Failed to create task. Please try again.');
      }
    });
    btnRow.appendChild(createBtn);

    card.appendChild(btnRow);
    container.appendChild(card);
  }

  function renderProductList(container, products) {
    if (!products.length) {
      container.innerHTML = '<p class="enh-no-results">No products found.</p>';
      return;
    }

    const header = document.createElement('p');
    header.className = 'enh-results-header';
    header.textContent = `${products.length} recommendation${products.length > 1 ? 's' : ''}`;
    container.appendChild(header);

    const list = document.createElement('div');
    list.className = 'enh-product-list';

    products.forEach(product => {
      const card = document.createElement('div');
      card.className = 'enh-product-card';

      const name = document.createElement('span');
      name.className = 'enh-product-name';
      name.textContent = product.title;

      const meta = document.createElement('div');
      meta.className = 'enh-product-meta';

      if (product.price) {
        const price = document.createElement('span');
        price.className = 'enh-product-price';
        price.textContent = product.price;
        meta.appendChild(price);
      }
      if (product.rating) {
        const rating = document.createElement('span');
        rating.className = 'enh-product-rating';
        rating.textContent = `★ ${product.rating}`;
        meta.appendChild(rating);
      }

      card.appendChild(name);
      card.appendChild(meta);

      if (product.url) {
        const link = document.createElement('a');
        link.href = product.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'enh-product-link';
        link.textContent = 'View →';
        card.appendChild(link);
      }

      list.appendChild(card);
    });

    container.appendChild(list);
  }

  // ── Auto-Execute (non-consequential actions run immediately) ─
  // Shows a slim status card while executing, updates to result.

  function renderAutoExecute(container, data) {
    const card = document.createElement('div');
    card.className = 'enh-action-card';

    const headline = document.createElement('p');
    headline.className = 'enh-action-headline';
    headline.textContent = data.headline;
    card.appendChild(headline);

    if (data.preview?.summary) {
      const summary = document.createElement('p');
      summary.className = 'enh-action-summary';
      summary.textContent = data.preview.summary;
      card.appendChild(summary);
    }

    const statusEl = document.createElement('p');
    statusEl.className = 'enh-action-rationale';
    statusEl.textContent = 'Working…';
    card.appendChild(statusEl);

    container.appendChild(card);

    // Execute immediately — no user approval needed
    executeAutoAction(data).then(async (res) => {
      if (res?.success) {
        // For NAVIGATE actions, just confirm — page opened in a new tab
        if (data.action_type === 'NAVIGATE' || (data.dom_actions?.[0]?.action === 'navigate')) {
          statusEl.textContent = 'Done — page opened.';
          statusEl.style.color = '#34d399';
          return;
        }

        const verification = interpretPageState(res.pageStateAfter);
        if (verification?.type === 'success') {
          statusEl.textContent = `Done \u2014 ${verification.snippet}`;
          statusEl.style.color = '#34d399';
        } else if (verification?.type === 'error') {
          statusEl.textContent = `Action ran, but page shows: ${verification.snippet}`;
          statusEl.style.color = '#fbbf24';
        } else {
          statusEl.textContent = 'Done.';
          statusEl.style.color = '#34d399';
        }
      } else {
        const errorType = res?.errorType || '';
        const errorMsg = res?.error || 'Action failed.';
        if (errorMsg === 'BLOCKED_SENSITIVE' || errorMsg === 'BLOCKED_DANGEROUS_CLICK') {
          statusEl.textContent = 'Stopped: this step requires your manual action.';
          statusEl.style.color = '#f59e0b';
        } else if (errorType === 'READ_ONLY_PAGE') {
          // Page had no form fields — show scraped content as a readable response instead
          statusEl.textContent = 'Read-only page — showing what I found:';
          statusEl.style.color = '#a5b4fc';
          const contentEl = document.createElement('p');
          contentEl.className = 'enh-action-rationale';
          contentEl.style.cssText = 'margin-top:8px;white-space:pre-wrap;max-height:200px;overflow-y:auto;font-size:12px;';
          contentEl.textContent = errorMsg.replace('This page has no form fields to fill. Here is what I can see:\n\n', '');
          card.appendChild(contentEl);
        } else {
          statusEl.textContent = `Couldn't complete: ${errorMsg}`;
          statusEl.style.color = '#f87171';
        }
      }
    });
  }

  async function executeAutoAction(data) {
    if (data.action_type === 'USE_EXISTING_TAB' && data.target_tab_url) {
      return sendToBackground('switch_tab', { targetTabUrl: data.target_tab_url });
    }
    if (data.dom_actions && data.dom_actions.length > 1) {
      return sendToBackground('execute_multi_step', { steps: data.dom_actions, tabId: currentTabId });
    }
    if (data.dom_actions && data.dom_actions.length === 1) {
      return sendToBackground('execute_action', { action: data.dom_actions[0], tabId: currentTabId });
    }
    return { success: false, error: 'No actions to execute.' };
  }

  // ── Post-Action Verification ──────────────────────────────────

  const SUCCESS_INDICATORS = [
    'added to cart', 'successfully', 'confirmed', 'thank you',
    'order placed', 'submitted', 'saved', 'updated', 'complete',
    'welcome back', 'signed in', 'logged in',
  ];

  const ERROR_INDICATORS = [
    'error', 'failed', 'out of stock', 'unavailable', 'invalid',
    'try again', 'something went wrong', 'not found',
    'incorrect', 'expired', 'denied',
  ];

  function interpretPageState(pageStateAfter) {
    if (!pageStateAfter?.mainContent) return null;
    const content = pageStateAfter.mainContent.toLowerCase().slice(0, 2000);

    for (const phrase of SUCCESS_INDICATORS) {
      if (content.includes(phrase)) {
        const idx = content.indexOf(phrase);
        const snippet = pageStateAfter.mainContent.slice(
          Math.max(0, idx - 20),
          Math.min(pageStateAfter.mainContent.length, idx + 60)
        ).trim();
        return { type: 'success', snippet };
      }
    }

    for (const phrase of ERROR_INDICATORS) {
      if (content.includes(phrase)) {
        const idx = content.indexOf(phrase);
        const snippet = pageStateAfter.mainContent.slice(
          Math.max(0, idx - 20),
          Math.min(pageStateAfter.mainContent.length, idx + 60)
        ).trim();
        return { type: 'error', snippet };
      }
    }

    return null;
  }

  // ── Agent Response ───────────────────────────────────────────

  function renderAgentResponse(container, data) {
    const card = document.createElement('div');
    card.className = 'enh-action-card';

    const headline = document.createElement('p');
    headline.className = 'enh-action-headline';
    headline.textContent = data.headline;
    card.appendChild(headline);

    const content = document.createElement('p');
    content.className = 'enh-action-content';
    let pc = data.primary_content;
    // Parse JSON strings (common for FIND_AND_REPLY, COMPOSE_EMAIL)
    if (typeof pc === 'string' && pc.startsWith('{')) {
      try { pc = JSON.parse(pc); } catch {}
    }
    content.textContent = typeof pc === 'object' && pc !== null
      ? (pc.replyBody || pc.body || pc.text || pc.message || JSON.stringify(pc, null, 2))
      : (pc || '');
    card.appendChild(content);

    if (data.rationale) {
      const rationale = document.createElement('p');
      rationale.className = 'enh-action-rationale';
      rationale.textContent = data.rationale;
      card.appendChild(rationale);
    }

    container.appendChild(card);
  }

  // ── Action Preview with Consent ──────────────────────────────

  function renderActionPreview(container, data) {
    const isBlocked = data.consent_level === 'blocked';
    const isHard = data.consent_level === 'hard';

    const card = document.createElement('div');
    card.className = `enh-action-card ${isBlocked ? 'enh-consent-blocked' : isHard ? 'enh-consent-hard' : 'enh-consent-soft'}`;

    const headline = document.createElement('p');
    headline.className = 'enh-action-headline';
    headline.textContent = data.headline;
    card.appendChild(headline);

    if (data.preview?.summary) {
      const summary = document.createElement('p');
      summary.className = 'enh-action-summary';
      summary.textContent = data.preview.summary;
      card.appendChild(summary);
    }

    if (data.preview?.details) {
      const details = document.createElement('div');
      details.className = 'enh-action-preview';
      details.textContent = data.preview.details;
      card.appendChild(details);
    }

    if (data.dom_actions && data.dom_actions.length > 0 && !isBlocked) {
      const stepList = document.createElement('ol');
      stepList.className = 'enh-action-steps';
      for (const step of data.dom_actions) {
        const li = document.createElement('li');
        li.textContent = step.description;
        stepList.appendChild(li);
      }
      card.appendChild(stepList);
    }

    if (data.rationale) {
      const rationale = document.createElement('p');
      rationale.className = 'enh-action-rationale';
      rationale.textContent = data.rationale;
      card.appendChild(rationale);
    }

    const btnRow = document.createElement('div');
    btnRow.className = 'enh-action-btn-row';

    if (isBlocked) {
      const understood = document.createElement('button');
      understood.className = 'enh-btn enh-consent-btn-blocked';
      understood.textContent = 'Understood';
      understood.addEventListener('click', () => {
        container.innerHTML = '';
        container.classList.add('enh-hidden');
      });
      btnRow.appendChild(understood);
    } else {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'enh-btn enh-consent-btn-cancel';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => {
        container.innerHTML = '';
        container.classList.add('enh-hidden');
      });
      btnRow.appendChild(cancelBtn);

      const confirmBtn = document.createElement('button');
      confirmBtn.className = `enh-btn ${isHard ? 'enh-consent-btn-hard' : 'enh-consent-btn-soft'}`;
      confirmBtn.textContent = getConfirmLabel(data.action_type);
      confirmBtn.addEventListener('click', () => executeAction(container, confirmBtn, data));
      btnRow.appendChild(confirmBtn);
    }

    card.appendChild(btnRow);
    container.appendChild(card);
  }

  function getConfirmLabel(actionType) {
    switch (actionType) {
      case 'COMPOSE_EMAIL':    return 'Insert Draft';
      case 'NAVIGATE':         return 'Yes, Open It';
      case 'USE_EXISTING_TAB': return 'Switch to Tab';
      case 'SEARCH_SITE':      return 'Yes, Search';
      case 'ADD_TO_CART':       return 'Yes, Add to Cart';
      case 'FILL_FORM':        return 'Yes, Fill It';
      case 'MULTI_STEP':       return 'Yes, Do This';
      case 'EXTRACT_TASKS':    return 'Extract Tasks';
      case 'TASK_DRAFT':       return 'Create Task';
      default:                 return 'Confirm';
    }
  }

  // ── Execute Action ───────────────────────────────────────────

  async function executeAction(container, btn, data) {
    setStage('STAGE_EXECUTION');
    btn.textContent = 'Working...';
    btn.disabled = true;

    let res;

    if (data.action_type === 'USE_EXISTING_TAB' && data.target_tab_url) {
      res = await sendToBackground('switch_tab', { targetTabUrl: data.target_tab_url });
      if (res?.success) {
        const msg = res.switched
          ? `Switched to: ${res.tabTitle || data.target_tab_url}`
          : `Opened: ${data.target_tab_url}`;
        container.innerHTML = `<p class="enh-success-message">${msg}</p>`;
        return;
      }

    } else if (data.action_type === 'TASK_DRAFT') {
      // Fallback: if consent card shown instead of custom preview, create directly
      let taskData;
      try {
        taskData = JSON.parse(data.primary_content);
      } catch {
        taskData = { title: data.headline, description: data.primary_content };
      }
      res = await sendToBackground('create_todo', taskData);
      if (res?.success) {
        container.innerHTML = '<p class="enh-success-message">Task created! View it in your dashboard.</p>';
        return;
      }

    } else if (data.action_type === 'EXTRACT_TASKS') {
      const parseRes = await sendToBackground('process_request', {
        userPrompt: 'Extract all actionable tasks from the current page. For each task include title, description, dueDate (YYYY-MM-DD or null), and priority (HIGH/MEDIUM/LOW). Use EXTRACT_TASKS with a JSON array in primary_content.',
        tabId: currentTabId,
        url: currentTabUrl,
      });
      if (parseRes?.success && parseRes?.data) {
        container.innerHTML = '';
        renderResults(parseRes.data);
        return;
      }
      res = parseRes || { success: false, error: 'Could not extract tasks from this page.' };

    } else if (data.action_type === 'COMPOSE_EMAIL' && currentSite === 'gmail') {
      const composeData = {};
      for (const step of (data.dom_actions || [])) {
        if (step.action === 'fill_field') {
          if (step.selector?.includes('to'))      composeData.to = step.value;
          if (step.selector?.includes('subject')) composeData.subject = step.value;
          if (step.selector?.includes('body') || step.selector?.includes('editable'))
            composeData.body = step.value;
        }
      }
      if (!composeData.body && data.primary_content) {
        const pc = data.primary_content;
        composeData.body = typeof pc === 'string' ? pc : (pc.body || pc.replyBody || JSON.stringify(pc));
      }
      res = await sendToBackground('gmail_compose', { tabId: currentTabId, data: composeData });

    } else if (data.dom_actions && data.dom_actions.length > 1) {
      res = await sendToBackground('execute_multi_step', {
        steps: data.dom_actions,
        tabId: currentTabId,
      });

    } else if (data.dom_actions && data.dom_actions.length === 1) {
      res = await sendToBackground('execute_action', {
        action: data.dom_actions[0],
        tabId: currentTabId,
      });

    } else {
      res = { success: false, error: 'No actions to execute.' };
    }

    if (res?.success) {
      const verification = interpretPageState(res.pageStateAfter);
      let doneText = 'Done! Action completed successfully.';
      let doneStyle = '';
      if (verification?.type === 'success') {
        doneText = `Done \u2014 ${verification.snippet}`;
      } else if (verification?.type === 'error') {
        doneText = `Action ran, but page shows: "${verification.snippet}"`;
        doneStyle = ' style="color: #fbbf24;"';
      }
      container.innerHTML = `<p class="enh-success-message"${doneStyle}>${doneText}</p>`;
    } else {
      const errorMsg = res?.error || 'Action failed. Please try again.';
      if (errorMsg === 'BLOCKED_SENSITIVE') {
        container.innerHTML = '<p class="enh-blocked-message">Blocked: This action involves sensitive data. Enhancivity never automates these fields.</p>';
      } else if (errorMsg === 'BLOCKED_DANGEROUS_CLICK') {
        container.innerHTML = '<p class="enh-blocked-message">Blocked: Enhancivity won\'t click Send/Pay/Submit buttons. You\'re always in control.</p>';
      } else {
        btn.textContent = getConfirmLabel(data.action_type);
        btn.disabled = false;
        showError(errorMsg);
      }
    }
  }

  // ── Orchestration: Multi-Site Search HUD ─────────────────────

  // autoStart=true: agentic law — show plan for 800ms then auto-begin
  // autoStart=false: show plan with manual "Search Now" button (legacy fallback)
  function renderOrchestratePlan(data, autoStart = true) {
    resultsArea.classList.remove('enh-hidden');

    const wrapper = document.createElement('div');
    wrapper.className = 'enh-msg enh-msg-assistant';

    const card = document.createElement('div');
    card.className = 'enh-action-card enh-consent-soft';

    const headline = document.createElement('p');
    headline.className = 'enh-action-headline';
    headline.textContent = data.headline;
    card.appendChild(headline);

    const plan = data.search_plan;
    const planInfo = document.createElement('div');
    planInfo.className = 'enh-orch-plan-info';

    const siteBadges = document.createElement('div');
    siteBadges.className = 'enh-orch-site-badges';
    for (const site of plan.sites) {
      const badge = document.createElement('span');
      badge.className = 'enh-orch-site-badge';
      badge.textContent = site;
      siteBadges.appendChild(badge);
    }
    planInfo.appendChild(siteBadges);

    const criteria = document.createElement('p');
    criteria.className = 'enh-orch-criteria';
    criteria.textContent = `Comparing by: ${plan.criteria}`;
    planInfo.appendChild(criteria);

    card.appendChild(planInfo);

    if (data.rationale) {
      const rationale = document.createElement('p');
      rationale.className = 'enh-action-rationale';
      rationale.textContent = data.rationale;
      card.appendChild(rationale);
    }

    if (autoStart) {
      // Show a slim status line then auto-launch
      const statusEl = document.createElement('p');
      statusEl.className = 'enh-action-rationale';
      statusEl.textContent = 'Launching searches…';
      card.appendChild(statusEl);

      wrapper.appendChild(card);
      resultsArea.appendChild(wrapper);

      setTimeout(() => {
        startOrchestration(data.search_plan, data.primary_content || '');
      }, 800);
    } else {
      const btnRow = document.createElement('div');
      btnRow.className = 'enh-action-btn-row';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'enh-btn enh-consent-btn-cancel';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => {
        resultsArea.innerHTML = '';
        resultsArea.classList.add('enh-hidden');
      });
      btnRow.appendChild(cancelBtn);

      const searchBtn = document.createElement('button');
      searchBtn.className = 'enh-btn enh-consent-btn-soft';
      searchBtn.textContent = 'Search Now';
      searchBtn.addEventListener('click', () => {
        startOrchestration(data.search_plan, data.primary_content || '');
      });
      btnRow.appendChild(searchBtn);

      card.appendChild(btnRow);
      wrapper.appendChild(card);
      resultsArea.appendChild(wrapper);
    }
  }

  // ── EXPLORE: Render plan card + run exploration loop ────────

  function renderExplorePlan(data, autoStart = true) {
    resultsArea.classList.remove('enh-hidden');

    const wrapper = document.createElement('div');
    wrapper.className = 'enh-msg enh-msg-assistant';

    const card = document.createElement('div');
    card.className = 'enh-action-card enh-consent-soft';

    const headline = document.createElement('p');
    headline.className = 'enh-action-headline';
    headline.textContent = data.headline || 'Exploring...';
    card.appendChild(headline);

    const plan = data.explore_plan;

    const planInfo = document.createElement('div');
    planInfo.className = 'enh-orch-plan-info';

    const goalEl = document.createElement('p');
    goalEl.className = 'enh-orch-criteria';
    goalEl.textContent = plan.goal;
    goalEl.style.fontWeight = '500';
    planInfo.appendChild(goalEl);

    const strategyEl = document.createElement('p');
    strategyEl.className = 'enh-orch-criteria';
    strategyEl.style.opacity = '0.7';
    strategyEl.style.fontSize = '11px';
    strategyEl.textContent = `Strategy: ${plan.strategy}`;
    planInfo.appendChild(strategyEl);

    const budgetBadges = document.createElement('div');
    budgetBadges.className = 'enh-orch-site-badges';

    const stepBadge = document.createElement('span');
    stepBadge.className = 'enh-orch-site-badge';
    stepBadge.textContent = `${plan.maxSteps} steps`;
    budgetBadges.appendChild(stepBadge);

    const creditBadge = document.createElement('span');
    creditBadge.className = 'enh-orch-site-badge';
    creditBadge.textContent = `~${plan.creditBudget} EU`;
    budgetBadges.appendChild(creditBadge);

    planInfo.appendChild(budgetBadges);
    card.appendChild(planInfo);

    if (data.rationale) {
      const rationale = document.createElement('p');
      rationale.className = 'enh-action-rationale';
      rationale.textContent = data.rationale;
      card.appendChild(rationale);
    }

    if (autoStart) {
      const statusEl = document.createElement('p');
      statusEl.className = 'enh-action-rationale';
      statusEl.textContent = 'Starting exploration...';
      card.appendChild(statusEl);

      wrapper.appendChild(card);
      resultsArea.appendChild(wrapper);

      setTimeout(() => {
        startExploration(plan);
      }, 800);
    } else {
      const btnRow = document.createElement('div');
      btnRow.className = 'enh-action-btn-row';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'enh-btn enh-consent-btn-cancel';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => {
        resultsArea.innerHTML = '';
        resultsArea.classList.add('enh-hidden');
      });
      btnRow.appendChild(cancelBtn);

      const exploreBtn = document.createElement('button');
      exploreBtn.className = 'enh-btn enh-consent-btn-soft';
      exploreBtn.textContent = 'Explore Now';
      exploreBtn.addEventListener('click', () => {
        startExploration(plan);
      });
      btnRow.appendChild(exploreBtn);

      card.appendChild(btnRow);
      wrapper.appendChild(card);
      resultsArea.appendChild(wrapper);
    }
  }

  async function startExploration(explorePlan) {
    // Wrap exploration HUD in an assistant bubble (preserves conversation above)
    const exploreWrapper = document.createElement('div');
    exploreWrapper.className = 'enh-msg enh-msg-assistant';

    const hud = document.createElement('div');
    hud.className = 'enh-orch-hud';

    const header = document.createElement('div');
    header.className = 'enh-orch-header';

    const badge = document.createElement('span');
    badge.className = 'enh-orch-badge-label';
    badge.textContent = 'Exploring';
    header.appendChild(badge);

    const statusEl = document.createElement('span');
    statusEl.className = 'enh-orch-status';
    statusEl.textContent = 'Starting...';
    header.appendChild(statusEl);

    hud.appendChild(header);

    // Step log area
    const stepLog = document.createElement('div');
    stepLog.className = 'enh-explore-step-log';
    stepLog.style.cssText = 'max-height: 200px; overflow-y: auto; padding: 6px 0;';
    hud.appendChild(stepLog);

    exploreWrapper.appendChild(hud);
    resultsArea.appendChild(exploreWrapper);
    resultsArea.classList.remove('enh-hidden');
    chatArea.scrollTop = chatArea.scrollHeight;

    // Listen for exploration progress
    if (explorationListener) {
      chrome.storage.onChanged.removeListener(explorationListener);
    }

    explorationListener = (changes) => {
      if (!changes.explorationProgress) return;
      const progress = changes.explorationProgress.newValue;
      if (!progress) return;

      const phaseLabel = progress.phase > 1 ? `[Phase ${progress.phase}] ` : '';
      statusEl.textContent = `${phaseLabel}Step ${progress.step}/${progress.total}: ${progress.description || ''}`;

      // Add step entry to log
      if (progress.step >= 0 && progress.description) {
        const stepEntry = document.createElement('div');
        stepEntry.style.cssText = 'display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: 11px; color: rgba(255,255,255,0.7);';

        const icon = document.createElement('span');
        icon.style.cssText = 'font-size: 10px; width: 14px; text-align: center;';
        if (progress.status === 'running') icon.textContent = '...';
        else if (progress.status === 'complete') icon.textContent = '\u2713';
        else if (progress.status === 'partial') icon.textContent = '\u25CB';
        else if (progress.status === 'consent') icon.textContent = '\u26A0';
        else if (progress.status === 'login_required') icon.textContent = '\uD83D\uDD12';
        else icon.textContent = '\u2022';

        const text = document.createElement('span');
        text.textContent = progress.description;

        stepEntry.appendChild(icon);
        stepEntry.appendChild(text);

        // Update last entry if same step, otherwise add new
        const existing = stepLog.querySelector(`[data-step="${progress.step}"]`);
        if (existing) {
          existing.replaceWith(stepEntry);
        } else {
          stepLog.appendChild(stepEntry);
        }
        stepEntry.setAttribute('data-step', progress.step);
        stepLog.scrollTop = stepLog.scrollHeight;
      }
    };

    chrome.storage.onChanged.addListener(explorationListener);

    // Get current tab
    let tabId;
    try {
      const tabRes = await sendToBackground('GET_CURRENT_TAB', {});
      tabId = tabRes?.tab?.id || null;
    } catch {
      tabId = null;
    }

    // Get the user's original prompt for auto-continuation context anchoring
    const lastUserMsg = conversationMessages.filter(m => m.role === 'user').pop();
    const userPrompt = lastUserMsg?.content || explorePlan.goal;

    // Start exploration via background (fire-and-forget — result arrives via chrome.storage)
    const startRes = await sendToBackground('explore_start', { explorePlan, tabId, userPrompt }, 10000);

    if (!startRes?.success && !startRes?.async) {
      // Immediate failure (e.g., no tabId, invalid plan)
      chrome.storage.onChanged.removeListener(explorationListener);
      explorationListener = null;
      exploreWrapper.innerHTML = `<div class="enh-action-card"><p class="enh-error-message">${startRes?.error || 'Failed to start exploration.'}</p></div>`;
      resultsArea.classList.remove('enh-hidden');
      chatArea.scrollTop = chatArea.scrollHeight;
      promptInput.focus();
      return;
    }

    // Wait for the final result via chrome.storage.session (set by background when loop finishes)
    const res = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false, error: 'Exploration timed out after 10 minutes.' });
      }, 600000);

      const resultListener = (changes, areaName) => {
        if (areaName !== 'session' || !changes.explorationResult) return;
        clearTimeout(timeout);
        chrome.storage.onChanged.removeListener(resultListener);
        resolve(changes.explorationResult.newValue);
      };
      chrome.storage.onChanged.addListener(resultListener);

      // Also check if result already arrived (race condition guard)
      chrome.storage.session.get(['explorationResult']).then(data => {
        if (data.explorationResult) {
          clearTimeout(timeout);
          chrome.storage.onChanged.removeListener(resultListener);
          // Clear it so next exploration starts fresh
          chrome.storage.session.remove(['explorationResult']).catch(() => {});
          resolve(data.explorationResult);
        }
      }).catch(() => {});
    });

    // Clean up listener
    if (explorationListener) {
      chrome.storage.onChanged.removeListener(explorationListener);
      explorationListener = null;
    }

    // If paused for login, show login-required UI and wait for user action
    if (res?.paused) {
      conversationMessages.push({
        role: 'assistant',
        content: `[Exploration Paused] ${res.pauseReason || 'Login required to continue.'}`,
        timestamp: Date.now(),
      });
      saveConversation();
      renderLoginRequired(res.pauseReason, res.resumeStateKey, res.authType);
      return;
    }

    // Render final result inside the explore wrapper (replaces the HUD, keeps conversation above)
    exploreWrapper.innerHTML = '';

    if (res?.success || res?.goalResult) {
      const card = document.createElement('div');
      card.className = 'enh-action-card';

      const headlineEl = document.createElement('p');
      headlineEl.className = 'enh-action-headline';
      headlineEl.textContent = res.success ? 'Exploration Complete' : 'Partial Results';
      card.appendChild(headlineEl);

      const resultEl = document.createElement('div');
      resultEl.className = 'enh-action-rationale';
      resultEl.style.whiteSpace = 'pre-wrap';
      resultEl.textContent = truncateForDisplay(res.goalResult || 'Exploration finished.');
      card.appendChild(resultEl);

      if (res.stepsUsed) {
        const metaEl = document.createElement('p');
        metaEl.style.cssText = 'font-size: 10px; opacity: 0.5; margin-top: 8px;';
        metaEl.textContent = `${res.stepsUsed} steps \u00B7 ${(res.creditsUsed || 0).toFixed(1)} EU`;
        card.appendChild(metaEl);
      }

      exploreWrapper.appendChild(card);

      // Push exploration result to conversation for follow-up context
      const explorationResult = res.goalResult || 'Exploration completed.';
      conversationMessages.push({
        role: 'assistant',
        content: `[Exploration Result] ${explorationResult}`,
        data: { action_type: 'EXPLORE_RESULT', goalResult: explorationResult, stepsUsed: res.stepsUsed, creditsUsed: res.creditsUsed },
        timestamp: Date.now(),
      });
      saveConversation();
    } else {
      const errorCard = document.createElement('div');
      errorCard.className = 'enh-action-card';
      errorCard.innerHTML = `<p class="enh-error-message">${res?.error || 'Exploration failed. Please try again.'}</p>`;
      exploreWrapper.appendChild(errorCard);

      // Push error to conversation so follow-ups have context
      conversationMessages.push({
        role: 'assistant',
        content: `[Exploration Failed] ${res?.error || 'Exploration failed.'}`,
        timestamp: Date.now(),
      });
      saveConversation();
    }

    resultsArea.classList.remove('enh-hidden');
    chatArea.scrollTop = chatArea.scrollHeight;
    promptInput.focus();
  }

  // ── Exploration Recovery (re-injected panel on new page) ──────

  function attachExplorationHUD(activeState) {
    // Re-create the live exploration HUD so the user sees progress on the new page
    const exploreWrapper = document.createElement('div');
    exploreWrapper.className = 'enh-msg enh-msg-assistant';
    exploreWrapper.id = 'enh-explore-recovery-wrapper';

    const hud = document.createElement('div');
    hud.className = 'enh-orch-hud';

    const header = document.createElement('div');
    header.className = 'enh-orch-header';

    const badge = document.createElement('span');
    badge.className = 'enh-orch-badge-label';
    badge.textContent = 'Exploring';
    header.appendChild(badge);

    const statusEl = document.createElement('span');
    statusEl.className = 'enh-orch-status';
    statusEl.textContent = activeState.goal ? `Goal: ${activeState.goal}` : 'In progress...';
    header.appendChild(statusEl);

    hud.appendChild(header);

    const stepLog = document.createElement('div');
    stepLog.className = 'enh-explore-step-log';
    stepLog.style.cssText = 'max-height: 200px; overflow-y: auto; padding: 6px 0;';
    hud.appendChild(stepLog);

    exploreWrapper.appendChild(hud);
    resultsArea.appendChild(exploreWrapper);
    resultsArea.classList.remove('enh-hidden');
    if (greeting) greeting.style.display = 'none';
    chatArea.scrollTop = chatArea.scrollHeight;

    // Show panel if minimized
    panel.classList.remove('enh-hidden');

    // Listen for progress updates from background.js
    if (explorationListener) {
      chrome.storage.onChanged.removeListener(explorationListener);
    }

    explorationListener = (changes) => {
      if (changes.explorationProgress) {
        const progress = changes.explorationProgress.newValue;
        if (!progress) return;

        const phaseLabel = progress.phase > 1 ? `[Phase ${progress.phase}] ` : '';
      statusEl.textContent = `${phaseLabel}Step ${progress.step}/${progress.total}: ${progress.description || ''}`;

        if (progress.step >= 0 && progress.description) {
          const stepEntry = document.createElement('div');
          stepEntry.style.cssText = 'display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: 11px; color: rgba(255,255,255,0.7);';

          const icon = document.createElement('span');
          icon.style.cssText = 'font-size: 10px; width: 14px; text-align: center;';
          if (progress.status === 'running') icon.textContent = '...';
          else if (progress.status === 'complete') icon.textContent = '\u2713';
          else if (progress.status === 'partial') icon.textContent = '\u25CB';
          else if (progress.status === 'consent') icon.textContent = '\u26A0';
          else if (progress.status === 'login_required') icon.textContent = '\uD83D\uDD12';
          else icon.textContent = '\u2022';

          const text = document.createElement('span');
          text.textContent = progress.description;

          stepEntry.appendChild(icon);
          stepEntry.appendChild(text);

          const existing = stepLog.querySelector(`[data-step="${progress.step}"]`);
          if (existing) {
            existing.replaceWith(stepEntry);
          } else {
            stepLog.appendChild(stepEntry);
          }
          stepEntry.setAttribute('data-step', progress.step);
          stepLog.scrollTop = stepLog.scrollHeight;
        }
      }

      // Detect when exploration finishes (explorationActive removed)
      if (changes.explorationActive && !changes.explorationActive.newValue) {
        // Exploration ended — check for result
        chrome.storage.session.get(['explorationResult']).then((data) => {
          if (data.explorationResult) {
            showExplorationResult(data.explorationResult);
            chrome.storage.session.remove('explorationResult').catch(() => {});
          }
          // Clean up listener
          if (explorationListener) {
            chrome.storage.onChanged.removeListener(explorationListener);
            explorationListener = null;
          }
        });
      }
    };

    chrome.storage.onChanged.addListener(explorationListener);
  }

  function showExplorationResult(res) {
    // Remove recovery HUD if present
    const recoveryWrapper = resultsArea.querySelector('#enh-explore-recovery-wrapper');
    if (recoveryWrapper) recoveryWrapper.remove();

    const wrapper = document.createElement('div');
    wrapper.className = 'enh-msg enh-msg-assistant';

    if (res.paused) {
      // Login pause — show login required UI
      conversationMessages.push({
        role: 'assistant',
        content: `[Exploration Paused] ${res.pauseReason || 'Login required to continue.'}`,
        timestamp: Date.now(),
      });
      saveConversation();
      renderLoginRequired(res.pauseReason, res.resumeStateKey, res.authType);
      return;
    }

    if (res.success || res.goalResult) {
      const card = document.createElement('div');
      card.className = 'enh-action-card';

      const headlineEl = document.createElement('p');
      headlineEl.className = 'enh-action-headline';
      headlineEl.textContent = res.success ? 'Exploration Complete' : 'Partial Results';
      card.appendChild(headlineEl);

      const resultEl = document.createElement('div');
      resultEl.className = 'enh-action-rationale';
      resultEl.style.whiteSpace = 'pre-wrap';
      resultEl.textContent = truncateForDisplay(res.goalResult || 'Exploration finished.');
      card.appendChild(resultEl);

      if (res.stepsUsed) {
        const metaEl = document.createElement('p');
        metaEl.style.cssText = 'font-size: 10px; opacity: 0.5; margin-top: 8px;';
        metaEl.textContent = `${res.stepsUsed} steps \u00B7 ${(res.creditsUsed || 0).toFixed(1)} EU`;
        card.appendChild(metaEl);
      }

      wrapper.appendChild(card);

      conversationMessages.push({
        role: 'assistant',
        content: `[Exploration Result] ${res.goalResult || 'Exploration completed.'}`,
        data: { action_type: 'EXPLORE_RESULT', goalResult: res.goalResult, stepsUsed: res.stepsUsed, creditsUsed: res.creditsUsed },
        timestamp: Date.now(),
      });
      saveConversation();
    } else {
      const errorCard = document.createElement('div');
      errorCard.className = 'enh-action-card';
      errorCard.innerHTML = `<p class="enh-error-message">${res.error || 'Exploration failed. Please try again.'}</p>`;
      wrapper.appendChild(errorCard);

      conversationMessages.push({
        role: 'assistant',
        content: `[Exploration Failed] ${res.error || 'Exploration failed.'}`,
        timestamp: Date.now(),
      });
      saveConversation();
    }

    resultsArea.appendChild(wrapper);
    resultsArea.classList.remove('enh-hidden');
    chatArea.scrollTop = chatArea.scrollHeight;
    promptInput.focus();
  }

  // ── Login Required: Pause exploration and wait for user login ──

  function renderLoginRequired(pauseReason, resumeStateKey, authType) {
    resultsArea.classList.remove('enh-hidden');

    const wrapper = document.createElement('div');
    wrapper.className = 'enh-msg enh-msg-assistant';

    const card = document.createElement('div');
    card.className = 'enh-action-card enh-consent-soft';
    card.style.cssText = 'border-color: rgba(245, 158, 11, 0.25); background: rgba(24, 18, 8, 0.85);';

    // Auth-type-specific UI
    const authUI = {
      login:       { icon: '\uD83D\uDD12', title: 'Login Required',        instruction: 'Sign in on this page. The agent will detect when you\u2019re done and resume automatically.' },
      two_factor:  { icon: '\uD83D\uDD10', title: 'Verification Required',  instruction: 'Complete the two-factor verification. The agent will resume when you\u2019re through.' },
      captcha:     { icon: '\uD83E\uDDE9', title: 'CAPTCHA Required',       instruction: 'Solve the CAPTCHA challenge. The agent will resume once verified.' },
      oauth:       { icon: '\uD83D\uDD11', title: 'Sign-In Required',       instruction: 'Complete the single sign-on process. The agent will resume automatically.' },
    };
    const ui = authUI[authType] || authUI.login;

    // Headline row
    const headlineRow = document.createElement('div');
    headlineRow.style.cssText = 'display: flex; align-items: center; gap: 8px;';

    const icon = document.createElement('span');
    icon.style.cssText = 'font-size: 16px;';
    icon.textContent = ui.icon;
    headlineRow.appendChild(icon);

    const headline = document.createElement('p');
    headline.className = 'enh-action-headline';
    headline.style.cssText = 'margin: 0; color: #fbbf24;';
    headline.textContent = ui.title;
    headlineRow.appendChild(headline);
    card.appendChild(headlineRow);

    const reason = document.createElement('p');
    reason.className = 'enh-action-rationale';
    reason.style.cssText = 'color: rgba(255,255,255,0.65); font-size: 12px;';
    reason.textContent = pauseReason || 'The page I reached requires you to log in before I can continue.';
    card.appendChild(reason);

    const instructions = document.createElement('p');
    instructions.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.4); margin: 0;';
    instructions.textContent = ui.instruction;
    card.appendChild(instructions);

    // Auto-resume indicator
    const autoResumeHint = document.createElement('div');
    autoResumeHint.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-top: 8px; padding: 6px 8px; background: rgba(245, 158, 11, 0.08); border-radius: 6px;';
    const pulseEl = document.createElement('span');
    pulseEl.style.cssText = 'width: 6px; height: 6px; border-radius: 50%; background: #f59e0b; animation: enh-pulse-amber 1.5s ease-in-out infinite;';
    const hintText = document.createElement('span');
    hintText.style.cssText = 'font-size: 10px; color: rgba(245, 158, 11, 0.7);';
    hintText.textContent = 'Watching for login completion\u2026 will auto-resume';
    autoResumeHint.appendChild(pulseEl);
    autoResumeHint.appendChild(hintText);
    card.appendChild(autoResumeHint);

    // Inject pulse animation if not already present
    if (!document.getElementById('enh-amber-pulse-style')) {
      const style = document.createElement('style');
      style.id = 'enh-amber-pulse-style';
      style.textContent = '@keyframes enh-pulse-amber { 0%,100% { opacity:1; } 50% { opacity:0.3; } }';
      document.head.appendChild(style);
    }

    const resumeBtn = document.createElement('button');
    resumeBtn.className = 'enh-btn enh-btn-primary enh-btn-sm';
    resumeBtn.style.cssText = 'margin-top: 8px; background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.3); color: #fbbf24; width: 100%;';
    resumeBtn.textContent = "Or click here to resume manually";

    // Auto-resume detection: the background's watchForLoginCompletion
    // updates explorationProgress when login is detected. Listen for it
    // and switch the UI from "waiting for login" to "running" automatically.
    const autoResumeListener = (changes) => {
      if (!changes.explorationProgress) return;
      const progress = changes.explorationProgress.newValue;
      if (!progress || progress.status === 'login_required') return;

      // Login detected — auto-resume is happening in the background
      chrome.storage.onChanged.removeListener(autoResumeListener);
      hintText.textContent = 'Login detected! Resuming\u2026';
      pulseEl.style.background = '#22c55e';
      resumeBtn.textContent = 'Auto-resuming\u2026';
      resumeBtn.disabled = true;

      // The background watcher handles the full resume loop.
      // Replace the login card with a progress tracker.
      setTimeout(() => {
        wrapper.remove();
        const resumedBadge = document.createElement('div');
        resumedBadge.style.cssText = 'font-size: 10px; color: rgba(99, 102, 241, 0.6); padding: 4px 0; text-align: center;';
        resumedBadge.textContent = '\u2014 Auto-resumed after login \u2014';
        resultsArea.appendChild(resumedBadge);
      }, 1500);
    };
    chrome.storage.onChanged.addListener(autoResumeListener);

    resumeBtn.addEventListener('click', async () => {
      // Manual resume — remove auto-resume listener
      chrome.storage.onChanged.removeListener(autoResumeListener);
      resumeBtn.textContent = 'Resuming...';
      resumeBtn.disabled = true;

      // Remove the login card
      wrapper.remove();

      // Show resumed badge
      const resumedBadge = document.createElement('div');
      resumedBadge.style.cssText = 'font-size: 10px; color: rgba(255,255,255,0.4); padding: 4px 0; text-align: center;';
      resumedBadge.textContent = '\u2014 Resuming exploration \u2014';
      resultsArea.appendChild(resumedBadge);

      // Re-attach progress listener
      if (explorationListener) {
        chrome.storage.onChanged.removeListener(explorationListener);
      }

      let stepLogEl = resultsArea.querySelector('.enh-explore-step-log');
      if (!stepLogEl) {
        stepLogEl = document.createElement('div');
        stepLogEl.className = 'enh-explore-step-log';
        stepLogEl.style.cssText = 'max-height: 200px; overflow-y: auto; padding: 6px 0;';
        resultsArea.appendChild(stepLogEl);
      }

      const resumeStatusEl = document.createElement('span');
      resumeStatusEl.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.5); padding: 4px 0; display: block;';
      resumeStatusEl.textContent = 'Connecting...';
      resultsArea.appendChild(resumeStatusEl);

      explorationListener = (changes) => {
        if (!changes.explorationProgress) return;
        const progress = changes.explorationProgress.newValue;
        if (!progress) return;
        resumeStatusEl.textContent = `Step ${progress.step}/${progress.total}: ${progress.description || ''}`;
        if (progress.step >= 0 && progress.description) {
          const stepEntry = document.createElement('div');
          stepEntry.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px;color:rgba(255,255,255,0.7);';
          const stepIcon = document.createElement('span');
          stepIcon.style.cssText = 'font-size:10px;width:14px;text-align:center;';
          if (progress.status === 'running') stepIcon.textContent = '...';
          else if (progress.status === 'complete') stepIcon.textContent = '\u2713';
          else if (progress.status === 'login_required') stepIcon.textContent = '\uD83D\uDD12';
          else stepIcon.textContent = '\u2022';
          const stepText = document.createElement('span');
          stepText.textContent = progress.description;
          stepEntry.appendChild(stepIcon);
          stepEntry.appendChild(stepText);
          const existing = stepLogEl.querySelector(`[data-step="${progress.step}"]`);
          if (existing) existing.replaceWith(stepEntry);
          else stepLogEl.appendChild(stepEntry);
          stepEntry.setAttribute('data-step', progress.step);
          stepLogEl.scrollTop = stepLogEl.scrollHeight;
        }
      };
      chrome.storage.onChanged.addListener(explorationListener);

      const res = await sendToBackground('explore_resume', { resumeStateKey }, 130000);

      chrome.storage.onChanged.removeListener(explorationListener);
      explorationListener = null;

      // Another login page — recursive pause
      if (res?.paused) {
        renderLoginRequired(res.pauseReason, res.resumeStateKey, res.authType);
        return;
      }

      // Render final result
      resultsArea.innerHTML = '';
      if (res?.success || res?.goalResult) {
        const rWrapper = document.createElement('div');
        rWrapper.className = 'enh-msg enh-msg-assistant';
        const rCard = document.createElement('div');
        rCard.className = 'enh-action-card';
        const h = document.createElement('p');
        h.className = 'enh-action-headline';
        h.textContent = res.success ? 'Exploration Complete' : 'Partial Results';
        rCard.appendChild(h);
        const r = document.createElement('div');
        r.className = 'enh-action-rationale';
        r.style.whiteSpace = 'pre-wrap';
        r.textContent = truncateForDisplay(res.goalResult || 'Exploration finished.');
        rCard.appendChild(r);
        if (res.stepsUsed) {
          const m = document.createElement('p');
          m.style.cssText = 'font-size:10px;opacity:0.5;margin-top:8px;';
          m.textContent = `${res.stepsUsed} steps \u00B7 ${(res.creditsUsed || 0).toFixed(1)} EU`;
          rCard.appendChild(m);
        }
        rWrapper.appendChild(rCard);
        resultsArea.appendChild(rWrapper);

        // Push resumed exploration result to conversation
        const explorationResult = res.goalResult || 'Exploration completed.';
        conversationMessages.push({
          role: 'assistant',
          content: `[Exploration Result] ${explorationResult}`,
          data: { action_type: 'EXPLORE_RESULT', goalResult: explorationResult, stepsUsed: res.stepsUsed, creditsUsed: res.creditsUsed },
          timestamp: Date.now(),
        });
        saveConversation();
      } else {
        const errCard = document.createElement('div');
        errCard.className = 'enh-action-card';
        errCard.innerHTML = `<p class="enh-error-message">${res?.error || 'Exploration failed after resume.'}</p>`;
        resultsArea.appendChild(errCard);

        conversationMessages.push({
          role: 'assistant',
          content: `[Exploration Failed] ${res?.error || 'Exploration failed after resume.'}`,
          timestamp: Date.now(),
        });
        saveConversation();
      }
      resultsArea.classList.remove('enh-hidden');
      chatArea.scrollTop = chatArea.scrollHeight;
      promptInput.focus();
    });

    card.appendChild(resumeBtn);
    wrapper.appendChild(card);
    resultsArea.appendChild(wrapper);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  async function startOrchestration(searchPlan, userPrompt) {
    // Wrap orchestration HUD in an assistant bubble (preserves conversation above)
    const orchWrapper = document.createElement('div');
    orchWrapper.className = 'enh-msg enh-msg-assistant';

    const hud = document.createElement('div');
    hud.className = 'enh-orch-hud';

    const header = document.createElement('div');
    header.className = 'enh-orch-header';

    const badge = document.createElement('span');
    badge.className = 'enh-orch-badge-label';
    badge.textContent = 'Global Search';
    header.appendChild(badge);

    const statusEl = document.createElement('span');
    statusEl.className = 'enh-orch-status';
    statusEl.textContent = 'Launching searches...';
    header.appendChild(statusEl);

    hud.appendChild(header);

    const sitesRow = document.createElement('div');
    sitesRow.className = 'enh-orch-sites-row';

    const siteElements = {};
    for (const site of searchPlan.sites) {
      const siteEl = document.createElement('div');
      siteEl.className = 'enh-orch-site-status pending';
      siteEl.innerHTML = `<span class="enh-orch-site-icon">⏳</span><span>${site}</span>`;
      sitesRow.appendChild(siteEl);
      siteElements[site] = siteEl;
    }

    hud.appendChild(sitesRow);
    orchWrapper.appendChild(hud);
    resultsArea.appendChild(orchWrapper);
    resultsArea.classList.remove('enh-hidden');
    chatArea.scrollTop = chatArea.scrollHeight;

    // Listen for progress
    if (orchestrationListener) {
      chrome.storage.onChanged.removeListener(orchestrationListener);
    }

    orchestrationListener = (changes) => {
      if (!changes.orchestrationProgress) return;
      const progress = changes.orchestrationProgress.newValue;
      if (!progress) return;

      statusEl.textContent = progress.detail || progress.phase;

      if (progress.phase?.startsWith('searching:')) {
        const site = progress.phase.split(':')[1];
        const siteEl = siteElements[site];
        if (siteEl) {
          siteEl.className = 'enh-orch-site-status active';
          siteEl.querySelector('.enh-orch-site-icon').textContent = '🔍';
        }
      }

      if (progress.phase === 'comparing') {
        for (const site of searchPlan.sites) {
          const siteEl = siteElements[site];
          if (siteEl) {
            siteEl.className = 'enh-orch-site-status done';
            siteEl.querySelector('.enh-orch-site-icon').textContent = '✓';
          }
        }
        statusEl.textContent = 'AI is picking the best option...';
      }
    };

    chrome.storage.onChanged.addListener(orchestrationListener);

    // Fire-and-forget — result arrives via chrome.storage.session
    const startRes = await sendToBackground('orchestrate_search', { searchPlan, userPrompt });

    if (!startRes?.success && !startRes?.async) {
      chrome.storage.onChanged.removeListener(orchestrationListener);
      orchestrationListener = null;
      orchWrapper.innerHTML = `<div class="enh-action-card"><p class="enh-error-message">${startRes?.error || 'Failed to start search.'}</p></div>`;
      return;
    }

    // Wait for the final result via chrome.storage.session
    const res = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false, error: 'Search timed out after 60 seconds.' });
      }, 60000);

      const resultListener = (changes, areaName) => {
        if (areaName !== 'session' || !changes.orchestrationResult) return;
        clearTimeout(timeout);
        chrome.storage.onChanged.removeListener(resultListener);
        resolve(changes.orchestrationResult.newValue);
      };
      chrome.storage.onChanged.addListener(resultListener);

      // Race condition guard
      chrome.storage.session.get(['orchestrationResult']).then(data => {
        if (data.orchestrationResult) {
          clearTimeout(timeout);
          chrome.storage.onChanged.removeListener(resultListener);
          chrome.storage.session.remove(['orchestrationResult']).catch(() => {});
          resolve(data.orchestrationResult);
        }
      }).catch(() => {});
    });

    if (orchestrationListener) {
      chrome.storage.onChanged.removeListener(orchestrationListener);
      orchestrationListener = null;
    }

    if (!res?.success) {
      orchWrapper.innerHTML = `<div class="enh-action-card"><p class="enh-error-message">${res?.error || 'Search failed. Please try again.'}</p></div>`;
      conversationMessages.push({
        role: 'assistant',
        content: `[Search Failed] ${res?.error || 'Search failed.'}`,
        timestamp: Date.now(),
      });
      saveConversation();
      return;
    }

    // Replace HUD with comparison results inside the wrapper
    orchWrapper.innerHTML = '';
    renderComparison(orchWrapper, res.data);

    // Push orchestration result to conversation for follow-up context
    conversationMessages.push({
      role: 'assistant',
      content: `[Search Result] ${res.data?.summary || 'Search completed.'}`,
      data: res.data,
      timestamp: Date.now(),
    });
    saveConversation();
    promptInput.focus();
  }

  function renderComparison(container, data) {
    container.innerHTML = '';

    if (!data || !data.winner) {
      container.innerHTML = '<div class="enh-action-card"><p class="enh-no-results">No comparison results returned.</p></div>';
      return;
    }

    if (data.summary) {
      const summary = document.createElement('p');
      summary.className = 'enh-orch-summary';
      summary.textContent = data.summary;
      container.appendChild(summary);
    }

    // Winner card
    const winnerCard = document.createElement('div');
    winnerCard.className = 'enh-orch-winner-card';

    const winnerLabel = document.createElement('span');
    winnerLabel.className = 'enh-orch-winner-label';
    winnerLabel.textContent = '★ Best Pick';
    winnerCard.appendChild(winnerLabel);

    const winnerTitle = document.createElement('p');
    winnerTitle.className = 'enh-orch-winner-title';
    winnerTitle.textContent = data.winner.title;
    winnerCard.appendChild(winnerTitle);

    const winnerMeta = document.createElement('div');
    winnerMeta.className = 'enh-orch-winner-meta';

    const winnerPrice = document.createElement('span');
    winnerPrice.className = 'enh-orch-winner-price';
    winnerPrice.textContent = data.winner.price;
    winnerMeta.appendChild(winnerPrice);

    const winnerSite = document.createElement('span');
    winnerSite.className = 'enh-orch-site-badge';
    winnerSite.textContent = data.winner.site;
    winnerMeta.appendChild(winnerSite);

    if (data.winner.trustBadge) {
      const trustBadge = document.createElement('span');
      trustBadge.className = `enh-trust-badge enh-trust-${data.winner.trustBadge}`;
      trustBadge.textContent = data.winner.trustBadge === 'verified' ? '✓ Verified' :
                               data.winner.trustBadge === 'aggregator' ? '◆ Aggregator' :
                               data.winner.trustBadge === 'caution' ? '⚠ Caution' : '✕ Rejected';
      winnerMeta.appendChild(trustBadge);
    }

    winnerCard.appendChild(winnerMeta);

    if (data.winner.rationale) {
      const rationale = document.createElement('p');
      rationale.className = 'enh-orch-winner-rationale';
      rationale.textContent = data.winner.rationale;
      winnerCard.appendChild(rationale);
    }

    if (data.winner.url) {
      const goBtn = document.createElement('button');
      goBtn.className = 'enh-btn enh-btn-primary enh-orch-go-btn';
      goBtn.textContent = 'Go to Product →';
      goBtn.addEventListener('click', async () => {
        goBtn.textContent = 'Navigating...';
        goBtn.disabled = true;
        const navRes = await sendToBackground('navigate_to_winner', {
          url: data.winner.url,
          tabId: currentTabId,
        });
        if (navRes?.success) {
          goBtn.textContent = '✓ Opened';
        } else {
          chrome.tabs.create({ url: data.winner.url, active: true });
          goBtn.textContent = '✓ Opened in new tab';
        }
      });
      winnerCard.appendChild(goBtn);
    }

    container.appendChild(winnerCard);

    // Alternatives
    if (data.alternatives && data.alternatives.length > 0) {
      const altHeader = document.createElement('p');
      altHeader.className = 'enh-orch-alt-header';
      altHeader.textContent = 'Also worth considering';
      container.appendChild(altHeader);

      for (const alt of data.alternatives) {
        const altCard = document.createElement('div');
        altCard.className = 'enh-orch-alt-card';

        const altInfo = document.createElement('div');
        altInfo.className = 'enh-orch-alt-info';

        const altTitle = document.createElement('span');
        altTitle.className = 'enh-orch-alt-title';
        altTitle.textContent = alt.title;
        altInfo.appendChild(altTitle);

        const altMeta = document.createElement('div');
        altMeta.className = 'enh-orch-alt-meta';
        let altMetaHtml = `<span>${alt.price}</span><span class="enh-orch-site-badge">${alt.site}</span>`;
        if (alt.trustBadge) {
          const badgeLabel = alt.trustBadge === 'verified' ? '✓' :
                             alt.trustBadge === 'aggregator' ? '◆' :
                             alt.trustBadge === 'caution' ? '⚠' : '✕';
          altMetaHtml += `<span class="enh-trust-badge enh-trust-${alt.trustBadge}">${badgeLabel}</span>`;
        }
        altMeta.innerHTML = altMetaHtml;
        altInfo.appendChild(altMeta);

        if (alt.note) {
          const altNote = document.createElement('p');
          altNote.className = 'enh-orch-alt-note';
          altNote.textContent = alt.note;
          altInfo.appendChild(altNote);
        }

        altCard.appendChild(altInfo);

        if (alt.url) {
          const altLink = document.createElement('button');
          altLink.className = 'enh-btn enh-orch-alt-btn';
          altLink.textContent = 'View';
          altLink.addEventListener('click', () => {
            chrome.tabs.create({ url: alt.url, active: true });
          });
          altCard.appendChild(altLink);
        }

        container.appendChild(altCard);
      }
    }

    // Rejected sites
    if (data.rejectedSites && data.rejectedSites.length > 0) {
      const rejHeader = document.createElement('p');
      rejHeader.className = 'enh-orch-alt-header enh-trust-rejected-header';
      rejHeader.textContent = 'Excluded (low trust)';
      container.appendChild(rejHeader);

      for (const rej of data.rejectedSites) {
        const rejEl = document.createElement('div');
        rejEl.className = 'enh-trust-rejected-item';
        rejEl.innerHTML = `<span class="enh-trust-badge enh-trust-rejected">✕</span> ` +
          `<span>${rej.site}</span> — <span class="enh-trust-rejected-reason">${rej.reason}</span>`;
        container.appendChild(rejEl);
      }
    }
  }

  // ── UI Helpers ───────────────────────────────────────────────

  function setLoading(on) {
    loadingBar.classList.toggle('enh-hidden', !on);
    submitBtn.disabled = on;
    if (on) {
      // Double rAF: first frame triggers layout recalc after display:none→flex,
      // second frame scrolls after the new height is committed to the render tree
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          chatArea.scrollTop = chatArea.scrollHeight;
        });
      });
    } else {
      setStage('');
    }
  }

  function setStage(stage) {
    const label = shadow.querySelector('.enh-loading-label');
    if (label) {
      label.textContent = STAGE_LABELS[stage] || 'Thinking with your memory...';
    }
  }

  function clearResults() {
    // replaceChildren() is faster than innerHTML='' for large DOM trees
    resultsArea.replaceChildren();
    resultsArea.classList.add('enh-hidden');
    mainError.textContent = '';
  }

  function showError(msg) {
    const FRIENDLY_HINTS = {
      '[BACKEND_TIMEOUT]': 'The server took too long. Try again in a moment.',
      '[NETWORK_ERROR]': 'Cannot reach the server. Check your internet connection.',
      '[NO_RESPONSE]': 'Extension communication failed. Try reloading the extension.',
      '[HANDLER_CRASH]': 'Something broke internally. Try again or reload the extension.',
      '[SERVER_ERROR]': 'Server error — try again or check if the backend is running.',
      '[BACKEND_DOWN]': 'Backend server is down (5xx). Check if the server is running.',
      '[AUTH_ERROR]': 'Authentication failed. Please sign out and sign back in.',
      '[RATE_LIMITED]': 'Too many requests — wait a moment and try again.',
      '[TOKEN_LIMIT]': 'Request too large — try a shorter prompt or clear conversation.',
      '[PARSE_ERROR]': 'Could not process that request — try rephrasing it.',
      '[INSUFFICIENT_CREDITS]': 'Low Energy — you need more Energy Units to continue. Top up at enhancivity.com/dashboard/upgrade',
    };

    let displayMsg = msg;
    for (const [prefix, hint] of Object.entries(FRIENDLY_HINTS)) {
      if (msg.startsWith(prefix)) {
        displayMsg = hint;
        break;
      }
    }

    // Show as error bubble in chat instead of just bottom text
    const errorBubble = document.createElement('div');
    errorBubble.className = 'enh-msg enh-msg-error';
    errorBubble.textContent = displayMsg;
    resultsArea.appendChild(errorBubble);
    resultsArea.classList.remove('enh-hidden');
    chatArea.scrollTop = chatArea.scrollHeight;

    mainError.textContent = '';
    console.warn('[Enhancivity Panel] Error:', msg);
  }

  // ── State Persistence ────────────────────────────────────────

  async function saveState() {
    try {
      const isHidden = panel.classList.contains('enh-hidden');
      await chrome.storage.session.set({
        enhPanelState: {
          // isOpen: true means "open and visible" — used by onActivated to decide re-injection
          isOpen: !isHidden,
          // isMinimized: true means "— was clicked" — restoreState hides panel but keeps data
          isMinimized: isHidden && conversationMessages.length > 0,
          greetingHidden: greeting?.style.display === 'none',
          position: {
            left: panel.style.left,
            top: panel.style.top,
            right: panel.style.right,
            bottom: panel.style.bottom,
          },
        },
      });
    } catch {
      // session storage may not be available — non-critical
    }
  }

  async function restoreState() {
    try {
      const stored = await chrome.storage.session.get(['enhPanelState', convKey()]);
      const enhPanelState = stored.enhPanelState;
      const enhConversation = stored[convKey()];

      if (enhPanelState) {
        // Restore position
        if (enhPanelState.position) {
          const pos = enhPanelState.position;
          if (pos.left && pos.left !== 'auto') {
            panel.style.left = pos.left;
            panel.style.right = 'auto';
          }
          if (pos.top && pos.top !== 'auto') {
            panel.style.top = pos.top;
            panel.style.bottom = 'auto';
          }
        }
        // Restore minimized state (— button): panel hidden but NOT cleared
        if (enhPanelState.isMinimized) {
          panel.classList.add('enh-hidden');
        }
        // Restore greeting hidden state
        if (enhPanelState.greetingHidden && greeting) {
          greeting.style.display = 'none';
        }
      }
      // Restore this tab's conversation only
      if (enhConversation && enhConversation.length > 0) {
        conversationMessages = enhConversation;
        rebuildChatThread();
      }

      // ── Exploration Recovery ──────────────────────────────────
      // If we were re-injected during an active exploration, re-attach the progress HUD
      const exploreState = await chrome.storage.session.get(['explorationActive', 'explorationResult']);

      if (exploreState.explorationResult && !exploreState.explorationActive) {
        // Exploration finished while panel was being re-injected — show final result
        const res = exploreState.explorationResult;
        showExplorationResult(res);
        await chrome.storage.session.remove('explorationResult');
      } else if (exploreState.explorationActive) {
        // Exploration is still running — show live HUD
        attachExplorationHUD(exploreState.explorationActive);
      }
    } catch {
      // non-critical
    }
  }

  // ── Message Listener (from background.js) ────────────────────

  // Store listener reference on window so SPA re-init can remove it
  window.__enhPanelMessageListener = (message, sender, sendResponse) => {
    if (message.type === 'enh_panel_toggle') {
      togglePanel();
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'enh_panel_ping') {
      // Only report "ok" if the panel DOM is actually in the page
      const hostAlive = !!document.getElementById('enh-panel-host');
      sendResponse({ ok: hostAlive });
      return true;
    }
    if (message.type === 'TASK_COMPLETE') {
      // Could update UI if showing task results
      sendResponse({ ok: true });
      return true;
    }

    // ── Delegate Auto-Fill: background.js sends task payload to pre-fill prompt ──
    if (message.type === 'enh_delegate_autofill') {
      const { taskTitle, taskDescription, priority, dueDate, tags } = message.payload || {};
      if (!taskTitle) { sendResponse({ ok: false }); return true; }

      console.log('[Panel] Auto-filling delegated task:', taskTitle);

      // Show panel if hidden
      if (panel.classList.contains('enh-hidden')) {
        panel.classList.remove('enh-hidden');
      }

      // Build the auto-fill prompt
      const parts = [`Task: ${taskTitle}`];
      if (taskDescription) parts.push(`Description: ${taskDescription}`);
      if (dueDate) {
        try { parts.push(`Due: ${new Date(dueDate).toLocaleDateString()}`); } catch { parts.push(`Due: ${dueDate}`); }
      }
      if (priority) parts.push(`Importance: ${priority}`);
      if (tags && tags.length) parts.push(`Tags: ${Array.isArray(tags) ? tags.join(', ') : tags}`);
      parts.push('Please help me complete this.');

      promptInput.value = parts.join(', ');
      submitBtn.disabled = false;
      submitBtn.classList.add('active');

      // Hide greeting
      if (greeting) greeting.style.display = 'none';

      promptInput.focus();
      saveState();

      sendResponse({ ok: true });
      return true;
    }
  };
  chrome.runtime.onMessage.addListener(window.__enhPanelMessageListener);

  // ── Delegate Auto-Fill via window.postMessage (from dashboard_bridge.js) ──
  // Bridge and panel are both content scripts on the same page, so window.postMessage works.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'ENHANCIVITY_DELEGATE_AUTOFILL') return;
    if (event.data?.source !== 'enhancivity-bridge') return;

    const { taskTitle, taskDescription, priority, dueDate, tags } = event.data.payload || {};
    if (!taskTitle) return;

    console.log('[Panel] Auto-filling delegated task via postMessage:', taskTitle);

    // Show panel if hidden
    if (panel.classList.contains('enh-hidden')) {
      panel.classList.remove('enh-hidden');
    }

    // Build the auto-fill prompt
    const parts = [`Task: ${taskTitle}`];
    if (taskDescription) parts.push(`Description: ${taskDescription}`);
    if (dueDate) {
      try { parts.push(`Due: ${new Date(dueDate).toLocaleDateString()}`); } catch { parts.push(`Due: ${dueDate}`); }
    }
    if (priority) parts.push(`Importance: ${priority}`);
    if (tags && tags.length) parts.push(`Tags: ${Array.isArray(tags) ? tags.join(', ') : tags}`);
    parts.push('Please help me complete this.');

    promptInput.value = parts.join(', ');
    submitBtn.disabled = false;
    submitBtn.classList.add('active');

    if (greeting) greeting.style.display = 'none';
    promptInput.focus();
    saveState();
  });

  // ── Briefing Action via window.postMessage (from dashboard_bridge.js) ──
  // When a user clicks a dynamic action button on a Briefing card, the bridge
  // sends the actionIntent here. We auto-fill AND auto-submit since the intent
  // is AI-generated and ready to execute (no user editing needed).
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'ENHANCIVITY_BRIEFING_ACTION') return;
    if (event.data?.source !== 'enhancivity-bridge') return;

    const { actionIntent, buttonText, briefingId } = event.data.payload || {};
    if (!actionIntent) return;

    console.log('[Panel] Briefing action received:', buttonText, '| Intent:', actionIntent);

    // Show panel if hidden
    if (panel.classList.contains('enh-hidden')) {
      panel.classList.remove('enh-hidden');
    }

    // Set the prompt to the actionIntent
    promptInput.value = actionIntent;
    submitBtn.disabled = false;
    submitBtn.classList.add('active');

    if (greeting) greeting.style.display = 'none';

    // Auto-submit — the actionIntent is an AI-crafted instruction ready for execution
    handleSubmit();
  });

  // ── Inline auth form (panel login / signup / reset) ─────────

  const authForm    = $('#enh-auth-form');
  const authSubmit  = $('#enh-auth-submit');
  const authError   = $('#enh-auth-error');
  const authSuccess = $('#enh-auth-success');
  let authMode = 'signin'; // 'signin' | 'signup' | 'resetpw'

  function setAuthMode(mode) {
    authMode = mode;
    const nameField    = $('#enh-auth-name');
    const pwField      = $('#enh-auth-password');
    const newPwField   = $('#enh-auth-new-password');
    const title        = $('#enh-auth-title');
    const toggleSignup = $('#enh-auth-toggle-signup');
    const toggleForgot = $('#enh-auth-toggle-forgot');
    const linkSep      = $('#enh-auth-link-sep');

    authError?.classList.add('enh-hidden');
    authSuccess?.classList.add('enh-hidden');

    if (mode === 'signin') {
      title.textContent = 'Sign in to Enhancivity';
      nameField.classList.add('enh-hidden');
      pwField.classList.remove('enh-hidden');
      pwField.placeholder = 'Password';
      newPwField.classList.add('enh-hidden');
      authSubmit.textContent = 'Sign In';
      toggleSignup.textContent = 'Create account';
      toggleForgot?.classList.remove('enh-hidden');
      linkSep?.classList.remove('enh-hidden');
    } else if (mode === 'signup') {
      title.textContent = 'Create your account';
      nameField.classList.remove('enh-hidden');
      pwField.classList.remove('enh-hidden');
      pwField.placeholder = 'Password (min 6 characters)';
      newPwField.classList.add('enh-hidden');
      authSubmit.textContent = 'Sign Up';
      toggleSignup.textContent = 'Already have an account? Sign in';
      toggleForgot?.classList.add('enh-hidden');
      linkSep?.classList.add('enh-hidden');
    } else if (mode === 'resetpw') {
      title.textContent = 'Reset your password';
      nameField.classList.add('enh-hidden');
      pwField.classList.add('enh-hidden');
      newPwField.classList.remove('enh-hidden');
      authSubmit.textContent = 'Reset Password';
      toggleSignup.textContent = 'Back to sign in';
      toggleForgot?.classList.add('enh-hidden');
      linkSep?.classList.add('enh-hidden');
    }
    authSubmit.disabled = false;
  }

  $('#enh-auth-toggle-signup')?.addEventListener('click', () => {
    setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
  });
  $('#enh-auth-toggle-forgot')?.addEventListener('click', () => {
    setAuthMode('resetpw');
  });

  if (authForm) {
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#enh-auth-email').value.trim();
      authSubmit.disabled = true;
      authError.classList.add('enh-hidden');
      authSuccess?.classList.add('enh-hidden');

      if (authMode === 'signin') {
        const password = $('#enh-auth-password').value;
        if (!email || !password) { authSubmit.disabled = false; return; }
        authSubmit.textContent = 'Signing in...';

        const res = await sendToBackground('extension_login', { email, password });
        if (res?.success) {
          authFallback.classList.add('enh-hidden');
          chatArea.classList.remove('enh-hidden');
          $('#enh-context-strip')?.classList.remove('enh-hidden');
          $('.enh-input-area')?.classList.remove('enh-hidden');
          await init();
        } else {
          authError.textContent = res?.message || 'Login failed. Check your email and password.';
          authError.classList.remove('enh-hidden');
          authSubmit.textContent = 'Sign In';
          authSubmit.disabled = false;
        }

      } else if (authMode === 'signup') {
        const name = $('#enh-auth-name').value.trim();
        const password = $('#enh-auth-password').value;
        if (!name || !email || !password) { authSubmit.disabled = false; return; }
        if (name.length < 2) {
          authError.textContent = 'Name must be at least 2 characters.';
          authError.classList.remove('enh-hidden');
          authSubmit.disabled = false;
          return;
        }
        if (password.length < 6) {
          authError.textContent = 'Password must be at least 6 characters.';
          authError.classList.remove('enh-hidden');
          authSubmit.disabled = false;
          return;
        }
        authSubmit.textContent = 'Creating account...';

        const res = await sendToBackground('extension_signup', { name, email, password });
        if (res?.success) {
          authFallback.classList.add('enh-hidden');
          chatArea.classList.remove('enh-hidden');
          $('#enh-context-strip')?.classList.remove('enh-hidden');
          $('.enh-input-area')?.classList.remove('enh-hidden');
          await init();
        } else {
          authError.textContent = res?.message || 'Sign up failed.';
          authError.classList.remove('enh-hidden');
          authSubmit.textContent = 'Sign Up';
          authSubmit.disabled = false;
        }

      } else if (authMode === 'resetpw') {
        const newPassword = $('#enh-auth-new-password').value;
        if (!email || !newPassword) { authSubmit.disabled = false; return; }
        if (newPassword.length < 6) {
          authError.textContent = 'Password must be at least 6 characters.';
          authError.classList.remove('enh-hidden');
          authSubmit.disabled = false;
          return;
        }
        authSubmit.textContent = 'Resetting...';

        const res = await sendToBackground('extension_reset_password', { email, newPassword });
        if (res?.success) {
          if (authSuccess) {
            authSuccess.textContent = res.message || 'Password reset. You can now sign in.';
            authSuccess.classList.remove('enh-hidden');
          }
          setTimeout(() => setAuthMode('signin'), 2000);
        } else {
          authError.textContent = res?.message || 'Password reset failed.';
          authError.classList.remove('enh-hidden');
        }
        authSubmit.textContent = 'Reset Password';
        authSubmit.disabled = false;
      }
    });
  }

  // ── Launch ───────────────────────────────────────────────────
  init();

})();
