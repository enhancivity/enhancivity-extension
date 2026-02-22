// ============================================================
// Enhancivity Universal Page Scraper
//
// Injected on-demand via chrome.scripting.executeScript()
// Extracts clean, relevant text from ANY webpage.
//
// Returns a structured object with:
//   - pageTitle, pageUrl, siteType
//   - selectedText (if user highlighted something)
//   - mainContent (cleaned page text, max ~4000 chars)
//   - meta (description, headings)
// ============================================================

(() => {
  'use strict';

  const MAX_CONTENT = 4000;
  const MAX_SELECTED = 2000;

  // ── Site Type Detection ──────────────────────────────────

  function detectSiteType() {
    const url = location.href;
    if (url.includes('slack.com')) return 'slack';
    if (url.includes('linkedin.com')) return 'linkedin';
    if (url.includes('docs.google.com')) return 'google-docs';
    if (url.includes('sheets.google.com')) return 'google-sheets';
    if (url.includes('outlook.live.com') || url.includes('outlook.office.com')) return 'outlook';
    if (/indeed|glassdoor|monster|ziprecruiter/i.test(url)) return 'job-board';
    if (/trello|asana|notion|jira/i.test(url)) return 'project-tool';
    if (/twitter|x\.com|facebook|instagram/i.test(url)) return 'social';
    if (/github\.com/i.test(url)) return 'github';
    if (/stackoverflow|stackexchange/i.test(url)) return 'stackoverflow';
    if (/youtube\.com/i.test(url)) return 'youtube';
    return 'webpage';
  }

  // ── Elements to Skip ─────────────────────────────────────

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IFRAME', 'CANVAS',
    'VIDEO', 'AUDIO', 'IMG', 'PICTURE', 'SOURCE', 'TEMPLATE',
  ]);

  const SKIP_ROLES = new Set([
    'navigation', 'banner', 'contentinfo', 'complementary',
    'search', 'form', 'alert', 'alertdialog', 'dialog',
  ]);

  const SKIP_CLASS_PATTERNS = /nav|footer|sidebar|cookie|banner|popup|modal|overlay|advert|promo|newsletter|subscribe/i;

  function shouldSkipElement(el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute('role');
    if (role && SKIP_ROLES.has(role)) return true;
    const tag = el.tagName;
    if (tag === 'NAV' || tag === 'FOOTER' || tag === 'HEADER') return true;
    const cls = el.className;
    if (typeof cls === 'string' && SKIP_CLASS_PATTERNS.test(cls)) return true;
    const id = el.id;
    if (id && SKIP_CLASS_PATTERNS.test(id)) return true;
    // Skip hidden elements
    if (el.offsetParent === null && el.tagName !== 'BODY') return true;
    return false;
  }

  // ── Text Extraction ──────────────────────────────────────

  function extractText(root) {
    const chunks = [];

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim();
        if (text.length > 1) chunks.push(text);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (shouldSkipElement(node)) return;

      for (const child of node.childNodes) {
        walk(child);
      }
    }

    walk(root);
    return chunks.join('\n');
  }

  // ── Main Content Finder ──────────────────────────────────

  function findMainContent() {
    // Strategy 1: Semantic elements
    const semantic = document.querySelector('main, [role="main"], article');
    if (semantic) {
      const text = extractText(semantic);
      if (text.length > 100) return text;
    }

    // Strategy 2: Find the largest text-dense container
    const candidates = document.querySelectorAll('div, section');
    let bestNode = null;
    let bestScore = 0;

    for (const el of candidates) {
      if (shouldSkipElement(el)) continue;
      const paragraphs = el.querySelectorAll('p, li, td, dd, span');
      const textLen = el.innerText?.length || 0;
      // Score = text length, penalize if too many links (probably nav)
      const links = el.querySelectorAll('a').length;
      const score = textLen - (links * 50);
      if (score > bestScore && textLen > 200) {
        bestScore = score;
        bestNode = el;
      }
    }

    if (bestNode) {
      const text = extractText(bestNode);
      if (text.length > 100) return text;
    }

    // Strategy 3: Fallback — full body text
    return extractText(document.body);
  }

  // ── Smart Truncation ─────────────────────────────────────

  function truncate(text, maxLen, siteType) {
    if (!text || text.length <= maxLen) return text;

    // Chat apps: keep the END (most recent messages)
    if (siteType === 'slack' || siteType === 'social') {
      return text.slice(-maxLen);
    }

    // Default: keep beginning + end (context + conclusion)
    const half = Math.floor(maxLen / 2);
    return text.slice(0, half) + '\n\n[...content truncated...]\n\n' + text.slice(-half);
  }

  // ── Clean Text ───────────────────────────────────────────

  function cleanText(text) {
    return text
      .replace(/\t/g, ' ')
      .replace(/ {3,}/g, '  ')              // Collapse excessive spaces
      .replace(/\n{4,}/g, '\n\n\n')         // Max 3 newlines
      .replace(/^\s+$/gm, '')               // Remove whitespace-only lines
      .trim();
  }

  // ── Extract Metadata ─────────────────────────────────────

  function extractMeta() {
    // Meta description
    const descEl = document.querySelector('meta[name="description"], meta[property="og:description"]');
    const description = descEl?.content || '';

    // First 5 headings
    const headingEls = document.querySelectorAll('h1, h2');
    const headings = [];
    for (let i = 0; i < Math.min(headingEls.length, 5); i++) {
      const text = headingEls[i].innerText?.trim();
      if (text && text.length < 200) headings.push(text);
    }

    return { description: description.slice(0, 300), headings };
  }

  // ── Main Execution ───────────────────────────────────────

  const siteType = detectSiteType();
  const selectedText = window.getSelection()?.toString()?.trim() || '';
  const rawContent = findMainContent();
  const mainContent = truncate(cleanText(rawContent), MAX_CONTENT, siteType);
  const meta = extractMeta();

  return {
    pageTitle: document.title || '',
    pageUrl: location.href,
    siteType,
    selectedText: selectedText.slice(0, MAX_SELECTED),
    mainContent: mainContent || '',
    meta,
  };
})();
