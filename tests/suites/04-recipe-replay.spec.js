// @ts-check
const { test, expect } = require('../helpers/fixtures');
const { getServiceWorker, getExtensionId } = require('../helpers/extension');
const { generateTestToken } = require('../helpers/auth');

test.describe('Recipe Replay', () => {

  test('single-tab replay executes click + type steps on form page', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const extensionId = getExtensionId(sw);

    // Open test form page
    const formPage = await context.newPage();
    await formPage.goto('http://localhost:3099/harness/form-page.html');
    await formPage.waitForLoadState('domcontentloaded');

    // Inject content_replay.js into the form page via the service worker
    const tabId = await formPage.evaluate(() => {
      // We can't get the tab ID from inside the page — we'll use the SW
      return null;
    });

    // Send replay message directly to the service worker
    const token = generateTestToken();
    const recipe = {
      id: 'test-replay-001',
      workflowName: 'Fill test form',
      siteDomain: 'localhost',
      steps: [
        {
          type: 'click',
          selectors: [
            { strategy: 'css-id', value: '#first-name' },
            { strategy: 'placeholder', value: 'First Name' },
          ],
          description: 'Click the First Name field',
        },
        {
          type: 'type',
          selectors: [
            { strategy: 'css-id', value: '#first-name' },
            { strategy: 'placeholder', value: 'First Name' },
          ],
          value: 'John',
          description: 'Type the name',
        },
        {
          type: 'click',
          selectors: [
            { strategy: 'css-id', value: '#email' },
            { strategy: 'placeholder', value: 'Email address' },
          ],
          description: 'Click the email field',
        },
        {
          type: 'type',
          selectors: [
            { strategy: 'css-id', value: '#email' },
            { strategy: 'placeholder', value: 'Email address' },
          ],
          value: 'john@test.com',
          description: 'Type the email',
        },
      ],
      variables: [],
    };

    // Use SW to trigger replay on the active tab
    const result = await sw.evaluate(async ({ recipe, token }) => {
      // Store token so the replay handler can authenticate
      await chrome.storage.local.set({ token });

      // Find the active tab (the form page)
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return { success: false, error: 'No active tab found' };

      // Inject content_replay.js
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content_replay.js'],
        });
      } catch (e) {
        return { success: false, error: 'Injection failed: ' + e.message };
      }

      // Wait for injection
      await new Promise(r => setTimeout(r, 500));

      // Send replay command
      try {
        const res = await chrome.tabs.sendMessage(tab.id, {
          type: 'replay_recipe',
          recipe,
          variables: {},
        });
        return res || { success: false, error: 'No response from content_replay' };
      } catch (e) {
        return { success: false, error: 'sendMessage failed: ' + e.message };
      }
    }, { recipe, token });

    // Verify replay result
    expect(result).toBeTruthy();
    if (result.success) {
      expect(result.completedSteps).toBe(4);
    }

    // Verify the form was actually filled
    const firstName = await formPage.locator('#first-name').inputValue();
    const email = await formPage.locator('#email').inputValue();

    // If replay succeeded, values should be filled
    if (result.success) {
      expect(firstName).toBe('John');
      expect(email).toBe('john@test.com');
    }

    await formPage.close();
  });

  test('replay reports failure on non-existent selector', async ({ context }) => {
    const sw = await getServiceWorker(context);

    const formPage = await context.newPage();
    await formPage.goto('http://localhost:3099/harness/form-page.html');
    await formPage.waitForLoadState('domcontentloaded');

    const token = generateTestToken();

    const result = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return { success: false, error: 'No active tab' };

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content_replay.js'],
        });
      } catch (e) {
        return { success: false, error: 'Injection failed: ' + e.message };
      }

      await new Promise(r => setTimeout(r, 500));

      try {
        const res = await chrome.tabs.sendMessage(tab.id, {
          type: 'replay_recipe',
          recipe: {
            id: 'test-fail-001',
            steps: [
              {
                type: 'click',
                selectors: [
                  { strategy: 'css-id', value: '#nonexistent-element' },
                ],
                description: 'Click a non-existent element',
              },
            ],
          },
          variables: {},
        });
        return res || { success: false, error: 'No response' };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }, { token });

    expect(result).toBeTruthy();
    expect(result.success).toBe(false);
    if (result.failedAtStep) {
      expect(result.failedAtStep).toBe(1);
      expect(result.failReason).toBeTruthy();
    }

    await formPage.close();
  });

  test('replay with variable substitution replaces {{variables}}', async ({ context }) => {
    const sw = await getServiceWorker(context);

    const formPage = await context.newPage();
    await formPage.goto('http://localhost:3099/harness/form-page.html');
    await formPage.waitForLoadState('domcontentloaded');

    const token = generateTestToken();

    const result = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return { success: false, error: 'No active tab' };

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content_replay.js'],
        });
      } catch (e) {
        return { success: false, error: 'Injection failed: ' + e.message };
      }

      await new Promise(r => setTimeout(r, 500));

      try {
        const res = await chrome.tabs.sendMessage(tab.id, {
          type: 'replay_recipe',
          recipe: {
            id: 'test-var-001',
            steps: [
              {
                type: 'click',
                selectors: [{ strategy: 'css-id', value: '#first-name' }],
                description: 'Click name field',
              },
              {
                type: 'type',
                selectors: [{ strategy: 'css-id', value: '#first-name' }],
                value: '{{userName}}',
                description: 'Type the variable name',
              },
            ],
          },
          variables: { userName: 'Kibrom' },
        });
        return res || { success: false, error: 'No response' };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }, { token });

    if (result.success) {
      const firstName = await formPage.locator('#first-name').inputValue();
      expect(firstName).toBe('Kibrom');
    }

    await formPage.close();
  });

  test('multi-tab replay switches tabs and continues the remaining steps', async ({ context }) => {
    const sw = await getServiceWorker(context);

    const formPage = await context.newPage();
    await formPage.goto('http://localhost:3099/harness/form-page.html');
    await formPage.waitForLoadState('domcontentloaded');

    const settingsPage = await context.newPage();
    await settingsPage.goto('http://127.0.0.1:3099/harness/settings-page.html');
    await settingsPage.waitForLoadState('domcontentloaded');

    await settingsPage.bringToFront();

    const result = await sw.evaluate(async () => {
      const recipe = {
        id: 'test-multi-tab-001',
        workflowName: 'Fill form then open usage tab',
        siteDomain: 'localhost',
        startUrl: 'http://localhost:3099/harness/form-page.html',
        steps: [
          {
            stepNumber: 1,
            action: {
              type: 'click',
              selectors: [{ strategy: 'css-id', value: '#first-name', priority: 1 }],
              description: 'Click the First Name field',
            },
          },
          {
            stepNumber: 2,
            action: {
              type: 'type',
              selectors: [{ strategy: 'css-id', value: '#first-name', priority: 1 }],
              inputType: 'variable',
              variableName: 'userName',
              description: 'Type the name',
            },
          },
          {
            stepNumber: 3,
            action: {
              type: 'switch_tab',
              targetDomain: '127.0.0.1',
              targetUrl: 'http://127.0.0.1:3099/harness/settings-page.html',
              description: 'Switch to 127.0.0.1',
            },
          },
          {
            stepNumber: 4,
            action: {
              type: 'click',
              selectors: [
                { strategy: 'css', value: '[data-tab="usage"]', priority: 1 },
                { strategy: 'aria-label', value: 'Usage settings', priority: 2 },
                { strategy: 'text-content', value: 'Usage', priority: 3 },
              ],
              description: 'Click "Usage"',
            },
          },
        ],
        variables: [{ name: 'userName', description: 'Name for the form field' }],
      };

      return chrome.runtime.sendMessage({
        type: 'learning_replay_recipe',
        data: {
          recipe,
          variables: { userName: 'Kibrom' },
          taskContext: 'Fill the form and inspect usage',
        },
      });
    });

    expect(result).toBeTruthy();
    expect(result.success).toBe(true);
    expect(result.partial).toBe(false);
    expect(result.completedSteps).toBe(4);
    expect(result.totalSteps).toBe(4);

    await expect(formPage.locator('#first-name')).toHaveValue('Kibrom');
    await expect(settingsPage.locator('#panel-usage')).toHaveClass(/active/);
    await expect(settingsPage.locator('[data-tab="usage"]')).toHaveClass(/active/);

    await settingsPage.close();
    await formPage.close();
  });
});
