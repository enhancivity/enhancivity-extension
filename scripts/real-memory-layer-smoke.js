'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const extensionDir = path.join(root, 'dist', 'memory-layer-extension');
const backendBase = process.env.MEMORY_LAYER_API_BASE || 'http://localhost:3001';
const targetUrl = 'http://localhost:3098/memory-layer-founder-target.html';

function assertFile(relativePath) {
  const fullPath = path.join(extensionDir, relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing release extension file: ${fullPath}`);
  }
}

async function assertBackendReady() {
  const response = await fetch(`${backendBase}/api/health`);
  if (!response.ok) {
    throw new Error(`Backend health check failed: HTTP ${response.status}`);
  }
}

async function getExtensionId(context) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const targets = await cdp.send('Target.getTargets');
      const target = targets.targetInfos.find(info =>
        info.url.startsWith('chrome-extension://') &&
        info.url.includes('/memory_layer_background.js')
      );
      if (target?.url) {
        return target.url.match(/chrome-extension:\/\/([^/]+)\//)?.[1];
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('Memory Layer extension background worker did not appear.');
  } finally {
    await cdp.detach().catch(() => {});
    await page.close().catch(() => {});
  }
}

async function apiRequest(pathname, token, options = {}) {
  const response = await fetch(`${backendBase}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${pathname} failed: HTTP ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function findProposalCardByTextareaValue(page, expectedText) {
  const cards = page.locator('.proposal-card');
  const count = await cards.count();
  const values = [];

  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    const value = await card.locator('textarea').first().inputValue().catch(() => '');
    values.push(value);
    if (value.includes(expectedText)) {
      return card;
    }
  }

  throw new Error(`Could not find proposal containing "${expectedText}". Proposal values: ${JSON.stringify(values)}`);
}

function targetHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Memory Layer Founder Target</title>
</head>
<body>
  <h1>Founder Target</h1>
  <p>Requirement: The memory layer must require explicit wake, project selection, review, and manual submit.</p>
  <form id="demo-form">
    <textarea id="target-input" rows="8">Help me plan shipping the memory-layer MVP</textarea>
    <button id="submit-button" type="submit">Submit</button>
  </form>
  <output id="submit-count">0</output>
  <script>
    let submitCount = 0;
    document.getElementById('demo-form').addEventListener('submit', event => {
      event.preventDefault();
      submitCount += 1;
      document.getElementById('submit-count').textContent = String(submitCount);
    });
  </script>
</body>
</html>`;
}

async function run() {
  [
    'manifest.json',
    'memory_layer_background.js',
    'memory_layer_sidepanel.html',
    'memory_layer_sidepanel.js',
    'memory_layer_content.js',
    'memory_layer_extractors.js',
  ].forEach(assertFile);

  await assertBackendReady();

  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--no-first-run',
      '--disable-popup-blocking',
      '--disable-component-extensions-with-background-pages',
    ],
  });

  try {
    await context.route(targetUrl, route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: targetHtml(),
    }));

    const extensionId = await getExtensionId(context);
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/memory_layer_sidepanel.html`);
    await panel.locator('#auth-card').waitFor({ state: 'visible', timeout: 15_000 });

    const unique = Date.now();
    await panel.locator('#auth-signup-tab').click();
    await panel.locator('#auth-name').fill('Memory Smoke');
    await panel.locator('#auth-email').fill(`memory-smoke-${unique}@example.com`);
    await panel.locator('#auth-password').fill('Someone1234');
    await panel.locator('#auth-submit').click();
    await panel.locator('#memory-app').waitFor({ state: 'visible', timeout: 30_000 });

    const noProjectVisible = await panel.locator('#no-project-onboarding').isVisible().catch(() => false);
    if (noProjectVisible) {
      await panel.locator('#project-name').fill(`Founder Demo ${unique}`);
      await panel.locator('#create-project-btn').click();
      await panel.locator('#no-project-onboarding').waitFor({ state: 'hidden', timeout: 15_000 });
      await panel.locator('#project-select').evaluate(element => element.value).then(value => {
        if (!value) {
          throw new Error('Project was created, but the side panel did not select it.');
        }
      });
    }

    const storage = await panel.evaluate(async () => chrome.storage.local.get(['token', 'memoryLayerSelectedProjectId']));
    if (!storage.token || !storage.memoryLayerSelectedProjectId) {
      throw new Error(`Extension did not persist token and selected project: ${JSON.stringify({
        hasToken: Boolean(storage.token),
        selectedProjectId: storage.memoryLayerSelectedProjectId || null,
      })}`);
    }

    await apiRequest(`/api/memory-layer/projects/${encodeURIComponent(storage.memoryLayerSelectedProjectId)}/memory`, storage.token, {
      method: 'POST',
      body: JSON.stringify({
        type: 'goal',
        title: 'Founder demo objective',
        content: 'Ship the isolated memory-layer MVP with explicit review before insertion or saving.',
        importance: 5,
        sensitivity: 'standard',
        sourceType: 'manual',
        sourceTool: 'real_stack_smoke',
      }),
    });

    const target = await context.newPage();
    await target.goto(targetUrl);
    await target.locator('#target-input').focus();
    await target.locator('#target-input').evaluate(element => element.setSelectionRange(6, 6));

    await panel.bringToFront();
    await panel.locator('#wake-btn').click();
    await panel.locator('#wake-state').filter({ hasText: 'Awake' }).waitFor({ timeout: 15_000 });
    await panel.locator('#insert-instruction').fill('Help me plan shipping the isolated memory-layer MVP with explicit review.');
    await panel.locator('#prepare-context-btn').click();
    await panel.locator('#context-review').waitFor({ state: 'visible', timeout: 15_000 });
    const contextText = await panel.locator('#context-review').inputValue();
    if (!contextText.includes('Ship the isolated memory-layer MVP')) {
      throw new Error(`Prepared context did not include the seeded founder demo memory. Actual context: ${contextText.slice(0, 500)}`);
    }
    await panel.locator('#insert-reviewed-btn').click();

    const inserted = await target.locator('#target-input').inputValue();
    if (!inserted.includes('Ship the isolated memory-layer MVP')) {
      throw new Error('Reviewed context was not inserted into the target input.');
    }
    const submitCount = await target.locator('#submit-count').textContent();
    if (submitCount !== '0') {
      throw new Error('Target form was submitted automatically.');
    }

    await panel.locator('#capture-note').fill('Requirement: real stack smoke confirms capture remains reviewed before saving.');
    await panel.locator('#capture-btn').click();
    await panel.locator('.proposal-card').first().waitFor({ state: 'visible', timeout: 15_000 });
    const captureProposal = await findProposalCardByTextareaValue(panel, 'real stack smoke confirms capture');
    await captureProposal.locator('.primary-btn').first().click();
    await captureProposal.locator('.recommendation-card').first().waitFor({ state: 'visible', timeout: 15_000 });
    await captureProposal.locator('.recommendation-card input[type="checkbox"]').first().check();
    await captureProposal.locator('.primary-btn').first().click();
    await panel.locator('#tool-status').filter({ hasText: 'Saved reviewed memory.' }).waitFor({ timeout: 15_000 });

    const list = await apiRequest(`/api/memory-layer/projects/${encodeURIComponent(storage.memoryLayerSelectedProjectId)}/memory`, storage.token);
    const savedItems = list.memoryItems || [];
    if (!savedItems.some(item => String(item.content || '').includes('real stack smoke confirms capture'))) {
      throw new Error('Saved reviewed capture was not visible through the live backend memory list.');
    }

    console.log(JSON.stringify({
      success: true,
      backendBase,
      extensionDir,
      projectId: storage.memoryLayerSelectedProjectId,
      insertedContext: true,
      autoSubmitPrevented: true,
      savedReviewedCapture: true,
    }, null, 2));
  } finally {
    await context.close().catch(() => {});
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
