// ============================================================
// Enhancivity Recipe Replay Engine — Content Script
//
// Injected on-demand via chrome.scripting.executeScript()
// Replays learned recipes step by step — no AI calls needed.
// Uses multi-strategy selector fallback for resilience.
// ============================================================

(() => {
  'use strict';

  // Prevent double-injection
  if (window.__enhReplayInjected) return;
  window.__enhReplayInjected = true;

  // ── Element Finding (Multi-Strategy Selector Resolution) ─────

  function findElement(selectors, description) {
    // Try selectors in priority order
    const sorted = [...selectors].sort((a, b) => a.priority - b.priority);

    for (const sel of sorted) {
      try {
        let el = null;

        switch (sel.strategy) {
          case 'data-testid':
            el = document.querySelector(sel.value);
            break;

          case 'aria-label':
            el = document.querySelector(`[aria-label="${CSS.escape(sel.value)}"]`);
            break;

          case 'css-id':
          case 'css':
            el = document.querySelector(sel.value);
            break;

          case 'name':
            el = document.querySelector(`[name="${CSS.escape(sel.value)}"]`);
            break;

          case 'placeholder':
            el = document.querySelector(`[placeholder="${CSS.escape(sel.value)}"]`);
            break;

          case 'text-content': {
            // Find element by text content — multi-pass: exact → innerText → contains → fuzzy
            const textCandidates = document.querySelectorAll(
              'button, a, span, div, label, h1, h2, h3, h4, p, li, td, nav, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"]'
            );
            const target = sel.value.trim().toLowerCase();

            // Pass 1: Exact match on innerText (visible text only)
            for (const c of textCandidates) {
              const inner = (c.innerText || c.textContent || '').trim();
              if (inner === sel.value && isVisible(c)) { el = c; break; }
            }

            // Pass 2: Case-insensitive match
            if (!el) {
              for (const c of textCandidates) {
                const inner = (c.innerText || c.textContent || '').trim().toLowerCase();
                if (inner === target && isVisible(c)) { el = c; break; }
              }
            }

            // Pass 3: Direct text nodes only (skip nested child text)
            if (!el) {
              for (const c of textCandidates) {
                const directText = getDirectText(c);
                if (directText && directText.toLowerCase() === target && isVisible(c)) { el = c; break; }
              }
            }

            // Pass 4: Element contains the target text as a standalone word/phrase
            // (handles cases where textContent has extra whitespace or minor additions)
            if (!el && target.length >= 3) {
              for (const c of textCandidates) {
                const inner = (c.innerText || c.textContent || '').trim().toLowerCase();
                // Must be a close match — inner starts or ends with target, or target is the majority
                if (inner.includes(target) && inner.length < target.length * 3 && isVisible(c)) {
                  // Prefer the most specific (smallest) matching element
                  if (!el || c.textContent.length < el.textContent.length) {
                    el = c;
                  }
                }
              }
            }
            break;
          }

          case 'role-text': {
            // Match by ARIA role + visible text (very resilient on SPAs)
            try {
              const { role, text } = JSON.parse(sel.value);
              const roleCandidates = document.querySelectorAll(`[role="${role}"]`);
              const targetText = text.trim().toLowerCase();
              for (const c of roleCandidates) {
                const inner = (c.innerText || c.textContent || '').trim().toLowerCase();
                if ((inner === targetText || inner.includes(targetText)) && isVisible(c)) {
                  el = c;
                  break;
                }
              }
            } catch {}
            break;
          }

          case 'xpath': {
            const result = document.evaluate(
              sel.value, document, null,
              XPathResult.FIRST_ORDERED_NODE_TYPE, null
            );
            el = result.singleNodeValue;
            break;
          }
        }

        if (el && isVisible(el)) {
          // Cross-validate fragile selectors (CSS path, XPath) against the description
          // to prevent clicking the WRONG element after DOM shifts (e.g., feed refresh)
          if ((sel.strategy === 'css' || sel.strategy === 'xpath') && description) {
            const labelMatch = description.match(/["'](.+?)["']/);
            if (labelMatch) {
              const expectedLabel = labelMatch[1].trim().toLowerCase();
              const elText = (el.innerText || el.textContent || '').trim().toLowerCase();
              const elAria = (el.getAttribute('aria-label') || '').toLowerCase();
              const elPlaceholder = (el.getAttribute('placeholder') || '').toLowerCase();

              const matches = elText.includes(expectedLabel) ||
                              elAria.includes(expectedLabel) ||
                              elPlaceholder.includes(expectedLabel) ||
                              expectedLabel.includes(elText);

              if (!matches && expectedLabel.length >= 2) {
                // Fragile selector found an element but it doesn't match the description
                // — likely a wrong element due to DOM shift. Skip it.
                console.log(`[Enhancivity Replay] ${sel.strategy} found element but text mismatch: expected "${expectedLabel}", got "${elText.slice(0, 40)}". Skipping.`);
                continue;
              }
            }
          }
          return { element: el, usedStrategy: sel.strategy };
        }
      } catch {
        // Selector failed — try next strategy
        continue;
      }
    }

    // Last resort: use the step's description to find the element
    // Description format is like 'Click "Settings"' or 'Type into "Search"'
    if (description) {
      const labelMatch = description.match(/["'](.+?)["']/);
      if (labelMatch) {
        const label = labelMatch[1].trim().toLowerCase();
        const allClickable = document.querySelectorAll(
          'a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [contenteditable], label, summary'
        );

        // Pass 1: innerText exact (case-insensitive)
        for (const c of allClickable) {
          const inner = (c.innerText || c.textContent || '').trim().toLowerCase();
          if (inner === label && isVisible(c)) {
            console.log('[Enhancivity Replay] Found via description fallback (exact):', label);
            return { element: c, usedStrategy: 'description-fallback' };
          }
        }

        // Pass 2: direct text match
        for (const c of allClickable) {
          const direct = getDirectText(c);
          if (direct && direct.toLowerCase() === label && isVisible(c)) {
            console.log('[Enhancivity Replay] Found via description fallback (direct-text):', label);
            return { element: c, usedStrategy: 'description-fallback' };
          }
        }

        // Pass 3: aria-label match
        for (const c of allClickable) {
          const aria = (c.getAttribute('aria-label') || '').toLowerCase();
          if (aria === label && isVisible(c)) {
            console.log('[Enhancivity Replay] Found via description fallback (aria):', label);
            return { element: c, usedStrategy: 'description-fallback' };
          }
        }

        // Pass 4: contains match (smallest matching element wins)
        let bestFallback = null;
        for (const c of allClickable) {
          const inner = (c.innerText || c.textContent || '').trim().toLowerCase();
          if (inner.includes(label) && inner.length < label.length * 4 && isVisible(c)) {
            if (!bestFallback || c.textContent.length < bestFallback.textContent.length) {
              bestFallback = c;
            }
          }
        }
        if (bestFallback) {
          console.log('[Enhancivity Replay] Found via description fallback (contains):', label);
          return { element: bestFallback, usedStrategy: 'description-fallback' };
        }
      }
    }

    return null;
  }

  function getDirectText(el) {
    // Get only direct text nodes (not nested child text like SVG innards)
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      }
    }
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ── Wait-and-Find: retry finding element with generous timeout ──
  // Default 30s — pages can take 10-20s to load after SPA transitions.
  // Polls every 500ms (first 5s) then every 800ms (remaining time) to avoid CPU thrash.

  async function waitForElement(selectors, timeoutMs = 15000, description) {
    const startTime = Date.now();
    let attempts = 0;
    while (Date.now() - startTime < timeoutMs) {
      const found = findElement(selectors, description);
      if (found) {
        console.log(`[Enhancivity Replay] Found element after ${attempts} attempts (${Date.now() - startTime}ms) using "${found.usedStrategy}"`);
        return found;
      }
      attempts++;
      // Poll faster in the first 5 seconds, slower after (element likely waiting for page load)
      const elapsed = Date.now() - startTime;
      await delay(elapsed < 5000 ? 400 : 800);
    }
    // Log what we tried for debugging
    console.warn(`[Enhancivity Replay] Element NOT found after ${attempts} attempts (${timeoutMs}ms timeout). Selectors tried:`,
      selectors.map(s => `${s.strategy}="${typeof s.value === 'string' ? s.value.slice(0, 60) : s.value}"`).join(', ')
    );
    if (description) {
      console.warn('[Enhancivity Replay] Step description:', description);
    }
    return null;
  }

  // ── Action Executors ──────────────────────────────────────────

  async function executeClick(action) {
    const found = await waitForElement(action.selectors, 15000, action.description);
    if (!found) return { success: false, error: `Element not found for click: "${action.description || 'unknown'}"` };

    const el = found.element;

    // Scroll into view
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await delay(200);

    // Visual highlight
    const prevOutline = el.style.outline;
    el.style.outline = '2px solid #6366f1';
    setTimeout(() => { el.style.outline = prevOutline; }, 800);

    // Snapshot pre-click state for navigation detection
    const preClickUrl = window.location.href;
    const preClickBodyLen = document.body?.innerHTML?.length || 0;

    // Human-like click sequence
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
    const y = rect.top + rect.height * (0.3 + Math.random() * 0.4);

    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
    await delay(40 + Math.random() * 40);
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
    await delay(30 + Math.random() * 50);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));

    // Also call .click() as fallback for React/Vue synthetic events
    try { el.click(); } catch {}

    // Post-click: detect if click caused page transition (SPA navigation or major DOM change)
    // and wait for the page to stabilize before the next step
    await delay(300);
    const postClickUrl = window.location.href;
    const postClickBodyLen = document.body?.innerHTML?.length || 0;
    const urlChanged = postClickUrl !== preClickUrl;
    const majorDomChange = Math.abs(postClickBodyLen - preClickBodyLen) > 2000;

    if (urlChanged || majorDomChange) {
      console.log(`[Enhancivity Replay] Click triggered page transition (url: ${urlChanged}, domDelta: ${Math.abs(postClickBodyLen - preClickBodyLen)}). Waiting for page to stabilize...`);
      await waitForPageStable();
    }

    return { success: true, usedStrategy: found.usedStrategy };
  }

  // Wait for the page DOM to stop changing (signals that SPA navigation or
  // dynamic content loading has finished). Max wait: 15 seconds.
  async function waitForPageStable(maxWaitMs = 15000, settleMs = 800) {
    const startTime = Date.now();
    let lastBodyLen = document.body?.innerHTML?.length || 0;
    let stableSince = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      await delay(300);
      const currentLen = document.body?.innerHTML?.length || 0;
      if (Math.abs(currentLen - lastBodyLen) > 200) {
        // DOM still changing — reset stable timer
        lastBodyLen = currentLen;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= settleMs) {
        // DOM has been stable for settleMs — page is ready
        console.log(`[Enhancivity Replay] Page stabilized after ${Date.now() - startTime}ms`);
        return;
      }
    }
    console.log(`[Enhancivity Replay] Page stability timeout after ${maxWaitMs}ms — proceeding anyway`);
  }

  async function executeType(action, variables) {
    const found = await waitForElement(action.selectors, 15000, action.description);
    if (!found) return { success: false, error: `Element not found for type: "${action.description || 'unknown'}"` };

    const el = found.element;
    const value = action.inputType === 'variable'
      ? (variables[action.variableName] || '')
      : (action.fixedValue || '');

    if (!value) return { success: true, usedStrategy: found.usedStrategy, note: 'Empty value — skipped' };

    // Focus the element
    el.focus();
    el.click();
    await delay(100);

    // Clear existing value
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = '';
    }

    // Tier 1: execCommand insertText (works on most fields)
    let typed = false;
    try {
      document.execCommand('insertText', false, value);
      // Check if it actually worked
      const currentVal = el.value || el.textContent || '';
      if (currentVal.includes(value)) typed = true;
    } catch {}

    // Tier 2: Direct assignment + input event (React-compatible)
    if (!typed) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        // Use native setter to trigger React's synthetic event system
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        )?.set || Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        )?.set;

        if (nativeSetter) {
          nativeSetter.call(el, value);
        } else {
          el.value = value;
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        typed = true;
      } else if (el.isContentEditable) {
        el.textContent = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        typed = true;
      }
    }

    // Tier 3: CDP fallback (sent via background.js) — for canvas editors
    if (!typed) {
      try {
        await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: 'cdp_insert_text',
            text: value,
            elementRect: {
              x: Math.round(el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2),
              y: Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2),
            },
          }, resolve);
        });
        typed = true;
      } catch {}
    }

    return { success: typed, usedStrategy: found.usedStrategy };
  }

  async function executeKeypress(action) {
    const options = {
      key: action.key,
      code: action.key === 'Enter' ? 'Enter' : action.key === 'Tab' ? 'Tab' : `Key${action.key.toUpperCase()}`,
      bubbles: true,
      cancelable: true,
    };

    if (action.modifiers) {
      if (action.modifiers.includes('ctrl')) options.ctrlKey = true;
      if (action.modifiers.includes('shift')) options.shiftKey = true;
      if (action.modifiers.includes('alt')) options.altKey = true;
      if (action.modifiers.includes('meta')) options.metaKey = true;
    }

    const activeEl = document.activeElement || document.body;
    activeEl.dispatchEvent(new KeyboardEvent('keydown', options));
    await delay(30);
    activeEl.dispatchEvent(new KeyboardEvent('keyup', options));

    return { success: true };
  }

  async function executeScroll(action) {
    if (action.scrollPercent !== undefined) {
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      const targetY = Math.round((action.scrollPercent / 100) * maxScroll);
      window.scrollTo({ top: targetY, behavior: 'smooth' });
    } else {
      window.scrollBy({ top: action.amount || 300, behavior: 'smooth' });
    }

    await delay(500);
    return { success: true };
  }

  async function executeWait(action) {
    if (action.condition === 'fixed-delay') {
      await delay(Math.min(action.timeout || 2000, 60000));
      return { success: true };
    }

    if (action.condition === 'element-visible' && action.selectors) {
      // Allow up to 60 seconds for an element to appear (page loads, SPA transitions)
      const timeout = Math.min(action.timeout || 30000, 60000);
      const startTime = Date.now();

      while (Date.now() - startTime < timeout) {
        const found = findElement(action.selectors, action.description);
        if (found) return { success: true };
        await delay(500);
      }

      return { success: false, error: `Element did not appear within ${Math.round(timeout / 1000)}s timeout` };
    }

    // Default: short wait
    await delay(action.timeout || 2000);
    return { success: true };
  }

  // ── LLM-Fill: pause navigator, ask LLM to generate text, type it in ──
  // This step is completely decoupled from navigation timing.
  // The navigator pauses indefinitely until the LLM signals completion.
  // Safety cap: 3 minutes max (even GPT-4 shouldn't need more).

  async function executeLlmFill(action, variables) {
    // Find the target input element
    const found = await waitForElement(action.selectors, 15000, action.description);
    if (!found) return { success: false, error: `Element not found for AI fill: "${action.description || 'unknown'}"` };

    const el = found.element;

    // Focus the element
    el.focus();
    el.click();
    await delay(100);

    // Build context: what does the LLM need to generate?
    const llmPrompt = action.llmPrompt || action.variableDescription || `Generate text for: ${action.description}`;

    // Gather page context (visible text around the element for the LLM to reference)
    let pageContext = '';
    try {
      // Grab nearby visible text for context (e.g., email thread, form labels)
      const parent = el.closest('form, [role="dialog"], [role="main"], main, article, section') || el.parentElement;
      if (parent) {
        pageContext = (parent.innerText || '').slice(0, 2000);
      }
    } catch {}

    // Include any user-provided variable overrides (e.g., tone, topic)
    const extraContext = {};
    if (action.contextVariables && variables) {
      for (const varName of action.contextVariables) {
        if (variables[varName]) extraContext[varName] = variables[varName];
      }
    }

    console.log(`[Enhancivity Replay] LLM Fill — pausing navigator, sending to LLM: "${llmPrompt.slice(0, 80)}..."`);

    // Report progress: navigator is waiting for LLM
    chrome.runtime.sendMessage({
      type: 'replay_progress',
      data: {
        stepNumber: action._stepNumber || 0,
        totalSteps: action._totalSteps || 0,
        description: `AI is generating: ${action.description || 'content'}...`,
        isLlmStep: true,
      },
    });

    // Send to background.js → backend API. No timeout on our side —
    // the background handler has its own 3-minute safety cap.
    let llmResult;
    try {
      llmResult = await new Promise((resolve, reject) => {
        const safetyTimeout = setTimeout(() => {
          reject(new Error('LLM generation timed out after 3 minutes'));
        }, 180000); // 3 min safety cap

        chrome.runtime.sendMessage({
          type: 'recipe_llm_fill',
          data: {
            prompt: llmPrompt,
            pageContext,
            extraContext,
            fieldDescription: action.description,
          },
        }, (response) => {
          clearTimeout(safetyTimeout);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
    } catch (err) {
      return { success: false, error: `LLM fill failed: ${err.message}` };
    }

    if (!llmResult?.success || !llmResult.text) {
      return { success: false, error: `LLM returned no text: ${llmResult?.error || 'unknown error'}` };
    }

    const generatedText = llmResult.text;
    console.log(`[Enhancivity Replay] LLM generated ${generatedText.length} chars. Typing into field...`);

    // Clear existing value
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = '';
    }

    // Type the generated text using 3-Tier Typing Cascade
    let typed = false;

    // Tier 1: execCommand insertText
    try {
      document.execCommand('insertText', false, generatedText);
      const currentVal = el.value || el.textContent || '';
      if (currentVal.includes(generatedText.slice(0, 20))) typed = true;
    } catch {}

    // Tier 2: Direct assignment + input event
    if (!typed) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        )?.set || Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        )?.set;

        if (nativeSetter) {
          nativeSetter.call(el, generatedText);
        } else {
          el.value = generatedText;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        typed = true;
      } else if (el.isContentEditable) {
        el.textContent = generatedText;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        typed = true;
      }
    }

    // Tier 3: CDP fallback
    if (!typed) {
      try {
        await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: 'cdp_insert_text',
            text: generatedText,
            elementRect: {
              x: Math.round(el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2),
              y: Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2),
            },
          }, resolve);
        });
        typed = true;
      } catch {}
    }

    return { success: typed, usedStrategy: found.usedStrategy, llmChars: generatedText.length };
  }

  async function executeNavigate(action) {
    window.location.href = action.url;
    // Navigation will reload the page — the background.js handles continuation
    return { success: true, navigated: true };
  }

  // ── Main Replay Function ──────────────────────────────────────

  async function replayRecipe(recipe, variables) {
    const results = [];
    const startTime = Date.now();

    console.log('[Enhancivity Replay] Starting recipe:', recipe.workflowName, '— steps:', recipe.steps.length);

    for (let i = 0; i < recipe.steps.length; i++) {
      const step = recipe.steps[i];
      const action = step.action;

      console.log(`[Enhancivity Replay] Step ${i + 1}/${recipe.steps.length}: ${action.type} — ${action.description || ''}`);

      // Report progress to background
      chrome.runtime.sendMessage({
        type: 'replay_progress',
        data: {
          stepNumber: i + 1,
          totalSteps: recipe.steps.length,
          description: action.description,
        },
      });

      let result;

      // Per-step timeout: 45s for LLM steps (AI generation), 20s for everything else.
      // Prevents any single step from hanging the entire replay.
      const stepTimeoutMs = action.type === 'llm_fill' ? 45000 : 20000;

      try {
        const stepPromise = (async () => {
          switch (action.type) {
            case 'click':
              return await executeClick(action);
            case 'type':
              return await executeType(action, variables || {});
            case 'llm_fill':
              // Tag the action with step metadata for progress reporting
              action._stepNumber = i + 1;
              action._totalSteps = recipe.steps.length;
              return await executeLlmFill(action, variables || {});
            case 'keypress':
              return await executeKeypress(action);
            case 'scroll':
              return await executeScroll(action);
            case 'wait':
              return await executeWait(action);
            case 'navigate':
              return await executeNavigate(action);
            default:
              return { success: false, error: `Unknown action type: ${action.type}` };
          }
        })();

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Step timed out after ${stepTimeoutMs / 1000}s — element may not exist on this page`)), stepTimeoutMs)
        );

        result = await Promise.race([stepPromise, timeoutPromise]);

        if (action.type === 'navigate' && result.navigated) {
          // Page is navigating away — stop replay, background will re-inject
          return {
            success: true,
            partial: true,
            completedSteps: i + 1,
            totalSteps: recipe.steps.length,
            results,
            durationMs: Date.now() - startTime,
          };
        }
      } catch (err) {
        result = { success: false, error: err.message };
      }

      results.push({
        stepNumber: i + 1,
        actionType: action.type,
        description: action.description,
        ...result,
      });

      if (!result.success) {
        console.warn(`[Enhancivity Replay] Step ${i + 1} FAILED:`, result.error);
        console.warn('[Enhancivity Replay] Selectors tried:', JSON.stringify(action.selectors?.slice(0, 3)));
        // Step failed — report and stop
        return {
          success: false,
          failedAtStep: i + 1,
          failReason: result.error,
          results,
          durationMs: Date.now() - startTime,
        };
      }

      console.log(`[Enhancivity Replay] Step ${i + 1} OK (${result.usedStrategy || 'n/a'})`);

      // Human-like delay between steps (200-600ms)
      if (i < recipe.steps.length - 1) {
        await delay(200 + Math.random() * 400);
      }
    }

    return {
      success: true,
      partial: false,
      completedSteps: recipe.steps.length,
      totalSteps: recipe.steps.length,
      results,
      durationMs: Date.now() - startTime,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Message Listener ──────────────────────────────────────────

  // ── Replay a partial segment of steps (for multi-tab orchestration) ──

  async function replaySteps(steps, variables) {
    const results = [];
    const startTime = Date.now();

    console.log('[Enhancivity Replay] Starting segment replay:', steps.length, 'steps');

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const action = step.action;

      console.log(`[Enhancivity Replay] Step ${step.stepNumber}: ${action.type} — ${action.description || ''}`);

      chrome.runtime.sendMessage({
        type: 'replay_progress',
        data: {
          stepNumber: step.stepNumber,
          totalSteps: step._totalSteps || steps.length,
          description: action.description,
        },
      });

      let result;

      // Per-step timeout: 45s for LLM steps, 20s for everything else
      const stepTimeoutMs = action.type === 'llm_fill' ? 45000 : 20000;

      try {
        const stepPromise = (async () => {
          switch (action.type) {
            case 'click':
              return await executeClick(action);
            case 'type':
              return await executeType(action, variables || {});
            case 'llm_fill':
              action._stepNumber = step.stepNumber;
              action._totalSteps = step._totalSteps || steps.length;
              return await executeLlmFill(action, variables || {});
            case 'keypress':
              return await executeKeypress(action);
            case 'scroll':
              return await executeScroll(action);
            case 'wait':
              return await executeWait(action);
            case 'navigate':
              return await executeNavigate(action);
            default:
              return { success: false, error: `Unknown action type: ${action.type}` };
          }
        })();

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Step timed out after ${stepTimeoutMs / 1000}s — element may not exist on this page`)), stepTimeoutMs)
        );

        result = await Promise.race([stepPromise, timeoutPromise]);

        if (action.type === 'navigate' && result.navigated) {
          return {
            success: true,
            partial: true,
            completedSteps: i + 1,
            totalSteps: steps.length,
            results,
            durationMs: Date.now() - startTime,
          };
        }
      } catch (err) {
        result = { success: false, error: err.message };
      }

      results.push({
        stepNumber: step.stepNumber,
        actionType: action.type,
        description: action.description,
        ...result,
      });

      if (!result.success) {
        console.warn(`[Enhancivity Replay] Step ${step.stepNumber} FAILED:`, result.error);
        return {
          success: false,
          failedAtStep: step.stepNumber,
          failReason: result.error,
          results,
          durationMs: Date.now() - startTime,
        };
      }

      console.log(`[Enhancivity Replay] Step ${step.stepNumber} OK (${result.usedStrategy || 'n/a'})`);

      if (i < steps.length - 1) {
        await delay(200 + Math.random() * 400);
      }
    }

    return {
      success: true,
      partial: false,
      completedSteps: steps.length,
      totalSteps: steps.length,
      results,
      durationMs: Date.now() - startTime,
    };
  }

  // ── Message Listener ──────────────────────────────────────────

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'replay_recipe') {
      const { recipe, variables } = request;

      replayRecipe(recipe, variables).then(result => {
        sendResponse(result);
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });

      return true; // Async response
    }

    if (request.type === 'replay_steps') {
      const { steps, variables } = request;

      replaySteps(steps, variables).then(result => {
        sendResponse(result);
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });

      return true; // Async response
    }
  });

})();
