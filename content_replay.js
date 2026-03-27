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

  // Adaptive polling: tracks how long waitForElement took per step.
  // Shared across replayRecipe + waitForElement. Reset on each new replay.
  let elementFindTimings = [];

  // ── Element Finding (Multi-Strategy Selector Resolution) ─────

  function getAllReachableDocuments() {
    const docs = [document];
    try {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
          if (iframeDoc) docs.push(iframeDoc);
        } catch {
          // Cross-origin iframe: intentionally skipped
        }
      }
    } catch {}
    return docs;
  }

  function isVisibleInDocument(el, doc) {
    if (!el || !doc) return false;
    const view = doc.defaultView || window;
    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function resolveElementBySemanticId(semanticId) {
    if (!semanticId) return null;

    for (const doc of getAllReachableDocuments()) {
      try {
        const el = doc.querySelector(`[data-enh-sid="${CSS.escape(semanticId)}"]`);
        if (el && isVisibleInDocument(el, doc)) {
          return {
            element: el,
            usedStrategy: 'semantic-fallback',
            iframe: doc === document ? null : doc.defaultView?.frameElement || null,
          };
        }
      } catch {}
    }

    return null;
  }

  function normalizeMatchText(text) {
    if (!text) return '';
    return String(text)
      .replace(/\s+/g, ' ')
      .replace(/[↕↔↑↓←→]/g, ' ')
      .replace(/\s+(Ctrl|Cmd|Shift|Alt|Option|Meta)\b.*$/i, '')
      .replace(/\s+[⌘⌥⇧^].*$/, '')
      .trim()
      .toLowerCase();
  }

  function getImplicitRole(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    if (tag === 'button') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'option') return 'option';

    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }

    return '';
  }

  function resolveIdReferenceText(doc, idRefs) {
    if (!doc || !idRefs) return '';

    return idRefs
      .split(/\s+/)
      .map(id => doc.getElementById(id))
      .filter(Boolean)
      .map(node => normalizeMatchText(node.innerText || node.textContent || ''))
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  function getAccessibleRole(el) {
    return normalizeMatchText(el.getAttribute('role') || getImplicitRole(el));
  }

  function getAccessibleName(el, doc) {
    return normalizeMatchText(
      el.getAttribute('aria-label') ||
      resolveIdReferenceText(doc, el.getAttribute('aria-labelledby')) ||
      getDirectText(el) ||
      el.innerText ||
      el.textContent ||
      ''
    );
  }

  function getRoleText(doc, el) {
    return normalizeMatchText(getDirectText(el) || el.innerText || el.textContent || '');
  }

  function getA11yCandidates(doc) {
    if (!doc) return [];
    try {
      return Array.from(doc.querySelectorAll(
        'button, a[href], input, select, textarea, summary, dialog, [role], [aria-label], [aria-labelledby], [contenteditable="true"]'
      )).filter(el => isVisibleInDocument(el, doc));
    } catch {
      return [];
    }
  }

  function toFoundElement(doc, element, usedStrategy) {
    return {
      element,
      usedStrategy,
      iframe: doc === document ? null : doc.defaultView?.frameElement || null,
    };
  }

  function findElementByA11y(a11yData) {
    if (!a11yData) return null;

    const targetRole = normalizeMatchText(a11yData.role);
    const labelCandidates = Array.from(new Set([
      a11yData.ariaLabel,
      a11yData.name,
      a11yData.ariaLabelledBy,
    ].map(normalizeMatchText).filter(Boolean)));

    if (!targetRole && labelCandidates.length === 0) return null;

    for (const doc of getAllReachableDocuments()) {
      const candidates = getA11yCandidates(doc);

      for (const candidate of candidates) {
        const candidateRole = getAccessibleRole(candidate);
        const candidateName = getAccessibleName(candidate, doc);
        const roleMatches = !targetRole || candidateRole === targetRole;

        if (!roleMatches || !candidateName) continue;
        if (labelCandidates.some(label => candidateName === label)) {
          return toFoundElement(doc, candidate, 'a11y-exact');
        }
      }
    }

    let bestFuzzyMatch = null;
    for (const doc of getAllReachableDocuments()) {
      const candidates = getA11yCandidates(doc);

      for (const candidate of candidates) {
        const candidateName = getAccessibleName(candidate, doc);
        if (!candidateName) continue;

        const matchedLabel = labelCandidates.find(label =>
          candidateName.includes(label) || label.includes(candidateName)
        );
        if (!matchedLabel) continue;

        const score = Math.abs(candidateName.length - matchedLabel.length);
        if (!bestFuzzyMatch || score < bestFuzzyMatch.score) {
          bestFuzzyMatch = {
            doc,
            candidate,
            score,
          };
        }
      }
    }

    if (bestFuzzyMatch) {
      return toFoundElement(bestFuzzyMatch.doc, bestFuzzyMatch.candidate, 'a11y-fuzzy');
    }

    if (!targetRole || labelCandidates.length === 0) return null;

    for (const doc of getAllReachableDocuments()) {
      const candidates = getA11yCandidates(doc);

      for (const candidate of candidates) {
        const candidateRole = getAccessibleRole(candidate);
        const candidateText = getRoleText(doc, candidate);
        if (candidateRole !== targetRole || !candidateText) continue;

        if (labelCandidates.some(label => candidateText === label || candidateText.includes(label))) {
          return toFoundElement(doc, candidate, 'a11y-role-text');
        }
      }
    }

    return null;
  }

  async function resolveViaSemanticFallback(description, semanticContext) {
    const goalParts = [];
    if (description) goalParts.push(description);
    if (semanticContext?.label) goalParts.push(`Target label: ${semanticContext.label}`);
    if (semanticContext?.tag) goalParts.push(`Element tag: ${semanticContext.tag}`);
    if (semanticContext?.role) goalParts.push(`ARIA role: ${semanticContext.role}`);
    if (semanticContext?.type) goalParts.push(`Input type: ${semanticContext.type}`);
    if (semanticContext?.ariaLabel) goalParts.push(`Aria label: ${semanticContext.ariaLabel}`);
    if (semanticContext?.placeholder) goalParts.push(`Placeholder: ${semanticContext.placeholder}`);
    if (semanticContext?.title) goalParts.push(`Title: ${semanticContext.title}`);
    if (semanticContext?.context) goalParts.push(`Nearby context: ${semanticContext.context}`);
    if (semanticContext?.position) goalParts.push(`Viewport area: ${semanticContext.position}`);
    if (semanticContext?.previousStep) goalParts.push(`Previous step: ${semanticContext.previousStep}`);
    if (semanticContext?.nextStep) goalParts.push(`Next step: ${semanticContext.nextStep}`);
    if (semanticContext?.workflowName) goalParts.push(`Workflow: ${semanticContext.workflowName}`);

    const userGoal = goalParts.filter(Boolean).join('\n');
    if (!userGoal) return null;

    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'semantic_scrape',
          data: {
            userGoal,
            category: 'general',
            mode: 'find_element',
          },
        }, (result) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(result || { success: false, error: 'No semantic response.' });
        });
      });

      if (!response?.success || !response?.data?.target?.semanticId) {
        return null;
      }

      const resolved = resolveElementBySemanticId(response.data.target.semanticId);
      if (resolved) {
        console.log('[Enhancivity Replay] Recovered element via semantic fallback:', response.data.target.rationale || response.data.target.semanticId);
      }
      return resolved;
    } catch (err) {
      console.warn('[Enhancivity Replay] Semantic fallback failed:', err.message);
      return null;
    }
  }

  function getVisibleMatches(doc, selectors) {
    const matches = [];
    for (const selector of selectors) {
      try {
        const found = Array.from(doc.querySelectorAll(selector))
          .filter(el => isVisibleInDocument(el, doc));
        matches.push(...found);
      } catch {}
    }
    return matches;
  }

  function findGmailSpecialElement(description, semanticContext) {
    const host = window.location.hostname.toLowerCase();
    if (!host.includes('mail.google.com')) return null;

    const hint = `${description || ''} ${semanticContext?.label || ''} ${semanticContext?.ariaLabel || ''}`.toLowerCase();
    if (!hint.trim()) return null;

    const docs = getAllReachableDocuments();

    const resolveLastVisible = (selectors, strategy) => {
      for (const doc of docs) {
        const matches = getVisibleMatches(doc, selectors);
        if (matches.length > 0) {
          const el = matches[matches.length - 1];
          return {
            element: el,
            usedStrategy: strategy,
            iframe: doc === document ? null : doc.defaultView?.frameElement || null,
          };
        }
      }
      return null;
    };

    if (hint.includes('compose')) {
      return resolveLastVisible([
        '.T-I.T-I-KE.L3',
        'div[role="button"][gh="cm"]',
        '[gh="cm"]',
        '[data-tooltip="Compose"]',
      ], 'gmail-compose');
    }

    if (hint.includes('subject')) {
      return resolveLastVisible([
        'input[name="subjectbox"]',
        'input[placeholder="Subject"]',
      ], 'gmail-subject');
    }

    if (hint.includes('message body') || hint.includes('body') || hint.includes('compose body')) {
      return resolveLastVisible([
        '.Am.Al.editable[role="textbox"]',
        'div[aria-label="Message Body"]',
        'div[aria-label*="Message Body" i][contenteditable="true"]',
        '[g_editable="true"][role="textbox"]',
        '[role="textbox"][contenteditable="true"]',
      ], 'gmail-body');
    }

    if (hint.includes('to') || hint.includes('recipient')) {
      return resolveLastVisible([
        'textarea[name="to"]',
        'input[name="to"]',
        'input[aria-label*="recipients" i]',
      ], 'gmail-to');
    }

    return null;
  }

  function findElement(selectors, description, semanticContext) {
    const gmailSpecial = findGmailSpecialElement(description, semanticContext);
    if (gmailSpecial) return gmailSpecial;

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
            const target = normalizeMatchText(sel.value);

            // Pass 1: Exact match on innerText (visible text only)
            for (const c of textCandidates) {
              const inner = normalizeMatchText(c.innerText || c.textContent || '');
              if (inner === target && isVisible(c)) { el = c; break; }
            }

            // Pass 2: Case-insensitive match
            if (!el) {
              for (const c of textCandidates) {
                const inner = normalizeMatchText(c.innerText || c.textContent || '');
                if (inner === target && isVisible(c)) { el = c; break; }
              }
            }

            // Pass 3: Direct text nodes only (skip nested child text)
            if (!el) {
              for (const c of textCandidates) {
                const directText = normalizeMatchText(getDirectText(c));
                if (directText && directText === target && isVisible(c)) { el = c; break; }
              }
            }

            // Pass 4: Element contains the target text as a standalone word/phrase
            // (handles cases where textContent has extra whitespace or minor additions)
            if (!el && target.length >= 3) {
              for (const c of textCandidates) {
                const inner = normalizeMatchText(c.innerText || c.textContent || '');
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
              const targetText = normalizeMatchText(text);
              for (const c of roleCandidates) {
                const inner = normalizeMatchText(c.innerText || c.textContent || '');
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
              const expectedLabel = normalizeMatchText(labelMatch[1]);
              const elText = normalizeMatchText(el.innerText || el.textContent || '');
              const elAria = normalizeMatchText(el.getAttribute('aria-label') || '');
              const elPlaceholder = normalizeMatchText(el.getAttribute('placeholder') || '');

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
        const label = normalizeMatchText(labelMatch[1]);
        const allClickable = document.querySelectorAll(
          'a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [contenteditable], label, summary'
        );

        // Pass 1: innerText exact (case-insensitive)
        for (const c of allClickable) {
          const inner = normalizeMatchText(c.innerText || c.textContent || '');
          if (inner === label && isVisible(c)) {
            console.log('[Enhancivity Replay] Found via description fallback (exact):', label);
            return { element: c, usedStrategy: 'description-fallback' };
          }
        }

        // Pass 2: direct text match
        for (const c of allClickable) {
          const direct = normalizeMatchText(getDirectText(c));
          if (direct && direct === label && isVisible(c)) {
            console.log('[Enhancivity Replay] Found via description fallback (direct-text):', label);
            return { element: c, usedStrategy: 'description-fallback' };
          }
        }

        // Pass 3: aria-label match
        for (const c of allClickable) {
          const aria = normalizeMatchText(c.getAttribute('aria-label') || '');
          if (aria === label && isVisible(c)) {
            console.log('[Enhancivity Replay] Found via description fallback (aria):', label);
            return { element: c, usedStrategy: 'description-fallback' };
          }
        }

        // Pass 4: contains match (smallest matching element wins)
        let bestFallback = null;
        for (const c of allClickable) {
          const inner = normalizeMatchText(c.innerText || c.textContent || '');
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

    // ── Iframe fallback: search inside same-origin iframes ──
    // Gmail compose body, Outlook editor, and other apps render input fields
    // inside iframes. document.querySelector can't reach them.
    try {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        let iframeDoc;
        try {
          iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        } catch {
          continue; // cross-origin — skip
        }
        if (!iframeDoc) continue;

        // Try selectors inside this iframe
        const sorted = [...selectors].sort((a, b) => a.priority - b.priority);
        for (const sel of sorted) {
          try {
            let el = null;
            if (sel.strategy === 'aria-label') {
              el = iframeDoc.querySelector(`[aria-label="${CSS.escape(sel.value)}"]`);
            } else if (sel.strategy === 'css-id' || sel.strategy === 'css') {
              el = iframeDoc.querySelector(sel.value);
            } else if (sel.strategy === 'name') {
              el = iframeDoc.querySelector(`[name="${CSS.escape(sel.value)}"]`);
            } else if (sel.strategy === 'placeholder') {
              el = iframeDoc.querySelector(`[placeholder="${CSS.escape(sel.value)}"]`);
            } else if (sel.strategy === 'data-testid') {
              el = iframeDoc.querySelector(sel.value);
            }
            if (el) {
              console.log(`[Enhancivity Replay] Found in iframe via ${sel.strategy}:`, sel.value);
              return { element: el, usedStrategy: `iframe-${sel.strategy}`, iframe };
            }
          } catch { continue; }
        }

        // Try description fallback inside iframe
        if (description) {
          const labelMatch = description.match(/["'](.+?)["']/);
          if (labelMatch) {
            const label = normalizeMatchText(labelMatch[1]);
            const candidates = iframeDoc.querySelectorAll(
              'a, button, input, select, textarea, [role="button"], [role="textbox"], [contenteditable], label'
            );
            for (const c of candidates) {
              const aria = normalizeMatchText(c.getAttribute('aria-label') || '');
              const inner = normalizeMatchText(c.innerText || c.textContent || '');
              if ((aria === label || inner === label) && isVisibleInDocument(c, iframeDoc)) {
                console.log('[Enhancivity Replay] Found in iframe via description:', label);
                return { element: c, usedStrategy: 'iframe-description', iframe };
              }
            }
          }
        }
      }
    } catch (iframeErr) {
      console.warn('[Enhancivity Replay] Iframe search failed:', iframeErr.message);
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
  // Polls with adaptive timing: starts fast, slows down if element isn't found quickly.
  // Uses elementFindTimings (tracked per-replay in replayRecipe) to calibrate:
  //   - If recent steps found elements in <500ms → poll at 200ms, timeout at 5s
  //   - Otherwise → default 400ms poll, 12s timeout
  // After a navigation step, timings reset (new page = fresh loading).

  async function waitForElement(selectors, timeoutMs = 12000, description, semanticContext) {
    // Adaptive calibration from recent replay history
    let effectiveTimeout = timeoutMs;
    let basePollMs = 400;
    if (elementFindTimings.length >= 3) {
      const avg = elementFindTimings.slice(-5).reduce((a, b) => a + b, 0) / Math.min(elementFindTimings.length, 5);
      if (avg < 500) {
        basePollMs = 200;
        effectiveTimeout = Math.min(timeoutMs, 5000);
      }
    }

    const startTime = Date.now();
    let attempts = 0;
    while (Date.now() - startTime < effectiveTimeout) {
      const found = findElement(selectors, description, semanticContext);
      if (found) {
        const elapsed = Date.now() - startTime;
        console.log(`[Enhancivity Replay] Found element after ${attempts} attempts (${elapsed}ms) using "${found.usedStrategy}"`);
        elementFindTimings.push(elapsed);
        return found;
      }

      const a11yFound = semanticContext?.a11y ? findElementByA11y(semanticContext.a11y) : null;
      if (a11yFound) {
        const elapsed = Date.now() - startTime;
        console.log(`[Enhancivity Replay] Found element after ${attempts} attempts (${elapsed}ms) using "${a11yFound.usedStrategy}"`);
        elementFindTimings.push(elapsed);
        return a11yFound;
      }

      attempts++;
      // Poll faster initially, slower after 5s (element likely waiting for page load)
      const elapsed = Date.now() - startTime;
      await delay(elapsed < 5000 ? basePollMs : Math.max(basePollMs, 800));
    }
    // Log what we tried for debugging
    console.warn(`[Enhancivity Replay] Element NOT found after ${attempts} attempts (${timeoutMs}ms timeout). Selectors tried:`,
      selectors.map(s => `${s.strategy}="${typeof s.value === 'string' ? s.value.slice(0, 60) : s.value}"`).join(', ')
    );
    if (description) {
      console.warn('[Enhancivity Replay] Step description:', description);
    }

    const a11yFound = semanticContext?.a11y ? findElementByA11y(semanticContext.a11y) : null;
    if (a11yFound) {
      console.log('[Enhancivity Replay] Found element via accessibility fallback after deterministic failure.');
      return a11yFound;
    }

    const semanticFound = await resolveViaSemanticFallback(description, semanticContext);
    if (semanticFound) {
      console.log('[Enhancivity Replay] Found element via semantic fallback after deterministic failure.');
      return semanticFound;
    }

    return null;
  }

  // ── Action Executors ──────────────────────────────────────────

  async function warmNextStepTarget(action) {
    if (!Array.isArray(action.nextStepSelectors) || action.nextStepSelectors.length === 0) return;
    if (action.nextStepActionType === 'navigate') return;

    try {
      const nextFound = await waitForElement(
        action.nextStepSelectors,
        5000,
        action.nextStepDescription,
        action.nextStepSemanticContext
      );
      if (nextFound) {
        console.log('[Enhancivity Replay] Next UI state became available after click:', action.nextStepDescription || action.nextStepActionType);
      }
    } catch (_) {
      // Best-effort only
    }
  }

  // ── Consequential Action Detection ──────────────────────────
  // Uses the shared consequential_actions.js system (injected via manifest.json).
  // 5-Layer architecture: Always-Block → Always-Safe → Structural Finality → LLM → Recording
  // See docs/CONSEQUENTIAL_ACTION_SYSTEM.md for full documentation.
  //
  // Core Principle: Block ONLY when data irreversibly leaves the user's local
  // environment to a third-party system. Intermediate "Submit" buttons in
  // multi-step wizards (e.g., Facebook Ads demographics) are SAFE to click.
  const _ca = globalThis.__enhancivityConsequentialActions || {};

  // Map shared category names to legacy names used by waitForHumanDecision
  function _mapCategory(sharedCategory) {
    const MAP = { purchasing: 'purchase', approval: 'payment', sending: 'send', destructive: 'delete', publishing: 'send' };
    return MAP[sharedCategory] || 'confirm';
  }

  function getTimeoutForCategory(category) {
    switch (category) {
      case 'purchase': return 0;     // No auto-timeout for purchases — wait indefinitely
      case 'payment':  return 0;     // No auto-timeout for payments
      case 'delete':   return 20000; // 20 seconds for destructive actions
      case 'send':     return 15000; // 15 seconds for send buttons
      default:         return 15000;
    }
  }

  function getCriticalMessage(category, actionName) {
    if (_ca.PAUSE_BEHAVIOR) {
      // Use the shared system's message generator
      const sharedCat = { purchase: 'purchasing', payment: 'approval', send: 'sending', delete: 'destructive' }[category] || 'unknown';
      const behavior = _ca.PAUSE_BEHAVIOR[sharedCat] || _ca.PAUSE_BEHAVIOR.unknown;
      if (behavior?.message) return behavior.message(actionName);
    }
    // Fallback
    switch (category) {
      case 'purchase': return `Ready to purchase — click "${actionName}" when you want to buy`;
      case 'payment':  return `Payment ready — click "${actionName}" to confirm`;
      case 'send':     return `Message ready — click "${actionName}" when you want to send`;
      case 'delete':   return `Ready to delete — click "${actionName}" to confirm`;
      default:         return `Action ready — click "${actionName}" to confirm`;
    }
  }

  function isConsequentialClick(action, element) {
    // ── Priority 1: Recipe step has pre-classified consequential status (from recording) ──
    if (action._consequentialClassification) {
      return action._consequentialClassification.requiresHumanConfirmation === true;
    }

    // ── Priority 2: Use shared layered detection system ──
    if (_ca.assessAction) {
      const result = _ca.assessAction(element, action);
      return result.isDangerous;
    }

    // ── Fallback: minimal hardcoded check (shared module not loaded) ──
    const hints = [
      action.description,
      action.semanticContext?.label,
      action.semanticContext?.ariaLabel,
      action.semanticContext?.text,
      (element?.textContent || '').trim().slice(0, 50),
      element?.getAttribute('aria-label') || '',
    ].filter(Boolean).join(' ');

    return /\b(send|purchase|buy\s*now|place\s*order|pay\s*now|checkout|delete\s*permanently|publish|go\s*live)\b/i.test(hints);
  }

  function classifyConsequentialCategory(hints) {
    if (_ca.classifyCategory) {
      return _mapCategory(_ca.classifyCategory(hints));
    }
    // Fallback
    if (/\b(buy|purchase|place\s*order|checkout)\b/i.test(hints)) return 'purchase';
    if (/\b(pay|authorize|transfer)\b/i.test(hints)) return 'payment';
    if (/\b(delete|remove|unsubscribe|cancel\s*subscription)\b/i.test(hints)) return 'delete';
    if (/\b(send|reply|forward|post|publish|tweet|share)\b/i.test(hints)) return 'send';
    return 'confirm';
  }

  // Wait for user to click the consequential element, skip, or timeout
  function waitForHumanDecision(element, category, timeoutMs) {
    return new Promise((resolve) => {
      let resolved = false;
      let timeoutId = null;
      let countdownInterval = null;

      const actionName = (element.textContent || '').trim().slice(0, 30) || 'Action';
      const message = getCriticalMessage(category, actionName);

      // ── Create overlay banner ──
      const overlay = document.createElement('div');
      overlay.id = 'enhancivity-critical-overlay';
      overlay.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
        background: rgba(18, 18, 24, 0.95); backdrop-filter: blur(12px);
        border-bottom: 2px solid #f59e0b;
        padding: 12px 20px; display: flex; align-items: center; justify-content: center; gap: 16px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        font-size: 14px; color: #fff;
      `;

      const msgSpan = document.createElement('span');
      msgSpan.textContent = message;
      overlay.appendChild(msgSpan);

      // Countdown display (only if timeout > 0)
      const countdownSpan = document.createElement('span');
      countdownSpan.style.cssText = 'color: #f59e0b; font-weight: 600; min-width: 30px;';
      if (timeoutMs > 0) {
        let remaining = Math.ceil(timeoutMs / 1000);
        countdownSpan.textContent = `${remaining}s`;
        overlay.appendChild(countdownSpan);
        countdownInterval = setInterval(() => {
          remaining--;
          countdownSpan.textContent = remaining > 0 ? `${remaining}s` : '';
        }, 1000);
      }

      // Skip button
      const skipBtn = document.createElement('button');
      skipBtn.textContent = 'Skip';
      skipBtn.style.cssText = `
        padding: 6px 16px; background: rgba(255,255,255,0.15);
        border: 1px solid rgba(255,255,255,0.3); border-radius: 6px;
        color: #fff; cursor: pointer; font-size: 13px; font-weight: 500;
      `;
      skipBtn.addEventListener('mouseenter', () => { skipBtn.style.background = 'rgba(255,255,255,0.25)'; });
      skipBtn.addEventListener('mouseleave', () => { skipBtn.style.background = 'rgba(255,255,255,0.15)'; });
      overlay.appendChild(skipBtn);

      document.body.appendChild(overlay);

      // ── Pulsing highlight on the target element ──
      element.style.outline = '3px solid #f59e0b';
      element.style.boxShadow = '0 0 12px rgba(245, 158, 11, 0.5)';
      element.style.animation = 'enh-consent-pulse 1.5s ease-in-out infinite';
      const pulseStyle = document.createElement('style');
      pulseStyle.id = 'enh-consent-pulse-style';
      pulseStyle.textContent = `@keyframes enh-consent-pulse { 0%,100% { outline-color: #f59e0b; } 50% { outline-color: #ef4444; } }`;
      document.head.appendChild(pulseStyle);

      function cleanup() {
        if (resolved) return;
        resolved = true;
        if (timeoutId) clearTimeout(timeoutId);
        if (countdownInterval) clearInterval(countdownInterval);
        overlay.remove();
        pulseStyle.remove();
        element.style.outline = '';
        element.style.boxShadow = '';
        element.style.animation = '';
      }

      // ── User clicks the consequential element ──
      element.addEventListener('click', function handler() {
        element.removeEventListener('click', handler);
        cleanup();
        resolve({ action: 'clicked' });
      }, { once: true });

      // ── User clicks Skip ──
      skipBtn.addEventListener('click', () => {
        cleanup();
        resolve({ action: 'skipped' });
      });

      // ── Timeout (only if > 0; purchases/payments wait indefinitely) ──
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          cleanup();
          resolve({ action: 'timeout' });
        }, timeoutMs);
      }
    });
  }

  async function executeClick(action) {
    const found = await waitForElement(action.selectors, 12000, action.description, action.semanticContext);
    if (!found) return { success: false, error: `Element not found for click: "${action.description || 'unknown'}"` };

    const el = found.element;

    // ONE-INCH RULE: Pause before consequential actions (Send, Buy, Delete, Submit)
    // The agent does 99% of the work, the user clicks the final action button.
    if (isConsequentialClick(action, el)) {
      const hints = [action.description, action.semanticContext?.label, (el.textContent || '').trim().slice(0, 50)].filter(Boolean).join(' ');
      const category = classifyConsequentialCategory(hints);
      const timeoutMs = getTimeoutForCategory(category);
      const actionName = action.description || action.semanticContext?.label || 'Action';

      console.log(`[Enhancivity Replay] CONSEQUENTIAL ACTION: "${actionName}" (${category}, timeout: ${timeoutMs || 'none'}). Waiting for user...`);

      // Scroll the element into view
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Notify the side panel / floating panel
      try {
        chrome.runtime.sendMessage({
          type: 'replay_consent_required',
          data: { action: actionName, category, reason: getCriticalMessage(category, actionName) },
        });
      } catch {}

      // Wait for user to click, skip, or timeout
      const decision = await waitForHumanDecision(el, category, timeoutMs);

      if (decision.action === 'clicked') {
        console.log(`[Enhancivity Replay] User clicked "${actionName}" — action confirmed.`);
        return { success: true, humanConfirmed: true, note: `User clicked "${actionName}".` };
      } else {
        const reason = decision.action === 'skipped' ? 'User skipped' : 'Timed out';
        console.log(`[Enhancivity Replay] ${reason} for "${actionName}".`);
        return {
          success: true,
          skippedConsequential: true,
          note: `${reason} — "${actionName}" not clicked.`,
        };
      }
    }

    const clickHint = `${action.description || ''} ${action.semanticContext?.label || ''}`.toLowerCase();
    const isGmailComposeClick = window.location.hostname.includes('mail.google.com') &&
      (found.usedStrategy === 'gmail-compose' || clickHint.includes('compose'));

    // Scroll into view
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await delay(200);

    // Visual highlight
    const prevOutline = el.style.outline;
    el.style.outline = '2px solid #6366f1';
    setTimeout(() => { el.style.outline = prevOutline; }, 800);

    // Wait for disabled buttons to become enabled (e.g., ChatGPT send button
    // enables after text appears in the input with a brief delay)
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      const maxWait = 2000;
      const pollInterval = 200;
      const startTime = Date.now();
      while ((el.disabled || el.getAttribute('aria-disabled') === 'true') && Date.now() - startTime < maxWait) {
        await delay(pollInterval);
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
        console.warn(`[Enhancivity Replay] Button still disabled after ${maxWait}ms, attempting click anyway: "${action.description || 'unknown'}"`);
      }
    }

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
    await delay(100);
    const postClickUrl = window.location.href;
    const postClickBodyLen = document.body?.innerHTML?.length || 0;
    const urlChanged = postClickUrl !== preClickUrl;
    const majorDomChange = Math.abs(postClickBodyLen - preClickBodyLen) > 2000;

    if (urlChanged || majorDomChange) {
      console.log(`[Enhancivity Replay] Click triggered page transition (url: ${urlChanged}, domDelta: ${Math.abs(postClickBodyLen - preClickBodyLen)}). Waiting for page to stabilize...`);
      await waitForPageStable();
    }

    await warmNextStepTarget(action);

    if (isGmailComposeClick) {
      const composeReady = await waitForElement([
        { strategy: 'css', value: '.Am.Al.editable[role="textbox"]', priority: 1 },
        { strategy: 'aria-label', value: 'Message Body', priority: 2 },
        { strategy: 'css', value: 'input[name="subjectbox"]', priority: 3 },
      ], 12000, 'Type into "Message Body"', { label: 'Message Body' });

      if (!composeReady) {
        return { success: false, error: 'Compose window did not finish opening after click.' };
      }
    }

    return { success: true, usedStrategy: found.usedStrategy };
  }

  // Wait for the page DOM to stop changing (signals that SPA navigation or
  // dynamic content loading has finished). Max wait: 15 seconds.
  async function waitForPageStable(maxWaitMs = 15000, settleMs = 500) {
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
    const found = await waitForElement(action.selectors, 12000, action.description, action.semanticContext);
    if (!found) return { success: false, error: `Element not found for type: "${action.description || 'unknown'}"` };

    const el = found.element;
    let value = action.inputType === 'variable'
      ? (variables[action.variableName] || '')
      : (action.fixedValue || '');

    // If a required variable has no value, fail the recipe so the AI takes over.
    // Never fall back to the recorded example — it was just a demonstration, not the actual value.
    if (!value && action.inputType === 'variable') {
      return { success: false, error: `Variable "${action.variableName}" has no value — recipe cannot execute` };
    }

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
    // Use the element's ownerDocument (handles iframe elements correctly)
    let typed = false;
    try {
      const execDoc = el.ownerDocument || document;
      execDoc.execCommand('insertText', false, value);
      // Check if it actually worked
      const currentVal = el.value || el.textContent || '';
      if (currentVal.includes(value)) typed = true;
    } catch {}

    // Tier 2: Direct assignment + input event (React-compatible)
    if (!typed) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        // Use native setter to trigger React's synthetic event system
        const inputCtor = el.ownerDocument?.defaultView?.HTMLInputElement || window.HTMLInputElement;
        const textAreaCtor = el.ownerDocument?.defaultView?.HTMLTextAreaElement || window.HTMLTextAreaElement;
        const nativeSetter = Object.getOwnPropertyDescriptor(
          inputCtor?.prototype || {}, 'value'
        )?.set || Object.getOwnPropertyDescriptor(
          textAreaCtor?.prototype || {}, 'value'
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
        const found = findElement(action.selectors, action.description, action.semanticContext);
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
    const found = await waitForElement(action.selectors, 12000, action.description, action.semanticContext);
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
    if (variables?.__task_context) extraContext.taskContext = variables.__task_context;
    if (variables?.__workflow_name) extraContext.workflowName = variables.__workflow_name;
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
      const execDoc = el.ownerDocument || document;
      execDoc.execCommand('insertText', false, generatedText);
      const currentVal = el.value || el.textContent || '';
      if (currentVal.includes(generatedText.slice(0, 20))) typed = true;
    } catch {}

    // Tier 2: Direct assignment + input event
    if (!typed) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        const inputCtor = el.ownerDocument?.defaultView?.HTMLInputElement || window.HTMLInputElement;
        const textAreaCtor = el.ownerDocument?.defaultView?.HTMLTextAreaElement || window.HTMLTextAreaElement;
        const nativeSetter = Object.getOwnPropertyDescriptor(
          inputCtor?.prototype || {}, 'value'
        )?.set || Object.getOwnPropertyDescriptor(
          textAreaCtor?.prototype || {}, 'value'
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

  async function executeNavigate(action, vars = {}) {
    const SEARCH_PARAMS = ['k', 'q', 's', 'search', 'query', 'keywords'];
    let targetUrl = action.url;
    if (vars.__search_query) {
      try {
        const u = new URL(targetUrl);
        for (const p of SEARCH_PARAMS) {
          if (u.searchParams.has(p)) {
            u.searchParams.set(p, vars.__search_query);
            targetUrl = u.toString();
            break;
          }
        }
      } catch { /* malformed URL — skip */ }
    }
    window.location.href = targetUrl;
    // Navigation will reload the page — the background.js handles continuation
    return { success: true, navigated: true };
  }

  // ── Main Replay Function ──────────────────────────────────────

  function withReplayContext(action, prevStep, nextStep, workflowName) {
    return {
      ...action,
      semanticContext: {
        ...(action.semanticContext || {}),
        previousStep: prevStep?.action?.description || undefined,
        nextStep: nextStep?.action?.description || undefined,
        workflowName: workflowName || undefined,
      },
      nextStepDescription: nextStep?.action?.description || undefined,
      nextStepSelectors: Array.isArray(nextStep?.action?.selectors) ? nextStep.action.selectors : undefined,
      nextStepActionType: nextStep?.action?.type || undefined,
      nextStepSemanticContext: nextStep?.action?.semanticContext
        ? {
            ...nextStep.action.semanticContext,
            workflowName: workflowName || undefined,
          }
        : undefined,
    };
  }

  // ── Safety: detect if we've accidentally navigated to a login/auth page ──
  function isOnAuthPage() {
    const url = window.location.href.toLowerCase();
    const path = window.location.pathname.toLowerCase();
    const AUTH_PATTERNS = [
      /\/signin\b/, /\/sign-in\b/, /\/login\b/, /\/log-in\b/,
      /\/register\b/, /\/signup\b/, /\/sign-up\b/, /\/createaccount\b/,
      /\/ap\/signin/, /\/ap\/register/, // Amazon-specific
      /\/auth\//, /\/oauth\//, /\/sso\//,
      /\/accounts\/login/, /\/accounts\/signup/,
    ];
    if (AUTH_PATTERNS.some(p => p.test(url) || p.test(path))) return true;

    // Also check page content for sign-in forms
    const hasPasswordField = document.querySelector('input[type="password"]');
    const title = (document.title || '').toLowerCase();
    if (hasPasswordField && (/sign in|log in|create account|register/i.test(title))) return true;

    return false;
  }

  // ── Safety: detect if current domain matches the recipe's expected domain ──
  function isDomainMismatch(recipe) {
    if (!recipe?.siteDomain) return false;
    const currentHost = window.location.hostname.toLowerCase().replace(/^www\./, '');
    const expectedDomain = recipe.siteDomain.toLowerCase().replace(/^www\./, '');

    // Exact match
    if (currentHost === expectedDomain) return false;

    // Domain family match (amazon.de vs amazon.com)
    const currentRoot = currentHost.split('.').slice(-2).join('.');
    const expectedRoot = expectedDomain.split('.').slice(-2).join('.');
    const currentBase = currentHost.split('.')[0];
    const expectedBase = expectedDomain.split('.')[0];

    // Same base domain (amazon.de ↔ amazon.com, mail.google.com ↔ gmail.com)
    if (currentBase === expectedBase) return false;
    if (currentRoot === expectedRoot) return false;

    // Special cases: mail.google.com ↔ gmail
    if ((currentHost.includes('google.com') && expectedDomain.includes('google.com')) ||
        (currentHost.includes('google.com') && expectedDomain.includes('gmail'))) return false;

    return true;
  }

  async function replayRecipe(recipe, variables) {
    const results = [];
    const startTime = Date.now();
    // Reset adaptive polling timings for this replay session
    elementFindTimings = [];

    console.log('[Enhancivity Replay] Starting recipe:', recipe.workflowName, '— steps:', recipe.steps.length);

    for (let i = 0; i < recipe.steps.length; i++) {
      // Safety check: stop if we've navigated to a login/auth page
      if (i > 0 && isOnAuthPage()) {
        console.warn('[Enhancivity Replay] STOPPED: navigated to auth/login page. Recipe replay aborted to prevent unintended actions.');
        return {
          success: false,
          failedAtStep: i + 1,
          failReason: 'Navigated to login/authentication page — replay stopped for safety.',
          results,
          durationMs: Date.now() - startTime,
        };
      }

      // Safety check: stop if we've drifted to a completely different domain
      if (i > 0 && isDomainMismatch(recipe)) {
        const currentHost = window.location.hostname;
        console.warn(`[Enhancivity Replay] STOPPED: domain mismatch. Expected "${recipe.siteDomain}", on "${currentHost}". Recipe replay aborted.`);
        return {
          success: false,
          failedAtStep: i + 1,
          failReason: `Domain mismatch: expected "${recipe.siteDomain}" but on "${currentHost}".`,
          results,
          durationMs: Date.now() - startTime,
        };
      }

      const step = recipe.steps[i];
      const action = withReplayContext(
        step.action,
        i > 0 ? recipe.steps[i - 1] : null,
        i + 1 < recipe.steps.length ? recipe.steps[i + 1] : null,
        recipe.workflowName
      );

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

      // Per-step timeout: dynamic by action type.
      // Prevents any single step from hanging the entire replay.
      const stepTimeoutMs =
        action.type === 'llm_fill' ? 120000 :
        action.type === 'click' ? 20000 :
        action.type === 'type' ? 20000 :
        action.type === 'wait' ? Math.max(15000, action.timeout || 0) :
        15000;

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
              return await executeNavigate(action, variables || {});
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

        // Reset adaptive timings after navigation — new page may load slowly
        if (action.type === 'navigate' || action.type === 'click') {
          const postUrl = window.location.href;
          if (i > 0 && postUrl !== (recipe.steps[i - 1]?.url || '')) {
            elementFindTimings.length = 0; // Clear history — fresh page
          }
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

      // ONE-INCH RULE: If this step was a consequential action that was skipped,
      // stop the replay immediately. The user must click the highlighted button manually.
      if (result.skippedConsequential) {
        console.log(`[Enhancivity Replay] Stopping at consequential action (step ${i + 1}). User must confirm.`);
        return {
          success: true,
          partial: false,
          skippedConsequential: true,
          consequentialStep: action.description || 'Final action',
          completedSteps: i + 1,
          totalSteps: recipe.steps.length,
          results,
          durationMs: Date.now() - startTime,
        };
      }

      // Brief delay between steps (50-150ms) — enough to avoid synchronous event conflicts
      if (i < recipe.steps.length - 1) {
        await delay(50 + Math.random() * 100);
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
      // Safety check: stop if we've navigated to a login/auth page
      if (i > 0 && isOnAuthPage()) {
        console.warn('[Enhancivity Replay] STOPPED: navigated to auth/login page during segment replay.');
        return {
          success: false,
          failedAtStep: steps[i]?.stepNumber || i + 1,
          failReason: 'Navigated to login/authentication page — replay stopped for safety.',
          results,
          durationMs: Date.now() - startTime,
        };
      }

      const step = steps[i];
      const action = withReplayContext(
        step.action,
        i > 0 ? steps[i - 1] : null,
        i + 1 < steps.length ? steps[i + 1] : null,
        null
      );

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

      // Per-step timeout: dynamic by action type.
      const stepTimeoutMs =
        action.type === 'llm_fill' ? 120000 :
        action.type === 'click' ? 20000 :
        action.type === 'type' ? 20000 :
        action.type === 'wait' ? Math.max(15000, action.timeout || 0) :
        15000;

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
              return await executeNavigate(action, variables || {});
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

      // ONE-INCH RULE: Stop at consequential actions — user must confirm manually
      if (result.skippedConsequential) {
        console.log(`[Enhancivity Replay] Stopping at consequential action (step ${step.stepNumber}). User must confirm.`);
        return {
          success: true,
          partial: false,
          skippedConsequential: true,
          consequentialStep: action.description || 'Final action',
          completedSteps: i + 1,
          totalSteps: steps.length,
          results,
          durationMs: Date.now() - startTime,
        };
      }

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
    if (request.type === 'ping_replay') {
      sendResponse({ alive: true });
      return false;
    }

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

    // ── Probe: check if an element exists on the current page (no execution) ──
    if (request.type === 'replay_probe') {
      const { selectors, description, semanticContext } = request;
      if (!selectors?.length) {
        sendResponse({ found: false });
        return false;
      }
      const result = findElement(selectors, description, semanticContext)
        || (semanticContext?.a11y ? findElementByA11y(semanticContext.a11y) : null);
      sendResponse({ found: !!result });
      return false; // Synchronous response
    }
  });

})();
