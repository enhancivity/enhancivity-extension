// @ts-check
const { test, expect } = require('../helpers/fixtures');
const { getServiceWorker } = require('../helpers/extension');

async function runReplayOnActiveTab(sw, recipe, variables = {}) {
  return sw.evaluate(async ({ recipe, variables }) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      return { success: false, error: 'No active tab found' };
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content_replay.js'],
    });

    await new Promise(resolve => setTimeout(resolve, 300));
    return chrome.tabs.sendMessage(tab.id, {
      type: 'replay_recipe',
      recipe,
      variables,
    });
  }, { recipe, variables });
}

test.describe('Recipe Replay Backward Compatibility', () => {
  test('old-format recipe (DOM selectors only, no a11y) replays successfully', async ({ context }) => {
    const sw = await getServiceWorker(context);

    const page = await context.newPage();
    await page.goto('http://localhost:3099/harness/icon-only.html');
    await page.waitForLoadState('domcontentloaded');
    await page.bringToFront();

    // Old-format recipe: selectors array only, no semanticContext.a11y
    const recipe = {
      id: 'backward-compat-001',
      workflowName: 'Click home button (old format, no a11y)',
      siteDomain: 'localhost',
      steps: [
        {
          stepNumber: 1,
          action: {
            type: 'click',
            selectors: [
              { strategy: 'css-id', value: '#home-button', priority: 1 },
            ],
            description: 'Click the home button',
            // No semanticContext — old format
          },
        },
      ],
    };

    const result = await runReplayOnActiveTab(sw, recipe);

    expect(result?.success).toBe(true);
    // Standard CSS selector should work — a11y fallback must NOT be needed
    expect(result?.results?.[0]?.usedStrategy).not.toContain('a11y');
    await expect(page.locator('#status')).toHaveText('clicked-home');

    await page.close();
  });

  test('old-format recipe with multiple selectors tries each in priority order', async ({ context }) => {
    const sw = await getServiceWorker(context);

    const page = await context.newPage();
    await page.goto('http://localhost:3099/harness/icon-only.html');
    await page.waitForLoadState('domcontentloaded');
    await page.bringToFront();

    // First selector is stale, second is valid — must fall through to second
    const recipe = {
      id: 'backward-compat-002',
      workflowName: 'Click home button via fallback selector',
      siteDomain: 'localhost',
      steps: [
        {
          stepNumber: 1,
          action: {
            type: 'click',
            selectors: [
              { strategy: 'css-id', value: '#stale-selector-does-not-exist', priority: 1 },
              { strategy: 'css-id', value: '#home-button', priority: 2 },
            ],
            description: 'Click the home button',
          },
        },
      ],
    };

    const result = await runReplayOnActiveTab(sw, recipe);

    expect(result?.success).toBe(true);
    expect(result?.results?.[0]?.usedStrategy).not.toContain('a11y');
    await expect(page.locator('#status')).toHaveText('clicked-home');

    await page.close();
  });
});
