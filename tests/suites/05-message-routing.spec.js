// @ts-check
const { test, expect } = require('@playwright/test');
const { getServiceWorker, getExtensionId } = require('../helpers/extension');
const { generateTestToken } = require('../helpers/auth');

test.describe('Message Routing', () => {
  let sw;

  test.beforeEach(async ({ context }) => {
    sw = await getServiceWorker(context);
    // Inject auth token into storage
    await sw.evaluate(async (token) => {
      await chrome.storage.local.set({ token });
    }, generateTestToken());
  });

  // Each message type that the background.js handles should return a valid response object
  // (not undefined). This catches the "Cannot read properties of undefined (reading 'success')" bug.

  const simpleMessageTypes = [
    { type: 'get_active_tab', data: {}, description: 'get_active_tab returns response' },
    { type: 'GET_CURRENT_TAB', data: {}, description: 'GET_CURRENT_TAB returns response' },
    { type: 'fetch_model_registry', data: {}, description: 'fetch_model_registry returns response' },
    { type: 'fetch_todos', data: {}, description: 'fetch_todos returns response' },
    { type: 'learning_session_status', data: {}, description: 'learning_session_status returns response' },
    { type: 'learning_get_recipes', data: {}, description: 'learning_get_recipes returns response' },
  ];

  for (const msg of simpleMessageTypes) {
    test(msg.description, async () => {
      const result = await sw.evaluate(async ({ type, data }) => {
        return new Promise((resolve) => {
          chrome.runtime.sendMessage({ type, data }, (response) => {
            resolve(response);
          });
        });
      }, msg);

      // Must return an object (not undefined, not null for most handlers)
      expect(result).toBeDefined();
      if (result && typeof result === 'object') {
        // Most handlers return { success: boolean, ... }
        expect('success' in result || 'status' in result || Array.isArray(result) || 'todos' in result || 'id' in result).toBeTruthy();
      }
    });
  }

  test('process_request returns valid action response', async () => {
    const result = await sw.evaluate(async () => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'process_request',
          data: {
            userPrompt: 'recommend something for me',
            pageContext: { url: 'http://localhost:3099/harness/form-page.html', pageTitle: 'Test' },
          },
        }, (response) => {
          resolve(response);
        });
      });
    });

    expect(result).toBeTruthy();
    expect(result.success).toBe(true);
    if (result.data) {
      expect(result.data.action_type).toBeTruthy();
      expect(result.data.headline).toBeTruthy();
    }
  });

  test('unknown message type does not crash', async () => {
    const result = await sw.evaluate(async () => {
      return new Promise((resolve) => {
        // Set a timeout — if no handler catches it, sendMessage callback gets undefined
        const timer = setTimeout(() => resolve('TIMEOUT_OK'), 3000);
        chrome.runtime.sendMessage({ type: 'completely_unknown_type_xyz' }, (response) => {
          clearTimeout(timer);
          resolve(response === undefined ? 'UNDEFINED_OK' : response);
        });
      });
    });

    // Unknown types should either return undefined or timeout — NOT crash
    expect(result === 'UNDEFINED_OK' || result === 'TIMEOUT_OK' || result === undefined).toBeTruthy();
  });
});
