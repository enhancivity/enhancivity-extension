// ============================================================
// Enhancivity Popup Script — Chief of Staff Edition
// ============================================================

const PLACEHOLDERS = {
  gmail:   "Analyze this email...",
  amazon:  "Evaluate this product...",
  global:  "Search across the web...",
  general: "Command Enhancivity..."
};

const BADGE_CONFIG = {
  gmail:   { label: 'Gmail',   color: '#ef4444' },
  amazon:  { label: 'Amazon',  color: '#f59e0b' },
  global:  { label: 'Global',  color: '#6366f1' },
  general: { label: 'General', color: '' }         // default styling
};

let currentTabId   = null;
let currentTabUrl  = '';
let currentSite    = 'general';

// ── Init ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const { token } = await chrome.storage.local.get(['token']);
  if (token) {
    await initMainView();
  } else {
    showView('auth-view');
    setupAuthHandlers();
  }
});

// ── Auth Handlers ────────────────────────────────────────────

function setupAuthHandlers() {
  const loginForm = document.getElementById('login-form');
  const loginBtn  = document.getElementById('login-btn');
  const googleBtn = document.getElementById('google-login-btn');
  const errorEl   = document.getElementById('auth-error');

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email    = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    if (!email || !password) { errorEl.textContent = 'Please fill in all fields.'; return; }

    loginBtn.textContent = 'Logging in...';
    loginBtn.disabled = true;
    errorEl.textContent = '';

    const res = await sendToBackground('extension_login', { email, password });
    loginBtn.textContent = 'Log In';
    loginBtn.disabled = false;

    if (res?.success) {
      await initMainView();
    } else {
      errorEl.textContent = res?.message || 'Login failed.';
    }
  });

  googleBtn.addEventListener('click', async () => {
    errorEl.textContent = '';
    googleBtn.disabled = true;
    const res = await sendToBackground('google_login');
    googleBtn.disabled = false;
    if (res?.success) {
      await initMainView();
    } else {
      errorEl.textContent = res?.message || 'Google sign-in failed.';
    }
  });
}

// ── Main View ────────────────────────────────────────────────

async function initMainView() {
  showView('main-view');

  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    currentTabId  = tab.id;
    currentTabUrl = tab.url || '';
    currentSite   = detectSite(currentTabUrl);
  }

  applyContext(currentSite);

  // Show memory indicator if memory is cached
  const { userMemory } = await chrome.storage.local.get(['userMemory']);
  if (userMemory) {
    document.getElementById('memory-indicator').classList.remove('hidden');
  }

  // Sign out
  document.getElementById('sign-out-btn').addEventListener('click', async () => {
    await chrome.storage.local.clear();
    showView('auth-view');
    setupAuthHandlers();
  });

  // Input & send button interaction
  const submitBtn   = document.getElementById('submit-btn');
  const promptInput = document.getElementById('prompt-input');

  // Highlight send button when text is entered
  promptInput.addEventListener('input', () => {
    const hasText = promptInput.value.trim().length > 0;
    submitBtn.disabled = !hasText;
    submitBtn.classList.toggle('active', hasText);
  });

  submitBtn.addEventListener('click', () => handleSubmit());
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  });

  // Focus input on open
  promptInput.focus();
}

function detectSite(url) {
  if (!url) return 'global';
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url === 'about:blank') return 'global';
  if (url.includes('mail.google.com')) return 'gmail';
  if (/amazon\.(com|co\.uk|de|fr|ca|com\.au)/.test(url)) return 'amazon';
  return 'general';
}

function applyContext(site) {
  const badge  = document.getElementById('context-badge');
  const input  = document.getElementById('prompt-input');
  const config = BADGE_CONFIG[site] || BADGE_CONFIG.general;

  badge.textContent = config.label;
  if (config.color) {
    badge.style.background = config.color;
    badge.style.color = '#fff';
  }
  input.placeholder = PLACEHOLDERS[site] || PLACEHOLDERS.general;
}

// ── Submit & Process ─────────────────────────────────────────

async function handleSubmit() {
  const promptInput = document.getElementById('prompt-input');
  const userPrompt  = promptInput.value.trim();
  if (!userPrompt) return;

  // Hide greeting on first submit
  const greeting = document.getElementById('chat-greeting');
  if (greeting) greeting.style.display = 'none';

  setLoading(true);
  clearResults();

  // ── STAGE 1: Tab Triage ──────────────────────────────────
  setStage('STAGE_TRIAGE');
  let availableTabs = [];
  try {
    const triageRes = await sendToBackground('GET_TAB_TRIAGE_MAP', {}, 5000);
    if (triageRes?.success) availableTabs = triageRes.tabs;
    // Non-critical: proceed without tabs if triage fails
  } catch { /* proceed without tab context */ }

  // ── STAGE 2: Backend AI Call ─────────────────────────────
  setStage('STAGE_BACKEND');
  const res = await sendToBackground('process_request', {
    userPrompt,
    tabId: currentTabId,
    url:   currentTabUrl,
    availableTabs,
  });

  // ── STAGE 3: Parse & Validate ────────────────────────────
  setStage('STAGE_PARSING');
  setLoading(false);

  if (!res?.success) {
    const errLabel = res?.errorType ? `[${res.errorType}] ` : '';
    showError(errLabel + (res?.error || 'Something went wrong. Please try again.'));
    return;
  }

  promptInput.value = '';
  // Reset send button state
  document.getElementById('submit-btn').disabled = true;
  document.getElementById('submit-btn').classList.remove('active');

  // FETCH_TASKS: pull from API and render inline
  if (res.data?.action_type === 'FETCH_TASKS') {
    await handleFetchTasks(res.data);
    return;
  }

  // ORCHESTRATE: auto-start if consent_level is 'auto' (agentic law)
  if (res.data?.action_type === 'ORCHESTRATE' && res.data?.search_plan) {
    renderOrchestratePlan(res.data, res.data.consent_level === 'auto');
    return;
  }

  // EXPLORE: multi-step agentic exploration loop
  if (res.data?.action_type === 'EXPLORE' && res.data?.explore_plan) {
    renderExplorePlan(res.data, res.data.consent_level === 'auto');
    return;
  }

  renderResults(res.data);
}

// ── FETCH_TASKS Handler ──────────────────────────────────────

async function handleFetchTasks(data) {
  const area = document.getElementById('results-area');
  area.innerHTML = '';
  area.classList.remove('hidden');

  setStage('STAGE_EXECUTION');
  setLoading(true);

  const period = data.task_period || '';
  const fetchRes = await sendToBackground('fetch_todos', { period });

  setLoading(false);

  if (!fetchRes?.success) {
    area.innerHTML = `<p class="error-message">${fetchRes?.error || 'Failed to fetch tasks.'}</p>`;
    return;
  }

  const todos = fetchRes.todos || [];
  const periodLabel = period ? ` for ${period.charAt(0).toUpperCase() + period.slice(1)}` : '';

  if (todos.length === 0) {
    area.innerHTML = `
      <div class="action-card">
        <p class="action-headline">No Tasks Found${periodLabel}</p>
        <p class="action-summary">There are no tasks${periodLabel} in your Enhancivity account. You can create new tasks from the dashboard or by processing emails.</p>
      </div>`;
    document.getElementById('chat-area').scrollTop = document.getElementById('chat-area').scrollHeight;
    return;
  }

  // Header
  const header = document.createElement('p');
  header.className = 'results-header';
  header.textContent = `${todos.length} task${todos.length !== 1 ? 's' : ''}${periodLabel}`;
  area.appendChild(header);

  // Task cards
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

  area.appendChild(list);

  // Scroll to bottom
  document.getElementById('chat-area').scrollTop = document.getElementById('chat-area').scrollHeight;
}

// ── Results Rendering ─────────────────────────────────────────

function renderResults(data) {
  const area = document.getElementById('results-area');
  area.innerHTML = '';
  area.classList.remove('hidden');

  if (!data) { area.innerHTML = '<p class="no-results">No results returned.</p>'; return; }

  if (data.type === 'tasks') {
    renderTaskList(area, data.items || []);
  } else if (data.type === 'products') {
    renderProductList(area, data.items || []);
  } else if (data.action_type === 'TASK_DRAFT' && data.primary_content) {
    // Single task extracted from page — show structured card with Create button
    renderTaskDraft(area, data);
  } else if (data.action_type === 'EXTRACT_TASKS' && data.primary_content) {
    // Multiple tasks extracted — parse JSON array and show checklist
    try {
      const tasks = JSON.parse(data.primary_content);
      if (Array.isArray(tasks) && tasks.length > 0) {
        renderTaskList(area, tasks);
      } else {
        renderTaskDraft(area, data);
      }
    } catch {
      renderTaskDraft(area, data);
    }
  } else if (data.consent_level === 'auto' && data.dom_actions && data.dom_actions.length > 0) {
    // Fully agentic: execute immediately, show slim status card
    renderAutoExecute(area, data);
  } else if (data.consent_level && data.consent_level !== 'auto' && data.dom_actions) {
    // Consequential action: show consent card
    renderActionPreview(area, data);
  } else if (data.primary_content) {
    // Standard agent response (RECOMMENDATION, WARNING)
    renderAgentResponse(area, data);
  } else {
    const msg = document.createElement('p');
    msg.className = 'text-result';
    msg.textContent = data.message || JSON.stringify(data);
    area.appendChild(msg);
  }

  // Scroll chat area to bottom
  document.getElementById('chat-area').scrollTop = document.getElementById('chat-area').scrollHeight;
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

    if (product.price) {
      const price = document.createElement('span');
      price.className = 'product-price';
      price.textContent = product.price;
      meta.appendChild(price);
    }
    if (product.rating) {
      const rating = document.createElement('span');
      rating.className = 'product-rating';
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
      link.className = 'product-link';
      link.textContent = 'View →';
      card.appendChild(link);
    }

    list.appendChild(card);
  });

  container.appendChild(list);
}

// ── Task Draft Card (single task from TASK_DRAFT) ─────────────

function renderTaskDraft(container, data) {
  let task = {};
  try {
    task = JSON.parse(data.primary_content);
  } catch {
    // primary_content isn't JSON — treat headline as title
    task = { title: data.headline || data.primary_content };
  }

  const card = document.createElement('div');
  card.className = 'action-card';

  const headline = document.createElement('p');
  headline.className = 'action-headline';
  headline.textContent = 'Task Ready to Create';
  card.appendChild(headline);

  const titleEl = document.createElement('p');
  titleEl.className = 'task-title';
  titleEl.style.cssText = 'font-size:14px;font-weight:600;margin:8px 0 4px;color:#f1f5f9;';
  titleEl.textContent = task.title || data.headline;
  card.appendChild(titleEl);

  if (task.description) {
    const desc = document.createElement('p');
    desc.className = 'action-content';
    desc.style.cssText = 'font-size:12px;color:#94a3b8;margin:0 0 8px;';
    desc.textContent = task.description;
    card.appendChild(desc);
  }

  const meta = document.createElement('p');
  meta.className = 'task-meta';
  meta.style.cssText = 'font-size:11px;margin:0 0 12px;';
  const parts = [];
  if (task.priority) parts.push(task.priority);
  if (task.dueDate) parts.push(`Due: ${task.dueDate}`);
  meta.textContent = parts.join(' · ');
  card.appendChild(meta);

  const createBtn = document.createElement('button');
  createBtn.className = 'btn btn-primary create-btn';
  createBtn.textContent = 'Create Task';
  createBtn.addEventListener('click', async () => {
    createBtn.textContent = 'Creating...';
    createBtn.disabled = true;
    const res = await sendToBackground('create_todo', {
      title: task.title || data.headline,
      description: task.description || '',
      dueDate: task.dueDate || null,
      priority: task.priority || 'MEDIUM',
    });
    if (res?.success) {
      card.innerHTML = '<p class="success-message">Task created in Enhancivity</p>';
    } else {
      createBtn.textContent = 'Create Task';
      createBtn.disabled = false;
      showError('Failed to create task. Please try again.');
    }
  });
  card.appendChild(createBtn);

  container.appendChild(card);
}

// ── Auto-Execute (non-consequential actions run immediately) ──

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
  statusEl.textContent = 'Working…';
  card.appendChild(statusEl);

  container.appendChild(card);
  document.getElementById('chat-area').scrollTop = document.getElementById('chat-area').scrollHeight;

  // Fire immediately — no user approval needed
  executeAutoAction(data).then(res => {
    if (res?.success) {
      statusEl.textContent = 'Done.';
      statusEl.style.color = '#34d399';
    } else {
      const errorMsg = res?.error || 'Action failed.';
      statusEl.textContent = `Couldn't complete: ${errorMsg}`;
      statusEl.style.color = '#f87171';
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

// ── Agent Response (text-based: RECOMMENDATION, WARNING) ──

function renderAgentResponse(container, data) {
  const card = document.createElement('div');
  card.className = 'action-card';

  const headline = document.createElement('p');
  headline.className = 'action-headline';
  headline.textContent = data.headline;
  card.appendChild(headline);

  const content = document.createElement('p');
  content.className = 'action-content';
  content.textContent = data.primary_content;
  card.appendChild(content);

  if (data.rationale) {
    const rationale = document.createElement('p');
    rationale.className = 'action-rationale';
    rationale.textContent = data.rationale;
    card.appendChild(rationale);
  }

  container.appendChild(card);
}

// ── Action Preview with Consent ───────────────────────────────

function renderActionPreview(container, data) {
  const isBlocked = data.consent_level === 'blocked';
  const isHard    = data.consent_level === 'hard';

  const card = document.createElement('div');
  card.className = `action-card ${isBlocked ? 'consent-blocked' : isHard ? 'consent-hard' : 'consent-soft'}`;

  // Headline
  const headline = document.createElement('p');
  headline.className = 'action-headline';
  headline.textContent = data.headline;
  card.appendChild(headline);

  // Preview summary
  if (data.preview?.summary) {
    const summary = document.createElement('p');
    summary.className = 'action-summary';
    summary.textContent = data.preview.summary;
    card.appendChild(summary);
  }

  // Preview details (email draft, etc.) — scrollable
  if (data.preview?.details) {
    const details = document.createElement('div');
    details.className = 'action-preview';
    details.textContent = data.preview.details;
    card.appendChild(details);
  }

  // Step list for multi-step actions
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

  // Rationale (muted)
  if (data.rationale) {
    const rationale = document.createElement('p');
    rationale.className = 'action-rationale';
    rationale.textContent = data.rationale;
    card.appendChild(rationale);
  }

  // Action buttons
  const btnRow = document.createElement('div');
  btnRow.className = 'action-btn-row';

  if (isBlocked) {
    // Blocked: just an "Understood" button
    const understood = document.createElement('button');
    understood.className = 'btn consent-btn-blocked';
    understood.textContent = 'Understood';
    understood.addEventListener('click', () => {
      container.innerHTML = '';
      container.classList.add('hidden');
    });
    btnRow.appendChild(understood);
  } else {
    // Cancel button
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn consent-btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      container.innerHTML = '';
      container.classList.add('hidden');
    });
    btnRow.appendChild(cancelBtn);

    // Confirm button
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
    case 'COMPOSE_EMAIL': return 'Insert Draft';
    case 'NAVIGATE':      return 'Yes, Open It';
    case 'USE_EXISTING_TAB': return 'Switch to Tab';
    case 'SEARCH_SITE':   return 'Yes, Search';
    case 'ADD_TO_CART':    return 'Yes, Add to Cart';
    case 'FILL_FORM':     return 'Yes, Fill It';
    case 'MULTI_STEP':    return 'Yes, Do This';
    case 'EXTRACT_TASKS': return 'Extract Tasks';
    default:              return 'Confirm';
  }
}

async function executeAction(container, btn, data) {
  setStage('STAGE_EXECUTION');
  btn.textContent = 'Working...';
  btn.disabled = true;

  let res;

  // USE_EXISTING_TAB: switch to an already-open tab
  if (data.action_type === 'USE_EXISTING_TAB' && data.target_tab_url) {
    res = await sendToBackground('switch_tab', { targetTabUrl: data.target_tab_url });
    if (res?.success) {
      const msg = res.switched
        ? `Switched to: ${res.tabTitle || data.target_tab_url}`
        : `Opened: ${data.target_tab_url}`;
      container.innerHTML = `<p class="success-message">${msg}</p>`;
      return;
    }

  // EXTRACT_TASKS: re-prompt agent with explicit task extraction instruction
  // (page content is scraped automatically inside process_request via content_universal.js)
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

  // Gmail-specific compose/reply handling
  } else if (data.action_type === 'COMPOSE_EMAIL' && currentSite === 'gmail') {
    // Extract compose data from primary_content and dom_actions
    const composeData = {};
    for (const step of (data.dom_actions || [])) {
      if (step.action === 'fill_field') {
        if (step.selector?.includes('to'))      composeData.to = step.value;
        if (step.selector?.includes('subject')) composeData.subject = step.value;
        if (step.selector?.includes('body') || step.selector?.includes('editable'))
          composeData.body = step.value;
      }
    }
    // Fallback: use primary_content as body if no body in dom_actions
    if (!composeData.body && data.primary_content) {
      composeData.body = data.primary_content;
    }
    res = await sendToBackground('gmail_compose', { tabId: currentTabId, data: composeData });

  } else if (data.dom_actions && data.dom_actions.length > 1) {
    // Multi-step execution
    res = await sendToBackground('execute_multi_step', {
      steps: data.dom_actions,
      tabId: currentTabId,
    });

  } else if (data.dom_actions && data.dom_actions.length === 1) {
    // Single action
    res = await sendToBackground('execute_action', {
      action: data.dom_actions[0],
      tabId: currentTabId,
    });

  } else {
    res = { success: false, error: 'No actions to execute.' };
  }

  // Show result
  if (res?.success) {
    container.innerHTML = '<p class="success-message">Done! Action completed successfully.</p>';
  } else {
    const errorMsg = res?.error || 'Action failed. Please try again.';
    if (errorMsg === 'BLOCKED_SENSITIVE') {
      container.innerHTML = '<p class="blocked-message">Blocked: This action involves sensitive data (passwords, payment info). Enhancivity never automates these fields.</p>';
    } else if (errorMsg === 'BLOCKED_DANGEROUS_CLICK') {
      container.innerHTML = '<p class="blocked-message">Blocked: Enhancivity won\'t click Send/Pay/Submit buttons. You\'re always in control of final actions.</p>';
    } else {
      btn.textContent = getConfirmLabel(data.action_type);
      btn.disabled = false;
      showError(errorMsg);
    }
  }
}

// ── Orchestration: Multi-Site Search HUD ─────────────────────

let orchestrationListener = null;

// autoStart=true: agentic law — show plan briefly then auto-launch
function renderOrchestratePlan(data, autoStart = true) {
  const area = document.getElementById('results-area');
  area.innerHTML = '';
  area.classList.remove('hidden');

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
    statusEl.textContent = 'Launching searches…';
    card.appendChild(statusEl);
    area.appendChild(card);
    setTimeout(() => startOrchestration(data.search_plan, data.primary_content || ''), 800);
  } else {
    const btnRow = document.createElement('div');
    btnRow.className = 'action-btn-row';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn consent-btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => { area.innerHTML = ''; area.classList.add('hidden'); });
    btnRow.appendChild(cancelBtn);

    const searchBtn = document.createElement('button');
    searchBtn.className = 'btn consent-btn-soft';
    searchBtn.textContent = 'Search Now';
    searchBtn.addEventListener('click', () => startOrchestration(data.search_plan, data.primary_content || ''));
    btnRow.appendChild(searchBtn);

    card.appendChild(btnRow);
    area.appendChild(card);
  }
}

// ── EXPLORE: Render plan card + run exploration loop ────────

function renderExplorePlan(data, autoStart = true) {
  const area = document.getElementById('results-area');
  area.innerHTML = '';
  area.classList.remove('hidden');

  const card = document.createElement('div');
  card.className = 'action-card consent-soft';

  const headline = document.createElement('p');
  headline.className = 'action-headline';
  headline.textContent = data.headline || 'Exploring...';
  card.appendChild(headline);

  const plan = data.explore_plan;

  const goalEl = document.createElement('p');
  goalEl.className = 'orch-criteria';
  goalEl.textContent = plan.goal;
  goalEl.style.fontWeight = '500';
  card.appendChild(goalEl);

  const strategyEl = document.createElement('p');
  strategyEl.className = 'orch-criteria';
  strategyEl.style.opacity = '0.7';
  strategyEl.style.fontSize = '11px';
  strategyEl.textContent = `Strategy: ${plan.strategy}`;
  card.appendChild(strategyEl);

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

  card.appendChild(budgetBadges);

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
    area.appendChild(card);
    setTimeout(() => startExploration(plan), 800);
  } else {
    const btnRow = document.createElement('div');
    btnRow.className = 'action-btn-row';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn consent-btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => { area.innerHTML = ''; area.classList.add('hidden'); });
    btnRow.appendChild(cancelBtn);

    const exploreBtn = document.createElement('button');
    exploreBtn.className = 'btn consent-btn-soft';
    exploreBtn.textContent = 'Explore Now';
    exploreBtn.addEventListener('click', () => startExploration(plan));
    btnRow.appendChild(exploreBtn);

    card.appendChild(btnRow);
    area.appendChild(card);
  }
}

let explorationListener = null;

async function startExploration(explorePlan) {
  const area = document.getElementById('results-area');
  area.innerHTML = '';

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

  // Step log
  const stepLog = document.createElement('div');
  stepLog.style.cssText = 'max-height: 180px; overflow-y: auto; padding: 6px 0;';
  hud.appendChild(stepLog);

  area.appendChild(hud);

  // Listen for progress
  if (explorationListener) {
    chrome.storage.onChanged.removeListener(explorationListener);
  }

  explorationListener = (changes) => {
    if (!changes.explorationProgress) return;
    const progress = changes.explorationProgress.newValue;
    if (!progress) return;

    statusEl.textContent = `Step ${progress.step}/${progress.total}: ${progress.description || ''}`;

    if (progress.step >= 0 && progress.description) {
      const stepEntry = document.createElement('div');
      stepEntry.style.cssText = 'display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 11px; color: rgba(255,255,255,0.7);';

      const icon = document.createElement('span');
      icon.style.cssText = 'font-size: 10px; width: 14px; text-align: center;';
      if (progress.status === 'running') icon.textContent = '...';
      else if (progress.status === 'complete') icon.textContent = '\u2713';
      else if (progress.status === 'partial') icon.textContent = '\u25CB';
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

  // Get active tab
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;

  const res = await chrome.runtime.sendMessage({
    type: 'explore_start',
    data: { explorePlan, tabId },
  });

  chrome.storage.onChanged.removeListener(explorationListener);
  explorationListener = null;

  // Render result
  area.innerHTML = '';

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
    resultEl.textContent = res.goalResult || 'Exploration finished.';
    card.appendChild(resultEl);

    if (res.stepsUsed) {
      const metaEl = document.createElement('p');
      metaEl.style.cssText = 'font-size: 10px; opacity: 0.5; margin-top: 8px;';
      metaEl.textContent = `${res.stepsUsed} steps \u00B7 ${(res.creditsUsed || 0).toFixed(1)} EU`;
      card.appendChild(metaEl);
    }

    area.appendChild(card);
  } else {
    area.innerHTML = `<div class="action-card"><p class="error-message">${res?.error || 'Exploration failed.'}</p></div>`;
  }
}

async function startOrchestration(searchPlan, userPrompt) {
  const area = document.getElementById('results-area');
  area.innerHTML = '';

  // Build the orchestration HUD
  const hud = document.createElement('div');
  hud.className = 'orch-hud';
  hud.id = 'orch-hud';

  const header = document.createElement('div');
  header.className = 'orch-header';

  const badge = document.createElement('span');
  badge.className = 'orch-badge-label';
  badge.textContent = 'Global Search';
  header.appendChild(badge);

  const status = document.createElement('span');
  status.className = 'orch-status';
  status.id = 'orch-status';
  status.textContent = 'Launching searches...';
  header.appendChild(status);

  hud.appendChild(header);

  // Site progress badges
  const sitesRow = document.createElement('div');
  sitesRow.className = 'orch-sites-row';
  sitesRow.id = 'orch-sites-row';

  for (const site of searchPlan.sites) {
    const siteEl = document.createElement('div');
    siteEl.className = 'orch-site-status pending';
    siteEl.id = `orch-site-${site}`;
    siteEl.innerHTML = `<span class="orch-site-icon">⏳</span><span>${site}</span>`;
    sitesRow.appendChild(siteEl);
  }

  hud.appendChild(sitesRow);
  area.appendChild(hud);

  // Listen for progress updates from background.js via chrome.storage
  if (orchestrationListener) {
    chrome.storage.onChanged.removeListener(orchestrationListener);
  }

  orchestrationListener = (changes) => {
    if (!changes.orchestrationProgress) return;
    const progress = changes.orchestrationProgress.newValue;
    if (!progress) return;

    const statusEl = document.getElementById('orch-status');
    if (statusEl) statusEl.textContent = progress.detail || progress.phase;

    // Update individual site badges
    if (progress.phase?.startsWith('searching:')) {
      const site = progress.phase.split(':')[1];
      const siteEl = document.getElementById(`orch-site-${site}`);
      if (siteEl) {
        siteEl.className = 'orch-site-status active';
        siteEl.querySelector('.orch-site-icon').textContent = '🔍';
      }
    }

    if (progress.phase === 'comparing') {
      // Mark all sites as done
      for (const site of searchPlan.sites) {
        const siteEl = document.getElementById(`orch-site-${site}`);
        if (siteEl) {
          siteEl.className = 'orch-site-status done';
          siteEl.querySelector('.orch-site-icon').textContent = '✓';
        }
      }
      if (statusEl) statusEl.textContent = 'AI is picking the best option...';
    }
  };

  chrome.storage.onChanged.addListener(orchestrationListener);

  // Trigger the actual orchestration
  const res = await sendToBackground('orchestrate_search', { searchPlan, userPrompt });

  // Clean up listener
  chrome.storage.onChanged.removeListener(orchestrationListener);
  orchestrationListener = null;

  if (!res?.success) {
    area.innerHTML = `<div class="action-card"><p class="error-message">${res?.error || 'Search failed. Please try again.'}</p></div>`;
    return;
  }

  // Render comparison results
  renderComparison(area, res.data);
}

function renderComparison(container, data) {
  container.innerHTML = '';

  if (!data || !data.winner) {
    container.innerHTML = '<div class="action-card"><p class="no-results">No comparison results returned.</p></div>';
    return;
  }

  // Summary line
  if (data.summary) {
    const summary = document.createElement('p');
    summary.className = 'orch-summary';
    summary.textContent = data.summary;
    container.appendChild(summary);
  }

  // Winner card (large, prominent)
  const winnerCard = document.createElement('div');
  winnerCard.className = 'orch-winner-card';

  const winnerLabel = document.createElement('span');
  winnerLabel.className = 'orch-winner-label';
  winnerLabel.textContent = '★ Best Pick';
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

  // Trust badge
  if (data.winner.trustBadge) {
    const trustBadge = document.createElement('span');
    trustBadge.className = `trust-badge trust-${data.winner.trustBadge}`;
    trustBadge.textContent = data.winner.trustBadge === 'verified' ? '✓ Verified' :
                             data.winner.trustBadge === 'aggregator' ? '◆ Aggregator' :
                             data.winner.trustBadge === 'caution' ? '⚠ Caution' : '✕ Rejected';
    winnerMeta.appendChild(trustBadge);
  }

  winnerCard.appendChild(winnerMeta);

  if (data.winner.rationale) {
    const rationale = document.createElement('p');
    rationale.className = 'orch-winner-rationale';
    rationale.textContent = data.winner.rationale;
    winnerCard.appendChild(rationale);
  }

  // "Go to Product" button
  if (data.winner.url) {
    const goBtn = document.createElement('button');
    goBtn.className = 'btn btn-primary orch-go-btn';
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
        // Fallback: open in new tab
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
        const badgeLabel = alt.trustBadge === 'verified' ? '✓' :
                           alt.trustBadge === 'aggregator' ? '◆' :
                           alt.trustBadge === 'caution' ? '⚠' : '✕';
        altMetaHtml += `<span class="trust-badge trust-${alt.trustBadge}">${badgeLabel}</span>`;
      }
      altMeta.innerHTML = altMetaHtml;
      altInfo.appendChild(altMeta);

      if (alt.note) {
        const altNote = document.createElement('p');
        altNote.className = 'orch-alt-note';
        altNote.textContent = alt.note;
        altInfo.appendChild(altNote);
      }

      altCard.appendChild(altInfo);

      if (alt.url) {
        const altLink = document.createElement('button');
        altLink.className = 'btn orch-alt-btn';
        altLink.textContent = 'View';
        altLink.addEventListener('click', () => {
          chrome.tabs.create({ url: alt.url, active: true });
        });
        altCard.appendChild(altLink);
      }

      container.appendChild(altCard);
    }
  }

  // Rejected sites (trust < 4.0)
  if (data.rejectedSites && data.rejectedSites.length > 0) {
    const rejHeader = document.createElement('p');
    rejHeader.className = 'orch-alt-header trust-rejected-header';
    rejHeader.textContent = 'Excluded (low trust)';
    container.appendChild(rejHeader);

    for (const rej of data.rejectedSites) {
      const rejEl = document.createElement('div');
      rejEl.className = 'trust-rejected-item';
      rejEl.innerHTML = `<span class="trust-badge trust-rejected">✕</span> ` +
        `<span>${rej.site}</span> — <span class="trust-rejected-reason">${rej.reason}</span>`;
      container.appendChild(rejEl);
    }
  }
}

// ── Utilities ────────────────────────────────────────────────

// ── Defensive Pipeline: typed errors + timeout ───────────────

const PIPELINE_TIMEOUT_MS = 20000; // 20 seconds

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

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

function setLoading(on) {
  document.getElementById('loading-bar').classList.toggle('hidden', !on);
  document.getElementById('submit-btn').disabled = on;
  if (!on) setStage(''); // Clear stage when loading stops
}

// ── Stage Tracker: visual feedback during pipeline ───────────

const STAGE_LABELS = {
  STAGE_TRIAGE:    'Scanning your tabs...',
  STAGE_BACKEND:   'Thinking with your memory...',
  STAGE_PARSING:   'Validating response...',
  STAGE_EXECUTION: 'Executing action...',
};

function setStage(stage) {
  const label = document.querySelector('.loading-label');
  if (label) {
    label.textContent = STAGE_LABELS[stage] || 'Thinking with your memory...';
  }
}

function clearResults() {
  const area = document.getElementById('results-area');
  area.innerHTML = '';
  area.classList.add('hidden');
  document.getElementById('main-error').textContent = '';
}

function showError(msg) {
  // Map technical error types to user-friendly hints
  const FRIENDLY_HINTS = {
    '[BACKEND_TIMEOUT]': 'The server took too long. Try again in a moment.',
    '[NETWORK_ERROR]': 'Cannot reach the server. Check your internet connection.',
    '[NO_RESPONSE]': 'Extension communication failed. Try reloading the extension.',
    '[HANDLER_CRASH]': 'Something broke internally. Try again or reload the extension.',
    '[SERVER_ERROR]': 'The server returned an error. Try again.',
    '[PARSE_ERROR]': 'Could not process that request — try rephrasing it.',
  };

  let displayMsg = msg;
  for (const [prefix, hint] of Object.entries(FRIENDLY_HINTS)) {
    if (msg.startsWith(prefix)) {
      displayMsg = hint;
      break;
    }
  }

  document.getElementById('main-error').textContent = displayMsg;
  console.warn('[Enhancivity] Error shown to user:', msg); // Full detail in console
}
