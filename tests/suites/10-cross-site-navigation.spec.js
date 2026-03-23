// @ts-check
const { test: base, expect, chromium } = require('@playwright/test');
const path = require('path');
const { generateTestToken } = require('../helpers/auth');

/**
 * Regression test: Content script communication after full-page cross-site navigation.
 *
 * Bug scenario: Agent searches on Amazon (Site A), finds results, then navigates
 * to Gmail (Site B) to compose an email. The old content script dies during the
 * full-page navigation ("message channel closed"). The extension must re-inject
 * and communicate with the content script on the new page.
 *
 * This test verifies:
 * 1. chrome.scripting.executeScript works on Site A
 * 2. Full-page navigation to Site B
 * 3. chrome.scripting.executeScript works on Site B (after re-injection)
 * 4. chrome.tabs.sendMessage works on Site B (simulates replay/explore communication)
 *
 * Run with: npx playwright test 10-cross-site-navigation
 */

const test = base.extend({
  extensionContext: async ({}, use) => {
    const extPath = path.resolve(__dirname, '..', '..');
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
        '--no-first-run',
        '--disable-popup-blocking',
      ],
    });
    await use(context);
    await context.close();
  },
});

test.describe('Cross-site navigation: content script survival', () => {

  test('executeScript works on both pages after full navigation', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();

    // Navigate to Site A (search results)
    await page.goto('http://localhost:3099/harness/search-results.html?k=laptop+under+500+euro');
    await page.waitForLoadState('domcontentloaded');

    // Wait for service worker
    let sw;
    for (let i = 0; i < 30; i++) {
      sw = context.serviceWorkers().find(w => w.url().includes('background'));
      if (sw) break;
      await page.waitForTimeout(500);
    }
    expect(sw, 'Service worker should be running').toBeTruthy();

    // Step 1: Execute script on Site A — capture product data
    const siteAResult = await sw.evaluate(async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => ({
          title: document.title,
          url: location.href,
          productCount: document.querySelectorAll('.product').length,
          alive: true,
        }),
      });
      return { tabId: activeTab.id, data: result?.result };
    });

    expect(siteAResult.data.alive).toBe(true);
    expect(siteAResult.data.title).toContain('Search Results');
    expect(siteAResult.data.productCount).toBe(3);
    const tabId = siteAResult.tabId;

    // Step 2: Full-page navigation to Site B (email compose form)
    // This is the critical transition — content script from Site A dies here
    await page.goto('http://localhost:3099/harness/form-page.html');
    await page.waitForLoadState('domcontentloaded');

    // Step 3: Execute script on Site B — verify communication survives
    const siteBResult = await sw.evaluate(async ({ tabId }) => {
      // Small delay to let navigation settle (simulates real-world timing)
      await new Promise(r => setTimeout(r, 500));

      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => ({
            title: document.title,
            url: location.href,
            hasEmailField: !!document.querySelector('input[type="email"]'),
            hasMessageField: !!document.querySelector('textarea'),
            alive: true,
          }),
        });
        return { success: true, data: result?.result };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }, { tabId });

    expect(siteBResult.success, `executeScript on Site B failed: ${siteBResult.error}`).toBe(true);
    expect(siteBResult.data.alive).toBe(true);
    expect(siteBResult.data.title).toContain('Test Form');
    expect(siteBResult.data.hasEmailField).toBe(true);
    expect(siteBResult.data.hasMessageField).toBe(true);
  });

  test('sendMessage to content script works after cross-site navigation', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();

    // Navigate to Site A
    await page.goto('http://localhost:3099/harness/search-results.html?k=laptop');
    await page.waitForLoadState('domcontentloaded');

    let sw;
    for (let i = 0; i < 30; i++) {
      sw = context.serviceWorkers().find(w => w.url().includes('background'));
      if (sw) break;
      await page.waitForTimeout(500);
    }
    expect(sw, 'Service worker should be running').toBeTruthy();

    // Inject a listener content script on Site A
    const setupA = await sw.evaluate(async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => {
          chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
            if (msg.type === 'ping') sendResponse({ pong: true, page: document.title });
          });
        },
      });
      // Verify the listener works
      return new Promise((resolve) => {
        chrome.tabs.sendMessage(activeTab.id, { type: 'ping' }, (resp) => {
          resolve({ tabId: activeTab.id, response: resp, error: chrome.runtime.lastError?.message });
        });
      });
    });

    expect(setupA.response?.pong, 'ping on Site A should work').toBe(true);
    expect(setupA.response?.page).toContain('Search Results');
    const tabId = setupA.tabId;

    // Full-page navigate to Site B
    await page.goto('http://localhost:3099/harness/form-page.html');
    await page.waitForLoadState('domcontentloaded');

    // Try sendMessage to OLD content script — this should FAIL
    // (the old content script is dead after navigation)
    const staleResult = await sw.evaluate(async ({ tabId }) => {
      await new Promise(r => setTimeout(r, 300));
      return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: 'ping' }, (resp) => {
          resolve({ response: resp, error: chrome.runtime.lastError?.message });
        });
      });
    }, { tabId });

    // Old listener is dead — sendMessage should fail or return no response
    // This is the "message channel closed" error the user sees
    expect(
      staleResult.error || !staleResult.response,
      'Old content script should be dead after navigation'
    ).toBeTruthy();

    // Now RE-INJECT a fresh content script on Site B and verify it works
    const reinjectResult = await sw.evaluate(async ({ tabId }) => {
      // This is what the extension SHOULD do after navigation:
      // re-inject the content script before trying to communicate
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
            if (msg.type === 'ping') sendResponse({ pong: true, page: document.title });
          });
        },
      });

      return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: 'ping' }, (resp) => {
          resolve({ response: resp, error: chrome.runtime.lastError?.message });
        });
      });
    }, { tabId });

    expect(reinjectResult.error, `Re-injected ping failed: ${reinjectResult.error}`).toBeFalsy();
    expect(reinjectResult.response?.pong).toBe(true);
    expect(reinjectResult.response?.page).toContain('Test Form');
  });

  test('typing into form fields works after cross-site navigation', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();

    // Start on Site A (search results)
    await page.goto('http://localhost:3099/harness/search-results.html?k=laptop');
    await page.waitForLoadState('domcontentloaded');

    let sw;
    for (let i = 0; i < 30; i++) {
      sw = context.serviceWorkers().find(w => w.url().includes('background'));
      if (sw) break;
      await page.waitForTimeout(500);
    }
    expect(sw, 'Service worker should be running').toBeTruthy();

    // Capture data from Site A
    const productData = await sw.evaluate(async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => {
          const links = document.querySelectorAll('.product a');
          return Array.from(links).map(a => a.textContent.trim());
        },
      });
      return { tabId: activeTab.id, products: result?.result || [] };
    });

    expect(productData.products.length).toBeGreaterThan(0);
    const tabId = productData.tabId;

    // Navigate to Site B (email compose form)
    await page.goto('http://localhost:3099/harness/form-page.html');
    await page.waitForLoadState('domcontentloaded');

    // Fill the email form using executeScript (simulates what chain executor does)
    const fillResult = await sw.evaluate(async ({ tabId, recipient, subject, body }) => {
      await new Promise(r => setTimeout(r, 500));
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (r, s, b) => {
            const emailField = document.querySelector('#email');
            const subjectField = document.querySelector('#subject');
            const messageField = document.querySelector('#message');
            if (emailField) emailField.value = r;
            if (subjectField) subjectField.value = s;
            if (messageField) messageField.value = b;
            return {
              emailFilled: emailField?.value === r,
              subjectFilled: subjectField?.value === s,
              bodyFilled: messageField?.value === b,
            };
          },
          args: [recipient, subject, body],
        });
        return { success: true, data: result?.result };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }, {
      tabId,
      recipient: 'john@gmail.com',
      subject: `Laptop found: ${productData.products[0]}`,
      body: `I found this laptop for you: ${productData.products[0]}`,
    });

    expect(fillResult.success, `Form fill failed: ${fillResult.error}`).toBe(true);
    expect(fillResult.data.emailFilled).toBe(true);
    expect(fillResult.data.subjectFilled).toBe(true);
    expect(fillResult.data.bodyFilled).toBe(true);

    // Verify from Playwright's perspective too
    await expect(page.locator('#email')).toHaveValue('john@gmail.com');
    await expect(page.locator('#subject')).toHaveValue(/Laptop found/);
    await expect(page.locator('#message')).toHaveValue(/I found this laptop/);
  });
});
