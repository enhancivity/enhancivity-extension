'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '5mb' }));

// ── CORS (allow extension origin) ────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Test JWT secret (matches helpers/auth.js) ────────────────
const TEST_SECRET = 'enhancivity-test-secret-key-2026';

// ── Load fixture helper ──────────────────────────────────────
function fixture(name) {
  const p = path.join(__dirname, '..', 'fixtures', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ── Explore step counter (per-session) ───────────────────────
let exploreStepCounter = 0;

// ── ERROR MODE (for testing error scenarios) ─────────────────
// Tests toggle this by POSTing to /test/set-error-mode
let errorMode = null;

app.post('/test/set-error-mode', (req, res) => {
  errorMode = req.body.mode; // null | '500' | '401' | '402' | 'timeout'
  res.json({ success: true, mode: errorMode });
});

app.post('/test/reset', (req, res) => {
  errorMode = null;
  exploreStepCounter = 0;
  res.json({ success: true });
});

// Error mode middleware — BEFORE all route handlers
app.use((req, res, next) => {
  if (!errorMode || req.url.startsWith('/test/') || req.url.startsWith('/harness')) return next();

  if (errorMode === '500') return res.status(500).json({ error: 'Internal server error (test mode)' });
  if (errorMode === '401') return res.status(401).json({ error: 'Unauthorized (test mode)' });
  if (errorMode === '402') return res.status(402).json({ error: 'Insufficient credits (test mode)' });
  if (errorMode === 'timeout') return; // hang forever — never respond

  next();
});

// ── Serve test harness pages ─────────────────────────────────
app.use('/harness', express.static(path.join(__dirname, '..', 'harness')));

// ── AUTH ──────────────────────────────────────────────────────
app.post('/api/auth/extension/login', (req, res) => {
  const token = jwt.sign(
    { id: 'test-user-001', email: req.body.email || 'test@enhancivity.com', role: 'user' },
    TEST_SECRET,
    { expiresIn: '24h' }
  );
  res.json({
    success: true,
    token,
    user: { id: 'test-user-001', email: req.body.email || 'test@enhancivity.com', name: 'Test User' },
  });
});

app.post('/api/auth/extension/signup', (req, res) => {
  const token = jwt.sign(
    { id: 'test-user-001', email: req.body.email || 'test@enhancivity.com', role: 'user' },
    TEST_SECRET,
    { expiresIn: '24h' }
  );
  res.json({
    success: true,
    token,
    user: { id: 'test-user-001', email: req.body.email || 'test@enhancivity.com', name: req.body.name || 'Test User' },
  });
});

app.post('/api/auth/extension/reset-password', (req, res) => {
  res.json({ success: true, message: 'Password reset email sent.' });
});

app.post('/api/auth/extension/google', (req, res) => {
  const token = jwt.sign(
    { id: 'test-user-001', email: 'test@enhancivity.com', role: 'user' },
    TEST_SECRET,
    { expiresIn: '24h' }
  );
  res.json({ success: true, token, user: { id: 'test-user-001', email: 'test@enhancivity.com', name: 'Test User' } });
});

// ── AGENT PROCESS (main AI brain) ────────────────────────────
app.post('/api/agent/process', (req, res) => {
  const prompt = (req.body.userPrompt || '').toLowerCase();

  if (prompt.includes('desktop') && (prompt.includes('800') || prompt.includes('8000'))) {
    return res.json({
      action_type: 'ORCHESTRATE',
      headline: 'Finding the best desktop',
      rationale: 'I will search a couple of stores, stay within budget, and pick one.',
      primary_content: 'Searching for the best desktop under your budget.',
      search_plan: {
        sites: ['mockshop-a', 'mockshop-b'],
        queries: {
          'mockshop-a': 'laptop under 800 euro',
          'mockshop-b': 'laptop under 800 euro',
        },
        criteria: 'price and value',
        category: 'shopping',
        object: 'desktop',
        constraints: {
          maxPrice: '800 euro',
        },
      },
      consent_level: 'auto',
      preview: { summary: 'Search mock shops for a desktop under 800 euro.' },
    });
  }

  if (prompt.includes('navigate') || prompt.includes('go to')) {
    return res.json(fixture('process-navigate.json'));
  }
  if (prompt.includes('explore') || prompt.includes('check') || prompt.includes('find')) {
    return res.json(fixture('process-explore.json'));
  }

  // Default: recommendation
  res.json(fixture('process-recommendation.json'));
});

// ── EXPLORE ENDPOINTS ────────────────────────────────────────
app.post('/api/agent/explore-plan', (req, res) => {
  res.json({
    strategy: 'Navigate to the page, read the content, extract relevant data.',
    reasoning: 'The page is loaded. We need to scan for relevant elements.',
    estimatedSteps: 5,
    checkpoints: ['Page loaded', 'Elements found', 'Data extracted'],
  });
});

app.post('/api/agent/explore-step', (req, res) => {
  exploreStepCounter++;

  if (exploreStepCounter >= 5) {
    exploreStepCounter = 0;
    return res.json(fixture('explore-step.json'));
  }

  res.json({
    nextAction: {
      type: 'click_element',
      target: `s${exploreStepCounter}`,
      description: `Click element ${exploreStepCounter} to continue exploration`,
    },
    reasoning: `Step ${exploreStepCounter}: gathering information from the page.`,
    revisedStrategy: null,
    isGoalComplete: false,
    goalResult: null,
    extractedData: null,
    needsConsent: false,
    consentReason: null,
  });
});

// ── PARSE INTENT ─────────────────────────────────────────────
app.post('/api/agent/parse-intent', (req, res) => {
  const goal = (req.body.userGoal || '').toLowerCase();
  const pageUrl = req.body.semanticMap?.pageUrl || req.body.pageUrl || '';

  if (pageUrl.includes('mock-shop-a')) {
    if (goal.includes('desktop')) {
      return res.json({
        products: [
          { title: 'Budget Desktop Tower', price: '€699,00', url: 'http://localhost:3099/harness/mock-shop-a.html?p=desktop-budget', confidence: 'high' },
          { title: 'Gaming Desktop Pro', price: '€1.299,00', url: 'http://localhost:3099/harness/mock-shop-a.html?p=desktop-pro', confidence: 'high' },
        ],
        pageType: 'search_results',
        siteName: 'Mock Shop A',
        trustScore: 8.8,
        trustRationale: 'Mock marketplace A',
      });
    }

    if (goal.includes('laptop')) {
      return res.json({
        products: [
          { title: 'Ultrabook Laptop 14"', price: '€799,00', url: 'http://localhost:3099/harness/mock-shop-a.html?p=laptop-ultrabook', confidence: 'high' },
          { title: 'Creator Laptop 16"', price: '€1.099,00', url: 'http://localhost:3099/harness/mock-shop-a.html?p=laptop-creator', confidence: 'high' },
        ],
        pageType: 'search_results',
        siteName: 'Mock Shop A',
        trustScore: 8.8,
        trustRationale: 'Mock marketplace A',
      });
    }
  }

  if (pageUrl.includes('mock-shop-b')) {
    if (goal.includes('desktop')) {
      return res.json({
        products: [
          { title: 'Compact Desktop PC', price: '€749,00', url: 'http://localhost:3099/harness/mock-shop-b.html?p=desktop-compact', confidence: 'high' },
          { title: 'Studio Workstation Desktop', price: '€1.499,00', url: 'http://localhost:3099/harness/mock-shop-b.html?p=desktop-workstation', confidence: 'high' },
        ],
        pageType: 'search_results',
        siteName: 'Mock Shop B',
        trustScore: 8.2,
        trustRationale: 'Mock marketplace B',
      });
    }

    if (goal.includes('laptop')) {
      return res.json({
        products: [
          { title: 'Business Laptop 15"', price: '€779,00', url: 'http://localhost:3099/harness/mock-shop-b.html?p=laptop-business', confidence: 'high' },
          { title: 'Gaming Laptop 17"', price: '€1.399,00', url: 'http://localhost:3099/harness/mock-shop-b.html?p=laptop-gaming', confidence: 'high' },
        ],
        pageType: 'search_results',
        siteName: 'Mock Shop B',
        trustScore: 8.2,
        trustRationale: 'Mock marketplace B',
      });
    }
  }

  res.json({
    products: [],
    pageType: 'general',
    siteName: 'Test Site',
    trustScore: 8,
    trustRationale: 'Test page with known structure.',
  });
});

app.post('/api/agent/compare', (req, res) => {
  const allProducts = (req.body.results || []).flatMap((siteResult) =>
    (siteResult.results || []).map((item) => ({
      ...item,
      site: siteResult.site,
      trustScore: siteResult.trustScore || 8,
    }))
  );

  if (allProducts.length === 0) {
    return res.status(422).json({ error: 'No products to compare.' });
  }

  const parsePrice = (price) => {
    const match = String(price || '').match(/(\d[\d.,]*)/);
    if (!match) return Number.POSITIVE_INFINITY;
    return Number(match[1].replace(/\./g, '').replace(',', '.'));
  };

  allProducts.sort((a, b) => parsePrice(a.price) - parsePrice(b.price));
  const winner = allProducts[0];

  res.json({
    winner: {
      title: winner.title,
      price: winner.price,
      url: winner.url,
      site: winner.site,
      rationale: 'Cheapest valid product after filtering.',
      trustBadge: 'verified',
      trustScore: winner.trustScore,
      finalScore: 95,
    },
    alternatives: allProducts.slice(1, 3).map((item) => ({
      title: item.title,
      price: item.price,
      url: item.url,
      site: item.site,
      note: 'Alternative option',
      trustBadge: 'verified',
      trustScore: item.trustScore,
    })),
    summary: `Best match: ${winner.title} at ${winner.price}`,
  });
});

// ── CHAIN EXECUTION (Phase 5) ────────────────────────────────
app.post('/api/agent/chain/plan', (req, res) => {
  const userRequest = (req.body.userRequest || '').toLowerCase();

  // Multi-site: Amazon + Gmail
  if (userRequest.includes('amazon') && (userRequest.includes('email') || userRequest.includes('gmail'))) {
    return res.json({
      success: true,
      isChain: true,
      subTasks: [
        {
          order: 1,
          intent: 'search for a product on Amazon',
          domain: 'amazon.com',
          category: 'search',
          inputs: [{ name: 'search_query', value: 'laptop', source: 'user' }],
          outputs: [{ name: 'product_url', type: 'page-url' }, { name: 'product_title', type: 'text-content' }],
          recipe: null,
          recipeScore: 0,
          executionMethod: 'ai_reasoning',
          resolvedInputs: { search_query: 'laptop' },
          pendingInputs: [],
        },
        {
          order: 2,
          intent: 'compose and send an email in Gmail',
          domain: 'mail.google.com',
          category: 'compose',
          inputs: [
            { name: 'recipient', value: 'john@gmail.com', source: 'user' },
            { name: 'product_url', source: 'previous_step', fromStep: 1, fromOutput: 'product_url' },
          ],
          outputs: [{ name: 'send_confirmation', type: 'boolean' }],
          recipe: null,
          recipeScore: 0,
          executionMethod: 'ai_reasoning',
          resolvedInputs: { recipient: 'john@gmail.com' },
          pendingInputs: [{ name: 'product_url', source: 'previous_step', fromStep: 1, fromOutput: 'product_url' }],
        },
      ],
      totalSteps: 2,
      recipeCount: 0,
      aiCount: 2,
    });
  }

  // Single-site fallback
  res.json({ success: true, isChain: false, subTasks: [{ order: 1, intent: userRequest, domain: req.body.currentDomain || 'unknown', category: 'other', inputs: [], outputs: [] }] });
});

app.post('/api/agent/chain/resolve-inputs', (req, res) => {
  const { subTask, outputStore } = req.body;
  const resolved = {};
  if (subTask && subTask.inputs) {
    for (const input of subTask.inputs) {
      if (input.source === 'user' && input.value) {
        resolved[input.name] = input.value;
      } else if (input.source === 'previous_step' && outputStore) {
        const prev = outputStore[input.fromStep];
        if (prev && prev[input.fromOutput]) {
          resolved[input.name] = prev[input.fromOutput];
        }
      }
    }
  }
  res.json({ success: true, resolvedInputs: resolved });
});

// ── RECIPES ──────────────────────────────────────────────────
// Phase 2+3: Structural matching — returns recipe with fingerprint
app.get('/api/recipes/match', (req, res) => {
  const task = (req.query.task || '').toLowerCase();
  if (task.includes('known-recipe')) {
    return res.json(fixture('recipe-match.json'));
  }
  // Phase 2: structural match — return recipe for "fill form" style tasks
  if (task.includes('fill') && task.includes('form')) {
    return res.json(fixture('recipe-match-fingerprint.json'));
  }
  res.json({ success: true, found: false });
});

app.get('/api/recipes/mine', (req, res) => {
  res.json(fixture('recipes-mine.json'));
});

app.post('/api/recipes', (req, res) => {
  // Phase 1: return fingerprint + autoDescription with saved recipe
  const steps = req.body.steps || [];
  const domains = [...new Set(steps.map(s => { try { return new URL(s.url || '').hostname.replace(/^www\./, ''); } catch { return 'unknown'; } }))];
  res.json({
    success: true,
    recipe: {
      id: 'recipe-new-001',
      ...req.body,
      fingerprint: {
        domains,
        actionSignature: steps.slice(0, 10).map(s => ({ action: s.action?.type || 'unknown', target: 'generic-element', domain: domains[0] || null })),
        category: 'other',
        subCategory: null,
        requiresInputs: [],
        producesOutputs: ['page-url'],
      },
      autoDescription: 'Auto-generated: workflow on ' + (domains[0] || 'unknown'),
      isSegment: domains.length > 1, // Phase 4: multi-domain = segmented
      parentRecipeId: null,
    },
  });
});

// Phase 1: Backfill fingerprints
app.post('/api/recipes/backfill-fingerprints', (req, res) => {
  res.json({ success: true, processed: 2, fingerprinted: 2, errors: 0 });
});

// Phase 4: Backfill segments
app.post('/api/recipes/backfill-segments', (req, res) => {
  res.json({ success: true, processed: 1, segmented: 1, segmentsCreated: 2, errors: 0 });
});

app.get('/api/recipes/atlas', (req, res) => {
  res.json({ success: true, recipes: [] });
});

app.put('/api/recipes/:id/validate', (req, res) => {
  res.json({ success: true });
});

app.put('/api/recipes/:id/fail', (req, res) => {
  res.json({ success: true });
});

app.delete('/api/recipes/:id', (req, res) => {
  res.json({ success: true });
});

// ── TODOS ────────────────────────────────────────────────────
app.get('/api/todos', (req, res) => {
  res.json({
    todos: [
      { id: 'todo-1', title: 'Review quarterly report', status: 'PENDING', priority: 'HIGH', dueDate: '2026-03-25', aiCreated: false },
      { id: 'todo-2', title: 'Send follow-up email', status: 'PENDING', priority: 'MEDIUM', dueDate: '2026-03-20', aiCreated: true },
      { id: 'todo-3', title: 'Update project roadmap', status: 'IN_PROGRESS', priority: 'LOW', dueDate: null, aiCreated: false },
    ],
  });
});

app.post('/api/todos', (req, res) => {
  res.json({ success: true, data: { id: 'todo-new-001', userId: 'test-user-001', ...req.body, createdAt: new Date().toISOString() } });
});

app.patch('/api/todos/:id', (req, res) => {
  res.json({ success: true, data: { id: req.params.id, ...req.body } });
});

// ── MODELS ───────────────────────────────────────────────────
app.get('/api/models', (req, res) => {
  res.json(fixture('models-registry.json'));
});

// ── BILLING ──────────────────────────────────────────────────
app.get('/api/billing/balance', (req, res) => {
  res.json({ success: true, balance: 100, status: 'active', isTrial: false });
});

app.get('/api/billing/usage', (req, res) => {
  res.json({ success: true, usage: [] });
});

app.get('/api/billing/bundles', (req, res) => {
  res.json([{ id: 'bundle-1', label: 'Starter Pack', credits: 1000, price_usd: 15, isActive: true }]);
});

app.post('/api/billing/grant-trial', (req, res) => {
  res.json({ success: true, balance: 50, alreadyGranted: false });
});

// ── MEMORY ───────────────────────────────────────────────────
app.get('/api/teach-agent/:userId', (req, res) => {
  res.json({ facts: [], goals: [], traits: [] });
});

app.post('/api/memory/signal', (req, res) => {
  res.json({ success: true });
});

// ── SKILLS ───────────────────────────────────────────────────
app.post('/api/skills/resolve-site', (req, res) => {
  const domain = String(req.body.domain || '').toLowerCase();
  if (domain === 'mockshop-a') {
    return res.json({
      success: true,
      fromCache: false,
      skill: { id: 'skill-mockshop-a', searchUrl: 'http://localhost:3099/harness/mock-shop-a.html?q={query}' },
    });
  }
  if (domain === 'mockshop-b') {
    return res.json({
      success: true,
      fromCache: false,
      skill: { id: 'skill-mockshop-b', searchUrl: 'http://localhost:3099/harness/mock-shop-b.html?q={query}' },
    });
  }
  res.json({ success: true, skill: null, fromCache: false });
});

app.post('/api/skills/record-outcome', (req, res) => {
  res.json({ success: true });
});

app.post('/api/skills/regenerate', (req, res) => {
  res.json({ success: true });
});

app.post('/api/skills/should-regenerate', (req, res) => {
  res.json({ shouldRegenerate: false });
});

// ── SITEMAP ──────────────────────────────────────────────────
app.post('/api/sitemap/capture', (req, res) => {
  res.json({ success: true });
});

app.get('/api/sitemap/lookup', (req, res) => {
  res.json({ success: true, found: false });
});

// ── HEALTH ───────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ── RECIPE LLM FILL ──────────────────────────────────────────
app.post('/api/agent/recipe-fill', (req, res) => {
  res.json({ success: true, text: 'AI-generated text for recipe fill' });
});

// ── CATCH-ALL for unhandled routes ───────────────────────────
app.use((req, res) => {
  console.log(`[MockServer] Unhandled: ${req.method} ${req.url}`);
  res.status(404).json({ success: false, error: `Mock not implemented: ${req.method} ${req.url}` });
});

// ── START ────────────────────────────────────────────────────
const PORT = process.env.MOCK_PORT || 3099;
const server = app.listen(PORT, () => {
  console.log(`[MockServer] Running on http://localhost:${PORT}`);
});

module.exports = { app, server };
