// ============================================================
// Enhancivity — Universal Interaction Engine
//
// Production-grade DOM interaction engine for form filling,
// clicking, data extraction, and data transfer across ANY
// website regardless of frontend framework.
//
// This is a standalone module. Existing content scripts call
// into it — it does NOT replace them.
//
// Architecture: see task spec for full module map.
// ============================================================

(() => {
  'use strict';

  // Prevent double-injection
  if (window.__enhInteractionEngine) return;
  window.__enhInteractionEngine = true;

  // ═══════════════════════════════════════════════════════════
  // PART 1: UTILITIES
  // Everything else depends on these.
  // ═══════════════════════════════════════════════════════════

  /**
   * Debug logger — every function in this module logs through here.
   * Prefix: [InteractionEngine] for easy filtering in DevTools.
   */
  function log(action, details) {
    console.debug(`[InteractionEngine] ${action}`, details);
  }

  /**
   * Promise-based sleep.
   */
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Normalize values for comparison.
   * Strips whitespace, formatting characters, and lowercases.
   * Handles masked inputs like (123) 456-7890 vs 1234567890.
   */
  function normalize(val) {
    if (val == null) return '';
    return String(val).replace(/[\s\-\(\)\.\,]/g, '').toLowerCase();
  }

  /**
   * Returns correct key and code values for keyboard event simulation.
   * Handles letters, numbers, symbols, whitespace, and control keys.
   */
  function getKeyCode(char) {
    if (char === ' ') return { key: ' ', code: 'Space' };
    if (char === '\t') return { key: 'Tab', code: 'Tab' };
    if (char === '\n' || char === '\r') return { key: 'Enter', code: 'Enter' };
    if (/[a-z]/i.test(char)) return { key: char, code: `Key${char.toUpperCase()}` };
    if (/[0-9]/.test(char)) return { key: char, code: `Digit${char}` };

    const symbolMap = {
      '@': { key: '@', code: 'Digit2' },
      '.': { key: '.', code: 'Period' },
      ',': { key: ',', code: 'Comma' },
      '-': { key: '-', code: 'Minus' },
      '_': { key: '_', code: 'Minus' },
      '/': { key: '/', code: 'Slash' },
      '\\': { key: '\\', code: 'Backslash' },
      '=': { key: '=', code: 'Equal' },
      '+': { key: '+', code: 'Equal' },
      '!': { key: '!', code: 'Digit1' },
      '#': { key: '#', code: 'Digit3' },
      '$': { key: '$', code: 'Digit4' },
      '%': { key: '%', code: 'Digit5' },
      '&': { key: '&', code: 'Digit7' },
      '*': { key: '*', code: 'Digit8' },
      '(': { key: '(', code: 'Digit9' },
      ')': { key: ')', code: 'Digit0' },
      ';': { key: ';', code: 'Semicolon' },
      ':': { key: ':', code: 'Semicolon' },
      "'": { key: "'", code: 'Quote' },
      '"': { key: '"', code: 'Quote' },
      '[': { key: '[', code: 'BracketLeft' },
      ']': { key: ']', code: 'BracketRight' },
      '{': { key: '{', code: 'BracketLeft' },
      '}': { key: '}', code: 'BracketRight' },
      '`': { key: '`', code: 'Backquote' },
      '~': { key: '~', code: 'Backquote' },
      '<': { key: '<', code: 'Comma' },
      '>': { key: '>', code: 'Period' },
      '?': { key: '?', code: 'Slash' },
      '|': { key: '|', code: 'Backslash' },
      '^': { key: '^', code: 'Digit6' },
    };

    return symbolMap[char] || { key: char, code: 'Unidentified' };
  }

  /**
   * Fuzzy match DOM elements (options, suggestions, list items) against a target value.
   * Returns the best-matching element, or null if no match exceeds the threshold.
   *
   * Scoring strategy:
   *   1.0 — exact text match (returns immediately)
   *   0.8 — substring containment (either direction)
   *   0.7 — word-level overlap
   *   0.3 — minimum threshold to return a match
   *
   * Falls back to the first option only if no match meets the threshold.
   */
  function findBestMatch(options, targetValue) {
    if (!options || options.length === 0) return null;

    const target = targetValue.toLowerCase().trim();
    let bestMatch = null;
    let bestScore = 0;

    for (const option of options) {
      const text = (option.textContent || option.innerText || '').toLowerCase().trim();

      // Exact match — return immediately
      if (text === target) {
        log('findBestMatch', { result: 'exact', text });
        return option;
      }

      let score = 0;

      // Substring containment
      if (text.includes(target)) {
        score = target.length / text.length;
      } else if (target.includes(text)) {
        score = text.length / target.length;
      }

      // Word-level matching: "Full Name" should match "Name"
      const targetWords = target.split(/\s+/);
      const textWords = text.split(/\s+/);
      const wordOverlap = targetWords.filter(w =>
        textWords.some(tw => tw.includes(w) || w.includes(tw))
      ).length;
      // Score relative to target words (not max), so "ZIP" matching 1/1 of its own
      // words scores 1.0 even if the option has more words.
      // Also consider the max-based score for multi-word targets.
      const wordScoreByTarget = wordOverlap / targetWords.length;
      const wordScoreByMax = wordOverlap / Math.max(targetWords.length, textWords.length);
      // Use a blend: heavily weight the target-relative score (did we find what we searched for?)
      // but penalize slightly if the option has many extra words
      const wordScore = wordScoreByTarget * 0.7 + wordScoreByMax * 0.3;
      score = Math.max(score, wordScore);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = option;
      }
    }

    log('findBestMatch', { target, bestScore, matched: bestMatch ? (bestMatch.textContent || '').trim().substring(0, 40) : null });
    return bestScore > 0.3 ? bestMatch : null;
  }

  /**
   * Scroll element into the center of the viewport.
   * Uses 'instant' behavior to avoid animation delays.
   */
  async function ensureElementInView(el) {
    log('ensureElementInView', { tag: el.tagName, id: el.id });
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(100);
    return { success: true };
  }

  // ═══════════════════════════════════════════════════════════
  // PART 2: ELEMENT CLASSIFICATION
  // Determines which fill strategy to use for any DOM element.
  // ═══════════════════════════════════════════════════════════

  /**
   * Detect if we're running inside an iframe.
   * Cross-origin iframes block the window.top check — returns true in that case.
   */
  function isInsideIframe() {
    try {
      return window.self !== window.top;
    } catch (e) {
      return true; // cross-origin iframe blocks this check
    }
  }

  /**
   * Classify a DOM element into a fill strategy type.
   *
   * Priority order (first match wins):
   *   iframe_protected → ignore → contenteditable → autocomplete →
   *   custom_dropdown → datepicker → masked_input → framework_controlled →
   *   native_input → unknown
   *
   * Returns one of:
   *   'iframe_protected', 'ignore', 'contenteditable', 'autocomplete',
   *   'custom_dropdown', 'datepicker', 'masked_input', 'framework_controlled',
   *   'native_input', 'unknown'
   */
  function classifyElement(el) {
    log('classify', { tag: el.tagName, type: el.type, id: el.id, class: el.className });

    // ── iframe protection ──
    if (isInsideIframe()) return 'iframe_protected';

    // ── Hidden inputs — skip entirely ──
    if (el.tagName === 'INPUT' && el.type === 'hidden') return 'ignore';

    // ── Contenteditable — check BEFORE input tags ──
    // Some editors use divs/spans, not input/textarea.
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
      return 'contenteditable';
    }

    // ── Native <select> → always custom_dropdown strategy ──
    if (el.tagName === 'SELECT') return 'custom_dropdown';

    // ── Autocomplete detection — PRIORITY over dropdown ──
    // When an INPUT has role=combobox + aria-autocomplete, it needs typing
    // to trigger suggestions (not click-to-open like a dropdown).
    const isAutocomplete =
      el.hasAttribute('data-google-places') ||
      el.getAttribute('aria-autocomplete') === 'list' ||
      el.getAttribute('aria-autocomplete') === 'both' ||
      (el.getAttribute('role') === 'combobox' && el.tagName === 'INPUT') ||
      (el.closest && (
        el.closest('[class*="autocomplete"]') ||
        el.closest('[class*="typeahead"]') ||
        el.closest('[class*="suggest"]')
      ));

    if (isAutocomplete) return 'autocomplete';

    // ── Custom dropdown detection ──
    // Catches MUI, Headless UI, Radix, Ant Design, Select2, Downshift.
    const isCustomDropdown =
      el.getAttribute('role') === 'combobox' ||
      el.getAttribute('role') === 'listbox' ||
      el.getAttribute('aria-haspopup') === 'listbox' ||
      el.getAttribute('aria-haspopup') === 'true' ||
      el.hasAttribute('aria-expanded') ||
      (el.closest && (
        el.closest('[class*="select2"]') ||
        el.closest('[data-radix-select]') ||
        el.closest('[class*="MuiSelect"]')
      ));

    if (isCustomDropdown) return 'custom_dropdown';

    // ── For INPUT / TEXTAREA elements ──
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {

      // Native date/time inputs — always use datepicker strategy
      // (needs native value setter + change event, not plain fillNative)
      if (el.type === 'date' || el.type === 'datetime-local' || el.type === 'time') {
        return 'datepicker';
      }

      // Datepicker: readonly + date-related context
      if (el.readOnly && el.closest && (
        el.closest('[class*="date"]') ||
        el.closest('[class*="picker"]') ||
        el.closest('[class*="calendar"]')
      )) return 'datepicker';

      // Readonly non-datepicker — don't touch
      if (el.readOnly) return 'ignore';

      // Masked input: has mask library markers or phone formatting
      if (el.hasAttribute('data-mask') ||
          el.hasAttribute('data-inputmask') ||
          (el.closest && (
            el.closest('[class*="mask"]') ||
            el.closest('[class*="cleave"]') ||
            el.closest('[class*="imask"]')
          )) ||
          (el.type === 'tel' && (el.maxLength > 0 || el.pattern))) {
        return 'masked_input';
      }

      // Framework detection: React, Vue, Angular
      const isReact = el._valueTracker ||
        Object.keys(el).some(k =>
          k.startsWith('__reactFiber') ||
          k.startsWith('__reactProps') ||
          k.startsWith('__reactInternalInstance')
        );

      const isVue = el.__vue__ || el.__vueParentComponent ||
        (el.closest && el.closest('[data-v-]') !== null);

      const isAngular = el.__ngContext__ ||
        (el.closest && el.closest('[ng-version]') !== null) ||
        (el.closest && (
          el.closest('[_ngcontent]') !== null ||
          el.closest('[_nghost]') !== null
        ));

      if (isReact || isVue || isAngular) return 'framework_controlled';

      return 'native_input';
    }

    return 'unknown';
  }

  /**
   * Detect the specific rich text editor type for a contenteditable element.
   * Used by fillContentEditable to choose the right insertion strategy.
   *
   * Returns one of:
   *   'prosemirror', 'slate', 'draftjs', 'quill', 'tinymce',
   *   'codemirror', 'lexical', 'generic'
   */
  function detectEditor(el) {
    if (el.closest('.ProseMirror')) return 'prosemirror';
    if (el.closest('[data-slate-editor]')) return 'slate';
    if (el.closest('.DraftEditor-root') || el.closest('[data-editor]')) return 'draftjs';
    if (el.closest('.ql-editor')) return 'quill';
    if (el.closest('.tox-edit-area') || el.closest('.mce-content-body')) return 'tinymce';
    if (el.closest('.CodeMirror') || el.closest('.cm-editor')) return 'codemirror';
    if (el.closest('[data-lexical-editor]')) return 'lexical';
    return 'generic';
  }

  // ═══════════════════════════════════════════════════════════
  // PART 3: INPUT STRATEGIES
  // The fill dispatcher + all strategy functions.
  // ═══════════════════════════════════════════════════════════

  /**
   * Main dispatcher — classifies the element and routes to the correct strategy.
   * Returns { success: boolean, reason?: string }
   */
  async function fillField(el, value) {
    const type = classifyElement(el);
    log('fillField', { type, value: String(value).substring(0, 30), elementId: el.id });

    switch (type) {
      case 'native_input':          return await fillNative(el, value);
      case 'framework_controlled':  return await fillFramework(el, value);
      case 'contenteditable':       return await fillContentEditable(el, value);
      case 'custom_dropdown':       return await selectDropdown(el, value);
      case 'autocomplete':          return await handleAutocomplete(el, value);
      case 'masked_input':          return await typeHumanLike(el, value);
      case 'datepicker':            return await handleDatePicker(el, value);
      case 'iframe_protected':
        log('fillField', 'iframe_protected — user must fill manually');
        return { success: false, reason: 'iframe_protected', message: 'This field is in a protected iframe. User must fill it manually.' };
      case 'ignore':
        return { success: true, reason: 'hidden_or_readonly_skipped' };
      default:
        return await fallbackTyping(el, value);
    }
  }

  /**
   * Retry wrapper — attempts fillField up to maxAttempts times.
   */
  async function fillWithRetry(el, value, maxAttempts = 3) {
    for (let i = 0; i < maxAttempts; i++) {
      log('fillWithRetry', { attempt: i + 1, maxAttempts });
      const result = await fillField(el, value);
      if (result.success) return result;
      await sleep(200 + i * 300);
    }
    return { success: false, reason: 'fill_failed_after_retries', attempts: maxAttempts };
  }

  // ── 3b: fillNative ──────────────────────────────────────────

  /**
   * Fill a plain HTML input/textarea with no framework overhead.
   * Sets .value directly, fires input + change events.
   */
  async function fillNative(el, value) {
    log('fillNative', { tag: el.tagName, id: el.id });
    el.focus();
    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    await sleep(30);

    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    return await verifyField(el, value);
  }

  // ── 3c: fillFramework (THE MOST CRITICAL FUNCTION) ──────────

  /**
   * Fill a React/Vue/Angular controlled input.
   * Uses the native prototype setter to bypass framework property overrides,
   * then resets React's _valueTracker so the framework sees the change.
   * Falls back to typeHumanLike if framework fill fails verification.
   */
  async function fillFramework(el, value) {
    log('fillFramework', { tag: el.tagName, id: el.id });
    el.focus();
    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    await sleep(50);

    const isTextarea = el.tagName === 'TEXTAREA';
    const prototype = isTextarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    const nativeSetter = descriptor?.set;

    if (!nativeSetter) {
      log('fillFramework', 'no native setter found — falling back to fillNative');
      return await fillNative(el, value);
    }

    const lastValue = el.value;

    // Set value via native prototype setter — bypasses React/Vue/Angular override
    nativeSetter.call(el, value);

    // REACT FIX: Reset the value tracker so React sees this as a genuine change
    if (el._valueTracker) {
      el._valueTracker.setValue(lastValue);
      log('fillFramework', 'reset React _valueTracker');
    }

    // Dispatch events that all frameworks listen for
    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

    await sleep(50);

    const result = await verifyField(el, value);

    if (!result.success) {
      log('fillFramework', `framework fill failed (${result.reason}) — falling back to keyboard simulation`);
      // Clear using the SAME framework-safe method
      nativeSetter.call(el, '');
      if (el._valueTracker) el._valueTracker.setValue(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(50);

      return await typeHumanLike(el, value);
    }

    return result;
  }

  // ── 3d: fillContentEditable ─────────────────────────────────

  /**
   * Fill a contenteditable element (rich text editors).
   * Uses editor-specific strategies based on detectEditor().
   * Cascade: execCommand → clipboard paste → keyboard simulation.
   */
  async function fillContentEditable(el, value) {
    const editorType = detectEditor(el);
    log('fillContentEditable', { editorType, valueLength: value.length });

    // ── FORCE FOCUS: Click + mousedown/up + focus ──
    // ProseMirror, Slate, and other editors require a real click sequence
    // to place the cursor inside the editable region. .focus() alone is not enough.
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.click();
    el.focus();
    el.dispatchEvent(new Event('focus', { bubbles: true }));
    await sleep(50);

    // ── CLEAR existing content with element-scoped Range ──
    // Use Range.selectNodeContents instead of document.execCommand('selectAll')
    // to avoid selecting content outside the editor.
    const sel = window.getSelection();
    sel.removeAllRanges();
    const existingText = (el.innerText || el.textContent || '').trim();
    if (existingText) {
      const clearRange = document.createRange();
      clearRange.selectNodeContents(el);
      sel.addRange(clearRange);
      document.execCommand('delete', false, null);
      sel.removeAllRanges();
      await sleep(30);
    }

    // ── PLACE CURSOR at start (collapsed — ready for insertion) ──
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    sel.addRange(range);

    // DraftJS: ignores execCommand in newer versions — must use keyboard simulation
    if (editorType === 'draftjs') {
      await sleep(30);
      return await typeHumanLike(el, value);
    }

    // ═══════════════════════════════════════════════
    // TIER 1: execCommand('insertText')
    // Works on: plain contentEditable, Lexical, some Slate
    // ═══════════════════════════════════════════════
    log('fillContentEditable', 'Tier 1: execCommand insertText');
    try {
      document.execCommand('insertText', false, value);
    } catch (e) {
      log('fillContentEditable', 'Tier 1 threw: ' + e.message);
    }
    await sleep(100);

    let verifyResult = await verifyContentEditable(el, value);
    if (verifyResult.success) {
      await syncEditorState(el);
      return verifyResult;
    }

    // ═══════════════════════════════════════════════
    // TIER 2: ClipboardEvent paste (enhanced for ProseMirror)
    // Chrome ignores clipboardData in ClipboardEvent constructor —
    // we must use Object.defineProperty to force it onto the event.
    // Also fires beforeinput(insertFromPaste) for modern ProseMirror.
    // ═══════════════════════════════════════════════
    log('fillContentEditable', 'Tier 2: ClipboardEvent paste');
    try {
      // Re-focus and place cursor
      el.focus();
      el.click();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      sel.removeAllRanges();
      const r2 = document.createRange();
      r2.selectNodeContents(el);
      r2.collapse(false);
      sel.addRange(r2);

      // Build DataTransfer with both plain text and HTML
      const dt = new DataTransfer();
      dt.setData('text/plain', value);
      dt.setData('text/html', `<p>${value.replace(/\n/g, '</p><p>')}</p>`);

      // Create paste event and FORCE clipboardData onto it
      const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, 'clipboardData', {
        value: dt, writable: false, configurable: true,
      });
      el.dispatchEvent(pasteEvent);

      // Also fire beforeinput with insertFromPaste — modern ProseMirror (2024+)
      await sleep(50);
      try {
        el.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'insertFromPaste', data: value, dataTransfer: dt,
          bubbles: true, cancelable: true, composed: true,
        }));
        el.dispatchEvent(new InputEvent('input', {
          inputType: 'insertFromPaste', data: value,
          bubbles: true, cancelable: false, composed: true,
        }));
      } catch (e2) {
        log('fillContentEditable', 'Tier 2 InputEvent failed (non-fatal): ' + e2.message);
      }
      await sleep(200);

      verifyResult = await verifyContentEditable(el, value);
      if (verifyResult.success) {
        await syncEditorState(el);
        return verifyResult;
      }
    } catch (clipError) {
      log('fillContentEditable', 'Tier 2 clipboard paste failed: ' + clipError.message);
    }

    // ═══════════════════════════════════════════════
    // TIER 3: Sequential keyboard simulation
    // Slowest but most reliable — character by character with jitter.
    // ═══════════════════════════════════════════════
    log('fillContentEditable', 'Tier 3: keyboard simulation');
    // Re-focus, clear, place cursor
    el.focus();
    el.click();
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new Event('focus', { bubbles: true }));
    sel.removeAllRanges();
    const r3 = document.createRange();
    r3.selectNodeContents(el);
    r3.collapse(true);
    sel.addRange(r3);
    await sleep(30);

    const kbResult = await typeHumanLike(el, value);
    if (kbResult.success) {
      await syncEditorState(el);
    }
    return kbResult;
  }

  /**
   * ProseMirror state sync — forces the editor to reconcile its internal
   * state with the visible DOM content. Without this, the Submit/Post button
   * may stay grayed out even though text is visible.
   * Technique: blur → refocus → type Space → Backspace (net zero change).
   */
  async function syncEditorState(el) {
    if (!el.isContentEditable) return;
    try {
      el.blur();
      await sleep(50);
      el.focus();
      el.click();
      await sleep(50);

      document.execCommand('insertText', false, ' ');
      await sleep(30);
      document.execCommand('delete', false, null);
      await sleep(50);

      // Fire a synthetic input event as a final nudge
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: '',
      }));
      log('syncEditorState', 'complete');
    } catch (e) {
      log('syncEditorState', 'failed (non-fatal): ' + e.message);
    }
  }

  // ── 3e: selectDropdown ──────────────────────────────────────

  /**
   * Select an option from a native <select> or custom dropdown.
   * For custom dropdowns: click to open → wait for options → fuzzy match → click.
   */
  async function selectDropdown(el, value) {
    const normalized = value.toLowerCase().trim();
    log('selectDropdown', { value, tag: el.tagName });

    // Native <select>
    if (el.tagName === 'SELECT') {
      const option = [...el.options].find(o =>
        o.text.toLowerCase().includes(normalized) ||
        o.value.toLowerCase().includes(normalized)
      );
      if (option) {
        el.value = option.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        log('selectDropdown', 'native select — option found');
        return { success: true };
      }
      return { success: false, reason: 'option_not_found_in_native_select' };
    }

    // Custom dropdown — click to open
    el.click();
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    // Wait for options to appear
    const listboxSelectors = '[role="listbox"], [role="menu"], .dropdown-menu, .options-list, .select-options, .menu-items, [class*="select__menu"], [class*="MuiMenu"], [class*="ant-select-dropdown"]';
    let listbox = null;

    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(200 + attempt * 150);
      listbox = document.querySelector(listboxSelectors);
      if (listbox) break;
    }

    if (!listbox) {
      log('selectDropdown', 'dropdown did not open');
      return { success: false, reason: 'dropdown_didnt_open' };
    }

    const optionSelectors = '[role="option"], [role="menuitem"], .dropdown-item, .option, .select-option, [class*="select__option"], [class*="MuiMenuItem"], li';
    const options = listbox.querySelectorAll(optionSelectors);
    const match = findBestMatch(options, value);

    if (match) {
      match.click();
      await sleep(100);
      log('selectDropdown', 'option selected');
      return { success: true };
    }

    log('selectDropdown', 'no matching option found');
    return { success: false, reason: 'option_not_found' };
  }

  // ── 3f: handleAutocomplete ──────────────────────────────────

  /**
   * Fill an autocomplete field: type partial text, wait for suggestions, select best match.
   * Debounce-safe: waits with increasing delays for suggestions to appear.
   */
  async function handleAutocomplete(el, value) {
    log('handleAutocomplete', { value });

    // Type partial text to trigger suggestions
    const partial = value.slice(0, Math.min(5, value.length));
    await typeHumanLike(el, partial);

    // Wait for suggestions with increasing delays
    const suggestionSelectors = '[role="option"], [role="listbox"] li, .suggestion-item, .pac-item, .pac-matched, .autocomplete-result, .tt-suggestion, [class*="suggestion"], [class*="autocomplete"] li';
    let suggestions = null;

    for (let attempt = 0; attempt < 6; attempt++) {
      await sleep(300 + attempt * 200);
      suggestions = document.querySelectorAll(suggestionSelectors);
      if (suggestions.length > 0) break;
    }

    if (!suggestions || suggestions.length === 0) {
      log('handleAutocomplete', 'no suggestions appeared — falling back to framework fill');
      return await fillFramework(el, value);
    }

    const best = findBestMatch(suggestions, value);
    if (best) {
      best.click();
      await sleep(200);
      log('handleAutocomplete', 'suggestion selected');
      return { success: true };
    }

    // No good match in suggestions — type the full value
    log('handleAutocomplete', 'no matching suggestion — typing full value');
    // Clear field first
    el.focus();
    el.select && el.select();
    document.execCommand('delete', false, null);
    await sleep(50);
    return await fillFramework(el, value);
  }

  // ── 3g: typeHumanLike ───────────────────────────────────────

  /**
   * Type text character by character with realistic timing.
   * Full event sequence per char: keydown → beforeinput → execCommand → input → keyup.
   * Variable delays simulate human typing with occasional pauses.
   * Used for: masked inputs, bot evasion, contenteditable fallback.
   */
  async function typeHumanLike(el, text) {
    log('typeHumanLike', { textLength: text.length });

    el.focus();
    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    await sleep(50 + Math.random() * 80);

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const { key, code } = getKeyCode(char);

      // Full realistic event sequence
      el.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }));
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true, cancelable: true }));

      // Try execCommand first (works with most frameworks)
      const inserted = document.execCommand('insertText', false, char);
      if (!inserted) {
        // execCommand failed — manually append for regular inputs
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const start = el.selectionStart || el.value.length;
          const end = el.selectionEnd || el.value.length;
          el.value = el.value.substring(0, start) + char + el.value.substring(end);
          el.selectionStart = el.selectionEnd = start + 1;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }

      el.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true }));

      // Variable delay: mostly fast, occasional pauses
      if (Math.random() < 0.05 && i > 0) {
        await sleep(200 + Math.random() * 300);
      } else {
        await sleep(15 + Math.random() * 35);
      }
    }

    await sleep(50);

    // Use the right verifier: contenteditable has no .value property
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
      return await verifyContentEditable(el, text);
    }
    return await verifyField(el, text);
  }

  // ── 3h: handleDatePicker ────────────────────────────────────

  /**
   * Fill a native date/time input or custom datepicker.
   * Native: uses prototype setter + change event.
   * Custom: tries hidden input, then falls back to keyboard typing.
   */
  async function handleDatePicker(el, value) {
    log('handleDatePicker', { value, type: el.type });

    // Native date input — set directly via prototype setter
    if (el.type === 'date' || el.type === 'datetime-local' || el.type === 'time') {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true };
    }

    // Try to find a hidden input that stores the actual date value
    const form = el.closest('form') || el.parentElement;
    const hiddenDate = form?.querySelector('input[type="hidden"][name*="date"]');
    if (hiddenDate) {
      hiddenDate.value = value;
      hiddenDate.dispatchEvent(new Event('change', { bubbles: true }));
      log('handleDatePicker', 'set hidden date input');
      return { success: true };
    }

    // Custom date picker — click to open, then try keyboard input
    el.click();
    await sleep(300);
    return await typeHumanLike(el, value);
  }

  // ── 3i: fallbackTyping ──────────────────────────────────────

  /**
   * Last-resort fallback: tries framework fill → native fill → keyboard simulation.
   */
  async function fallbackTyping(el, value) {
    log('fallbackTyping', 'trying strategies in order');

    let result = await fillFramework(el, value);
    if (result.success) return result;

    result = await fillNative(el, value);
    if (result.success) return result;

    return await typeHumanLike(el, value);
  }

  // ═══════════════════════════════════════════════════════════
  // PART 4: VERIFICATION ENGINE
  // Checks that fill operations actually worked.
  // ═══════════════════════════════════════════════════════════

  /**
   * Verify that an input/textarea field contains the expected value.
   * Multi-layer check: DOM value → React state → validation errors.
   */
  async function verifyField(el, expected) {
    await sleep(50);

    const domValue = (el.value || '').trim();
    const expectedTrimmed = expected.trim();

    // Step 1: DOM value check with normalize (handles masked/formatted inputs)
    if (normalize(domValue) !== normalize(expectedTrimmed) && domValue !== expectedTrimmed) {
      log('verifyField', { step: 'dom_mismatch', actual: domValue, expected: expectedTrimmed });
      return { success: false, reason: 'dom_mismatch', actual: domValue, expected: expectedTrimmed };
    }

    // Step 2: React internal state cross-check
    if (el._valueTracker) {
      const trackerValue = el._valueTracker.getValue();
      if (normalize(trackerValue) !== normalize(expectedTrimmed) && trackerValue !== expectedTrimmed) {
        log('verifyField', { step: 'react_state_mismatch', tracker: trackerValue });
        return { success: false, reason: 'react_state_mismatch', actual: trackerValue };
      }
    }

    // Step 3: Trigger validation via blur
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(150);

    // Step 4: Check for validation error messages near the field
    const container = el.closest(
      '[class*="field"], [class*="form-group"], [class*="input-wrapper"], [class*="form-item"], [class*="form-control"]'
    );
    if (container) {
      const error = container.querySelector(
        '[class*="error"], [class*="invalid"], [role="alert"], .help-block, [class*="warning"]'
      );
      if (error && error.textContent.trim() && error.offsetHeight > 0) {
        log('verifyField', { step: 'validation_error', message: error.textContent.trim() });
        return { success: false, reason: 'validation_error', message: error.textContent.trim() };
      }
    }

    log('verifyField', 'success');
    return { success: true };
  }

  /**
   * Verify contenteditable element contains the expected text.
   * Checks textContent/innerText — editors may add formatting.
   */
  async function verifyContentEditable(el, value) {
    // ProseMirror and other editors need more time to update DOM after insertion
    await sleep(500);
    const expected = value.trim();
    const matchStr = expected.substring(0, Math.min(20, expected.length));

    // Check direct textContent/innerText
    let content = (el.textContent || el.innerText || '').trim();
    if (content.includes(matchStr)) return { success: true };

    // Check child nodes — ProseMirror renders inside <p>, <div>, <span> children
    const children = el.querySelectorAll('p, div, span, [data-contents], [data-block]');
    for (const child of children) {
      const childText = (child.innerText || child.textContent || '').trim();
      if (childText.includes(matchStr)) return { success: true };
    }

    // Check parent container (for editors where text appears in a sibling)
    const parent = el.closest('[role="textbox"], [contenteditable="true"], .editor, .ProseMirror, .ql-editor') || el.parentElement;
    if (parent && parent !== el) {
      const parentText = (parent.innerText || parent.textContent || '').trim();
      if (parentText.includes(matchStr)) return { success: true };
    }

    log('verifyContentEditable', { reason: 'mismatch', expected: matchStr, actual: content.substring(0, 50) });
    return { success: false, reason: 'contenteditable_mismatch', actual: content.substring(0, 50) };
  }

  // ═══════════════════════════════════════════════════════════
  // PART 5: REQUIRED FIELD DETECTION
  // Pre-submit scan for empty required fields.
  // ═══════════════════════════════════════════════════════════

  /**
   * Scan the page for required fields that are still empty.
   * Returns an array of objects describing each unfilled required field:
   *   { element, name, label, type }
   *
   * Skips: hidden inputs, invisible elements.
   * Handles: checkboxes (must be checked), radio groups (one must be selected).
   */
  function getRequiredEmptyFields() {
    const required = document.querySelectorAll('[required], [aria-required="true"]');
    log('getRequiredEmptyFields', { totalRequired: required.length });

    const empty = [...required]
      .filter(el => {
        // Skip hidden inputs
        if (el.type === 'hidden') return false;

        // Skip invisible elements
        if (el.offsetHeight === 0 && el.offsetWidth === 0) return false;

        // Checkbox: must be checked
        if (el.type === 'checkbox') return !el.checked;

        // Radio: at least one in the group must be checked
        if (el.type === 'radio') {
          return !document.querySelector(`input[name="${el.name}"]:checked`);
        }

        // All other inputs: must have a non-empty value
        return !el.value || el.value.trim() === '';
      })
      .map(el => ({
        element: el,
        name: el.name || el.id || 'unknown',
        label:
          (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim()) ||
          el.getAttribute('aria-label') ||
          el.placeholder ||
          el.name ||
          'unknown field',
        type: classifyElement(el),
      }));

    log('getRequiredEmptyFields', { emptyCount: empty.length });
    return empty;
  }

  // ═══════════════════════════════════════════════════════════
  // PART 6: CLICK ENGINE
  // Reliable clicking with scroll, hover, center-coordinate
  // targeting, icon/delegate resolution, and retry logic.
  // ═══════════════════════════════════════════════════════════

  /**
   * Walk up the DOM to find the nearest clickable ancestor.
   * Resolves cases where the click target is an SVG icon, img, or span
   * inside a button/link/interactive element.
   * Returns the clickable ancestor, or the original element if none found.
   */
  function findClickableParent(el) {
    let current = el;
    while (current && current !== document.body) {
      if (
        current.tagName === 'BUTTON' ||
        current.tagName === 'A' ||
        current.getAttribute('role') === 'button' ||
        current.getAttribute('role') === 'link' ||
        current.getAttribute('role') === 'menuitem' ||
        current.getAttribute('role') === 'tab' ||
        current.getAttribute('role') === 'option' ||
        current.getAttribute('role') === 'switch' ||
        (current.tabIndex >= 0 && current.tabIndex !== undefined) ||
        current.onclick ||
        current.hasAttribute('data-action') ||
        current.hasAttribute('ng-click') ||
        current.hasAttribute('@click') ||
        current.hasAttribute('v-on:click') ||
        current.hasAttribute('data-bs-toggle') ||
        current.hasAttribute('data-toggle') ||
        window.getComputedStyle(current).cursor === 'pointer'
      ) {
        log('findClickableParent', { resolved: current.tagName, id: current.id, from: el.tagName });
        return current;
      }
      current = current.parentElement;
    }
    return el; // Return original element if no clickable parent found
  }

  /**
   * Poll until element is visible and enabled, or timeout.
   * Visible = has width/height, not hidden/display:none, opacity > 0.
   * Enabled = not disabled, not aria-disabled="true".
   * Returns true if clickable, false if timed out.
   */
  async function waitUntilClickable(el, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        parseFloat(style.opacity) > 0;
      const enabled = !el.disabled && el.getAttribute('aria-disabled') !== 'true';

      if (visible && enabled) return true;
      await sleep(100);
    }
    log('waitUntilClickable', 'timeout — element not clickable');
    return false;
  }

  /**
   * Full reliable click simulation:
   *   1. Resolve to clickable parent (icon/delegate resolution)
   *   2. Scroll into view
   *   3. Wait until clickable
   *   4. Hover simulation (mouseover + mouseenter)
   *   5. Click at center coordinates (full pointer + mouse event sequence)
   * Returns { success: boolean, reason?: string }
   */
  async function reliableClick(el) {
    const clickTarget = findClickableParent(el);
    log('reliableClick', { target: clickTarget.tagName, text: (clickTarget.textContent || '').substring(0, 30) });

    // Scroll into view
    await ensureElementInView(clickTarget);

    // Wait for clickable
    const clickable = await waitUntilClickable(clickTarget);
    if (!clickable) return { success: false, reason: 'not_clickable_after_wait' };

    // Hover simulation
    clickTarget.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    clickTarget.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await sleep(30);

    // Click at center coordinates
    const rect = clickTarget.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    clickTarget.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }));
    clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
    clickTarget.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y }));
    clickTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
    clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));

    return { success: true };
  }

  /**
   * Retry wrapper for reliableClick.
   * Retries with increasing delay between attempts.
   */
  async function clickWithRetry(el, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      const result = await reliableClick(el);
      if (result.success) return result;
      await sleep(300 + i * 200);
    }
    return { success: false, reason: 'all_retries_failed' };
  }

  // ═══════════════════════════════════════════════════════════
  // PART 7: PAGE STABILITY ENGINE
  // Waits for the page to stop mutating before interacting.
  // ═══════════════════════════════════════════════════════════

  /**
   * Wait for the page DOM to stabilize (stop mutating).
   * Uses MutationObserver to track DOM changes. Resolves when no mutations
   * occur for `quietPeriod` ms, or rejects after `timeout` ms.
   *
   * Returns { stable: boolean, waitedMs?: number, reason?: string }
   */
  async function waitForPageStable({ timeout = 8000, quietPeriod = 500 } = {}) {
    // First: wait for basic document readiness
    if (document.readyState !== 'complete') {
      await new Promise(resolve => {
        if (document.readyState === 'complete') resolve();
        else window.addEventListener('load', resolve, { once: true });
      });
    }

    return new Promise((resolve) => {
      let lastMutationTime = Date.now();
      let resolved = false;

      const observer = new MutationObserver(() => {
        lastMutationTime = Date.now();
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });

      const checkInterval = setInterval(() => {
        if (Date.now() - lastMutationTime >= quietPeriod) {
          clearInterval(checkInterval);
          observer.disconnect();
          resolved = true;
          log('waitForPageStable', 'page stable');
          resolve({ stable: true, waitedMs: Date.now() - lastMutationTime });
        }
      }, 100);

      setTimeout(() => {
        if (!resolved) {
          clearInterval(checkInterval);
          observer.disconnect();
          log('waitForPageStable', 'timeout — page still mutating');
          resolve({ stable: false, reason: 'timeout' });
        }
      }, timeout);
    });
  }

  // ═══════════════════════════════════════════════════════════
  // PART 8: DATA EXTRACTION
  // Extract structured data from tables and card layouts.
  // ═══════════════════════════════════════════════════════════

  /**
   * Extract structured data from an HTML table element.
   * Returns { headers: string[], rows: object[], totalRows: number }
   * Each row is an object keyed by header name (or col_0, col_1 if no headers).
   * Cell values are { text: string, href: string|null }.
   */
  function extractTable(tableEl) {
    log('extractTable', { tag: tableEl.tagName });

    const thead = tableEl.querySelector('thead');
    const headerRow = thead
      ? thead.querySelector('tr')
      : tableEl.querySelector('tr:first-child');
    const headers = headerRow
      ? [...headerRow.querySelectorAll('th, td')].map(h => h.textContent.trim())
      : [];

    // Get body rows — skip the header row if it came from the body (no thead)
    const allBodyTrs = [...(tableEl.querySelector('tbody') || tableEl).querySelectorAll('tr')];
    const bodyRows = thead
      ? allBodyTrs  // thead exists: all tbody rows are data rows
      : allBodyTrs.filter(tr => tr !== headerRow);  // no thead: exclude the header row

    const rows = [...bodyRows].map(tr => {
      const cells = [...tr.querySelectorAll('td, th')].map(td => ({
        text: td.textContent.trim(),
        href: td.querySelector('a')?.href || null,
      }));

      const row = {};
      if (headers.length > 0) {
        headers.forEach((h, i) => {
          row[h] = cells[i] || { text: '', href: null };
        });
      } else {
        cells.forEach((cell, i) => { row[`col_${i}`] = cell; });
      }
      return row;
    });

    log('extractTable', { rows: rows.length, headers: headers.length });
    return { headers, rows, totalRows: rows.length };
  }

  /**
   * Extract structured data from repeated card/item elements.
   * containerSelector: CSS selector for each card element.
   * fieldSelectors: { fieldName: cssSelector } map for extracting fields from each card.
   * Returns array of objects with { text, href } per field.
   */
  function extractCards(containerSelector, fieldSelectors) {
    const cards = document.querySelectorAll(containerSelector);
    log('extractCards', { cards: cards.length });

    return [...cards].map(card => {
      const row = {};
      for (const [field, selector] of Object.entries(fieldSelectors)) {
        const el = card.querySelector(selector);
        row[field] = el ? {
          text: el.textContent.trim(),
          href: el.href || el.querySelector('a')?.href || null,
        } : null;
      }
      return row;
    });
  }

  // ═══════════════════════════════════════════════════════════
  // PART 9: DATA PERSISTENCE
  // Save/load extracted data via chrome.storage.local.
  // ═══════════════════════════════════════════════════════════

  /**
   * Save data to chrome.storage.local under a key.
   * Returns { success: boolean, reason?: string }
   */
  async function saveTransferData(key, data) {
    log('saveTransferData', { key, rowCount: Array.isArray(data) ? data.length : 'n/a' });
    try {
      await chrome.storage.local.set({ [key]: JSON.stringify(data) });
      return { success: true };
    } catch (e) {
      log('saveTransferData', 'error: ' + e.message);
      return { success: false, reason: e.message };
    }
  }

  /**
   * Load data from chrome.storage.local by key.
   * Returns { success: boolean, data?: any, reason?: string }
   */
  async function loadTransferData(key) {
    try {
      const result = await chrome.storage.local.get(key);
      if (result[key]) {
        const data = JSON.parse(result[key]);
        log('loadTransferData', { key, loaded: true });
        return { success: true, data };
      }
      return { success: false, reason: 'key_not_found' };
    } catch (e) {
      return { success: false, reason: e.message };
    }
  }

  /**
   * Remove data from chrome.storage.local by key.
   */
  async function clearTransferData(key) {
    try {
      await chrome.storage.local.remove(key);
      log('clearTransferData', { key });
      return { success: true };
    } catch (e) {
      return { success: false, reason: e.message };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PART 10: DATA TRANSFER UTILITIES
  // Convert data to TSV, find fields by label, fuzzy match.
  // ═══════════════════════════════════════════════════════════

  /**
   * Convert extracted data to tab-separated values string.
   * Handles both plain string values and {text, href} objects from extraction.
   */
  function toTSV(data, headers) {
    const escape = (val) => String(val || '').replace(/\t/g, ' ').replace(/\n/g, ' ').replace(/\r/g, '');
    const headerRow = headers.map(escape).join('\t');
    const dataRows = data.map(row =>
      headers.map(h => {
        const cell = row[h];
        const val = typeof cell === 'object' && cell !== null ? cell.text : cell;
        return escape(val);
      }).join('\t')
    );
    return [headerRow, ...dataRows].join('\n');
  }

  /**
   * Find a form field by its label text (fuzzy matching).
   * Searches: label[for], wrapping label, placeholder, aria-label, name, nearby text.
   * Returns the best-matching input element, or null.
   */
  function findField(fieldName) {
    const normalized = fieldName.toLowerCase().trim();
    const inputs = document.querySelectorAll('input:not([type="hidden"]), textarea, select');
    log('findField', { fieldName, candidates: inputs.length });

    let bestInput = null;
    let bestScore = 0;

    for (const input of inputs) {
      let score = 0;

      // Strategy 1: Label with for= attribute (strongest signal)
      if (input.id) {
        const label = document.querySelector(`label[for="${input.id}"]`);
        if (label) {
          const labelText = label.textContent.toLowerCase().trim();
          if (labelText === normalized) score = Math.max(score, 1.0);
          else if (labelText.includes(normalized) || normalized.includes(labelText)) {
            score = Math.max(score, 0.8);
          }
        }
      }

      // Strategy 2: Wrapping label
      const wrappingLabel = input.closest('label');
      if (wrappingLabel) {
        const text = wrappingLabel.textContent.toLowerCase().trim();
        if (text.includes(normalized)) score = Math.max(score, 0.75);
      }

      // Strategy 3: Placeholder
      const placeholder = (input.placeholder || '').toLowerCase();
      if (placeholder === normalized) score = Math.max(score, 0.9);
      else if (placeholder.includes(normalized) || normalized.includes(placeholder)) {
        score = Math.max(score, 0.7);
      }

      // Strategy 4: aria-label
      const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
      if (ariaLabel && (ariaLabel.includes(normalized) || normalized.includes(ariaLabel))) {
        score = Math.max(score, 0.7);
      }

      // Strategy 5: Name attribute
      const name = (input.name || '').toLowerCase().replace(/[_\-\.]/g, ' ');
      if (name && (name.includes(normalized) || normalized.includes(name))) {
        score = Math.max(score, 0.6);
      }

      // Strategy 6: Nearby text — only check immediate adjacent siblings
      // (not all parent children, which causes false matches in forms)
      const prev = input.previousElementSibling;
      if (prev && !prev.querySelector('input, textarea, select')) {
        const prevText = prev.textContent.toLowerCase().trim();
        if (prevText.includes(normalized)) {
          score = Math.max(score, 0.55);
        }
      }
      const next = input.nextElementSibling;
      if (next && !next.querySelector('input, textarea, select')) {
        const nextText = next.textContent.toLowerCase().trim();
        if (nextText.includes(normalized)) {
          score = Math.max(score, 0.45);
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestInput = input;
      }
    }

    log('findField', { fieldName, bestScore, found: !!bestInput });
    return bestScore > 0.3 ? bestInput : null;
  }

  // ═══════════════════════════════════════════════════════════
  // MODULE EXPORT
  // Exposed on window for content script access.
  // ═══════════════════════════════════════════════════════════

  window.__enhInteractionEngine = {
    // Utilities
    log,
    sleep,
    normalize,
    getKeyCode,
    findBestMatch,
    ensureElementInView,

    // Classification
    classifyElement,
    detectEditor,
    isInsideIframe,

    // Filling
    fillField,
    fillWithRetry,
    fillNative,
    fillFramework,
    fillContentEditable,
    selectDropdown,
    handleAutocomplete,
    typeHumanLike,
    handleDatePicker,
    fallbackTyping,

    // Verification
    verifyField,
    verifyContentEditable,

    // Required Field Detection
    getRequiredEmptyFields,

    // Clicking
    reliableClick,
    clickWithRetry,
    findClickableParent,
    waitUntilClickable,

    // Page Stability
    waitForPageStable,

    // Extraction
    extractTable,
    extractCards,

    // Data Transfer
    toTSV,
    findField,
    saveTransferData,
    loadTransferData,
    clearTransferData,
  };

})();
