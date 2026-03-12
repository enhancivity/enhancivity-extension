// ============================================================
// Enhancivity Side Panel — Chrome Side Panel API
// Replaces content_panel.js (injected floating div)
// Runs as a native Chrome side panel — no Shadow DOM, no z-index,
// no CSS conflicts, persists across tab switches automatically.
// ============================================================

'use strict';

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
let currentTabUrl = '';
let currentSite = 'general';
let orchestrationListener = null;
let explorationListener = null;
let conversationMessages = [];
let lastUserPrompt = '';

// ── DOM Refs ─────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);

const authView     = $('#auth-view');
const mainView     = $('#main-view');
const settingsView = $('#settings-view');
const contextBadge = $('#context-badge');
const chatArea     = $('#chat-area');
const greeting     = $('#chat-greeting');
const loadingBar   = $('#loading-bar');
const resultsArea  = $('#results-area');
const mainError    = $('#main-error');
const promptInput  = $('#prompt-input');
const submitBtn    = $('#submit-btn');
const memoryInd    = $('#memory-indicator');
const settingsBtn  = $('#settings-btn');
const byokBadge    = $('#byok-badge');
const signOutBtn   = $('#sign-out-btn');

// ── Truncation helper ────────────────────────────────────────

function truncateForDisplay(text, maxLen = 500) {
  if (!text || text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '... [see full results]';
}

// ── Conversation Helpers ───────────────────────────────────────

function convKey() {
  return currentTabId ? `enhConversation_${currentTabId}` : 'enhConversation_global';
}

async function saveConversation() {
  try {
    let msgs = conversationMessages;
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

  resultsArea.classList.remove('hidden');
  if (greeting) greeting.style.display = 'none';

  for (const msg of conversationMessages) {
    if (msg.role === 'user') {
      const bubble = document.createElement('div');
      bubble.className = 'msg msg-user';
      bubble.textContent = msg.content;
      resultsArea.appendChild(bubble);
    } else {
      const wrapper = document.createElement('div');
      wrapper.className = 'msg msg-assistant';
      if (msg.data) {
        renderResultsInto(wrapper, msg.data);
      } else {
        const p = document.createElement('p');
        p.className = 'text-result';
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

// ── View Management ──────────────────────────────────────────

function showView(viewId) {
  authView.classList.add('hidden');
  mainView.classList.add('hidden');
  settingsView.classList.add('hidden');
  $(viewId).classList.remove('hidden');
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
  } else {
    contextBadge.style.background = '';
    contextBadge.style.color = '';
  }
  promptInput.placeholder = PLACEHOLDERS[site] || PLACEHOLDERS.general;
}

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

// ── Init ─────────────────────────────────────────────────────

async function init() {
  const { token } = await chrome.storage.local.get(['token']);
  if (!token) {
    showView('#auth-view');
    setupAuthHandlers();
    return;
  }

  showView('#main-view');
  await initMainView();
}

async function initMainView() {
  // Get current active tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      currentTabId = tab.id;
      currentTabUrl = tab.url || '';
    }
  } catch { /* fallback */ }

  currentSite = detectSite(currentTabUrl);
  applyContext(currentSite);

  // Memory indicator
  const { userMemory } = await chrome.storage.local.get(['userMemory']);
  if (userMemory) memoryInd.classList.remove('hidden');

  // BYOK badge
  const { userApiKey } = await chrome.storage.local.get(['userApiKey']);
  if (userApiKey) byokBadge.classList.remove('hidden');

  // Restore conversation
  try {
    const stored = await chrome.storage.session.get([convKey()]);
    const enhConversation = stored[convKey()];
    if (enhConversation && enhConversation.length > 0) {
      conversationMessages = enhConversation;
      rebuildChatThread();
    }
  } catch { /* non-critical */ }

  // Check for active exploration
  try {
    const exploreState = await chrome.storage.session.get(['explorationActive', 'explorationResult']);
    if (exploreState.explorationResult && !exploreState.explorationActive) {
      showExplorationResult(exploreState.explorationResult);
      await chrome.storage.session.remove('explorationResult');
    } else if (exploreState.explorationActive) {
      attachExplorationHUD(exploreState.explorationActive);
    }
  } catch { /* non-critical */ }

  promptInput.focus();
}

// ── Tab Change Listener ──────────────────────────────────────
// Side panel persists, so we update context when user switches tabs

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    currentTabId = tab.id;
    currentTabUrl = tab.url || '';
    currentSite = detectSite(currentTabUrl);
    applyContext(currentSite);

    // Switch conversation to new tab's conversation
    try {
      const stored = await chrome.storage.session.get([convKey()]);
      const enhConversation = stored[convKey()];
      if (enhConversation && enhConversation.length > 0) {
        conversationMessages = enhConversation;
        rebuildChatThread();
      } else {
        conversationMessages = [];
        resultsArea.innerHTML = '';
        resultsArea.classList.add('hidden');
        if (greeting) greeting.style.display = '';
      }
    } catch { /* non-critical */ }
  } catch { /* tab may not exist */ }
});

// Also update on tab URL changes (SPA navigation)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === currentTabId && changeInfo.url) {
    currentTabUrl = changeInfo.url;
    currentSite = detectSite(currentTabUrl);
    applyContext(currentSite);
  }
});

// ── Keyboard Handling ─────────────────────────────────────────

promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSubmit();
  }
});

// ── Submit & Process ─────────────────────────────────────────

promptInput.addEventListener('input', () => {
  const hasText = promptInput.value.trim().length > 0;
  submitBtn.disabled = !hasText;
  submitBtn.classList.toggle('active', hasText);
  promptInput.style.height = 'auto';
  promptInput.style.height = promptInput.scrollHeight + 'px';
});

submitBtn.addEventListener('click', () => handleSubmit());

async function handleSubmit() {
  const userPrompt = promptInput.value.trim();
  if (!userPrompt) return;
  lastUserPrompt = userPrompt;

  if (greeting) greeting.style.display = 'none';

  const userBubble = document.createElement('div');
  userBubble.className = 'msg msg-user';
  userBubble.textContent = userPrompt;
  resultsArea.appendChild(userBubble);
  resultsArea.classList.remove('hidden');
  chatArea.scrollTop = chatArea.scrollHeight;

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

  const assistantContent = res.data?.primary_content || res.data?.headline || res.data?.message || 'Response received';
  conversationMessages.push({ role: 'assistant', content: assistantContent, data: res.data, timestamp: Date.now() });
  saveConversation();

  if (res.data?.action_type === 'FETCH_TASKS') {
    await handleFetchTasks(res.data);
    return;
  }

  if (res.data?.action_type === 'ORCHESTRATE' && res.data?.search_plan) {
    renderOrchestratePlan(res.data, res.data.consent_level === 'auto');
    return;
  }

  if (res.data?.action_type === 'EXPLORE' && res.data?.explore_plan) {
    renderExplorePlan(res.data, res.data.consent_level === 'auto');
    return;
  }

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
}

// ── FETCH_TASKS Handler ──────────────────────────────────────

async function handleFetchTasks(data) {
  resultsArea.classList.remove('hidden');
  setStage('STAGE_EXECUTION');
  setLoading(true);

  const period = data.task_period || '';
  const fetchRes = await sendToBackground('fetch_todos', { period });
  setLoading(false);

  const wrapper = document.createElement('div');
  wrapper.className = 'msg msg-assistant';

  if (!fetchRes?.success) {
    const errP = document.createElement('p');
    errP.className = 'error-message';
    errP.textContent = fetchRes?.error || 'Failed to fetch tasks.';
    wrapper.appendChild(errP);
    resultsArea.appendChild(wrapper);
    return;
  }

  const todos = fetchRes.todos || [];
  const periodLabel = period ? ` for ${period.charAt(0).toUpperCase() + period.slice(1)}` : '';

  if (todos.length === 0) {
    const emptyCard = document.createElement('div');
    emptyCard.className = 'action-card';
    emptyCard.innerHTML = `<p class="action-headline">No Tasks Found${periodLabel}</p><p class="action-summary">There are no tasks${periodLabel} in your Enhancivity account.</p>`;
    wrapper.appendChild(emptyCard);
    resultsArea.appendChild(wrapper);
    chatArea.scrollTop = chatArea.scrollHeight;
    return;
  }

  const header = document.createElement('p');
  header.className = 'results-header';
  header.textContent = `${todos.length} task${todos.length !== 1 ? 's' : ''}${periodLabel}`;
  wrapper.appendChild(header);

  const list = document.createElement('div');
  list.className = 'task-list';

  todos.forEach(todo => {
    const row = document.createElement('div');
    row.className = 'task-row';

    const statusDot = document.createElement('span');
    statusDot.style.cssText = `width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:5px;background:${
      todo.status === 'COMPLETED' ? '#34d399' :
      todo.status === 'IN_PROGRESS' ? '#6366f1' : '#fbbf24'
    }`;

    const info = document.createElement('div');
    info.className = 'task-info';

    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = todo.title;

    const meta = document.createElement('span');
    meta.className = 'task-meta';
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

async function handleFindAndReply(data) {
  resultsArea.classList.remove('hidden');

  const wrapper = document.createElement('div');
  wrapper.className = 'msg msg-assistant';

  const card = document.createElement('div');
  card.className = 'action-card consent-soft';

  const headline = document.createElement('p');
  headline.className = 'action-headline';
  headline.textContent = data.headline || 'Finding email & drafting reply...';
  card.appendChild(headline);

  const statusEl = document.createElement('p');
  statusEl.className = 'action-summary';
  statusEl.textContent = 'Searching your inbox...';
  card.appendChild(statusEl);

  wrapper.appendChild(card);
  resultsArea.appendChild(wrapper);
  chatArea.scrollTop = chatArea.scrollHeight;

  let payload = {};
  if (typeof data.primary_content === 'object' && data.primary_content !== null) {
    payload = data.primary_content;
  } else {
    try { payload = JSON.parse(data.primary_content); } catch { payload = { replyBody: data.primary_content }; }
  }

  const { searchQuery, replyBody, subject } = payload;

  if (!searchQuery || !searchQuery.trim()) {
    statusEl.textContent = 'Cannot search: no sender or search query provided. Please specify who to reply to.';
    statusEl.style.color = '#f87171';
    return;
  }

  if (!currentTabUrl.includes('mail.google.com')) {
    statusEl.textContent = 'Opening Gmail...';
    const navRes = await sendToBackground('switch_tab', { targetTabUrl: 'https://mail.google.com' });
    if (!navRes?.success) {
      statusEl.textContent = 'Could not open Gmail. Please navigate there manually.';
      statusEl.style.color = '#f87171';
      return;
    }
    if (navRes.tabId) currentTabId = navRes.tabId;
    currentTabUrl = 'https://mail.google.com/mail/';
    await new Promise(r => setTimeout(r, 2000));
  }

  statusEl.textContent = `Searching for emails from "${searchQuery}"...`;

  const res = await sendToBackground('gmail_find_and_reply', {
    tabId: currentTabId,
    searchQuery: searchQuery || '',
    replyBody: replyBody || '',
    subject: subject || '',
  });

  if (res?.success) {
    card.innerHTML = '';
    const successHeadline = document.createElement('p');
    successHeadline.className = 'action-headline';
    successHeadline.textContent = 'Reply ready — click Send when you\'re done';
    card.appendChild(successHeadline);
    const successNote = document.createElement('p');
    successNote.className = 'action-summary';
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
  card.className = 'action-card';
  card.style.borderColor = 'rgba(239, 68, 68, 0.3)';

  if (data.headline) {
    const headline = document.createElement('p');
    headline.className = 'action-headline';
    headline.textContent = data.headline;
    card.appendChild(headline);
  }

  const msg = document.createElement('p');
  msg.className = 'action-rationale';
  msg.style.color = '#fca5a5';
  msg.textContent = data._billing.message || `This action costs ${data._billing.requiredEU} EU but you have ${data._billing.balance.toFixed(1)} EU.`;
  card.appendChild(msg);

  const btn = document.createElement('button');
  btn.className = 'action-btn btn-primary';
  btn.style.background = 'linear-gradient(135deg, #FDBBF5, #897DF0)';
  btn.textContent = 'Top Up Energy Units';
  btn.onclick = () => { window.open('https://enhancivity.com/dashboard/upgrade', '_blank'); };
  card.appendChild(btn);
  container.appendChild(card);
}

function renderResultsInto(container, data) {
  if (!data) {
    const p = document.createElement('p');
    p.className = 'no-results';
    p.textContent = 'No results returned.';
    container.appendChild(p);
    return;
  }

  if (data._billing?.blocked) {
    renderBillingBlocked(container, data);
    return;
  }

  if (data.action_type === 'TASK_DRAFT') {
    renderTaskDraftPreview(container, data);
    return;
  }

  if (data.action_type === 'EXTRACT_TASKS' && data.primary_content) {
    try {
      const tasks = JSON.parse(data.primary_content);
      if (Array.isArray(tasks) && tasks.length > 0) {
        renderTaskList(container, tasks);
        return;
      }
    } catch { /* fall through */ }
    renderTaskDraftPreview(container, data);
    return;
  }

  if (data.action_type === 'EXPLORE_RESULT') {
    const card = document.createElement('div');
    card.className = 'action-card';
    const headlineEl = document.createElement('p');
    headlineEl.className = 'action-headline';
    headlineEl.textContent = data.goalResult ? 'Exploration Complete' : 'Exploration Failed';
    card.appendChild(headlineEl);
    const resultEl = document.createElement('div');
    resultEl.className = 'action-rationale';
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

  if (data.action_type === 'FIND_AND_REPLY') {
    const findReplyCard = document.createElement('div');
    findReplyCard.className = 'action-card consent-soft';
    const frHeadline = document.createElement('p');
    frHeadline.className = 'action-headline';
    frHeadline.textContent = data.headline || 'Finding email & drafting reply...';
    findReplyCard.appendChild(frHeadline);
    const frStatus = document.createElement('p');
    frStatus.className = 'action-summary';
    frStatus.textContent = 'Searching your inbox...';
    findReplyCard.appendChild(frStatus);
    container.appendChild(findReplyCard);
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
    renderAutoExecute(container, data);
  } else if (data.consent_level && data.consent_level !== 'auto' && data.dom_actions) {
    renderActionPreview(container, data);
  } else if (data.primary_content) {
    renderAgentResponse(container, data);
  } else {
    const msg = document.createElement('p');
    msg.className = 'text-result';
    msg.textContent = data.message || JSON.stringify(data);
    container.appendChild(msg);
  }
}

function renderResults(data) {
  const wrapper = document.createElement('div');
  wrapper.className = 'msg msg-assistant';
  renderResultsInto(wrapper, data);
  resultsArea.appendChild(wrapper);
  resultsArea.classList.remove('hidden');
  chatArea.scrollTop = chatArea.scrollHeight;
}

function renderClarification(data) {
  const clarification = data.clarification;
  const wrapper = document.createElement('div');
  wrapper.className = 'msg msg-assistant';

  const question = document.createElement('p');
  question.style.cssText = 'color: #e2e8f0; font-size: 13px; margin-bottom: 10px;';
  question.textContent = clarification.question;
  wrapper.appendChild(question);

  const optionsContainer = document.createElement('div');
  optionsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 6px;';

  clarification.options.forEach(option => {
    if (option.value === 'custom') {
      const customBtn = document.createElement('button');
      customBtn.style.cssText = 'background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #94a3b8; padding: 8px 12px; cursor: pointer; font-size: 12px; text-align: left; transition: all 0.15s;';
      customBtn.textContent = option.label;
      customBtn.addEventListener('mouseenter', () => { customBtn.style.background = 'rgba(99,102,241,0.15)'; customBtn.style.borderColor = 'rgba(99,102,241,0.3)'; });
      customBtn.addEventListener('mouseleave', () => { customBtn.style.background = 'rgba(255,255,255,0.06)'; customBtn.style.borderColor = 'rgba(255,255,255,0.1)'; });
      customBtn.addEventListener('click', () => {
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
        sendBtn.addEventListener('click', () => { if (inp.value.trim()) submitClarification(inp.value.trim()); });
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inp.value.trim()) submitClarification(inp.value.trim()); });
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
      btn.addEventListener('click', () => { submitClarification(option.value); });
      optionsContainer.appendChild(btn);
    }
  });

  wrapper.appendChild(optionsContainer);
  resultsArea.appendChild(wrapper);
  resultsArea.classList.remove('hidden');
  chatArea.scrollTop = chatArea.scrollHeight;
}

function submitClarification(answer) {
  const userMsg = document.createElement('div');
  userMsg.className = 'msg msg-user';
  userMsg.textContent = answer;
  resultsArea.appendChild(userMsg);
  chatArea.scrollTop = chatArea.scrollHeight;

  const originalPrompt = lastUserPrompt || '';
  const clarifiedPrompt = `${originalPrompt} [User clarification: ${answer}]`;
  promptInput.value = clarifiedPrompt;
  handleSubmit();
}

function renderTaskList(container, tasks) {
  if (!tasks.length) {
    container.innerHTML = '<p class="no-results">No tasks found.</p>';
    return;
  }

  const header = document.createElement('p');
  header.className = 'results-header';
  header.textContent = `${tasks.length} task${tasks.length > 1 ? 's' : ''} found`;
  container.appendChild(header);

  const list = document.createElement('div');
  list.className = 'task-list';

  tasks.forEach((task, i) => {
    const row = document.createElement('label');
    row.className = 'task-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.index = i;
    checkbox.className = 'task-checkbox';

    const info = document.createElement('div');
    info.className = 'task-info';
    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = task.title;
    const meta = document.createElement('span');
    meta.className = 'task-meta';
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
  createBtn.className = 'btn btn-primary create-btn';
  createBtn.textContent = 'Create Selected Tasks';
  createBtn.addEventListener('click', async () => {
    const selected = [...list.querySelectorAll('.task-checkbox:checked')]
      .map(cb => tasks[parseInt(cb.dataset.index)]);
    if (!selected.length) return;
    createBtn.textContent = 'Creating...';
    createBtn.disabled = true;
    const res = await sendToBackground('create_todos_bulk', selected);
    if (res?.success) {
      container.innerHTML = `<p class="success-message">${selected.length} task${selected.length > 1 ? 's' : ''} created in Enhancivity</p>`;
    } else {
      createBtn.textContent = 'Create Selected Tasks';
      createBtn.disabled = false;
      showError('Failed to create tasks. Please try again.');
    }
  });
  container.appendChild(createBtn);
}

function renderTaskDraftPreview(container, data) {
  let taskData;
  try { taskData = JSON.parse(data.primary_content); }
  catch { taskData = { title: data.headline || '', description: data.primary_content || '' }; }

  const card = document.createElement('div');
  card.className = 'action-card consent-soft';
  card.innerHTML = `
    <p class="action-headline">New Task</p>
    <div class="task-draft-form">
      <label class="draft-label">Title</label>
      <input type="text" class="draft-input" id="draft-title" value="" placeholder="Task title" />
      <label class="draft-label">Description</label>
      <textarea class="draft-textarea" id="draft-desc" rows="3" placeholder="Optional description"></textarea>
      <div class="draft-row">
        <div class="draft-field">
          <label class="draft-label">Priority</label>
          <select class="draft-select" id="draft-priority">
            <option value="HIGH">High</option>
            <option value="MEDIUM" selected>Medium</option>
            <option value="LOW">Low</option>
          </select>
        </div>
        <div class="draft-field">
          <label class="draft-label">Due Date</label>
          <input type="date" class="draft-input" id="draft-date" />
        </div>
      </div>
    </div>
  `;

  const titleInput = card.querySelector('#draft-title');
  const descInput = card.querySelector('#draft-desc');
  const prioritySelect = card.querySelector('#draft-priority');
  const dateInput = card.querySelector('#draft-date');

  titleInput.value = taskData.title || '';
  descInput.value = taskData.description || '';
  if (taskData.priority && ['HIGH', 'MEDIUM', 'LOW'].includes(taskData.priority)) {
    prioritySelect.value = taskData.priority;
  }
  if (taskData.dueDate) {
    try {
      const d = new Date(taskData.dueDate);
      if (!isNaN(d.getTime())) dateInput.value = d.toISOString().split('T')[0];
    } catch { /* ignore */ }
  }

  const btnRow = document.createElement('div');
  btnRow.className = 'action-btn-row';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn consent-btn-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => { container.innerHTML = ''; container.classList.add('hidden'); });
  btnRow.appendChild(cancelBtn);

  const createBtn = document.createElement('button');
  createBtn.className = 'btn consent-btn-soft';
  createBtn.textContent = 'Create Task';
  createBtn.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    if (!title) { titleInput.focus(); return; }
    createBtn.textContent = 'Creating...';
    createBtn.disabled = true;
    const todoData = { title, description: descInput.value.trim() || null, priority: prioritySelect.value, dueDate: dateInput.value || null };
    const res = await sendToBackground('create_todo', todoData);
    if (res?.success) {
      container.innerHTML = '<p class="success-message">Task created! View it in your dashboard.</p>';
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
    container.innerHTML = '<p class="no-results">No products found.</p>';
    return;
  }
  const header = document.createElement('p');
  header.className = 'results-header';
  header.textContent = `${products.length} recommendation${products.length > 1 ? 's' : ''}`;
  container.appendChild(header);

  const list = document.createElement('div');
  list.className = 'product-list';
  products.forEach(product => {
    const card = document.createElement('div');
    card.className = 'product-card';
    const name = document.createElement('span');
    name.className = 'product-name';
    name.textContent = product.title;
    const meta = document.createElement('div');
    meta.className = 'product-meta';
    if (product.price) { const p = document.createElement('span'); p.className = 'product-price'; p.textContent = product.price; meta.appendChild(p); }
    if (product.rating) { const r = document.createElement('span'); r.className = 'product-rating'; r.textContent = `\u2605 ${product.rating}`; meta.appendChild(r); }
    card.appendChild(name);
    card.appendChild(meta);
    if (product.url) {
      const link = document.createElement('a');
      link.href = product.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'product-link';
      link.textContent = 'View \u2192';
      card.appendChild(link);
    }
    list.appendChild(card);
  });
  container.appendChild(list);
}

// ── Auto-Execute ─────────────────────────────────────────────

function renderAutoExecute(container, data) {
  const card = document.createElement('div');
  card.className = 'action-card';
  const headline = document.createElement('p');
  headline.className = 'action-headline';
  headline.textContent = data.headline;
  card.appendChild(headline);
  if (data.preview?.summary) {
    const summary = document.createElement('p');
    summary.className = 'action-summary';
    summary.textContent = data.preview.summary;
    card.appendChild(summary);
  }
  const statusEl = document.createElement('p');
  statusEl.className = 'action-rationale';
  statusEl.textContent = 'Working...';
  card.appendChild(statusEl);
  container.appendChild(card);

  executeAutoAction(data).then(async (res) => {
    if (res?.success) {
      if (data.action_type === 'NAVIGATE' || (data.dom_actions?.[0]?.action === 'navigate')) {
        statusEl.textContent = 'Done \u2014 page opened.';
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
      const errorMsg = res?.error || 'Action failed.';
      if (errorMsg === 'BLOCKED_SENSITIVE' || errorMsg === 'BLOCKED_DANGEROUS_CLICK') {
        statusEl.textContent = 'Stopped: this step requires your manual action.';
        statusEl.style.color = '#f59e0b';
      } else if (res?.errorType === 'READ_ONLY_PAGE') {
        statusEl.textContent = 'Read-only page \u2014 showing what I found:';
        statusEl.style.color = '#a5b4fc';
        const contentEl = document.createElement('p');
        contentEl.className = 'action-rationale';
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
      const snippet = pageStateAfter.mainContent.slice(Math.max(0, idx - 20), Math.min(pageStateAfter.mainContent.length, idx + 60)).trim();
      return { type: 'success', snippet };
    }
  }
  for (const phrase of ERROR_INDICATORS) {
    if (content.includes(phrase)) {
      const idx = content.indexOf(phrase);
      const snippet = pageStateAfter.mainContent.slice(Math.max(0, idx - 20), Math.min(pageStateAfter.mainContent.length, idx + 60)).trim();
      return { type: 'error', snippet };
    }
  }
  return null;
}

// ── Agent Response ───────────────────────────────────────────

function renderAgentResponse(container, data) {
  const card = document.createElement('div');
  card.className = 'action-card';
  const headline = document.createElement('p');
  headline.className = 'action-headline';
  headline.textContent = data.headline;
  card.appendChild(headline);

  const content = document.createElement('p');
  content.className = 'action-content';
  let pc = data.primary_content;
  if (typeof pc === 'string' && pc.startsWith('{')) {
    try { pc = JSON.parse(pc); } catch {}
  }
  content.textContent = typeof pc === 'object' && pc !== null
    ? (pc.replyBody || pc.body || pc.text || pc.message || JSON.stringify(pc, null, 2))
    : (pc || '');
  card.appendChild(content);

  if (data.rationale) {
    const rationale = document.createElement('p');
    rationale.className = 'action-rationale';
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
  card.className = `action-card ${isBlocked ? 'consent-blocked' : isHard ? 'consent-hard' : 'consent-soft'}`;

  const headline = document.createElement('p');
  headline.className = 'action-headline';
  headline.textContent = data.headline;
  card.appendChild(headline);

  if (data.preview?.summary) {
    const summary = document.createElement('p');
    summary.className = 'action-summary';
    summary.textContent = data.preview.summary;
    card.appendChild(summary);
  }
  if (data.preview?.details) {
    const details = document.createElement('div');
    details.className = 'action-preview';
    details.textContent = data.preview.details;
    card.appendChild(details);
  }
  if (data.dom_actions && data.dom_actions.length > 0 && !isBlocked) {
    const stepList = document.createElement('ol');
    stepList.className = 'action-steps';
    for (const step of data.dom_actions) {
      const li = document.createElement('li');
      li.textContent = step.description;
      stepList.appendChild(li);
    }
    card.appendChild(stepList);
  }
  if (data.rationale) {
    const rationale = document.createElement('p');
    rationale.className = 'action-rationale';
    rationale.textContent = data.rationale;
    card.appendChild(rationale);
  }

  const btnRow = document.createElement('div');
  btnRow.className = 'action-btn-row';

  if (isBlocked) {
    const understood = document.createElement('button');
    understood.className = 'btn consent-btn-blocked';
    understood.textContent = 'Understood';
    understood.addEventListener('click', () => { container.innerHTML = ''; container.classList.add('hidden'); });
    btnRow.appendChild(understood);
  } else {
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn consent-btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => { container.innerHTML = ''; container.classList.add('hidden'); });
    btnRow.appendChild(cancelBtn);
    const confirmBtn = document.createElement('button');
    confirmBtn.className = `btn ${isHard ? 'consent-btn-hard' : 'consent-btn-soft'}`;
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
    case 'ADD_TO_CART':      return 'Yes, Add to Cart';
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
      const msg = res.switched ? `Switched to: ${res.tabTitle || data.target_tab_url}` : `Opened: ${data.target_tab_url}`;
      container.innerHTML = `<p class="success-message">${msg}</p>`;
      return;
    }
  } else if (data.action_type === 'TASK_DRAFT') {
    let taskData;
    try { taskData = JSON.parse(data.primary_content); }
    catch { taskData = { title: data.headline, description: data.primary_content }; }
    res = await sendToBackground('create_todo', taskData);
    if (res?.success) {
      container.innerHTML = '<p class="success-message">Task created! View it in your dashboard.</p>';
      return;
    }
  } else if (data.action_type === 'EXTRACT_TASKS') {
    const parseRes = await sendToBackground('process_request', {
      userPrompt: 'Extract all actionable tasks from the current page. For each task include title, description, dueDate (YYYY-MM-DD or null), and priority (HIGH/MEDIUM/LOW). Use EXTRACT_TASKS with a JSON array in primary_content.',
      tabId: currentTabId, url: currentTabUrl,
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
        if (step.selector?.includes('body') || step.selector?.includes('editable')) composeData.body = step.value;
      }
    }
    if (!composeData.body && data.primary_content) {
      const pc = data.primary_content;
      composeData.body = typeof pc === 'string' ? pc : (pc.body || pc.replyBody || JSON.stringify(pc));
    }
    res = await sendToBackground('gmail_compose', { tabId: currentTabId, data: composeData });
  } else if (data.dom_actions && data.dom_actions.length > 1) {
    res = await sendToBackground('execute_multi_step', { steps: data.dom_actions, tabId: currentTabId });
  } else if (data.dom_actions && data.dom_actions.length === 1) {
    res = await sendToBackground('execute_action', { action: data.dom_actions[0], tabId: currentTabId });
  } else {
    res = { success: false, error: 'No actions to execute.' };
  }

  if (res?.success) {
    const verification = interpretPageState(res.pageStateAfter);
    let doneText = 'Done! Action completed successfully.';
    let doneStyle = '';
    if (verification?.type === 'success') doneText = `Done \u2014 ${verification.snippet}`;
    else if (verification?.type === 'error') {
      doneText = `Action ran, but page shows: "${verification.snippet}"`;
      doneStyle = ' style="color: #fbbf24;"';
    }
    container.innerHTML = `<p class="success-message"${doneStyle}>${doneText}</p>`;
  } else {
    const errorMsg = res?.error || 'Action failed. Please try again.';
    if (errorMsg === 'BLOCKED_SENSITIVE') {
      container.innerHTML = '<p class="blocked-message">Blocked: This action involves sensitive data. Enhancivity never automates these fields.</p>';
    } else if (errorMsg === 'BLOCKED_DANGEROUS_CLICK') {
      container.innerHTML = '<p class="blocked-message">Blocked: Enhancivity won\'t click Send/Pay/Submit buttons. You\'re always in control.</p>';
    } else {
      btn.textContent = getConfirmLabel(data.action_type);
      btn.disabled = false;
      showError(errorMsg);
    }
  }
}

// ── Orchestration ────────────────────────────────────────────

function renderOrchestratePlan(data, autoStart = true) {
  resultsArea.classList.remove('hidden');
  const wrapper = document.createElement('div');
  wrapper.className = 'msg msg-assistant';
  const card = document.createElement('div');
  card.className = 'action-card consent-soft';

  const headline = document.createElement('p');
  headline.className = 'action-headline';
  headline.textContent = data.headline;
  card.appendChild(headline);

  const plan = data.search_plan;
  const planInfo = document.createElement('div');
  planInfo.className = 'orch-plan-info';

  const siteBadges = document.createElement('div');
  siteBadges.className = 'orch-site-badges';
  for (const site of plan.sites) {
    const badge = document.createElement('span');
    badge.className = 'orch-site-badge';
    badge.textContent = site;
    siteBadges.appendChild(badge);
  }
  planInfo.appendChild(siteBadges);

  const criteria = document.createElement('p');
  criteria.className = 'orch-criteria';
  criteria.textContent = `Comparing by: ${plan.criteria}`;
  planInfo.appendChild(criteria);
  card.appendChild(planInfo);

  if (data.rationale) {
    const rationale = document.createElement('p');
    rationale.className = 'action-rationale';
    rationale.textContent = data.rationale;
    card.appendChild(rationale);
  }

  if (autoStart) {
    const statusEl = document.createElement('p');
    statusEl.className = 'action-rationale';
    statusEl.textContent = 'Launching searches...';
    card.appendChild(statusEl);
    wrapper.appendChild(card);
    resultsArea.appendChild(wrapper);
    setTimeout(() => { startOrchestration(data.search_plan, data.primary_content || ''); }, 800);
  } else {
    const btnRow = document.createElement('div');
    btnRow.className = 'action-btn-row';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn consent-btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => { resultsArea.innerHTML = ''; resultsArea.classList.add('hidden'); });
    btnRow.appendChild(cancelBtn);
    const searchBtn = document.createElement('button');
    searchBtn.className = 'btn consent-btn-soft';
    searchBtn.textContent = 'Search Now';
    searchBtn.addEventListener('click', () => { startOrchestration(data.search_plan, data.primary_content || ''); });
    btnRow.appendChild(searchBtn);
    card.appendChild(btnRow);
    wrapper.appendChild(card);
    resultsArea.appendChild(wrapper);
  }
}

async function startOrchestration(searchPlan, userPrompt) {
  const orchWrapper = document.createElement('div');
  orchWrapper.className = 'msg msg-assistant';
  const hud = document.createElement('div');
  hud.className = 'orch-hud';

  const header = document.createElement('div');
  header.className = 'orch-header';
  const badge = document.createElement('span');
  badge.className = 'orch-badge-label';
  badge.textContent = 'Global Search';
  header.appendChild(badge);
  const statusEl = document.createElement('span');
  statusEl.className = 'orch-status';
  statusEl.textContent = 'Launching searches...';
  header.appendChild(statusEl);
  hud.appendChild(header);

  const sitesRow = document.createElement('div');
  sitesRow.className = 'orch-sites-row';
  const siteElements = {};
  for (const site of searchPlan.sites) {
    const siteEl = document.createElement('div');
    siteEl.className = 'orch-site-status pending';
    siteEl.innerHTML = `<span class="orch-site-icon">\u23F3</span><span>${site}</span>`;
    sitesRow.appendChild(siteEl);
    siteElements[site] = siteEl;
  }
  hud.appendChild(sitesRow);
  orchWrapper.appendChild(hud);
  resultsArea.appendChild(orchWrapper);
  resultsArea.classList.remove('hidden');
  chatArea.scrollTop = chatArea.scrollHeight;

  if (orchestrationListener) chrome.storage.onChanged.removeListener(orchestrationListener);
  orchestrationListener = (changes) => {
    if (!changes.orchestrationProgress) return;
    const progress = changes.orchestrationProgress.newValue;
    if (!progress) return;
    statusEl.textContent = progress.detail || progress.phase;
    if (progress.phase?.startsWith('searching:')) {
      const site = progress.phase.split(':')[1];
      const siteEl = siteElements[site];
      if (siteEl) {
        siteEl.className = 'orch-site-status active';
        siteEl.querySelector('.orch-site-icon').textContent = '\uD83D\uDD0D';
      }
    }
    if (progress.phase === 'comparing') {
      for (const site of searchPlan.sites) {
        const siteEl = siteElements[site];
        if (siteEl) {
          siteEl.className = 'orch-site-status done';
          siteEl.querySelector('.orch-site-icon').textContent = '\u2713';
        }
      }
      statusEl.textContent = 'AI is picking the best option...';
    }
  };
  chrome.storage.onChanged.addListener(orchestrationListener);

  const startRes = await sendToBackground('orchestrate_search', { searchPlan, userPrompt });
  if (!startRes?.success && !startRes?.async) {
    chrome.storage.onChanged.removeListener(orchestrationListener);
    orchestrationListener = null;
    orchWrapper.innerHTML = `<div class="action-card"><p class="error-message">${startRes?.error || 'Failed to start search.'}</p></div>`;
    return;
  }

  const res = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ success: false, error: 'Search timed out after 60 seconds.' }), 60000);
    const resultListener = (changes, areaName) => {
      if (areaName !== 'session' || !changes.orchestrationResult) return;
      clearTimeout(timeout);
      chrome.storage.onChanged.removeListener(resultListener);
      resolve(changes.orchestrationResult.newValue);
    };
    chrome.storage.onChanged.addListener(resultListener);
    chrome.storage.session.get(['orchestrationResult']).then(data => {
      if (data.orchestrationResult) {
        clearTimeout(timeout);
        chrome.storage.onChanged.removeListener(resultListener);
        chrome.storage.session.remove(['orchestrationResult']).catch(() => {});
        resolve(data.orchestrationResult);
      }
    }).catch(() => {});
  });

  if (orchestrationListener) { chrome.storage.onChanged.removeListener(orchestrationListener); orchestrationListener = null; }

  if (!res?.success) {
    orchWrapper.innerHTML = `<div class="action-card"><p class="error-message">${res?.error || 'Search failed. Please try again.'}</p></div>`;
    conversationMessages.push({ role: 'assistant', content: `[Search Failed] ${res?.error || 'Search failed.'}`, timestamp: Date.now() });
    saveConversation();
    return;
  }

  orchWrapper.innerHTML = '';
  renderComparison(orchWrapper, res.data);
  conversationMessages.push({ role: 'assistant', content: `[Search Result] ${res.data?.summary || 'Search completed.'}`, data: res.data, timestamp: Date.now() });
  saveConversation();
  promptInput.focus();
}

function renderComparison(container, data) {
  container.innerHTML = '';
  if (!data || !data.winner) {
    container.innerHTML = '<div class="action-card"><p class="no-results">No comparison results returned.</p></div>';
    return;
  }
  if (data.summary) {
    const summary = document.createElement('p');
    summary.className = 'orch-summary';
    summary.textContent = data.summary;
    container.appendChild(summary);
  }

  const winnerCard = document.createElement('div');
  winnerCard.className = 'orch-winner-card';
  const winnerLabel = document.createElement('span');
  winnerLabel.className = 'orch-winner-label';
  winnerLabel.textContent = '\u2605 Best Pick';
  winnerCard.appendChild(winnerLabel);
  const winnerTitle = document.createElement('p');
  winnerTitle.className = 'orch-winner-title';
  winnerTitle.textContent = data.winner.title;
  winnerCard.appendChild(winnerTitle);

  const winnerMeta = document.createElement('div');
  winnerMeta.className = 'orch-winner-meta';
  const winnerPrice = document.createElement('span');
  winnerPrice.className = 'orch-winner-price';
  winnerPrice.textContent = data.winner.price;
  winnerMeta.appendChild(winnerPrice);
  const winnerSite = document.createElement('span');
  winnerSite.className = 'orch-site-badge';
  winnerSite.textContent = data.winner.site;
  winnerMeta.appendChild(winnerSite);
  if (data.winner.trustBadge) {
    const trustBadge = document.createElement('span');
    trustBadge.className = `trust-badge trust-${data.winner.trustBadge}`;
    trustBadge.textContent = data.winner.trustBadge === 'verified' ? '\u2713 Verified' :
                             data.winner.trustBadge === 'aggregator' ? '\u25C6 Aggregator' :
                             data.winner.trustBadge === 'caution' ? '\u26A0 Caution' : '\u2715 Rejected';
    winnerMeta.appendChild(trustBadge);
  }
  winnerCard.appendChild(winnerMeta);
  if (data.winner.rationale) {
    const rationale = document.createElement('p');
    rationale.className = 'orch-winner-rationale';
    rationale.textContent = data.winner.rationale;
    winnerCard.appendChild(rationale);
  }
  if (data.winner.url) {
    const goBtn = document.createElement('button');
    goBtn.className = 'btn btn-primary orch-go-btn';
    goBtn.textContent = 'Go to Product \u2192';
    goBtn.addEventListener('click', async () => {
      goBtn.textContent = 'Navigating...';
      goBtn.disabled = true;
      const navRes = await sendToBackground('navigate_to_winner', { url: data.winner.url, tabId: currentTabId });
      if (navRes?.success) { goBtn.textContent = '\u2713 Opened'; }
      else { chrome.tabs.create({ url: data.winner.url, active: true }); goBtn.textContent = '\u2713 Opened in new tab'; }
    });
    winnerCard.appendChild(goBtn);
  }
  container.appendChild(winnerCard);

  if (data.alternatives && data.alternatives.length > 0) {
    const altHeader = document.createElement('p');
    altHeader.className = 'orch-alt-header';
    altHeader.textContent = 'Also worth considering';
    container.appendChild(altHeader);
    for (const alt of data.alternatives) {
      const altCard = document.createElement('div');
      altCard.className = 'orch-alt-card';
      const altInfo = document.createElement('div');
      altInfo.className = 'orch-alt-info';
      const altTitle = document.createElement('span');
      altTitle.className = 'orch-alt-title';
      altTitle.textContent = alt.title;
      altInfo.appendChild(altTitle);
      const altMeta = document.createElement('div');
      altMeta.className = 'orch-alt-meta';
      let altMetaHtml = `<span>${alt.price}</span><span class="orch-site-badge">${alt.site}</span>`;
      if (alt.trustBadge) {
        const badgeLabel = alt.trustBadge === 'verified' ? '\u2713' : alt.trustBadge === 'aggregator' ? '\u25C6' : alt.trustBadge === 'caution' ? '\u26A0' : '\u2715';
        altMetaHtml += `<span class="trust-badge trust-${alt.trustBadge}">${badgeLabel}</span>`;
      }
      altMeta.innerHTML = altMetaHtml;
      altInfo.appendChild(altMeta);
      if (alt.note) { const altNote = document.createElement('p'); altNote.className = 'orch-alt-note'; altNote.textContent = alt.note; altInfo.appendChild(altNote); }
      altCard.appendChild(altInfo);
      if (alt.url) {
        const altLink = document.createElement('button');
        altLink.className = 'btn orch-alt-btn';
        altLink.textContent = 'View';
        altLink.addEventListener('click', () => { chrome.tabs.create({ url: alt.url, active: true }); });
        altCard.appendChild(altLink);
      }
      container.appendChild(altCard);
    }
  }

  if (data.rejectedSites && data.rejectedSites.length > 0) {
    const rejHeader = document.createElement('p');
    rejHeader.className = 'orch-alt-header trust-rejected-header';
    rejHeader.textContent = 'Excluded (low trust)';
    container.appendChild(rejHeader);
    for (const rej of data.rejectedSites) {
      const rejEl = document.createElement('div');
      rejEl.className = 'trust-rejected-item';
      rejEl.innerHTML = `<span class="trust-badge trust-rejected">\u2715</span> <span>${rej.site}</span> \u2014 <span class="trust-rejected-reason">${rej.reason}</span>`;
      container.appendChild(rejEl);
    }
  }
}

// ── EXPLORE ──────────────────────────────────────────────────

function renderExplorePlan(data, autoStart = true) {
  resultsArea.classList.remove('hidden');
  const wrapper = document.createElement('div');
  wrapper.className = 'msg msg-assistant';
  const card = document.createElement('div');
  card.className = 'action-card consent-soft';

  const headline = document.createElement('p');
  headline.className = 'action-headline';
  headline.textContent = data.headline || 'Exploring...';
  card.appendChild(headline);

  const plan = data.explore_plan;
  const planInfo = document.createElement('div');
  planInfo.className = 'orch-plan-info';

  const goalEl = document.createElement('p');
  goalEl.className = 'orch-criteria';
  goalEl.textContent = plan.goal;
  goalEl.style.fontWeight = '500';
  planInfo.appendChild(goalEl);

  const strategyEl = document.createElement('p');
  strategyEl.className = 'orch-criteria';
  strategyEl.style.opacity = '0.7';
  strategyEl.style.fontSize = '11px';
  strategyEl.textContent = `Strategy: ${plan.strategy}`;
  planInfo.appendChild(strategyEl);

  const budgetBadges = document.createElement('div');
  budgetBadges.className = 'orch-site-badges';
  const stepBadge = document.createElement('span');
  stepBadge.className = 'orch-site-badge';
  stepBadge.textContent = `${plan.maxSteps} steps`;
  budgetBadges.appendChild(stepBadge);
  const creditBadge = document.createElement('span');
  creditBadge.className = 'orch-site-badge';
  creditBadge.textContent = `~${plan.creditBudget} EU`;
  budgetBadges.appendChild(creditBadge);
  planInfo.appendChild(budgetBadges);
  card.appendChild(planInfo);

  if (data.rationale) {
    const rationale = document.createElement('p');
    rationale.className = 'action-rationale';
    rationale.textContent = data.rationale;
    card.appendChild(rationale);
  }

  if (autoStart) {
    const statusEl = document.createElement('p');
    statusEl.className = 'action-rationale';
    statusEl.textContent = 'Starting exploration...';
    card.appendChild(statusEl);
    wrapper.appendChild(card);
    resultsArea.appendChild(wrapper);
    setTimeout(() => { startExploration(plan); }, 800);
  } else {
    const btnRow = document.createElement('div');
    btnRow.className = 'action-btn-row';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn consent-btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => { resultsArea.innerHTML = ''; resultsArea.classList.add('hidden'); });
    btnRow.appendChild(cancelBtn);
    const exploreBtn = document.createElement('button');
    exploreBtn.className = 'btn consent-btn-soft';
    exploreBtn.textContent = 'Explore Now';
    exploreBtn.addEventListener('click', () => { startExploration(plan); });
    btnRow.appendChild(exploreBtn);
    card.appendChild(btnRow);
    wrapper.appendChild(card);
    resultsArea.appendChild(wrapper);
  }
}

async function startExploration(explorePlan) {
  const exploreWrapper = document.createElement('div');
  exploreWrapper.className = 'msg msg-assistant';
  const hud = document.createElement('div');
  hud.className = 'orch-hud';

  const header = document.createElement('div');
  header.className = 'orch-header';
  const badge = document.createElement('span');
  badge.className = 'orch-badge-label';
  badge.textContent = 'Exploring';
  header.appendChild(badge);
  const statusEl = document.createElement('span');
  statusEl.className = 'orch-status';
  statusEl.textContent = 'Starting...';
  header.appendChild(statusEl);
  hud.appendChild(header);

  const stepLog = document.createElement('div');
  stepLog.className = 'explore-step-log';
  stepLog.style.cssText = 'max-height: 200px; overflow-y: auto; padding: 6px 0;';
  hud.appendChild(stepLog);

  exploreWrapper.appendChild(hud);
  resultsArea.appendChild(exploreWrapper);
  resultsArea.classList.remove('hidden');
  chatArea.scrollTop = chatArea.scrollHeight;

  if (explorationListener) chrome.storage.onChanged.removeListener(explorationListener);

  explorationListener = (changes) => {
    if (!changes.explorationProgress) return;
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
      if (existing) existing.replaceWith(stepEntry);
      else stepLog.appendChild(stepEntry);
      stepEntry.setAttribute('data-step', progress.step);
      stepLog.scrollTop = stepLog.scrollHeight;
    }
  };
  chrome.storage.onChanged.addListener(explorationListener);

  let tabId;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id || null;
  } catch { tabId = null; }

  // Get the user's original prompt for auto-continuation context anchoring
  const lastUserMsg = conversationMessages.filter(m => m.role === 'user').pop();
  const userPrompt = lastUserMsg?.content || explorePlan.goal;

  const startRes = await sendToBackground('explore_start', { explorePlan, tabId, userPrompt }, 10000);

  if (!startRes?.success && !startRes?.async) {
    chrome.storage.onChanged.removeListener(explorationListener);
    explorationListener = null;
    exploreWrapper.innerHTML = `<div class="action-card"><p class="error-message">${startRes?.error || 'Failed to start exploration.'}</p></div>`;
    resultsArea.classList.remove('hidden');
    chatArea.scrollTop = chatArea.scrollHeight;
    promptInput.focus();
    return;
  }

  const res = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ success: false, error: 'Exploration timed out after 10 minutes.' }), 600000);
    const resultListener = (changes, areaName) => {
      if (areaName !== 'session' || !changes.explorationResult) return;
      clearTimeout(timeout);
      chrome.storage.onChanged.removeListener(resultListener);
      resolve(changes.explorationResult.newValue);
    };
    chrome.storage.onChanged.addListener(resultListener);
    chrome.storage.session.get(['explorationResult']).then(data => {
      if (data.explorationResult) {
        clearTimeout(timeout);
        chrome.storage.onChanged.removeListener(resultListener);
        chrome.storage.session.remove(['explorationResult']).catch(() => {});
        resolve(data.explorationResult);
      }
    }).catch(() => {});
  });

  if (explorationListener) { chrome.storage.onChanged.removeListener(explorationListener); explorationListener = null; }

  if (res?.paused) {
    conversationMessages.push({ role: 'assistant', content: `[Exploration Paused] ${res.pauseReason || 'Login required to continue.'}`, timestamp: Date.now() });
    saveConversation();
    renderLoginRequired(res.pauseReason, res.resumeStateKey, res.authType);
    return;
  }

  exploreWrapper.innerHTML = '';
  if (res?.success || res?.goalResult) {
    const card = document.createElement('div');
    card.className = 'action-card';
    const headlineEl = document.createElement('p');
    headlineEl.className = 'action-headline';
    headlineEl.textContent = res.success ? 'Exploration Complete' : 'Partial Results';
    card.appendChild(headlineEl);
    const resultEl = document.createElement('div');
    resultEl.className = 'action-rationale';
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
    conversationMessages.push({
      role: 'assistant',
      content: `[Exploration Result] ${res.goalResult || 'Exploration completed.'}`,
      data: { action_type: 'EXPLORE_RESULT', goalResult: res.goalResult, stepsUsed: res.stepsUsed, creditsUsed: res.creditsUsed },
      timestamp: Date.now(),
    });
    saveConversation();
  } else {
    const errorCard = document.createElement('div');
    errorCard.className = 'action-card';
    errorCard.innerHTML = `<p class="error-message">${res?.error || 'Exploration failed. Please try again.'}</p>`;
    exploreWrapper.appendChild(errorCard);
    conversationMessages.push({ role: 'assistant', content: `[Exploration Failed] ${res?.error || 'Exploration failed.'}`, timestamp: Date.now() });
    saveConversation();
  }

  resultsArea.classList.remove('hidden');
  chatArea.scrollTop = chatArea.scrollHeight;
  promptInput.focus();
}

// ── Exploration Recovery HUD ─────────────────────────────────

function attachExplorationHUD(activeState) {
  const exploreWrapper = document.createElement('div');
  exploreWrapper.className = 'msg msg-assistant';
  exploreWrapper.id = 'explore-recovery-wrapper';

  const hud = document.createElement('div');
  hud.className = 'orch-hud';
  const header = document.createElement('div');
  header.className = 'orch-header';
  const badge = document.createElement('span');
  badge.className = 'orch-badge-label';
  badge.textContent = 'Exploring';
  header.appendChild(badge);
  const statusEl = document.createElement('span');
  statusEl.className = 'orch-status';
  statusEl.textContent = activeState.goal ? `Goal: ${activeState.goal}` : 'In progress...';
  header.appendChild(statusEl);
  hud.appendChild(header);

  const stepLog = document.createElement('div');
  stepLog.className = 'explore-step-log';
  stepLog.style.cssText = 'max-height: 200px; overflow-y: auto; padding: 6px 0;';
  hud.appendChild(stepLog);

  exploreWrapper.appendChild(hud);
  resultsArea.appendChild(exploreWrapper);
  resultsArea.classList.remove('hidden');
  if (greeting) greeting.style.display = 'none';
  chatArea.scrollTop = chatArea.scrollHeight;

  if (explorationListener) chrome.storage.onChanged.removeListener(explorationListener);

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
        if (existing) existing.replaceWith(stepEntry);
        else stepLog.appendChild(stepEntry);
        stepEntry.setAttribute('data-step', progress.step);
        stepLog.scrollTop = stepLog.scrollHeight;
      }
    }
    if (changes.explorationActive && !changes.explorationActive.newValue) {
      chrome.storage.session.get(['explorationResult']).then((data) => {
        if (data.explorationResult) {
          showExplorationResult(data.explorationResult);
          chrome.storage.session.remove('explorationResult').catch(() => {});
        }
        if (explorationListener) { chrome.storage.onChanged.removeListener(explorationListener); explorationListener = null; }
      });
    }
  };
  chrome.storage.onChanged.addListener(explorationListener);
}

function showExplorationResult(res) {
  const recoveryWrapper = document.getElementById('explore-recovery-wrapper');
  if (recoveryWrapper) recoveryWrapper.remove();

  const wrapper = document.createElement('div');
  wrapper.className = 'msg msg-assistant';

  if (res.paused) {
    conversationMessages.push({ role: 'assistant', content: `[Exploration Paused] ${res.pauseReason || 'Login required to continue.'}`, timestamp: Date.now() });
    saveConversation();
    renderLoginRequired(res.pauseReason, res.resumeStateKey, res.authType);
    return;
  }

  if (res.success || res.goalResult) {
    const card = document.createElement('div');
    card.className = 'action-card';
    const headlineEl = document.createElement('p');
    headlineEl.className = 'action-headline';
    headlineEl.textContent = res.success ? 'Exploration Complete' : 'Partial Results';
    card.appendChild(headlineEl);
    const resultEl = document.createElement('div');
    resultEl.className = 'action-rationale';
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
    errorCard.className = 'action-card';
    errorCard.innerHTML = `<p class="error-message">${res.error || 'Exploration failed. Please try again.'}</p>`;
    wrapper.appendChild(errorCard);
    conversationMessages.push({ role: 'assistant', content: `[Exploration Failed] ${res.error || 'Exploration failed.'}`, timestamp: Date.now() });
    saveConversation();
  }

  resultsArea.appendChild(wrapper);
  resultsArea.classList.remove('hidden');
  chatArea.scrollTop = chatArea.scrollHeight;
  promptInput.focus();
}

// ── Login Required ───────────────────────────────────────────

function renderLoginRequired(pauseReason, resumeStateKey, authType) {
  resultsArea.classList.remove('hidden');
  const wrapper = document.createElement('div');
  wrapper.className = 'msg msg-assistant';

  const card = document.createElement('div');
  card.className = 'action-card consent-soft';
  card.style.cssText = 'border-color: rgba(245, 158, 11, 0.25); background: rgba(24, 18, 8, 0.85);';

  const authUI = {
    login:       { icon: '\uD83D\uDD12', title: 'Login Required',        instruction: 'Sign in on this page. The agent will detect when you\u2019re done and resume automatically.' },
    two_factor:  { icon: '\uD83D\uDD10', title: 'Verification Required',  instruction: 'Complete the two-factor verification. The agent will resume when you\u2019re through.' },
    captcha:     { icon: '\uD83E\uDDE9', title: 'CAPTCHA Required',       instruction: 'Solve the CAPTCHA challenge. The agent will resume once verified.' },
    oauth:       { icon: '\uD83D\uDD11', title: 'Sign-In Required',       instruction: 'Complete the single sign-on process. The agent will resume automatically.' },
  };
  const ui = authUI[authType] || authUI.login;

  const headlineRow = document.createElement('div');
  headlineRow.style.cssText = 'display: flex; align-items: center; gap: 8px;';
  const iconEl = document.createElement('span');
  iconEl.style.cssText = 'font-size: 16px;';
  iconEl.textContent = ui.icon;
  headlineRow.appendChild(iconEl);
  const headlineEl = document.createElement('p');
  headlineEl.className = 'action-headline';
  headlineEl.style.cssText = 'margin: 0; color: #fbbf24;';
  headlineEl.textContent = ui.title;
  headlineRow.appendChild(headlineEl);
  card.appendChild(headlineRow);

  const reason = document.createElement('p');
  reason.className = 'action-rationale';
  reason.style.cssText = 'color: rgba(255,255,255,0.65); font-size: 12px;';
  reason.textContent = pauseReason || 'The page I reached requires you to log in before I can continue.';
  card.appendChild(reason);

  const instructions = document.createElement('p');
  instructions.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.4); margin: 0;';
  instructions.textContent = ui.instruction;
  card.appendChild(instructions);

  const autoResumeHint = document.createElement('div');
  autoResumeHint.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-top: 8px; padding: 6px 8px; background: rgba(245, 158, 11, 0.08); border-radius: 6px;';
  const pulseEl = document.createElement('span');
  pulseEl.style.cssText = 'width: 6px; height: 6px; border-radius: 50%; background: #f59e0b; animation: pulse-amber 1.5s ease-in-out infinite;';
  const hintText = document.createElement('span');
  hintText.style.cssText = 'font-size: 10px; color: rgba(245, 158, 11, 0.7);';
  hintText.textContent = 'Watching for login completion\u2026 will auto-resume';
  autoResumeHint.appendChild(pulseEl);
  autoResumeHint.appendChild(hintText);
  card.appendChild(autoResumeHint);

  // Inject pulse animation
  if (!document.getElementById('amber-pulse-style')) {
    const style = document.createElement('style');
    style.id = 'amber-pulse-style';
    style.textContent = '@keyframes pulse-amber { 0%,100% { opacity:1; } 50% { opacity:0.3; } }';
    document.head.appendChild(style);
  }

  const resumeBtn = document.createElement('button');
  resumeBtn.className = 'btn btn-primary btn-sm';
  resumeBtn.style.cssText = 'margin-top: 8px; background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.3); color: #fbbf24; width: 100%;';
  resumeBtn.textContent = 'Or click here to resume manually';

  const autoResumeListener = (changes) => {
    if (!changes.explorationProgress) return;
    const progress = changes.explorationProgress.newValue;
    if (!progress || progress.status === 'login_required') return;
    chrome.storage.onChanged.removeListener(autoResumeListener);
    hintText.textContent = 'Login detected! Resuming\u2026';
    pulseEl.style.background = '#22c55e';
    resumeBtn.textContent = 'Auto-resuming\u2026';
    resumeBtn.disabled = true;
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
    chrome.storage.onChanged.removeListener(autoResumeListener);
    resumeBtn.textContent = 'Resuming...';
    resumeBtn.disabled = true;
    wrapper.remove();

    const resumedBadge = document.createElement('div');
    resumedBadge.style.cssText = 'font-size: 10px; color: rgba(255,255,255,0.4); padding: 4px 0; text-align: center;';
    resumedBadge.textContent = '\u2014 Resuming exploration \u2014';
    resultsArea.appendChild(resumedBadge);

    const res = await sendToBackground('explore_resume', { resumeStateKey }, 130000);

    if (res?.paused) {
      renderLoginRequired(res.pauseReason, res.resumeStateKey, res.authType);
      return;
    }

    if (res?.success || res?.goalResult) {
      const rWrapper = document.createElement('div');
      rWrapper.className = 'msg msg-assistant';
      const rCard = document.createElement('div');
      rCard.className = 'action-card';
      const h = document.createElement('p');
      h.className = 'action-headline';
      h.textContent = res.success ? 'Exploration Complete' : 'Partial Results';
      rCard.appendChild(h);
      const r = document.createElement('div');
      r.className = 'action-rationale';
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
      conversationMessages.push({
        role: 'assistant',
        content: `[Exploration Result] ${res.goalResult || 'Exploration completed.'}`,
        data: { action_type: 'EXPLORE_RESULT', goalResult: res.goalResult, stepsUsed: res.stepsUsed, creditsUsed: res.creditsUsed },
        timestamp: Date.now(),
      });
      saveConversation();
    } else {
      const errCard = document.createElement('div');
      errCard.className = 'action-card';
      errCard.innerHTML = `<p class="error-message">${res?.error || 'Exploration failed after resume.'}</p>`;
      resultsArea.appendChild(errCard);
      conversationMessages.push({ role: 'assistant', content: `[Exploration Failed] ${res?.error || 'Exploration failed after resume.'}`, timestamp: Date.now() });
      saveConversation();
    }
    resultsArea.classList.remove('hidden');
    chatArea.scrollTop = chatArea.scrollHeight;
    promptInput.focus();
  });

  card.appendChild(resumeBtn);
  wrapper.appendChild(card);
  resultsArea.appendChild(wrapper);
  chatArea.scrollTop = chatArea.scrollHeight;
}

// ── UI Helpers ───────────────────────────────────────────────

function setLoading(on) {
  loadingBar.classList.toggle('hidden', !on);
  submitBtn.disabled = on;
  if (on) {
    requestAnimationFrame(() => { requestAnimationFrame(() => { chatArea.scrollTop = chatArea.scrollHeight; }); });
  } else {
    setStage('');
  }
}

function setStage(stage) {
  const label = document.querySelector('.loading-label');
  if (label) label.textContent = STAGE_LABELS[stage] || 'Thinking with your memory...';
}

function clearResults() {
  resultsArea.replaceChildren();
  resultsArea.classList.add('hidden');
  mainError.textContent = '';
}

function showError(msg) {
  const FRIENDLY_HINTS = {
    '[BACKEND_TIMEOUT]': 'The server took too long. Try again in a moment.',
    '[NETWORK_ERROR]': 'Cannot reach the server. Check your internet connection.',
    '[NO_RESPONSE]': 'Extension communication failed. Try reloading the extension.',
    '[HANDLER_CRASH]': 'Something broke internally. Try again or reload the extension.',
    '[SERVER_ERROR]': 'Server error \u2014 try again or check if the backend is running.',
    '[BACKEND_DOWN]': 'Backend server is down (5xx). Check if the server is running.',
    '[AUTH_ERROR]': 'Authentication failed. Please sign out and sign back in.',
    '[RATE_LIMITED]': 'Too many requests \u2014 wait a moment and try again.',
    '[TOKEN_LIMIT]': 'Request too large \u2014 try a shorter prompt or clear conversation.',
    '[PARSE_ERROR]': 'Could not process that request \u2014 try rephrasing it.',
    '[INSUFFICIENT_CREDITS]': 'Low Energy \u2014 you need more Energy Units to continue. Top up at enhancivity.com/dashboard/upgrade',
  };

  let displayMsg = msg;
  for (const [prefix, hint] of Object.entries(FRIENDLY_HINTS)) {
    if (msg.startsWith(prefix)) { displayMsg = hint; break; }
  }

  const errorBubble = document.createElement('div');
  errorBubble.className = 'msg msg-error';
  errorBubble.textContent = displayMsg;
  resultsArea.appendChild(errorBubble);
  resultsArea.classList.remove('hidden');
  chatArea.scrollTop = chatArea.scrollHeight;
  mainError.textContent = '';
  console.warn('[Enhancivity Side Panel] Error:', msg);
}

// ── Auth Handlers ────────────────────────────────────────────

let authMode = 'signin';

function setupAuthHandlers() {
  const authForm    = $('#auth-form');
  const authSubmit  = $('#auth-submit');
  const authError   = $('#auth-error');
  const authSuccess = $('#auth-success');

  function setAuthMode(mode) {
    authMode = mode;
    const nameField    = $('#auth-name');
    const pwField      = $('#auth-password');
    const newPwField   = $('#auth-new-password');
    const toggleSignup = $('#auth-toggle-signup');
    const toggleForgot = $('#auth-toggle-forgot');
    const linkSep      = $('#auth-link-sep');

    authError.textContent = '';
    authError.classList.remove('hidden');
    authSuccess?.classList.add('hidden');

    if (mode === 'signin') {
      nameField.classList.add('hidden');
      pwField.classList.remove('hidden');
      pwField.placeholder = 'Password';
      newPwField.classList.add('hidden');
      authSubmit.textContent = 'Sign In';
      toggleSignup.textContent = 'Create account';
      toggleForgot?.classList.remove('hidden');
      linkSep?.classList.remove('hidden');
    } else if (mode === 'signup') {
      nameField.classList.remove('hidden');
      pwField.classList.remove('hidden');
      pwField.placeholder = 'Password (min 6 characters)';
      newPwField.classList.add('hidden');
      authSubmit.textContent = 'Sign Up';
      toggleSignup.textContent = 'Already have an account? Sign in';
      toggleForgot?.classList.add('hidden');
      linkSep?.classList.add('hidden');
    } else if (mode === 'resetpw') {
      nameField.classList.add('hidden');
      pwField.classList.add('hidden');
      newPwField.classList.remove('hidden');
      authSubmit.textContent = 'Reset Password';
      toggleSignup.textContent = 'Back to sign in';
      toggleForgot?.classList.add('hidden');
      linkSep?.classList.add('hidden');
    }
    authSubmit.disabled = false;
  }

  $('#auth-toggle-signup')?.addEventListener('click', () => {
    setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
  });
  $('#auth-toggle-forgot')?.addEventListener('click', () => {
    setAuthMode('resetpw');
  });

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#auth-email').value.trim();
    authSubmit.disabled = true;
    authError.textContent = '';

    if (authMode === 'signin') {
      const password = $('#auth-password').value;
      if (!email || !password) { authSubmit.disabled = false; return; }
      authSubmit.textContent = 'Signing in...';
      const res = await sendToBackground('extension_login', { email, password });
      if (res?.success) {
        showView('#main-view');
        await initMainView();
      } else {
        authError.textContent = res?.message || 'Login failed. Check your email and password.';
        authSubmit.textContent = 'Sign In';
        authSubmit.disabled = false;
      }
    } else if (authMode === 'signup') {
      const name = $('#auth-name').value.trim();
      const password = $('#auth-password').value;
      if (!name || !email || !password) { authSubmit.disabled = false; return; }
      if (name.length < 2) { authError.textContent = 'Name must be at least 2 characters.'; authSubmit.disabled = false; return; }
      if (password.length < 6) { authError.textContent = 'Password must be at least 6 characters.'; authSubmit.disabled = false; return; }
      authSubmit.textContent = 'Creating account...';
      const res = await sendToBackground('extension_signup', { name, email, password });
      if (res?.success) {
        showView('#main-view');
        await initMainView();
      } else {
        authError.textContent = res?.message || 'Sign up failed.';
        authSubmit.textContent = 'Sign Up';
        authSubmit.disabled = false;
      }
    } else if (authMode === 'resetpw') {
      const newPassword = $('#auth-new-password').value;
      if (!email || !newPassword) { authSubmit.disabled = false; return; }
      if (newPassword.length < 6) { authError.textContent = 'Password must be at least 6 characters.'; authSubmit.disabled = false; return; }
      authSubmit.textContent = 'Resetting...';
      const res = await sendToBackground('extension_reset_password', { email, newPassword });
      if (res?.success) {
        if (authSuccess) { authSuccess.textContent = res.message || 'Password reset. You can now sign in.'; authSuccess.classList.remove('hidden'); }
        setTimeout(() => setAuthMode('signin'), 2000);
      } else {
        authError.textContent = res?.message || 'Password reset failed.';
      }
      authSubmit.textContent = 'Reset Password';
      authSubmit.disabled = false;
    }
  });
}

// ── Settings / Header Buttons ────────────────────────────────

const apiModeBtns        = document.querySelectorAll('.api-mode-btn');
const enhancivityPanel   = $('#enhancivity-mode-info');
const byokPanel          = $('#byok-mode-panel');
const byokProviderSelect = $('#byok-provider-select');
const apiKeyInput        = $('#api-key-input');
const apiKeyStatus       = $('#api-key-status');
const saveApiKeyBtn      = $('#save-api-key-btn');
const clearApiKeyBtn     = $('#clear-api-key-btn');
const intentBtns         = document.querySelectorAll('.intent-btn');
const intentModelLabel   = $('#intent-model-label');

// Model labels per intent + provider
const MODEL_LABELS = {
  openai:    { fast: 'gpt-4o-mini', balanced: 'gpt-4o', reasoning: 'o1' },
  anthropic: { fast: 'claude-haiku', balanced: 'claude-sonnet', reasoning: 'claude-opus' },
  default:   { fast: 'Fast model', balanced: 'Balanced model', reasoning: 'Max reasoning model' },
};

function maskKey(key) {
  if (!key) return '';
  const show = Math.min(key.length, 5);
  return key.slice(0, show) + '••••••••';
}

function showKeyStatus(msg, type = 'info') {
  if (!apiKeyStatus) return;
  apiKeyStatus.textContent = msg;
  apiKeyStatus.className = 'api-key-status';
  apiKeyStatus.style.color = type === 'success' ? '#4ade80' : type === 'error' ? '#ef4444' : '#8888a0';
  apiKeyStatus.classList.remove('hidden');
}

function hideKeyStatus() {
  if (apiKeyStatus) apiKeyStatus.classList.add('hidden');
}

function updateIntentLabel(intent, provider) {
  if (!intentModelLabel) return;
  const labels = MODEL_LABELS[provider] || MODEL_LABELS.default;
  intentModelLabel.textContent = labels[intent] || '';
}

function setApiMode(mode) {
  apiModeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  if (enhancivityPanel) enhancivityPanel.classList.toggle('hidden', mode !== 'enhancivity');
  if (byokPanel) byokPanel.classList.toggle('hidden', mode !== 'byok');
  chrome.storage.local.set({ apiMode: mode });
}

// Load saved settings when settings view opens
async function loadSettingsState() {
  const data = await chrome.storage.local.get([
    'userApiKey', 'userApiKeyProvider', 'userIntent', 'apiMode'
  ]);

  const savedProvider = data.userApiKeyProvider || '';
  const savedKey      = data.userApiKey || '';
  const savedIntent   = data.userIntent || 'balanced';

  // API mode toggle (default to 'enhancivity' if no BYOK key, or 'byok' if key exists)
  const savedMode = data.apiMode || (savedKey ? 'byok' : 'enhancivity');
  setApiMode(savedMode);

  // Provider dropdown
  if (byokProviderSelect) {
    byokProviderSelect.value = savedProvider || '';
  }

  // API key field
  if (apiKeyInput) {
    if (savedKey) {
      apiKeyInput.value = maskKey(savedKey);
      apiKeyInput.disabled = false;
      apiKeyInput.placeholder = 'Enter new key to replace...';
      apiKeyInput.dataset.hasKey = 'true';
    } else if (savedProvider) {
      apiKeyInput.value = '';
      apiKeyInput.disabled = false;
      apiKeyInput.placeholder = `Paste your ${savedProvider === 'openai' ? 'OpenAI' : 'Anthropic'} API key...`;
      apiKeyInput.dataset.hasKey = 'false';
    } else {
      apiKeyInput.value = '';
      apiKeyInput.disabled = true;
      apiKeyInput.placeholder = 'Select a provider first...';
      apiKeyInput.dataset.hasKey = 'false';
    }
  }

  // Save/Clear button states
  if (saveApiKeyBtn) saveApiKeyBtn.disabled = !savedProvider;
  if (clearApiKeyBtn) clearApiKeyBtn.disabled = !savedKey;

  // Status line
  if (savedKey && savedProvider) {
    showKeyStatus(`${savedProvider === 'openai' ? 'OpenAI' : 'Anthropic'} key connected: ${maskKey(savedKey)}`, 'success');
  } else {
    hideKeyStatus();
  }

  // Intent buttons
  intentBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.intent === savedIntent);
  });
  updateIntentLabel(savedIntent, savedProvider || 'default');
}

// When user focuses the masked key field, clear it so they can type a new key
apiKeyInput?.addEventListener('focus', () => {
  if (apiKeyInput.dataset.hasKey === 'true') {
    apiKeyInput.value = '';
    apiKeyInput.type = 'password';
  }
});

// When user blurs without typing, restore the masked display
apiKeyInput?.addEventListener('blur', async () => {
  if (apiKeyInput.value === '' && apiKeyInput.dataset.hasKey === 'true') {
    const { userApiKey } = await chrome.storage.local.get(['userApiKey']);
    if (userApiKey) apiKeyInput.value = maskKey(userApiKey);
  }
});

// Provider change
byokProviderSelect?.addEventListener('change', () => {
  const provider = byokProviderSelect.value;
  if (apiKeyInput) {
    apiKeyInput.disabled = false;
    apiKeyInput.placeholder = `Paste your ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key...`;
    // If there was a saved key from a different provider, clear it visually
    apiKeyInput.value = '';
    apiKeyInput.dataset.hasKey = 'false';
  }
  if (saveApiKeyBtn) saveApiKeyBtn.disabled = false;
  hideKeyStatus();

  // Update intent label for new provider
  const activeIntent = document.querySelector('.intent-btn.active')?.dataset.intent || 'balanced';
  updateIntentLabel(activeIntent, provider);
});

// Save key
saveApiKeyBtn?.addEventListener('click', async () => {
  const provider = byokProviderSelect?.value;
  const key = apiKeyInput?.value?.trim();

  if (!provider) {
    showKeyStatus('Select a provider first.', 'error');
    return;
  }
  if (!key || key.includes('••')) {
    showKeyStatus('Enter a valid API key.', 'error');
    return;
  }

  // Basic validation
  if (provider === 'openai' && !key.startsWith('sk-')) {
    showKeyStatus('OpenAI keys start with sk-', 'error');
    return;
  }

  await chrome.storage.local.set({
    userApiKey: key,
    userApiKeyProvider: provider,
  });

  apiKeyInput.value = maskKey(key);
  apiKeyInput.dataset.hasKey = 'true';
  apiKeyInput.placeholder = 'Enter new key to replace...';
  if (clearApiKeyBtn) clearApiKeyBtn.disabled = false;
  if (byokBadge) byokBadge.classList.remove('hidden');

  showKeyStatus(`${provider === 'openai' ? 'OpenAI' : 'Anthropic'} key saved: ${maskKey(key)}`, 'success');
});

// Clear key
clearApiKeyBtn?.addEventListener('click', async () => {
  await chrome.storage.local.remove(['userApiKey', 'userApiKeyProvider']);

  if (apiKeyInput) {
    apiKeyInput.value = '';
    apiKeyInput.dataset.hasKey = 'false';
    const provider = byokProviderSelect?.value;
    if (provider) {
      apiKeyInput.placeholder = `Paste your ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key...`;
    } else {
      apiKeyInput.disabled = true;
      apiKeyInput.placeholder = 'Select a provider first...';
    }
  }
  if (clearApiKeyBtn) clearApiKeyBtn.disabled = true;
  if (byokBadge) byokBadge.classList.add('hidden');

  showKeyStatus('API key cleared.', 'info');
  setTimeout(() => {
    hideKeyStatus();
    setApiMode('enhancivity');
  }, 1500);
});

// API mode toggle (Enhancivity / BYOK)
apiModeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    setApiMode(btn.dataset.mode);
  });
});

// Intent buttons
intentBtns.forEach(btn => {
  btn.addEventListener('click', async () => {
    const intent = btn.dataset.intent;
    intentBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    await chrome.storage.local.set({ userIntent: intent });
    const provider = byokProviderSelect?.value || 'default';
    updateIntentLabel(intent, provider);
  });
});

// Open settings → load saved state
settingsBtn?.addEventListener('click', () => {
  showView('#settings-view');
  loadSettingsState();
});
$('#settings-back-btn')?.addEventListener('click', () => showView('#main-view'));

signOutBtn?.addEventListener('click', async () => {
  await chrome.storage.local.clear();
  conversationMessages = [];
  showView('#auth-view');
  setupAuthHandlers();
});

// ── Message Listener (from background.js) ────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'enh_delegate_autofill') {
    const { taskTitle, taskDescription, priority, dueDate, tags } = message.payload || {};
    if (!taskTitle) { sendResponse({ ok: false }); return true; }

    showView('#main-view');
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

    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'ENHANCIVITY_BRIEFING_ACTION') {
    const { actionIntent } = message.payload || {};
    if (!actionIntent) { sendResponse({ ok: false }); return true; }
    showView('#main-view');
    promptInput.value = actionIntent;
    submitBtn.disabled = false;
    submitBtn.classList.add('active');
    if (greeting) greeting.style.display = 'none';
    handleSubmit();
    sendResponse({ ok: true });
    return true;
  }
});

// ── Launch ───────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
