// ============================================================
// Enhancivity Learning Mode — Action Recorder Content Script
//
// Injected on-demand via chrome.scripting.executeScript()
// Records user actions (click, type, scroll, keypress, navigate)
// and captures multi-strategy selectors for each element.
//
// Phase 1 Refactor: Steps are sent incrementally to background.js
// which is the central coordinator. This content script is a thin
// per-tab recorder — it captures DOM events and reports them.
// Background.js accumulates steps and builds the final recipe.
//
// Pure observation — never interferes with user actions.
// No AI calls during recording — all intelligence is in replay/matching.
// ============================================================

(() => {
  'use strict';

  // Prevent double-injection but allow re-activation
  if (window.__enhLearningInjected) {
    // Already injected — just listen for pause/resume messages
    return;
  }
  window.__enhLearningInjected = true;

  // ── State ─────────────────────────────────────────────────────

  let isRecording = false;
  let localStepCount = 0;   // Local count for overlay display only
  let nextInputIsVariable = false;
  let pendingVariableName = null;
  let lastActionTimestamp = 0;

  // Track recent type steps locally for debouncing (elementKey → true)
  // We need this to avoid sending duplicate type steps for the same field
  let recentTypeSteps = []; // { elementKey, stepId }

  // Overlay DOM references
  let overlayBar = null;
  let stepCountLabel = null;

  // ── Selector Generation ───────────────────────────────────────

  function looksGenerated(id) {
    if (!id) return true;
    return /^[:_]/.test(id) ||
           /\d{3,}/.test(id) ||
           /^(react|ember|angular|vue|mui|rc|radix)[-_]/i.test(id) ||
           id.length > 40;
  }

  function getElementKey(el) {
    const tag = el.tagName;
    const name = el.getAttribute('name') || '';
    const id = el.id || '';
    const ariaLabel = el.getAttribute('aria-label') || '';
    return `${tag}|${id}|${name}|${ariaLabel}`;
  }

  function getDirectText(el) {
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      }
    }
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function sanitizeLabelText(text) {
    if (!text) return '';
    let cleaned = String(text)
      .replace(/\s+/g, ' ')
      .replace(/[↕↔↑↓←→]/g, ' ')
      .trim();

    cleaned = cleaned.replace(/\s+(Ctrl|Cmd|Shift|Alt|Option|Meta)\b.*$/i, '').trim();
    cleaned = cleaned.replace(/\s+[⌘⌥⇧^].*$/, '').trim();

    const lines = cleaned.split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length > 0) {
      cleaned = lines.sort((a, b) => a.length - b.length)[0];
    }

    return cleaned.slice(0, 60).trim();
  }

  function buildCssSelector(el) {
    const parts = [];
    let current = el;
    let depth = 0;

    while (current && current !== document.body && depth < 5) {
      let selector = current.tagName.toLowerCase();

      if (current.id && !looksGenerated(current.id)) {
        selector = `#${CSS.escape(current.id)}`;
        parts.unshift(selector);
        break;
      }

      const classes = Array.from(current.classList || [])
        .filter(c => !looksGenerated(c) && c.length < 30 && !/^[a-z]{1,2}\d/.test(c))
        .slice(0, 3);

      if (classes.length > 0) {
        selector += '.' + classes.map(c => CSS.escape(c)).join('.');
      }

      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          selector += `:nth-child(${idx})`;
        }
      }

      parts.unshift(selector);
      current = current.parentElement;
      depth++;
    }

    return parts.join(' > ');
  }

  function buildXPath(el) {
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let tag = current.tagName.toLowerCase();
      const parent = current.parentNode;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          tag += `[${idx}]`;
        }
      }
      parts.unshift(tag);
      current = current.parentNode;
    }
    return '/' + parts.join('/');
  }

  function generateSelectors(el) {
    const selectors = [];
    let priority = 1;

    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (testId) {
      selectors.push({ strategy: 'data-testid', value: `[data-testid="${testId}"]`, priority: priority++ });
    }

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      selectors.push({ strategy: 'aria-label', value: ariaLabel, priority: priority++ });
    }

    if (el.id && !looksGenerated(el.id)) {
      selectors.push({ strategy: 'css-id', value: `#${CSS.escape(el.id)}`, priority: priority++ });
    }

    const name = el.getAttribute('name');
    if (name) {
      selectors.push({ strategy: 'name', value: name, priority: priority++ });
    }

    const placeholder = el.getAttribute('placeholder');
    if (placeholder) {
      selectors.push({ strategy: 'placeholder', value: placeholder, priority: priority++ });
    }

    const directText = sanitizeLabelText(getDirectText(el));
    const visibleText = directText || sanitizeLabelText(el.innerText || el.textContent || '');
    if (visibleText && visibleText.length < 60 && visibleText.length > 0) {
      selectors.push({ strategy: 'text-content', value: visibleText, priority: priority++ });
    }

    const role = el.getAttribute('role');
    if (role && visibleText) {
      selectors.push({ strategy: 'role-text', value: JSON.stringify({ role, text: visibleText }), priority: priority++ });
    }

    // ── Ancestor-anchored text selector (SPA-resilient) ──
    // On React/Vue SPAs, direct selectors often break on re-render.
    // Find the nearest ancestor with a stable identifier and combine it
    // with the element's visible text for a more robust selector.
    if (!selectors.some(s => s.strategy === 'text-content' || s.strategy === 'role-text' || s.strategy === 'aria-label')) {
      let ancestor = el.parentElement;
      let depth = 0;
      while (ancestor && depth < 5 && ancestor.tagName !== 'BODY') {
        const ancLabel = ancestor.getAttribute('aria-label') || ancestor.getAttribute('data-testid');
        if (ancLabel) {
          const elText = sanitizeLabelText(el.innerText || el.textContent || '').slice(0, 50);
          if (elText) {
            selectors.push({
              strategy: 'text-content',
              value: elText,
              priority: priority++,
            });
          }
          break;
        }
        ancestor = ancestor.parentElement;
        depth++;
      }
    }

    const cssPath = buildCssSelector(el);
    if (cssPath) {
      selectors.push({ strategy: 'css', value: cssPath, priority: priority++ });
    }

    const xpath = buildXPath(el);
    selectors.push({ strategy: 'xpath', value: xpath, priority: priority++ });

    return selectors;
  }

  // ── Description Generation ────────────────────────────────────

  function describeElement(el) {
    const tag = el.tagName.toLowerCase();
    const ariaLabel = el.getAttribute('aria-label');
    const placeholder = el.getAttribute('placeholder');
    const title = el.getAttribute('title');
    const type = el.getAttribute('type');
    const role = el.getAttribute('role');

    if (ariaLabel) return sanitizeLabelText(ariaLabel);
    if (placeholder) return sanitizeLabelText(placeholder);
    if (title) return sanitizeLabelText(title);

    // Use direct text first (avoids pulling in all nested children text)
    const directText = sanitizeLabelText(getDirectText(el));
    if (directText && directText.length > 0 && directText.length < 40) return directText;

    // Fall back to full textContent but only if short and meaningful
    const text = sanitizeLabelText(el.textContent || '').slice(0, 40);
    if (text && text.length > 1 && text.length < 40) return text;

    // Include role for context (e.g., "button" instead of just "div")
    if (role) return `${role} (${tag})`;
    if (type) return `${tag}[type="${type}"]`;

    // Last resort: include a CSS class hint for debugging
    const firstClass = Array.from(el.classList || [])
      .filter(c => !looksGenerated(c) && c.length < 25)
      .slice(0, 1)[0];
    if (firstClass) return `${tag}.${firstClass}`;

    return tag;
  }

  function buildSemanticContext(el) {
    const parent = el.parentElement;
    const role = el.getAttribute('role') || '';
    const type = el.getAttribute('type') || '';
    const aria = el.getAttribute('aria-label') || '';
    const title = el.getAttribute('title') || '';
    const placeholder = el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || '';
    const contextBits = [];

    if (parent) {
      const parentText = getDirectText(parent) || (parent.innerText || parent.textContent || '').trim();
      if (parentText && parentText.length < 140) contextBits.push(parentText);
    }

    const prev = el.previousElementSibling;
    if (prev) {
      const prevText = (prev.innerText || prev.textContent || '').trim();
      if (prevText && prevText.length < 100) contextBits.push(prevText);
    }

    const next = el.nextElementSibling;
    if (next) {
      const nextText = (next.innerText || next.textContent || '').trim();
      if (nextText && nextText.length < 100) contextBits.push(nextText);
    }

    const rect = el.getBoundingClientRect();
    const position =
      rect.top < window.innerHeight * 0.25 ? 'top' :
      rect.top < window.innerHeight * 0.7 ? 'middle' : 'bottom';

    return {
      label: describeElement(el),
      tag: el.tagName.toLowerCase(),
      role: role || undefined,
      type: type || undefined,
      ariaLabel: aria || undefined,
      title: title || undefined,
      placeholder: placeholder || undefined,
      context: contextBits.join(' | ').slice(0, 240) || undefined,
      position,
      viewport: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }

  function generateDescription(action, el) {
    const label = describeElement(el);
    switch (action) {
      case 'click': return `Click "${label}"`;
      case 'type': return `Type into "${label}"`;
      case 'select': return `Select option in "${label}"`;
      default: return `${action} on "${label}"`;
    }
  }

  // ── Send Step to Background ────────────────────────────────────

  function reportStep(step) {
    try {
      chrome.runtime.sendMessage({
        type: 'learning_step_recorded',
        data: step,
      });
    } catch (err) {
      console.warn('[Enhancivity Learning] Failed to report step:', err.message);
    }
  }

  function reportStepUpdate(elementKey, fixedValue) {
    // Tell background.js to update an existing type step's value (debounce)
    try {
      chrome.runtime.sendMessage({
        type: 'learning_step_update',
        data: { elementKey, fixedValue },
      });
    } catch (err) {
      console.warn('[Enhancivity Learning] Failed to report step update:', err.message);
    }
  }

  // ── Natural Wait Detection ────────────────────────────────────

  function maybeInsertWaitStep(currentTimestamp) {
    if (lastActionTimestamp === 0) {
      lastActionTimestamp = currentTimestamp;
      return;
    }

    const gap = currentTimestamp - lastActionTimestamp;
    lastActionTimestamp = currentTimestamp;

    if (gap >= 2000) {
      reportStep({
        action: {
          type: 'wait',
          condition: 'fixed-delay',
          timeout: Math.min(gap, 10000),
          description: `Wait ${Math.round(gap / 1000)}s (page loading)`,
        },
        url: window.location.href,
        timestamp: currentTimestamp - gap,
      });
    }
  }

  // ── Event Handlers ────────────────────────────────────────────

  function handleClick(event) {
    if (!isRecording) return;
    let el = event.target;
    if (el.closest('#enh-learning-overlay')) return;

    // ── Bubble up from non-interactive elements ──
    // On SPAs (React, Vue), clicks often land on deeply nested children
    // (SVG icons, spans inside buttons, etc.) that have no semantic identity.
    // Walk up to the nearest interactive ancestor to get meaningful selectors.
    const interactiveTags = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'DETAILS', 'LABEL']);
    const originalEl = el;
    let bubbleDepth = 0;
    while (el && bubbleDepth < 6) {
      if (interactiveTags.has(el.tagName) ||
          el.getAttribute('role') === 'button' ||
          el.getAttribute('role') === 'link' ||
          el.getAttribute('role') === 'menuitem' ||
          el.getAttribute('role') === 'tab' ||
          el.getAttribute('role') === 'option' ||
          el.getAttribute('tabindex') !== null ||
          el.getAttribute('onclick') !== null ||
          el.isContentEditable) {
        break;
      }
      // Don't bubble past body/html — means we clicked on a non-interactive area
      if (el.tagName === 'BODY' || el.tagName === 'HTML') {
        el = originalEl; // revert — record the original target
        break;
      }
      el = el.parentElement;
      bubbleDepth++;
    }
    // If we bubbled all the way up without finding anything, use original
    if (!el || el.tagName === 'BODY' || el.tagName === 'HTML') {
      el = originalEl;
    }

    // ── Skip clicks on non-interactive root elements ──
    // Clicks that land on <html>, <body>, or document root are almost always
    // misfires (SPA transition, click on background). These produce garbage selectors.
    if (el.tagName === 'HTML' || el.tagName === 'BODY') {
      console.log('[Enhancivity Learning] Skipping click on non-interactive element:', el.tagName);
      return;
    }

    const now = Date.now();
    maybeInsertWaitStep(now);

    const selectors = generateSelectors(el);

    // ── Selector quality gate ──
    // If the only selectors we captured are css/xpath (fragile on SPAs), warn.
    // A good recipe needs at least one semantic selector to survive DOM re-renders.
    const hasSemanticSelector = selectors.some(s =>
      ['data-testid', 'aria-label', 'name', 'placeholder', 'text-content', 'role-text'].includes(s.strategy)
    );
    if (!hasSemanticSelector) {
      console.warn('[Enhancivity Learning] WARNING: No semantic selectors found for clicked element — recipe step will be fragile:', el.tagName, el.className);
    }

    const step = {
      action: {
        type: 'click',
        selectors,
        description: generateDescription('click', el),
        semanticContext: buildSemanticContext(el),
      },
      url: window.location.href,
      timestamp: now,
    };

    reportStep(step);
    localStepCount++;
    // A click breaks the typing debounce chain
    recentTypeSteps = [];
    updateOverlay();
  }

  function handleInput(event) {
    if (!isRecording) return;
    const el = event.target;
    if (el.closest('#enh-learning-overlay')) return;

    const elementKey = getElementKey(el);
    const value = el.value || el.textContent || '';

    // Check if we already have a type step for this element (debounce)
    // Search backward — stop if we hit a non-type action
    let existingEntry = null;
    for (let i = recentTypeSteps.length - 1; i >= 0; i--) {
      const entry = recentTypeSteps[i];
      if (entry.isBreak) break; // A non-type action was recorded in between
      if (entry.elementKey === elementKey) {
        existingEntry = entry;
        break;
      }
    }

    if (existingEntry) {
      // Update existing step's value — tell background to update, don't create new step
      reportStepUpdate(elementKey, value);
      return;
    }

    // New type action — first time typing in this field
    const now = Date.now();
    maybeInsertWaitStep(now);

    const selectors = generateSelectors(el);
    const step = {
      _elementKey: elementKey, // Used by background.js for debounce matching
      action: {
        type: 'type',
        selectors,
        inputType: nextInputIsVariable ? 'variable' : 'fixed',
        description: generateDescription('type', el),
        semanticContext: buildSemanticContext(el),
      },
      url: window.location.href,
      timestamp: now,
    };

    if (nextInputIsVariable) {
      step.action.variableName = pendingVariableName || `input_${localStepCount + 1}`;
      step.action.variableDescription = `Value for "${describeElement(el)}"`;
      nextInputIsVariable = false;
      pendingVariableName = null;
    } else {
      step.action.fixedValue = value;
    }

    reportStep(step);
    recentTypeSteps.push({ elementKey });
    localStepCount++;
    updateOverlay();
  }

  function handleKeydown(event) {
    if (!isRecording) return;
    if (event.target.closest('#enh-learning-overlay')) return;

    const specialKeys = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete'];
    const hasModifier = event.ctrlKey || event.metaKey || event.altKey;

    if (!specialKeys.includes(event.key) && !hasModifier) return;
    if ((event.key === 'Backspace' || event.key === 'Delete') && !hasModifier) return;

    const now = Date.now();
    maybeInsertWaitStep(now);

    const modifiers = [];
    if (event.ctrlKey) modifiers.push('ctrl');
    if (event.shiftKey) modifiers.push('shift');
    if (event.altKey) modifiers.push('alt');
    if (event.metaKey) modifiers.push('meta');

    const description = modifiers.length > 0
      ? `Press ${modifiers.join('+')}+${event.key}`
      : `Press ${event.key}`;

    reportStep({
      action: {
        type: 'keypress',
        key: event.key,
        modifiers: modifiers.length > 0 ? modifiers : undefined,
        description,
      },
      url: window.location.href,
      timestamp: now,
    });

    localStepCount++;
    recentTypeSteps.push({ isBreak: true }); // Break typing debounce chain
    updateOverlay();
  }

  function handleScroll() {
    if (!isRecording) return;

    if (handleScroll._timer) clearTimeout(handleScroll._timer);

    handleScroll._timer = setTimeout(() => {
      const now = Date.now();
      const scrollY = window.scrollY;
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      const scrollPct = maxScroll > 0 ? Math.round((scrollY / maxScroll) * 100) : 0;

      reportStep({
        action: {
          type: 'scroll',
          direction: 'down',
          amount: scrollY,
          scrollPercent: scrollPct,
          description: `Scroll to ${scrollPct}% of page`,
        },
        url: window.location.href,
        timestamp: now,
      });

      localStepCount++;
      recentTypeSteps.push({ isBreak: true });
      updateOverlay();
    }, 500);
  }

  // ── URL Change Observer (SPA Navigation) ──────────────────────

  let lastObservedUrl = '';

  function observeUrlChanges() {
    lastObservedUrl = window.location.href;

    const checkUrl = () => {
      if (!isRecording) return;
      const currentUrl = window.location.href;
      if (currentUrl !== lastObservedUrl) {
        reportStep({
          action: {
            type: 'navigate',
            url: currentUrl,
            waitFor: 'load',
            description: `Navigate to ${new URL(currentUrl).pathname}`,
          },
          url: currentUrl,
          timestamp: Date.now(),
        });
        lastObservedUrl = currentUrl;
        localStepCount++;
        updateOverlay();
      }
    };

    observeUrlChanges._interval = setInterval(checkUrl, 500);
  }

  // ── Recording Overlay UI ──────────────────────────────────────

  function createOverlay() {
    if (overlayBar) return;

    overlayBar = document.createElement('div');
    overlayBar.id = 'enh-learning-overlay';
    overlayBar.innerHTML = `
      <div style="
        position: fixed;
        bottom: 16px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        background: rgba(18, 18, 24, 0.92);
        backdrop-filter: blur(16px);
        border: 1px solid rgba(99, 102, 241, 0.3);
        border-radius: 14px;
        padding: 10px 18px;
        display: flex;
        align-items: center;
        gap: 14px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        color: #ededef;
        font-size: 13px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 20px rgba(99, 102, 241, 0.15);
      ">
        <span style="
          width: 8px; height: 8px; border-radius: 50%;
          background: #ef4444;
          animation: enh-pulse 1.5s ease-in-out infinite;
        "></span>
        <span id="enh-learn-step-count" style="font-weight: 600; min-width: 90px;">Step 0</span>
        <button id="enh-learn-variable-btn" style="
          background: rgba(99, 102, 241, 0.15);
          border: 1px solid rgba(99, 102, 241, 0.3);
          color: #a5b4fc;
          border-radius: 8px;
          padding: 5px 12px;
          cursor: pointer;
          font-size: 11px;
          font-weight: 500;
          transition: all 0.2s;
        ">Mark Variable</button>
        <button id="enh-learn-pause-btn" style="
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: #ededef;
          border-radius: 8px;
          padding: 5px 12px;
          cursor: pointer;
          font-size: 11px;
          font-weight: 500;
          transition: all 0.2s;
        ">Pause</button>
        <button id="enh-learn-done-btn" style="
          background: linear-gradient(135deg, #6366f1, #4f46e5);
          border: none;
          color: #fff;
          border-radius: 8px;
          padding: 5px 14px;
          cursor: pointer;
          font-size: 11px;
          font-weight: 600;
          transition: all 0.2s;
        ">Done</button>
      </div>
      <style>
        @keyframes enh-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      </style>
    `;

    document.body.appendChild(overlayBar);

    document.getElementById('enh-learn-variable-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      markNextAsVariable();
    });

    document.getElementById('enh-learn-pause-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      togglePause();
    });

    document.getElementById('enh-learn-done-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      finishRecording();
    });

    stepCountLabel = document.getElementById('enh-learn-step-count');
  }

  function updateOverlay() {
    if (stepCountLabel) {
      stepCountLabel.textContent = `Step ${localStepCount}`;
    }
  }

  function removeOverlay() {
    if (overlayBar) {
      overlayBar.remove();
      overlayBar = null;
      stepCountLabel = null;
    }
  }

  // ── Variable Marking ──────────────────────────────────────────

  function markNextAsVariable() {
    const variableBtn = document.getElementById('enh-learn-variable-btn');

    if (nextInputIsVariable) {
      nextInputIsVariable = false;
      pendingVariableName = null;
      variableBtn.style.background = 'rgba(99, 102, 241, 0.15)';
      variableBtn.style.color = '#a5b4fc';
      variableBtn.textContent = 'Mark Variable';
      return;
    }

    const name = prompt('Name this variable (e.g., "recipient email", "search query"):');
    if (!name) return;

    nextInputIsVariable = true;
    pendingVariableName = name.trim().replace(/\s+/g, '_').toLowerCase();
    variableBtn.style.background = 'rgba(239, 68, 68, 0.2)';
    variableBtn.style.color = '#fca5a5';
    variableBtn.textContent = `Variable: ${pendingVariableName}`;
  }

  // ── Pause/Resume ──────────────────────────────────────────────

  function togglePause() {
    const pauseBtn = document.getElementById('enh-learn-pause-btn');

    if (isRecording) {
      isRecording = false;
      pauseBtn.textContent = 'Resume';
      pauseBtn.style.color = '#fbbf24';
    } else {
      isRecording = true;
      pauseBtn.textContent = 'Pause';
      pauseBtn.style.color = '#ededef';
    }
  }

  // ── Attach/Detach Listeners ───────────────────────────────────

  function attachListeners() {
    document.addEventListener('click', handleClick, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('keydown', handleKeydown, true);
    window.addEventListener('scroll', handleScroll, { passive: true, capture: true });
    observeUrlChanges();
  }

  function detachListeners() {
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('keydown', handleKeydown, true);
    window.removeEventListener('scroll', handleScroll, { capture: true });
    if (observeUrlChanges._interval) {
      clearInterval(observeUrlChanges._interval);
    }
  }

  // ── Start/Stop Recording ──────────────────────────────────────

  function startRecording() {
    localStepCount = 0;
    isRecording = true;
    nextInputIsVariable = false;
    pendingVariableName = null;
    lastActionTimestamp = 0;
    recentTypeSteps = [];

    createOverlay();
    attachListeners();

    console.log('[Enhancivity Learning] Recording started on tab');
  }

  function finishRecording() {
    isRecording = false;
    detachListeners();
    removeOverlay();

    console.log('[Enhancivity Learning] Recording stopped on tab, steps reported:', localStepCount);

    // Tell background.js to finalize the recipe
    chrome.runtime.sendMessage({ type: 'learning_session_stop' });
  }

  function cancelRecording() {
    isRecording = false;
    detachListeners();
    removeOverlay();
    localStepCount = 0;
    recentTypeSteps = [];
    console.log('[Enhancivity Learning] Recording cancelled on tab');
  }

  function pauseRecording() {
    isRecording = false;
    console.log('[Enhancivity Learning] Recording paused on tab');
  }

  function resumeRecording() {
    isRecording = true;
    lastActionTimestamp = Date.now(); // Reset wait detection
    console.log('[Enhancivity Learning] Recording resumed on tab');
  }

  // ── Message Listener ──────────────────────────────────────────

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'learning_start') {
      startRecording();
      sendResponse({ success: true });
      return;
    }

    if (request.type === 'learning_stop') {
      finishRecording();
      sendResponse({ success: true });
      return;
    }

    if (request.type === 'learning_cancel') {
      cancelRecording();
      sendResponse({ success: true });
      return;
    }

    if (request.type === 'learning_pause') {
      pauseRecording();
      sendResponse({ success: true });
      return;
    }

    if (request.type === 'learning_resume') {
      // Accept stepCount from background.js to show accurate count after navigation
      if (typeof request.stepCount === 'number' && request.stepCount > localStepCount) {
        localStepCount = request.stepCount;
      }
      if (!isRecording) {
        resumeRecording();
        if (!overlayBar) {
          createOverlay();
          attachListeners();
        }
        updateOverlay();
      }
      sendResponse({ success: true });
      return;
    }

    if (request.type === 'learning_status') {
      sendResponse({
        success: true,
        isRecording,
        stepCount: localStepCount,
      });
      return;
    }
  });

})();
