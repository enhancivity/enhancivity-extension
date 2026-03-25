// @ts-check
const { test, expect } = require('../helpers/fixtures');
const { getServiceWorker, getExtensionId } = require('../helpers/extension');
const { injectAuth } = require('../helpers/auth');

async function createExtensionPage(context, sw) {
  const extensionId = getExtensionId(sw);
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await extensionPage.waitForLoadState('domcontentloaded');
  return extensionPage;
}

async function initializeLearningRecorder(sw, extensionPage) {
  const tab = await sw.evaluate(async () => {
    await chrome.storage.session.remove(['learningSession', 'pendingRecipe']);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ? { id: tab.id, url: tab.url } : null;
  });

  if (!tab?.id || !tab.url) {
    return { success: false, stage: 'active-tab', error: 'No active harness tab found' };
  }

  const sessionStart = await extensionPage.evaluate(async (activeTab) => {
    return chrome.runtime.sendMessage({
      type: 'learning_session_start',
      data: {
        workflowName: 'Accessibility learning harness',
        tabId: activeTab.id,
        tabUrl: activeTab.url,
      },
    });
  }, tab);

  if (!sessionStart?.success) {
    return sessionStart || { success: false, stage: 'session-start', error: 'Failed to start learning session' };
  }

  const learningStart = await sw.evaluate(async (activeTabId) => {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      files: ['content_learning.js'],
    });

    await new Promise(resolve => setTimeout(resolve, 300));
    return chrome.tabs.sendMessage(activeTabId, { type: 'learning_start' });
  }, tab.id);

  return learningStart?.success
    ? learningStart
    : { ...(learningStart || {}), success: false, stage: 'learning-start' };
}

async function readBuiltRecipeFromLearningSession(sw) {
  return sw.evaluate(async () => {
    const { learningSession } = await chrome.storage.session.get('learningSession');
    if (!learningSession || typeof buildRecipeFromSession !== 'function') {
      return null;
    }

    const recipe = buildRecipeFromSession(learningSession);
    await chrome.storage.session.remove(['learningSession', 'pendingRecipe']);
    return recipe;
  });
}

async function readLearningSessionStepCount(sw) {
  return sw.evaluate(async () => {
    const { learningSession } = await chrome.storage.session.get('learningSession');
    return learningSession?.steps?.length || 0;
  });
}

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

async function takeExploreSnapshotOnActiveTab(sw) {
  return sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      return { success: false, error: 'No active tab found' };
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content_explore.js'],
    });

    await new Promise(resolve => setTimeout(resolve, 300));
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, {
        type: 'explore_action',
        actionType: 'take_snapshot',
      }, (resp) => resolve(resp || { success: false, error: chrome.runtime.lastError?.message }));
    });
  });
}

test.describe('Agent Accessibility', () => {
  test('recording captures DOM-derived accessibility metadata in recipe steps', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const extensionPage = await createExtensionPage(context, sw);
    await injectAuth(extensionPage);

    const page = await context.newPage();
    await page.goto('http://localhost:3099/harness/a11y-form.html');
    await page.waitForLoadState('domcontentloaded');
    await page.bringToFront();

    const startResult = await initializeLearningRecorder(sw, extensionPage);
    expect(startResult?.success).toBe(true);
    await page.waitForSelector('#enh-learning-overlay', { state: 'attached' });

    await page.locator('#compose-button').click();
    await expect(page.locator('#enh-learn-step-count')).toHaveText('Step 1');
    await expect.poll(async () => {
      return readLearningSessionStepCount(sw);
    }, { timeout: 5_000 }).toBe(1);

    const recipe = await readBuiltRecipeFromLearningSession(sw);
    expect(recipe).toBeTruthy();

    const clickStep = recipe.steps.find(step => step.action?.type === 'click');
    expect(clickStep).toBeTruthy();
    expect(clickStep.action.semanticContext.a11y).toMatchObject({
      name: 'Compose',
      role: 'button',
      ariaLabel: 'Compose',
      ariaDescribedBy: 'Open the composer panel',
      states: {
        disabled: false,
        expanded: false,
        modal: false,
      },
    });

    await page.close();
    await extensionPage.close();
  });

  test('replay falls back to accessibility data when DOM selectors are stale', async ({ context }) => {
    const sw = await getServiceWorker(context);

    const page = await context.newPage();
    await page.goto('http://localhost:3099/harness/icon-only.html');
    await page.waitForLoadState('domcontentloaded');
    await page.bringToFront();

    const recipe = {
      id: 'a11y-replay-fallback-001',
      workflowName: 'Click icon-only home button',
      siteDomain: 'localhost',
      steps: [
        {
          stepNumber: 1,
          action: {
            type: 'click',
            selectors: [
              { strategy: 'css-id', value: '#legacy-home-button', priority: 1 },
              { strategy: 'css', value: '.missing-home-button', priority: 2 },
            ],
            description: 'Activate the icon-only home control',
            semanticContext: {
              a11y: {
                name: 'Home',
                role: 'button',
                ariaLabel: 'Home',
              },
            },
          },
        },
      ],
    };

    const result = await runReplayOnActiveTab(sw, recipe);

    expect(result).toBeTruthy();
    expect(result.success).toBe(true);
    expect(result.results?.[0]?.usedStrategy).toBe('a11y-exact');
    await expect(page.locator('#status')).toHaveText('clicked-home');

    await page.close();
  });

  test('explore snapshots include aria role and label metadata', async ({ context }) => {
    const sw = await getServiceWorker(context);

    const page = await context.newPage();
    await page.goto('http://localhost:3099/harness/a11y-form.html');
    await page.waitForLoadState('domcontentloaded');
    await page.bringToFront();

    const result = await takeExploreSnapshotOnActiveTab(sw);

    expect(result?.success).toBe(true);
    const snapshot = result.snapshot;
    expect(snapshot).toBeTruthy();

    const composeElement = snapshot.semanticElements.find(element =>
      element?.aria?.role === 'button' && element?.aria?.label === 'Compose'
    );

    expect(composeElement).toBeTruthy();

    await page.close();
  });

  test('explore detects open modals via aria attributes', async ({ context }) => {
    const sw = await getServiceWorker(context, 60_000);

    const page = await context.newPage();
    await page.goto('http://localhost:3099/harness/modal-aria.html');
    await page.waitForLoadState('domcontentloaded');
    await page.bringToFront();

    const result = await takeExploreSnapshotOnActiveTab(sw);

    expect(result?.success).toBe(true);
    expect(result?.snapshot?.hasOpenModal).toBe(true);

    await page.close();
  });
});
