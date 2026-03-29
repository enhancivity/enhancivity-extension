// ============================================================
// Enhancivity — Universal Semantic Scraper (Ghost-Driver v1)
//
// Injected on-demand via chrome.scripting.executeScript()
// Replaces all site-specific scrapers with ONE AI-driven scraper.
//
// Phase 1: Traverses the visible DOM and builds a lightweight
//          "Semantic Map" — a compact JSON of interactable elements
//          (buttons, inputs, prices, links, labels).
//
// Phase 2: The Semantic Map is sent to /api/agent/parse-intent
//          by background.js (NOT by this script — content scripts
//          can't make authenticated API calls).
//
// Each mapped element is stamped with a data-enh-sid attribute
// so the Ghost-Driver can later resolve semanticIds back to
// real DOM elements for highlight / click / fill actions.
//
// Returns: SemanticMap object  { pageUrl, pageTitle, elements[] }
// ============================================================

(() => {
  'use strict';

  const MAX_ELEMENTS = 200;
  const MAX_TEXT     = 120;
  const MAX_CONTEXT  = 80;

  // ── Elements to Skip (reused from content_universal.js) ────

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IFRAME', 'CANVAS',
    'VIDEO', 'AUDIO', 'IMG', 'PICTURE', 'SOURCE', 'TEMPLATE',
    'BR', 'HR', 'META', 'LINK',
  ]);

  const SKIP_ROLES = new Set([
    'navigation', 'banner', 'contentinfo', 'complementary',
    'alert', 'alertdialog',
    // NOTE: 'form' and 'search' are NOT skipped — they contain the inputs we need to find.
    // 'dialog' is NOT skipped — modals often contain form fields (login, settings, etc).
  ]);

  const SKIP_CLASS_PATTERN = /cookie|banner|advert|promo|newsletter|subscribe|breadcrumb/i;

  function hasRelevantInteractiveDescendant(el) {
    try {
      return !!el.querySelector(
        'button, input, textarea, select, a[href], [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="textbox"], [contenteditable="true"]'
      );
    } catch {
      return false;
    }
  }

  function shouldSkip(el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute('role');
    if (role && SKIP_ROLES.has(role) && !hasRelevantInteractiveDescendant(el)) return true;
    const tag = el.tagName;
    if ((tag === 'NAV' || tag === 'FOOTER' || tag === 'HEADER') && !hasRelevantInteractiveDescendant(el)) return true;
    const cls = el.className;
    if (typeof cls === 'string' && SKIP_CLASS_PATTERN.test(cls) && !hasRelevantInteractiveDescendant(el)) return true;
    const id = el.id;
    if (id && SKIP_CLASS_PATTERN.test(id) && !hasRelevantInteractiveDescendant(el)) return true;
    // Hidden elements (except BODY/HTML, and except elements inside shadow DOM where
    // offsetParent is unreliable). Also exempt contenteditable and role=textbox — these
    // are often reported as offsetParent=null due to CSS position or shadow DOM host.
    if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML'
      && !el.isContentEditable && el.getAttribute('role') !== 'textbox'
      && !el.getRootNode()?.host) return true;
    return false;
  }

  // ── Price Detection ────────────────────────────────────────

  const PRICE_REGEX = /(?:[\$£€¥₹]|USD|EUR|GBP)\s*[\d,]+\.?\d{0,2}|[\d,]+\.?\d{0,2}\s*(?:USD|EUR|GBP|[\$£€¥₹])/i;

  function looksLikePrice(text) {
    return PRICE_REGEX.test(text);
  }

  // ── Element Classification ─────────────────────────────────

  function classifyElement(el) {
    const tag = el.tagName;

    // Buttons
    if (tag === 'BUTTON') return 'button';
    if (tag === 'INPUT' && (el.type === 'submit' || el.type === 'button')) return 'button';
    if (el.getAttribute('role') === 'button') return 'button';
    if (['link', 'tab', 'menuitem', 'option', 'switch', 'radio', 'treeitem'].includes(el.getAttribute('role'))) return 'button';

    // Inputs
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (el.type === 'hidden') return null;  // skip hidden inputs
      return 'input';
    }

    // ContentEditable elements (rich text editors: ProseMirror, Slate, Draft.js, Lexical)
    // Reddit, Notion, Medium, and many modern apps use contenteditable divs instead of textareas.
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
      // Only classify if this is the actual editor surface, not a parent container
      // that happens to be contenteditable. Check: has role=textbox, or is a known
      // editor class, or has no contenteditable children (is the leaf editor).
      const role = el.getAttribute('role');
      if (role === 'textbox') return 'input';
      const cls = typeof el.className === 'string' ? el.className : '';
      if (/ProseMirror|DraftEditor|ql-editor|ck-editor|lexical|slate/i.test(cls)) return 'input';
      // If no child is also contenteditable, this is the leaf editor surface
      const childEditable = el.querySelector('[contenteditable="true"]');
      if (!childEditable) return 'input';
    }

    // Links
    if (tag === 'A') {
      const href = el.getAttribute('href');
      if (!href || href === '#' || href.startsWith('javascript:')) return null;
      return 'link';
    }

    // Headings / titles
    if (/^H[1-6]$/.test(tag)) return 'text';

    // Check text content for prices
    const directText = getDirectText(el);
    if (directText && looksLikePrice(directText)) return 'price';

    // Elements with title/name/description class patterns
    if (typeof el.className === 'string') {
      if (/title|name|heading|label/i.test(el.className) && directText && directText.length > 3) {
        return 'text';
      }
    }

    return null;  // not interesting — skip
  }

  // ── Text Extraction ────────────────────────────────────────

  function getDirectText(el) {
    // Get text directly inside this element (not deep children)
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      }
    }
    text = text.trim();
    if (text.length > 1) return text;

    // Fallback: innerText (includes child text)
    const inner = (el.innerText || el.textContent || '').trim();
    return inner.length > 1 ? inner : '';
  }

  function truncate(str, max) {
    if (!str) return '';
    str = str.replace(/\s+/g, ' ').trim();
    return str.length > max ? str.slice(0, max) + '...' : str;
  }

  // ── Context Extraction ─────────────────────────────────────

  function getContext(el) {
    // Look at parent and siblings for nearby text
    const parent = el.parentElement;
    if (!parent) return '';

    const parts = [];

    // Parent text (if short enough to be a label/group).
    // Use direct text-node children only — NOT innerText fallback — to avoid
    // capturing all descendants' text when the parent is a large container like
    // <form>, <section>, or <div>. Without this guard, a flat form
    // (inputs directly inside <form>) causes every field's context to include
    // "First Name", "Email", etc. from the whole form, polluting label matching.
    let parentText = '';
    for (const node of parent.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) parentText += node.textContent;
    }
    parentText = parentText.replace(/\s+/g, ' ').trim();
    if (parentText && parentText.length > 2 && parentText.length < 200) {
      parts.push(parentText);
    }

    // Previous sibling text
    const prev = el.previousElementSibling;
    if (prev) {
      const prevText = (prev.innerText || '').trim();
      if (prevText && prevText.length > 2 && prevText.length < 200) {
        parts.push(prevText);
      }
    }

    // Next sibling text
    const next = el.nextElementSibling;
    if (next) {
      const nextText = (next.innerText || '').trim();
      if (nextText && nextText.length > 2 && nextText.length < 200) {
        parts.push(nextText);
      }
    }

    // For inputs: check for associated label
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      if (el.id) {
        const label = document.querySelector(`label[for="${el.id}"]`);
        if (label) parts.unshift(label.innerText?.trim());
      }
      // Check closest label parent
      const parentLabel = el.closest('label');
      if (parentLabel) {
        parts.unshift(parentLabel.innerText?.trim());
      }
    }

    return truncate(parts.filter(Boolean).join(' | '), MAX_CONTEXT);
  }

  // ── Relevant Attributes ────────────────────────────────────

  function getRelevantAttrs(el) {
    const attrs = {};
    const tag = el.tagName;

    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (el.name)        attrs.name = el.name;
      if (el.placeholder) attrs.placeholder = el.placeholder;
      if (el.type)        attrs.type = el.type;
      if (el.value && el.value.length < 100) attrs.value = el.value;
      // Character limit: maxlength attribute
      const maxLen = el.getAttribute('maxlength') || el.getAttribute('maxLength');
      if (maxLen && parseInt(maxLen, 10) > 0) attrs.maxlength = parseInt(maxLen, 10);
    }
    // ContentEditable / role=textbox: extract placeholder and character limits
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox') {
      const maxLen = el.getAttribute('maxlength') || el.getAttribute('maxLength');
      if (maxLen && parseInt(maxLen, 10) > 0) attrs.maxlength = parseInt(maxLen, 10);
      // Placeholder — contenteditable divs often use aria-placeholder or data-placeholder
      const placeholder = el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('placeholder');
      if (placeholder) attrs.placeholder = placeholder;
      // Name — for form association
      const name = el.getAttribute('name') || el.getAttribute('aria-label');
      if (name) attrs.name = name;
    }

    if (tag === 'A') {
      const href = el.getAttribute('href');
      if (href) attrs.href = href.slice(0, 200);
    }

    const testId = el.getAttribute('data-testid');
    if (testId) attrs['data-testid'] = testId;

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) attrs['aria-label'] = ariaLabel.slice(0, 80);

    return Object.keys(attrs).length > 0 ? attrs : undefined;
  }

  // ── Position / Visibility ──────────────────────────────────

  function getRect(el) {
    try {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left) };
    } catch {
      return { top: 0, left: 0 };
    }
  }

  function isAboveFold(rect) {
    return rect.top < window.innerHeight;
  }

  // ── Main Traversal ─────────────────────────────────────────

  function buildSemanticMap() {
    const elements = [];
    const counters = { button: 0, input: 0, link: 0, price: 0, text: 0 };
    const seenTexts = new Set();

    function walk(node, doc) {
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      if (node.tagName === 'IFRAME') {
        try {
          const iframeDoc = node.contentDocument || node.contentWindow?.document;
          if (iframeDoc?.body) {
            walk(iframeDoc.body, iframeDoc);
          }
        } catch {
          // Cross-origin iframe: intentionally skipped
        }
      }

      if (shouldSkip(node)) return;

      const type = classifyElement(node);

      if (type) {
        const text = truncate(getDirectText(node), MAX_TEXT);

        // Deduplicate by text content (avoid repeating identical nav links etc.)
        const dedupeKey = `${type}:${text.toLowerCase().slice(0, 40)}`;
        if (text && seenTexts.has(dedupeKey)) {
          // Still walk children in case there are interesting sub-elements
        } else {
          if (text) seenTexts.add(dedupeKey);

          const sid = `${type.slice(0, 4)}-${counters[type] || 0}`;
          counters[type] = (counters[type] || 0) + 1;

          const rect = getRect(node);

          elements.push({
            sid,
            tag: node.tagName.toLowerCase(),
            type,
            text,
            attrs: getRelevantAttrs(node),
            context: getContext(node),
            rect,
            visible: isAboveFold(rect),
            frameUrl: doc?.location?.href || location.href,
          });

          // Stamp the DOM element for later resolution by Ghost-Driver
          try {
            node.setAttribute('data-enh-sid', sid);
          } catch {
            // Some elements resist setAttribute (e.g., SVG in some browsers)
          }
        }
      }

      // Walk children
      for (const child of node.children) {
        walk(child, doc);
      }

      // Pierce shadow DOM — web components (Reddit's <shreddit-*>, Salesforce Lightning,
      // Atlassian, etc.) render their content inside shadow roots. Without this,
      // contenteditable editors and inputs inside shadow DOM are invisible to the scraper.
      if (node.shadowRoot) {
        for (const shadowChild of node.shadowRoot.children) {
          walk(shadowChild, doc);
        }
      }
    }

    walk(document.body, document);

    // Budget enforcement: if over MAX_ELEMENTS, drop below-fold elements first
    if (elements.length > MAX_ELEMENTS) {
      // Sort: above-fold first, then by DOM order (index)
      elements.sort((a, b) => {
        if (a.visible && !b.visible) return -1;
        if (!a.visible && b.visible) return 1;
        return 0;  // preserve DOM order within same visibility
      });
      elements.length = MAX_ELEMENTS;
    }

    return {
      pageUrl:   location.href,
      pageTitle: document.title || '',
      timestamp: Date.now(),
      viewport:  { width: window.innerWidth, height: window.innerHeight },
      elementCount: document.body.querySelectorAll('*').length,
      mappedCount:  elements.length,
      elements,
    };
  }

  // ── Execute ────────────────────────────────────────────────

  return buildSemanticMap();
})();
