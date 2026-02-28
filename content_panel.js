// ============================================================
// Enhancivity Floating Panel — Content Script Overlay
// Injected by background.js on icon click
// Replaces popup for persistent, draggable interaction
// ============================================================

(() => {
  'use strict';

  // Double-injection guard
  if (window.__enhPanelLoaded) {
    // Already loaded — toggle visibility
    window.__enhPanelToggle?.();
    return;
  }
  window.__enhPanelLoaded = true;

  // ── Constants ────────────────────────────────────────────────

  const PIPELINE_TIMEOUT_MS = 20000;

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
  let conversationMessages = []; // { role: 'user'|'assistant', content: string, data?: object, timestamp: number }

  // ── Conversation Helpers ───────────────────────────────────────

  async function saveConversation() {
    try {
      let msgs = conversationMessages;
      // Trim to stay under 5MB
      while (JSON.stringify(msgs).length > 5_000_000 && msgs.length > 2) {
        msgs = msgs.slice(2);
      }
      conversationMessages = msgs;
      await chrome.storage.session.set({ enhConversation: msgs });
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
      </div>
      <div class="enh-header-right">
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

      <!-- Loading -->
      <div class="enh-loading-bar enh-hidden" id="enh-loading-bar">
        <div class="enh-loading-glow"></div>
        <div class="enh-loading-content">
          <div class="enh-loading-spinner"></div>
          <span class="enh-loading-label">Thinking with your memory...</span>
        </div>
      </div>

      <!-- Results -->
      <div class="enh-results-area enh-hidden" id="enh-results-area"></div>

      <!-- Error -->
      <p class="enh-error-message" id="enh-main-error"></p>
    </div>

    <!-- Input Area -->
    <div class="enh-input-area">
      <div class="enh-input-pill">
        <input
          type="text"
          class="enh-prompt-field"
          id="enh-prompt-input"
          placeholder="Command Enhancivity..."
          autocomplete="off"
        >
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
      <p class="enh-auth-fallback-text">Please log in to Enhancivity first.</p>
      <button class="enh-auth-fallback-link" id="enh-auth-link">Open Extension Settings</button>
    </div>
  `;

  shadow.appendChild(panel);
  document.body.appendChild(host);

  // ── DOM Refs (inside shadow) ─────────────────────────────────

  const $ = (sel) => shadow.querySelector(sel);
  const dragHeader   = $('#enh-drag-header');
  const closeBtn     = $('#enh-close-btn');
  const minimizeBtn  = $('#enh-minimize-btn');
  const contextBadge = $('#enh-context-badge');
  const chatArea     = $('#enh-chat-area');
  const greeting     = $('#enh-chat-greeting');
  const loadingBar   = $('#enh-loading-bar');
  const resultsArea  = $('#enh-results-area');
  const mainError    = $('#enh-main-error');
  const promptInput  = $('#enh-prompt-input');
  const submitBtn    = $('#enh-submit-btn');
  const memoryInd    = $('#enh-memory-indicator');
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

    // Restore state if available
    await restoreState();

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

  document.addEventListener('mousemove', (e) => {
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
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    saveState();
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
    panel.classList.add('enh-hidden');
    // Clear conversation context
    clearResults();
    if (greeting) greeting.style.display = '';
    mainError.textContent = '';
    promptInput.value = '';
    submitBtn.disabled = true;
    submitBtn.classList.remove('active');
    // Clear conversation history
    conversationMessages = [];
    saveConversation();
    saveState();
  }

  // Expose toggle for re-injection calls
  window.__enhPanelToggle = togglePanel;

  closeBtn.addEventListener('click', closePanel);
  minimizeBtn.addEventListener('click', togglePanel);

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
    // Handle Enter for submit
    if (e.key === 'Enter') {
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
  });

  submitBtn.addEventListener('click', () => handleSubmit());

  async function handleSubmit() {
    const userPrompt = promptInput.value.trim();
    if (!userPrompt) return;

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

    // ORCHESTRATE
    if (res.data?.action_type === 'ORCHESTRATE' && res.data?.search_plan) {
      renderOrchestratePlan(res.data);
      return;
    }

    // FETCH_TASKS
    if (res.data?.action_type === 'FETCH_TASKS') {
      await handleFetchTasks(res.data);
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

  // ── Results Rendering ────────────────────────────────────────

  function renderResultsInto(container, data) {
    if (!data) {
      const p = document.createElement('p');
      p.className = 'enh-no-results';
      p.textContent = 'No results returned.';
      container.appendChild(p);
      return;
    }

    if (data.type === 'tasks') {
      renderTaskList(container, data.items || []);
    } else if (data.type === 'products') {
      renderProductList(container, data.items || []);
    } else if (data.consent_level && data.consent_level !== 'auto' && data.dom_actions) {
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
    content.textContent = data.primary_content;
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

    } else if (data.action_type === 'EXTRACT_TASKS') {
      const goalText = data.headline || data.primary_content || 'Extract tasks from this page';
      res = await sendToBackground('semantic_scrape', {
        tabId: currentTabId,
        url: currentTabUrl,
        userGoal: goalText,
        mode: 'fill_form',
      });
      const parseRes = await sendToBackground('process_request', {
        userPrompt: `Extract actionable tasks from this page. Focus on: ${goalText}`,
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
        composeData.body = data.primary_content;
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
      container.innerHTML = '<p class="enh-success-message">Done! Action completed successfully.</p>';
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

  function renderOrchestratePlan(data) {
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

  async function startOrchestration(searchPlan, userPrompt) {
    resultsArea.innerHTML = '';

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
    resultsArea.appendChild(hud);

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

    const res = await sendToBackground('orchestrate_search', { searchPlan, userPrompt });

    chrome.storage.onChanged.removeListener(orchestrationListener);
    orchestrationListener = null;

    if (!res?.success) {
      resultsArea.innerHTML = `<div class="enh-action-card"><p class="enh-error-message">${res?.error || 'Search failed. Please try again.'}</p></div>`;
      return;
    }

    renderComparison(resultsArea, res.data);
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
    if (!on) setStage('');
  }

  function setStage(stage) {
    const label = shadow.querySelector('.enh-loading-label');
    if (label) {
      label.textContent = STAGE_LABELS[stage] || 'Thinking with your memory...';
    }
  }

  function clearResults() {
    resultsArea.innerHTML = '';
    resultsArea.classList.add('enh-hidden');
    mainError.textContent = '';
  }

  function showError(msg) {
    const FRIENDLY_HINTS = {
      '[BACKEND_TIMEOUT]': 'The server took too long. Try again in a moment.',
      '[NETWORK_ERROR]': 'Cannot reach the server. Check your internet connection.',
      '[NO_RESPONSE]': 'Extension communication failed. Try reloading the extension.',
      '[HANDLER_CRASH]': 'Something broke internally. Try again or reload the extension.',
      '[SERVER_ERROR]': 'The server returned an error. Try again.',
      '[PARSE_ERROR]': 'Got an invalid response from the server.',
    };

    let displayMsg = msg;
    for (const [prefix, hint] of Object.entries(FRIENDLY_HINTS)) {
      if (msg.startsWith(prefix)) {
        displayMsg = hint;
        break;
      }
    }

    mainError.textContent = displayMsg;
    console.warn('[Enhancivity Panel] Error:', msg);
  }

  // ── State Persistence ────────────────────────────────────────

  async function saveState() {
    try {
      await chrome.storage.session.set({
        enhPanelState: {
          isOpen: !panel.classList.contains('enh-hidden'),
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
      const { enhPanelState, enhConversation } = await chrome.storage.session.get(['enhPanelState', 'enhConversation']);
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
        // Restore visibility
        if (enhPanelState.isOpen === false) {
          panel.classList.add('enh-hidden');
        }
        // Restore greeting hidden state
        if (enhPanelState.greetingHidden && greeting) {
          greeting.style.display = 'none';
        }
      }
      // Restore conversation
      if (enhConversation && enhConversation.length > 0) {
        conversationMessages = enhConversation;
        rebuildChatThread();
      }
    } catch {
      // non-critical
    }
  }

  // ── Message Listener (from background.js) ────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'enh_panel_toggle') {
      togglePanel();
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'enh_panel_ping') {
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'TASK_COMPLETE') {
      // Could update UI if showing task results
      sendResponse({ ok: true });
      return true;
    }
  });

  // ── Auth fallback link ───────────────────────────────────────

  const authLink = $('#enh-auth-link');
  if (authLink) {
    authLink.addEventListener('click', () => {
      // Open the popup.html in a new tab as fallback for auth
      chrome.runtime.sendMessage({ type: 'open_popup_tab' });
    });
  }

  // ── Launch ───────────────────────────────────────────────────
  init();

})();
