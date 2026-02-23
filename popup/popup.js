// ============================================================
// Enhancivity Popup Script — Chief of Staff Edition
// ============================================================

const PLACEHOLDERS = {
  gmail:   "Analyze this email...",
  amazon:  "Evaluate this product...",
  general: "Command Enhancivity..."
};

const BADGE_CONFIG = {
  gmail:   { label: 'Gmail',   color: '#ef4444' },
  amazon:  { label: 'Amazon',  color: '#f59e0b' },
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
  if (!url) return 'general';
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

  const res = await sendToBackground('process_request', {
    userPrompt,
    tabId: currentTabId,
    url:   currentTabUrl
  });

  setLoading(false);

  if (!res?.success) {
    showError(res?.error || 'Something went wrong. Please try again.');
    return;
  }

  promptInput.value = '';
  // Reset send button state
  document.getElementById('submit-btn').disabled = true;
  document.getElementById('submit-btn').classList.remove('active');

  renderResults(res.data);
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
  } else if (data.consent_level && data.consent_level !== 'auto' && data.dom_actions) {
    // DOM Action with consent required
    renderActionPreview(area, data);
  } else if (data.primary_content) {
    // Standard agent response (RECOMMENDATION, WARNING, TASK_DRAFT without dom_actions)
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

// ── Agent Response (text-based: RECOMMENDATION, WARNING, TASK_DRAFT) ──

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
    case 'SEARCH_SITE':   return 'Yes, Search';
    case 'ADD_TO_CART':    return 'Yes, Add to Cart';
    case 'FILL_FORM':     return 'Yes, Fill It';
    case 'MULTI_STEP':    return 'Yes, Do This';
    case 'EXTRACT_TASKS': return 'Extract Tasks';
    default:              return 'Confirm';
  }
}

async function executeAction(container, btn, data) {
  btn.textContent = 'Working...';
  btn.disabled = true;

  let res;

  // Gmail-specific compose/reply handling
  if (data.action_type === 'COMPOSE_EMAIL' && currentSite === 'gmail') {
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

// ── Utilities ────────────────────────────────────────────────

function sendToBackground(type, data) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, data }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    });
  });
}

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

function setLoading(on) {
  document.getElementById('loading-bar').classList.toggle('hidden', !on);
  document.getElementById('submit-btn').disabled = on;
}

function clearResults() {
  const area = document.getElementById('results-area');
  area.innerHTML = '';
  area.classList.add('hidden');
  document.getElementById('main-error').textContent = '';
}

function showError(msg) {
  document.getElementById('main-error').textContent = msg;
}
