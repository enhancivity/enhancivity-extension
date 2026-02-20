// ============================================================
// Enhancivity Popup Script — Grand Extension v2.0
// Responsibilities:
//   1. Auth state check → show login or main view
//   2. Detect active tab context (Gmail / Amazon / General)
//   3. Send prompt + tab context to background brain
//   4. Render results: task list OR product list OR text
// ============================================================

// Context placeholder hints shown in the textarea
const PLACEHOLDERS = {
  gmail:   "Type 'extract tasks' or ask anything about this email...",
  amazon:  "Type 'recommend' or ask about this product...",
  general: "Type 'create task' or ask anything..."
};

// Context badge styles
const BADGE_CONFIG = {
  gmail:   { label: 'Gmail',   color: '#ea4335' },
  amazon:  { label: 'Amazon',  color: '#ff9900' },
  general: { label: 'General', color: '#6b7280' }
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
  const loginForm    = document.getElementById('login-form');
  const loginBtn     = document.getElementById('login-btn');
  const googleBtn    = document.getElementById('google-login-btn');
  const errorEl      = document.getElementById('auth-error');

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

  // Update context badge and placeholder
  applyContext(currentSite);

  // Show memory indicator if memory is cached
  const { userMemory } = await chrome.storage.local.get(['userMemory']);
  if (userMemory) {
    document.getElementById('memory-bar').classList.remove('hidden');
    const tier2Count = userMemory?.tier2?.goals?.length || 0;
    const tier3Count = userMemory?.tier3?.traits?.length || 0;
    document.getElementById('memory-label').textContent =
      `Memory active · ${tier2Count} goals · ${tier3Count} traits`;
  }

  // Sign out
  document.getElementById('sign-out-btn').addEventListener('click', async () => {
    await chrome.storage.local.clear();
    showView('auth-view');
    setupAuthHandlers();
  });

  // Submit handler
  const submitBtn   = document.getElementById('submit-btn');
  const promptInput = document.getElementById('prompt-input');

  submitBtn.addEventListener('click', () => handleSubmit());
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  });
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

  badge.textContent        = config.label;
  badge.style.background   = config.color;
  input.placeholder        = PLACEHOLDERS[site] || PLACEHOLDERS.general;
}

// ── Submit & Process ─────────────────────────────────────────

async function handleSubmit() {
  const promptInput = document.getElementById('prompt-input');
  const userPrompt  = promptInput.value.trim();
  if (!userPrompt) return;

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
  } else {
    // Plain text / fallback
    const msg = document.createElement('p');
    msg.className = 'text-result';
    msg.textContent = data.message || JSON.stringify(data);
    area.appendChild(msg);
  }
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

  // Create Selected button
  const createBtn = document.createElement('button');
  createBtn.className = 'btn create-btn';
  createBtn.textContent = 'Create Selected Tasks';
  createBtn.addEventListener('click', async () => {
    const selected = [...list.querySelectorAll('.task-checkbox:checked')]
      .map(cb => tasks[parseInt(cb.dataset.index)]);

    if (!selected.length) return;

    createBtn.textContent = 'Creating...';
    createBtn.disabled = true;

    const res = await sendToBackground('create_todos_bulk', selected);

    if (res?.success) {
      container.innerHTML = `<p class="success-message">✓ ${selected.length} task${selected.length > 1 ? 's' : ''} created in Enhancivity!</p>`;
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
