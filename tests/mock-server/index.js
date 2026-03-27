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

// ── Data-transfer scenario support ───────────────────────────
let activeScenario = 'default';
let dataTransferStep = 0;

// ── SPA-stale scenario support ────────────────────────────────
let spaStaleStep = 0;
let spaStaleReady = false; // set true when explore-step is in-flight → signals harness page to pushState

// ── DOM-verify scenario support ───────────────────────────────
let domVerifyStep = 0;
let domVerifyStep2Content = null; // mainContent seen by the AI at step 2 (after the click)

const SUBSCRIPTION_TSV = 'Service\tPlan\tAmount\tNext Billing\nSpotify\tPremium\t$9.99\tApr 15\nNetflix\tStandard\t$15.49\tApr 20\nGitHub\tPro\t$4.00\tApr 1\nClaude\tMax\t$100.00\tApr 10';
const SUBSCRIPTION_TSV_BATCH2 = 'AWS\tBusiness\t$29.99\tApr 5';
const SPREADSHEET_URL = 'http://localhost:3099/harness/spreadsheet.html';
const EMAIL_URL = 'http://localhost:3099/harness/email-detail.html';

// ── ERROR MODE (for testing error scenarios) ─────────────────
// Tests toggle this by POSTing to /test/set-error-mode
let errorMode = null;

app.post('/test/set-error-mode', (req, res) => {
  errorMode = req.body.mode; // null | '500' | '401' | '402' | 'timeout'
  res.json({ success: true, mode: errorMode });
});

app.post('/test/set-scenario', (req, res) => {
  activeScenario = req.body.scenario || 'default';
  dataTransferStep = 0;
  res.json({ success: true, scenario: activeScenario });
});

app.post('/test/reset', (req, res) => {
  errorMode = null;
  exploreStepCounter = 0;
  activeScenario = 'default';
  dataTransferStep = 0;
  spaStaleStep = 0;
  spaStaleReady = false;
  domVerifyStep = 0;
  domVerifyStep2Content = null;
  res.json({ success: true });
});

// ── SPA-stale coordination: harness page polls this until ready to pushState ──
app.get('/test/spa-stale-ready', (req, res) => {
  res.json({ ready: spaStaleReady });
});

// ── DOM-verify: expose the mainContent the AI saw at step 2 (after the click) ──
app.get('/test/dom-verify-step2-snapshot', (req, res) => {
  res.json({ content: domVerifyStep2Content });
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
  // ── Data-transfer scenario: email → spreadsheet (6 steps) ──
  if (activeScenario === 'data-transfer') {
    dataTransferStep++;
    const steps = [
      // Step 1: Scrape email page, extract subscription data
      { nextAction: { type: 'scrape_page', description: 'Read subscription table from email' }, extractedData: SUBSCRIPTION_TSV, reasoning: 'Extracting subscription data from email.' },
      // Step 2: Navigate to spreadsheet
      { nextAction: { type: 'navigate', target: SPREADSHEET_URL, description: 'Navigate to spreadsheet' }, reasoning: 'Moving to target spreadsheet.' },
      // Step 3: Click cell A1
      { nextAction: { type: 'click_element', target: 'cell-a1', description: 'Click cell A1 to start pasting' }, reasoning: 'Selecting starting cell.' },
      // Step 4: Paste scratchpad data
      { nextAction: { type: 'paste_tsv', value: '__USE_SCRATCHPAD__', description: 'Paste subscription data into spreadsheet' }, reasoning: 'Bulk-pasting extracted data.' },
      // Step 5: Verify paste
      { nextAction: { type: 'scrape_page', description: 'Verify data landed in spreadsheet' }, reasoning: 'Checking paste result.' },
      // Step 6: Goal complete
      { isGoalComplete: true, goalResult: 'Successfully transferred subscription data (4 rows × 4 columns) from email to spreadsheet.', nextAction: null },
    ];
    const step = steps[Math.min(dataTransferStep - 1, steps.length - 1)];
    return res.json({
      nextAction: step.nextAction || null,
      reasoning: step.reasoning || 'Completing task.',
      revisedStrategy: null,
      isGoalComplete: step.isGoalComplete || false,
      goalResult: step.goalResult || null,
      extractedData: step.extractedData || null,
      needsConsent: false,
      consentReason: null,
    });
  }

  // ── Data-transfer-roundtrip scenario: email → sheet → email → sheet (10 steps) ──
  // Tests that navigate to the same URL twice does NOT trigger cycle detection
  if (activeScenario === 'data-transfer-roundtrip') {
    dataTransferStep++;
    const steps = [
      // Step 1: Scrape email — batch 1
      { nextAction: { type: 'scrape_page', description: 'Read subscription table from email' }, extractedData: SUBSCRIPTION_TSV, reasoning: 'Extracting first batch of data.' },
      // Step 2: Navigate to spreadsheet
      { nextAction: { type: 'navigate', target: SPREADSHEET_URL, description: 'Navigate to spreadsheet' }, reasoning: 'Moving to spreadsheet.' },
      // Step 3: Click cell A1
      { nextAction: { type: 'click_element', target: 'cell-a1', description: 'Click cell A1' }, reasoning: 'Selecting starting cell.' },
      // Step 4: Paste batch 1
      { nextAction: { type: 'paste_tsv', value: '__USE_SCRATCHPAD__', description: 'Paste first batch' }, reasoning: 'Pasting first batch.' },
      // Step 5: Navigate BACK to email for more data
      { nextAction: { type: 'navigate', target: EMAIL_URL, description: 'Navigate back to email for more data' }, reasoning: 'Returning to source for second batch.' },
      // Step 6: Scrape email — batch 2
      { nextAction: { type: 'scrape_page', description: 'Read additional data from email' }, extractedData: SUBSCRIPTION_TSV_BATCH2, reasoning: 'Extracting second batch.' },
      // Step 7: Navigate to spreadsheet AGAIN (same URL as step 2 — would trigger old cycle bug)
      { nextAction: { type: 'navigate', target: SPREADSHEET_URL, description: 'Navigate back to spreadsheet' }, reasoning: 'Returning to spreadsheet with second batch.' },
      // Step 8: Click cell A5
      { nextAction: { type: 'click_element', target: 'cell-a5', description: 'Click cell A5' }, reasoning: 'Selecting next empty cell.' },
      // Step 9: Paste batch 2
      { nextAction: { type: 'paste_tsv', value: '__USE_SCRATCHPAD__', description: 'Paste second batch' }, reasoning: 'Pasting second batch.' },
      // Step 10: Goal complete
      { isGoalComplete: true, goalResult: 'Successfully transferred all subscription data (5 rows) from email to spreadsheet in 2 batches.', nextAction: null },
    ];
    const step = steps[Math.min(dataTransferStep - 1, steps.length - 1)];
    return res.json({
      nextAction: step.nextAction || null,
      reasoning: step.reasoning || 'Completing task.',
      revisedStrategy: null,
      isGoalComplete: step.isGoalComplete || false,
      goalResult: step.goalResult || null,
      extractedData: step.extractedData || null,
      needsConsent: false,
      consentReason: null,
    });
  }

  // ── needs-consent scenario: step 2 requires One-Inch Rule approval ──
  // Tests that the exploration loop resumes after user clicks "Approve & Execute".
  // BUG 1: hudConsent() used sendMessage — SW suspension dropped the Promise.
  // FIX: Route consent through chrome.storage.session (storage.onChanged wakes SW).
  if (activeScenario === 'needs-consent') {
    dataTransferStep++;
    const steps = [
      // Step 1: Scrape current page (no consent needed)
      { nextAction: { type: 'scrape_page', description: 'Read current page' }, reasoning: 'Initial observation.' },
      // Step 2: Require One-Inch Rule consent before modifying spreadsheet
      {
        needsConsent: true, consentReason: 'Adding database headers to spreadsheet',
        nextAction: { type: 'type_text', target: 'inp-0', value: 'Subject', description: 'Type Subject header' },
        reasoning: 'Consent required before modifying the spreadsheet.',
      },
      // Step 3: Post-approval — loop resumes here (proves BUG 1 is fixed)
      { nextAction: { type: 'type_text', target: 'inp-1', value: 'Sender', description: 'Type Sender header' }, reasoning: 'Adding second column header.' },
      // Step 4: Goal complete
      { isGoalComplete: true, goalResult: 'Database headers added successfully', nextAction: null },
    ];
    const step = steps[Math.min(dataTransferStep - 1, steps.length - 1)];
    return res.json({
      nextAction: step.nextAction || null,
      reasoning: step.reasoning || 'Completing task.',
      revisedStrategy: null,
      isGoalComplete: step.isGoalComplete || false,
      goalResult: step.goalResult || null,
      extractedData: null,
      needsConsent: step.needsConsent || false,
      consentReason: step.consentReason || null,
    });
  }

  // ── pre-switch-no-extract scenario: AI omits extractedData before navigate ──
  // Tests the pre-switch capture safety net in background.js.
  // BUG 2: If AI navigates away without setting extractedData, dataBuffer stays
  // empty and paste_tsv has nothing to paste. FIX: background.js auto-captures
  // mainContent before any navigate when dataBuffer is empty.
  if (activeScenario === 'pre-switch-no-extract') {
    dataTransferStep++;
    const steps = [
      // Step 1: Navigate WITHOUT setting extractedData (simulates AI forgetting Rule 8)
      { nextAction: { type: 'navigate', target: SPREADSHEET_URL, description: 'Navigate to spreadsheet' }, reasoning: 'Opening spreadsheet (omitting pre-navigation capture).' },
      // Step 2: Paste from scratchpad — should work via pre-switch capture safety net
      { nextAction: { type: 'paste_tsv', value: '__USE_SCRATCHPAD__', description: 'Paste captured source data' }, reasoning: 'Pasting pre-captured data from scratchpad.' },
      // Step 3: Goal complete
      { isGoalComplete: true, goalResult: 'Data pasted to spreadsheet.', nextAction: null },
    ];
    const step = steps[Math.min(dataTransferStep - 1, steps.length - 1)];
    return res.json({
      nextAction: step.nextAction || null,
      reasoning: step.reasoning || 'Completing task.',
      revisedStrategy: null,
      isGoalComplete: step.isGoalComplete || false,
      goalResult: step.goalResult || null,
      extractedData: null,  // INTENTIONALLY absent — tests the safety net
      needsConsent: false,
      consentReason: null,
    });
  }

  // ── Default explore-step behavior ──
  if (activeScenario === 'action-history') {
    dataTransferStep++;
    const semanticElements = req.body.currentPageState?.semanticElements || [];
    const findSid = (needle) => {
      const lowerNeedle = needle.toLowerCase();
      const match = semanticElements.find((element) => {
        const text = String(element?.text || '').toLowerCase();
        const ariaLabel = String(element?.aria?.label || element?.attrs?.ariaLabel || '').toLowerCase();
        return text.includes(lowerNeedle) || ariaLabel.includes(lowerNeedle);
      });
      return match?.sid || null;
    };

    const usageSid = findSid('usage');
    const billingSid = findSid('billing');
    const generalSid = findSid('general');
    const steps = [
      { nextAction: { type: 'click_element', target: usageSid, description: 'Open the usage tab' }, reasoning: 'First, inspect usage settings.' },
      { nextAction: { type: 'click_element', target: billingSid, description: 'Open the billing tab' }, reasoning: 'Next, inspect billing settings.' },
      { nextAction: { type: 'click_element', target: generalSid, description: 'Return to the general tab' }, reasoning: 'Finally, return to the general tab.' },
      { isGoalComplete: true, goalResult: 'Exploration completed after reviewing all three settings tabs.', nextAction: null },
    ];
    const step = steps[Math.min(dataTransferStep - 1, steps.length - 1)];
    return res.json({
      nextAction: step.nextAction || null,
      reasoning: step.reasoning || 'Completing task.',
      revisedStrategy: null,
      isGoalComplete: step.isGoalComplete || false,
      goalResult: step.goalResult || null,
      extractedData: null,
      needsConsent: false,
      consentReason: null,
    });
  }

  // ── SPA-stale scenario ──────────────────────────────────────
  // Step 1: signal the harness page to do pushState, then after 300ms respond
  //         with "click butt-0" (targeting a Phase-A SID). The 300ms gap ensures
  //         the page's pushState fires — and sidsStale=true is set in background.js —
  //         before the response arrives, so the SPA_STALE_GUARD triggers.
  // ── DOM-verify scenario ──────────────────────────────────────────────────────
  // Step 1: Agent sees the page. Tell it to click butt-0 (the "Load Content" button).
  // Step 2: Agent sends the snapshot taken AFTER the click. Record mainContent so the
  //         test can assert it contains "FINAL CONTENT LOADED" (proving waitForDomChange
  //         waited for the 1500ms content load before snapshotting). Return goal complete.
  if (activeScenario === 'dom-verify') {
    domVerifyStep++;
    if (domVerifyStep === 1) {
      return res.json({
        nextAction: { type: 'click_element', target: 'butt-0', description: 'Click the Load Content button' },
        reasoning: 'Clicking the primary button to load content.',
        isGoalComplete: false,
        goalResult: null,
        revisedStrategy: null,
        needsConsent: false,
        consentReason: null,
        extractedData: null,
      });
    }
    // Step 2+: capture what the agent saw and finish.
    domVerifyStep2Content = req.body.currentPageState?.mainContent || '';
    return res.json({
      nextAction: null,
      isGoalComplete: true,
      goalResult: 'Content loaded successfully.',
      reasoning: 'Page shows loaded content — goal complete.',
      revisedStrategy: null,
      needsConsent: false,
      consentReason: null,
      extractedData: null,
    });
  }

  // Step 2+: return goal complete (agent recovered after re-snapshot).
  if (activeScenario === 'spa-stale') {
    spaStaleStep++;
    if (spaStaleStep === 1) {
      spaStaleReady = true; // harness page is polling this — it will pushState immediately
      return setTimeout(() => {
        res.json({
          nextAction: { type: 'click_element', target: 'butt-0', description: 'Click DELETE ALL DATA' },
          reasoning: 'Targeting the primary action button on the page.',
          isGoalComplete: false,
          goalResult: null,
          revisedStrategy: null,
          needsConsent: false,
          consentReason: null,
          extractedData: null,
        });
      }, 300);
    }
    return res.json({
      nextAction: null,
      isGoalComplete: true,
      goalResult: 'Goal achieved after re-snapshot following SPA navigation.',
      reasoning: 'Fresh snapshot confirmed goal completion.',
      revisedStrategy: null,
      needsConsent: false,
      consentReason: null,
      extractedData: null,
    });
  }

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

  // Ghost-chain test: returns a 2-sub-task chain on localhost so no external
  // tab navigation is needed. Sub-task 2 has a pendingInput (previous_step
  // reference) that triggers a /api/agent/chain/resolve-inputs call, which
  // is the observable used by 16-ghost-chain.spec.js.
  if (userRequest.includes('__ghost_test__')) {
    return res.json({
      success: true,
      isChain: true,
      subTasks: [
        {
          order: 1, intent: 'ghost test sub-task 1',
          domain: 'localhost', category: 'other',
          inputs: [], outputs: [{ name: 'page_title', type: 'text-content' }],
          recipe: null, recipeScore: 0, executionMethod: 'ai_reasoning',
          resolvedInputs: {}, pendingInputs: [],
        },
        {
          order: 2, intent: 'ghost test sub-task 2',
          domain: 'localhost', category: 'other',
          inputs: [{ name: 'prev_result', source: 'previous_step', fromStep: 1, fromOutput: 'page_title' }],
          outputs: [],
          recipe: null, recipeScore: 0, executionMethod: 'ai_reasoning',
          resolvedInputs: {},
          pendingInputs: [{ name: 'prev_result', source: 'previous_step', fromStep: 1, fromOutput: 'page_title' }],
        },
      ],
      totalSteps: 2, recipeCount: 0, aiCount: 2,
    });
  }

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
  // Bug 1 regression test: recipe with navigate URL baked in from recording time
  // The navigate step has ?k=tshirt — after fix, this should be replaced with __search_query
  if (task.includes('url-sub-test')) {
    return res.json({
      success: true,
      found: true,
      score: 75,
      recipe: {
        id: 'url-sub-test-001',
        workflowName: 'URL substitution test recipe',
        siteDomain: 'localhost',
        confidence: 0.8,
        validationCount: 5,
        status: 'CANDIDATE',
        steps: [
          {
            stepNumber: 1,
            action: {
              type: 'type',
              inputType: 'variable',
              variableName: '__search_query',
              originalFixedValue: 'tshirt',
              selectors: [{ strategy: 'css-id', value: '#search-box', priority: 1 }],
              description: 'Search box',
            },
          },
          {
            stepNumber: 2,
            action: {
              type: 'navigate',
              url: 'http://localhost:3099/harness/search-results.html?k=tshirt',
              description: 'Navigate to search results',
            },
          },
        ],
        variables: [{ name: '__search_query', description: 'Search query' }],
        fingerprint: { domains: ['localhost'], category: 'search', actionSignature: ['type', 'navigate'], requiresInputs: [], producesOutputs: ['page-url'] },
        autoDescription: 'URL substitution test',
      },
    });
  }

  // Bug 2 regression test: low-score recipe (27/100) should NOT auto-replay
  // Before fix: recipe fires and navigates away. After fix: skipped, page stays.
  if (task.includes('low-score-test')) {
    return res.json({
      success: true,
      found: true,
      score: 27,
      recipe: {
        id: 'low-score-test-001',
        workflowName: 'Low score test recipe',
        siteDomain: 'localhost',
        confidence: 0.3,
        validationCount: 1,
        status: 'CANDIDATE',
        steps: [
          {
            stepNumber: 1,
            action: {
              type: 'navigate',
              url: 'http://localhost:3099/harness/search-results.html',
              description: 'Navigate to search results (wrong page)',
            },
          },
        ],
        variables: [],
        fingerprint: { domains: ['localhost'], category: 'other', actionSignature: ['navigate'], requiresInputs: [], producesOutputs: ['page-url'] },
        autoDescription: 'Low score test',
      },
    });
  }

  // Low-score own recipe — always matched regardless of score
  if (task.includes('low-score-own')) {
    return res.json({
      success: true,
      found: true,
      recipe: {
        id: 'own-low-score-001',
        workflowName: 'My form recipe (low score)',
        siteDomain: 'localhost',
        stepCount: 2,
        confidence: 0.3,
        validationCount: 1,
        status: 'CANDIDATE',
        trainedBy: 'test-user-001',
        startUrl: 'http://localhost:3099/harness/form-page.html',
        steps: [
          { stepNumber: 1, action: { type: 'click', selectors: [{ strategy: 'css-id', value: '#first-name', priority: 1 }], description: 'Click name field' } },
          { stepNumber: 2, action: { type: 'type', selectors: [{ strategy: 'css-id', value: '#first-name', priority: 1 }], inputType: 'variable', variableName: 'userName', description: 'Type name' } },
        ],
        variables: [{ name: 'userName', description: 'Name' }],
        variables: [],
        fingerprint: { domains: ['localhost'], category: 'other', actionSignature: [], requiresInputs: [], producesOutputs: ['page-url'] },
        autoDescription: 'Low score own recipe',
      },
      matchType: 'structural',
      score: 5,
    });
  }
  // Community recipe recommendation
  if (task.includes('community-recipe')) {
    return res.json({
      success: true,
      found: true,
      recipe: {
        id: 'community-rec-001',
        workflowName: 'Community form fill',
        siteDomain: 'localhost',
        stepCount: 2,
        confidence: 0.9,
        validationCount: 10,
        status: 'PROMOTED',
        trainedBy: 'other-user-999',
        startUrl: 'http://localhost:3099/harness/form-page.html',
        steps: [
          { type: 'click', selectors: [{ strategy: 'css-id', value: '#first-name' }], description: 'Click name field' },
          { type: 'type', selectors: [{ strategy: 'css-id', value: '#first-name' }], value: 'CommunityUser', description: 'Type name' },
        ],
        variables: [],
        fingerprint: { domains: ['localhost'], category: 'fill-form', actionSignature: [], requiresInputs: [], producesOutputs: ['page-url'] },
        autoDescription: 'Community recommended recipe',
      },
      matchType: 'structural',
      score: 85,
    });
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

app.post('/api/sitemap/capture-action', (req, res) => {
  res.json({ success: true });
});

app.get('/api/sitemap/lookup', (req, res) => {
  res.json({ success: true, found: false });
});

app.post('/api/sitemap/lookup-action', (req, res) => {
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
