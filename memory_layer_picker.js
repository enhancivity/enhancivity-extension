// Selection-first design capture: subject picker (devtools-inspector pattern).
// The user disambiguates subject-vs-container by pointing: hover-highlight snaps
// to the nearest VISUALLY BOUNDED ancestor (what a human reads as "the card /
// the hero / the artwork"), Alt walks up and Shift+Alt back down the ancestor
// chain (Alt+wheel does the same), click selects, drag selects a free rectangle,
// Esc cancels. Reads the page only; while picking the overlay intercepts every
// pointer event so clicks can never reach the page or any embedded frame — the
// picker never clicks, scrolls, or acts on the page itself. Operates on the
// visible viewport only and in the TOP frame only (same no-agent boundary as the
// text extractor).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EnhancivityMemoryLayerPickerCore = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const MIN_SELECTION_CSS_PX = 24;
  const DRAG_THRESHOLD_PX = 4;
  const PAGE_VIEWPORT_COVERAGE = 0.95;
  const FULL_BLEED_COVERAGE = 0.9;
  const BACKGROUND_IMAGE_MAX_TEXT = 12;
  const MAX_SUBTREE_ELEMENTS = 600;
  const MAX_DESCENDANT_SCAN = 200;
  const MAX_DOM_COLORS = 8;
  const MAX_DOM_FONTS = 2;
  const MAX_CAPTURE_SEGMENTS = 4;
  // Visual-anchor snap: how far above the deepest hit we look for the perceived
  // design unit, and the coverage at which a candidate stops being a "unit" and
  // starts being the page (the user can still reach page scope via Alt).
  const MAX_SNAP_CLIMB = 8;
  const SNAP_MAX_VIEWPORT_COVERAGE = 0.5;
  // Re-measure tolerance: if the subject moved less than this between click and
  // screenshot, the original rect is kept (sub-pixel layout jitter is noise).
  const REMEASURE_TOLERANCE_PX = 2;

  const PIXEL_TAGS = new Set(['img', 'picture', 'canvas', 'video']);
  const HEADLINE_TAGS = new Set(['h1', 'h2', 'h3', 'h4']);

  // Pure classification decision table (exported for tests). The caller measures;
  // this decides. Order matters: an explicit drag-rect is always a pixel crop, a
  // near-viewport selection is the whole page, then pixel content beats subtree.
  function classifySubject(info = {}) {
    if (info.mode === 'drag-rect') return 'pixel-subject';
    if ((info.viewportCoverage || 0) >= PAGE_VIEWPORT_COVERAGE) return 'page';
    if (info.isCrossOriginFrame || info.isPixelTag || info.isInlineSvg) return 'pixel-subject';
    if (info.hasBackgroundImage && (info.textChars || 0) < BACKGROUND_IMAGE_MAX_TEXT) return 'pixel-subject';
    if ((info.pixelDescendantCoverage || 0) >= FULL_BLEED_COVERAGE) return 'pixel-subject';
    return 'dom-subtree';
  }

  // Pure: does this ancestor-chain entry render a visible boundary of its own?
  // These are the signals a human uses to read "one design unit": pixel content,
  // a painted background, a border, or a shadow. Radius alone paints nothing.
  function isVisualBoundary(info = {}) {
    return Boolean(
      info.isPixelTag
      || info.isInlineSvg
      || info.hasBackgroundImage
      || info.hasBackgroundColor
      || info.hasBorder
      || info.hasShadow
    );
  }

  // Pure: choose the index in an ancestor-chain info array (index 0 = deepest
  // hit, ascending) that best matches the design unit the user perceives. Stops
  // at the first visually bounded entry within MAX_SNAP_CLIMB; a candidate
  // covering most of the viewport is "page", never a snap target (climbing stops
  // there). Nothing bounded -> the deepest hit, exactly the pre-snap behavior.
  function chooseVisualAnchorIndex(infos = []) {
    for (let i = 0; i < infos.length && i <= MAX_SNAP_CLIMB; i += 1) {
      const info = infos[i] || {};
      if ((info.viewportCoverage || 0) >= SNAP_MAX_VIEWPORT_COVERAGE) break;
      if (isVisualBoundary(info)) return i;
    }
    return 0;
  }

  function normalizeRect(rect) {
    const left = Math.min(rect.left, rect.right);
    const top = Math.min(rect.top, rect.bottom);
    return {
      x: left,
      y: top,
      w: Math.abs(rect.right - rect.left),
      h: Math.abs(rect.bottom - rect.top),
    };
  }

  function clampRectToViewport(rect, viewportWidth, viewportHeight) {
    const x = Math.max(0, rect.x);
    const y = Math.max(0, rect.y);
    const right = Math.min(viewportWidth, rect.x + rect.w);
    const bottom = Math.min(viewportHeight, rect.y + rect.h);
    return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
  }

  function intersectionArea(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
  }

  // Pure: did the subject move/resize beyond layout jitter between click and
  // screenshot? Drives the capture-instant re-measure.
  function rectsDifferBeyond(a, b, tolerance = REMEASURE_TOLERANCE_PX) {
    return Math.abs(a.x - b.x) > tolerance
      || Math.abs(a.y - b.y) > tolerance
      || Math.abs(a.w - b.w) > tolerance
      || Math.abs(a.h - b.h) > tolerance;
  }

  function computeSegmentLayout({ docRectCss, viewportH, maxSegments = MAX_CAPTURE_SEGMENTS, overlapPx = 0 } = {}) {
    const rect = docRectCss || {};
    const height = Number(rect.h);
    const y = Number(rect.y);
    const viewportHeight = Number(viewportH);
    const cap = Math.max(1, Math.floor(Number(maxSegments) || MAX_CAPTURE_SEGMENTS));
    const overlap = Math.max(0, Number(overlapPx) || 0);
    if (!(height > 0) || !(viewportHeight > 0) || !Number.isFinite(y)) return [];
    const step = Math.max(1, viewportHeight - overlap);
    const count = Math.max(1, Math.min(cap, Math.ceil(Math.max(1, height - overlap) / step)));
    return Array.from({ length: count }, (_, index) => {
      const offset = index * step;
      const scrollY = Math.max(0, y + offset);
      return {
        scrollY,
        expectedRectCssY: y - scrollY,
        segmentH: Math.min(viewportHeight, Math.max(0, height - offset)),
      };
    });
  }

  function channelHex(value) {
    return Math.max(0, Math.min(255, Math.round(Number(value)))).toString(16).padStart(2, '0');
  }

  // Pure (probe injectable): computed CSS color -> '#rrggbb' or null. The legacy
  // rgb()/rgba() comma form is parsed exactly; every other format Chrome can
  // compute (oklch, lab, color(display-p3 …), color-mix results) goes through the
  // caller-supplied probe, which rasterizes the color and reports sRGB bytes —
  // without it those colors were silently dropped on exactly the modern,
  // design-forward sites users capture. Colors under 50% alpha are not "the
  // design's color" and stay excluded on both paths.
  function cssColorToHex(value, probe) {
    const raw = String(value || '').trim();
    if (!raw || raw === 'transparent' || raw === 'none') return null;
    const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)$/.exec(raw);
    if (match) {
      const alpha = match[4] === undefined ? 1 : Number(match[4]);
      if (!(alpha >= 0.5)) return null;
      return `#${channelHex(match[1])}${channelHex(match[2])}${channelHex(match[3])}`;
    }
    if (typeof probe !== 'function') return null;
    const probed = probe(raw);
    if (!probed || !(probed.a >= 128)) return null;
    return `#${channelHex(probed.r)}${channelHex(probed.g)}${channelHex(probed.b)}`;
  }

  // Pure: pull the color tokens out of a computed gradient (or any CSS image)
  // string, in order. Gradient stops are core brand identity and invisible to
  // backgroundColor; each extracted token still goes through cssColorToHex.
  function extractCssColorTokens(value) {
    const raw = String(value || '');
    const pattern = /rgba?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|lab\([^)]*\)|lch\([^)]*\)|hsla?\([^)]*\)|color\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g;
    return raw.match(pattern) || [];
  }

  const core = {
    classifySubject,
    isVisualBoundary,
    chooseVisualAnchorIndex,
    normalizeRect,
    clampRectToViewport,
    intersectionArea,
    rectsDifferBeyond,
    computeSegmentLayout,
    cssColorToHex,
    extractCssColorTokens,
    MIN_SELECTION_CSS_PX,
    FULL_BLEED_COVERAGE,
    PAGE_VIEWPORT_COVERAGE,
    MAX_SNAP_CLIMB,
    SNAP_MAX_VIEWPORT_COVERAGE,
    REMEASURE_TOLERANCE_PX,
    MAX_CAPTURE_SEGMENTS,
  };

  // ---------------------------------------------------------------------------
  // Everything below is DOM/runtime wiring; absent in test (Node) contexts.
  // ---------------------------------------------------------------------------
  const inBrowser = typeof window !== 'undefined'
    && typeof document !== 'undefined'
    && typeof chrome !== 'undefined'
    && chrome.runtime?.onMessage;
  if (!inBrowser) return core;

  let isTopFrame = true;
  try {
    isTopFrame = window.top === window;
  } catch (_err) {
    isTopFrame = false;
  }

  const state = {
    active: false,
    overlay: null,
    highlightBox: null,
    chip: null,
    rectBox: null,
    deepest: null, // deepest hovered element (raw hit)
    chain: [], // [deepest, ...ancestors], bounded
    snapIndex: 0, // chosen visual anchor within chain
    depthOffset: 0, // user adjustment via Alt / Shift+Alt / Alt+wheel
    chipMetaElement: null, // memo key for the expensive chip measurement
    chipMetaFullBleed: null,
    dragStart: null,
    dragging: false,
    dragRect: null,
    listeners: [],
  };
  let lastPickedSubjectElement = null;
  let lastPickedDocRectCss = null;

  function tagOf(element) {
    return (element?.tagName || '').toLowerCase();
  }

  function viewOf(element) {
    return element?.ownerDocument?.defaultView || window;
  }

  // Element rect in TOP-window viewport CSS px, accumulating same-origin frame
  // offsets (mirrors the extractor's frame-offset approach, with x as well).
  function topRectOf(element) {
    let rect = element.getBoundingClientRect();
    let result = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    let win = viewOf(element);
    let guard = 0;
    while (win && win !== window && guard < 10) {
      guard += 1;
      let frameElement = null;
      try {
        frameElement = win.frameElement;
      } catch (_err) {
        frameElement = null; // cross-origin parent: cannot translate further
      }
      if (!frameElement) break;
      const frameRect = frameElement.getBoundingClientRect();
      result = {
        x: result.x + frameRect.left + frameElement.clientLeft,
        y: result.y + frameRect.top + frameElement.clientTop,
        w: result.w,
        h: result.h,
      };
      win = frameElement.ownerDocument?.defaultView || null;
    }
    return result;
  }

  // First real page element at a TOP-document point. The overlay intercepts
  // pointer events (pointer-events:auto), so plain elementFromPoint would only
  // ever see the overlay — read the full hit-test stack and skip our own nodes.
  function topDocElementAt(x, y) {
    const stack = document.elementsFromPoint(x, y) || [];
    for (const node of stack) {
      if (state.overlay && (node === state.overlay || state.overlay.contains(node))) continue;
      return node;
    }
    return null;
  }

  // Deepest element at top-viewport coordinates, piercing open shadow roots and
  // descending same-origin iframes. Cross-origin frames stay opaque (the iframe
  // element itself is the result).
  function deepElementFromPoint(clientX, clientY) {
    let doc = document;
    let x = clientX;
    let y = clientY;
    let element = null;
    let guard = 0;
    while (guard < 20) {
      guard += 1;
      let found = doc === document ? topDocElementAt(x, y) : doc.elementFromPoint(x, y);
      if (!found) break;
      // Pierce open shadow roots at this point.
      let pierce = 0;
      while (found.shadowRoot && pierce < 10) {
        const inner = found.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === found) break;
        found = inner;
        pierce += 1;
      }
      element = found;
      if (tagOf(found) === 'iframe' || tagOf(found) === 'frame') {
        let innerDoc = null;
        try {
          innerDoc = found.contentDocument;
        } catch (_err) {
          innerDoc = null;
        }
        if (!innerDoc) break; // cross-origin: opaque pixel subject
        const frameRect = found.getBoundingClientRect();
        x -= frameRect.left + found.clientLeft;
        y -= frameRect.top + found.clientTop;
        doc = innerDoc;
        continue;
      }
      break;
    }
    return element;
  }

  // Structural parent that can climb out of open shadow roots and same-origin
  // iframes (the same traversal the old depth-walk used).
  function parentOf(element) {
    let parent = element.parentElement;
    if (!parent) {
      const rootNode = element.getRootNode?.();
      if (rootNode && rootNode.host) {
        parent = rootNode.host; // climb out of an open shadow root
      } else {
        try {
          parent = viewOf(element).frameElement || null; // climb out of a same-origin iframe
        } catch (_err) {
          parent = null;
        }
      }
    }
    if (!parent || tagOf(parent) === 'html') return null;
    return parent;
  }

  function buildAnchorChain(deepest) {
    const chain = [];
    let current = deepest;
    let guard = 0;
    while (current && guard < 50) {
      guard += 1;
      chain.push(current);
      current = parentOf(current);
    }
    return chain;
  }

  function isHiddenElement(element) {
    const style = viewOf(element).getComputedStyle(element);
    return !style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0;
  }

  function hasBackgroundImage(element) {
    const style = viewOf(element).getComputedStyle(element);
    return Boolean(style && /url\(|gradient\(/i.test(style.backgroundImage || ''));
  }

  function hasOpaqueBackgroundColor(style) {
    const value = style?.backgroundColor || '';
    if (!value || value === 'transparent') return false;
    const match = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*([0-9.]+))?\s*\)$/.exec(value);
    if (match) return match[1] === undefined || Number(match[1]) > 0;
    // Non-rgb computed value (oklch/lab/color()): painted unless fully keywordless.
    return true;
  }

  function hasVisibleBorder(style) {
    if (!style) return false;
    return ['Top', 'Right', 'Bottom', 'Left'].some(side =>
      style[`border${side}Style`] !== 'none' && parseFloat(style[`border${side}Width`]) > 0);
  }

  // Measured info for one ancestor-chain entry, in the shape the pure
  // chooseVisualAnchorIndex decision table consumes.
  function describeChainEntry(element, viewportWidth, viewportHeight) {
    const style = viewOf(element).getComputedStyle(element);
    const rect = clampRectToViewport(topRectOf(element), viewportWidth, viewportHeight);
    return {
      isPixelTag: PIXEL_TAGS.has(tagOf(element)),
      isInlineSvg: tagOf(element) === 'svg',
      hasBackgroundImage: Boolean(style && /url\(|gradient\(/i.test(style.backgroundImage || '')),
      hasBackgroundColor: hasOpaqueBackgroundColor(style),
      hasBorder: hasVisibleBorder(style),
      hasShadow: Boolean(style) && style.boxShadow !== 'none' && style.boxShadow !== '',
      viewportCoverage: (rect.w * rect.h) / (viewportWidth * viewportHeight),
    };
  }

  function rebuildChainFor(deepest) {
    state.deepest = deepest;
    state.chain = deepest ? buildAnchorChain(deepest) : [];
    state.depthOffset = 0;
    if (state.chain.length === 0) {
      state.snapIndex = 0;
      return;
    }
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const infos = state.chain
      .slice(0, MAX_SNAP_CLIMB + 1)
      .map(element => describeChainEntry(element, viewportWidth, viewportHeight));
    state.snapIndex = chooseVisualAnchorIndex(infos);
  }

  function currentTarget() {
    if (state.chain.length === 0) return null;
    const index = Math.max(0, Math.min(state.chain.length - 1, state.snapIndex + state.depthOffset));
    return state.chain[index];
  }

  function adjustDepth(delta) {
    if (state.chain.length === 0) return;
    const index = state.snapIndex + state.depthOffset + delta;
    const clamped = Math.max(0, Math.min(state.chain.length - 1, index));
    state.depthOffset = clamped - state.snapIndex;
    refreshHighlight();
  }

  function subtreeTextChars(element) {
    // Visible-ish text only: style/script payloads must not count as "text", or
    // a background-image hero carrying an inline <style> stops classifying as a
    // pixel subject.
    // Only the BACKGROUND_IMAGE_MAX_TEXT threshold consumes this value, so the
    // walk stops as soon as the answer is decided.
    const enough = BACKGROUND_IMAGE_MAX_TEXT * 4;
    let total = 0;
    const walk = (node, guard) => {
      if (!node || guard.count > 400 || total > enough) return;
      for (const child of node.childNodes || []) {
        if (child.nodeType === 3) {
          total += (child.textContent || '').trim().length;
        } else if (child.nodeType === 1) {
          guard.count += 1;
          const tag = tagOf(child);
          if (tag === 'style' || tag === 'script' || tag === 'noscript' || tag === 'template') continue;
          walk(child, guard);
        }
        if (total > enough) return;
      }
    };
    walk(element, { count: 0 });
    return total;
  }

  // Largest pixel-content descendant and how much of the selection it covers
  // (the full-bleed rule: a wrapped portfolio <img> is the subject, not its div).
  function largestPixelDescendant(element, selectionRect) {
    const descendants = element.querySelectorAll('img, canvas, video, picture');
    let best = null;
    let bestArea = 0;
    let scanned = 0;
    for (const candidate of descendants) {
      scanned += 1;
      if (scanned > MAX_DESCENDANT_SCAN) break;
      if (isHiddenElement(candidate)) continue;
      const rect = topRectOf(candidate);
      const area = intersectionArea(rect, selectionRect);
      if (area > bestArea) {
        bestArea = area;
        best = candidate;
      }
    }
    const selectionArea = selectionRect.w * selectionRect.h;
    return {
      element: best,
      coverage: selectionArea > 0 ? bestArea / selectionArea : 0,
    };
  }

  // 1×1 canvas probe: rasterizes any CSS color Chrome supports into sRGB bytes.
  // OUR OWN canvas, never the page's (no taint risk); out-of-gamut wide-gamut
  // values clamp to nearest-sRGB, which is deterministic per browser. Cached —
  // computed color strings repeat heavily across a subtree.
  let probeCtx = null;
  const probeCache = new Map();
  function probeCssColor(value) {
    if (probeCache.has(value)) return probeCache.get(value);
    let result = null;
    try {
      if (typeof CSS === 'undefined' || !CSS.supports || CSS.supports('color', value)) {
        if (!probeCtx) {
          const canvas = typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(1, 1)
            : Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
          probeCtx = canvas.getContext('2d', { willReadFrequently: true });
        }
        if (probeCtx) {
          probeCtx.clearRect(0, 0, 1, 1);
          probeCtx.fillStyle = value;
          probeCtx.fillRect(0, 0, 1, 1);
          const data = probeCtx.getImageData(0, 0, 1, 1).data;
          result = { r: data[0], g: data[1], b: data[2], a: data[3] };
        }
      }
    } catch (_err) {
      result = null;
    }
    if (probeCache.size > 512) probeCache.clear();
    probeCache.set(value, result);
    return result;
  }

  function firstFontFamily(value) {
    const first = String(value || '').split(',')[0] || '';
    return first.replace(/["']/g, '').trim();
  }

  // Scoped computed-style tokens for dom-subtree subjects: exact authored values,
  // ranked by frequency. Bounded BREADTH-FIRST walk — a huge subtree cannot stall
  // the page, and when the budget runs out it has covered every region of the
  // selection evenly instead of starving later siblings (depth-first spent the
  // whole budget inside the first branch).
  function collectDomTokens(rootElement) {
    const colorCounts = new Map(); // hex -> {count, roles:Set}
    const fontMap = new Map(); // family -> {weights:Set, where:Set}
    const radiusCounts = new Map();
    let visited = 0;
    let totalColorHits = 0;

    const noteColor = (hex, role) => {
      if (!hex) return;
      totalColorHits += 1;
      const entry = colorCounts.get(hex) || { count: 0, roles: new Set() };
      entry.count += 1;
      entry.roles.add(role);
      colorCounts.set(hex, entry);
    };

    const queue = [rootElement];
    while (queue.length > 0 && visited < MAX_SUBTREE_ELEMENTS) {
      const element = queue.shift();
      if (!element) continue;
      visited += 1;
      if (isHiddenElement(element)) continue; // hidden prunes its whole subtree
      const style = viewOf(element).getComputedStyle(element);
      if (!style) continue;

      if ((element.textContent || '').trim()) noteColor(cssColorToHex(style.color, probeCssColor), 'text');
      noteColor(cssColorToHex(style.backgroundColor, probeCssColor), 'background');
      if (style.borderTopStyle !== 'none' && parseFloat(style.borderTopWidth) > 0) {
        noteColor(cssColorToHex(style.borderTopColor, probeCssColor), 'border');
      }
      // Gradient stops are brand identity too, and invisible to backgroundColor.
      const backgroundImage = style.backgroundImage || '';
      if (/gradient\(/i.test(backgroundImage)) {
        extractCssColorTokens(backgroundImage).slice(0, 4).forEach(token => {
          noteColor(cssColorToHex(token, probeCssColor), 'gradient');
        });
      }

      const family = firstFontFamily(style.fontFamily);
      if (family && (element.textContent || '').trim()) {
        const entry = fontMap.get(family) || { weights: new Set(), where: new Set() };
        const weight = parseInt(style.fontWeight, 10);
        if (Number.isInteger(weight)) entry.weights.add(weight);
        entry.where.add(HEADLINE_TAGS.has(tagOf(element)) ? 'headlines' : 'body');
        fontMap.set(family, entry);
      }

      const radius = style.borderTopLeftRadius;
      if (radius && radius !== '0px') {
        radiusCounts.set(radius, (radiusCounts.get(radius) || 0) + 1);
      }

      for (const child of element.children || []) queue.push(child);
      if (element.shadowRoot) {
        for (const child of element.shadowRoot.children || []) queue.push(child);
      }
    }

    const colors = [...colorCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, MAX_DOM_COLORS)
      .map(([hex, entry]) => ({
        hex,
        role: [...entry.roles][0] || 'color',
        frequency: totalColorHits > 0 ? Math.round((entry.count / totalColorHits) * 1000) / 1000 : null,
      }));

    const fonts = [...fontMap.entries()]
      .sort((a, b) => b[1].weights.size + b[1].where.size - (a[1].weights.size + a[1].where.size))
      .slice(0, MAX_DOM_FONTS)
      .map(([family, entry]) => ({
        family,
        weights: [...entry.weights].sort((a, b) => a - b),
        where: entry.where.has('headlines') ? 'headlines' : 'body',
      }));

    let radii = null;
    let radiiBest = 0;
    for (const [value, count] of radiusCounts.entries()) {
      if (count > radiiBest) {
        radiiBest = count;
        radii = value;
      }
    }

    return { colors, fonts, shape: { radii, spacingScale: null } };
  }

  function sanitizeElementSrc(element) {
    const tag = tagOf(element);
    if (tag === 'img') return element.currentSrc || element.src || null;
    if (tag === 'video') return element.poster || element.currentSrc || null;
    if (tag === 'picture') {
      const img = element.querySelector('img');
      return img ? (img.currentSrc || img.src || null) : null;
    }
    return null;
  }

  function describeSourceElement(element) {
    const tag = tagOf(element);
    return {
      tag,
      src: sanitizeElementSrc(element),
      alt: element.getAttribute?.('alt') || null,
      naturalSize: tag === 'img'
        ? { w: element.naturalWidth || null, h: element.naturalHeight || null }
        : (tag === 'video' ? { w: element.videoWidth || null, h: element.videoHeight || null } : null),
    };
  }

  function isCrossOriginFrame(element) {
    if (tagOf(element) !== 'iframe' && tagOf(element) !== 'frame') return false;
    try {
      return !element.contentDocument;
    } catch (_err) {
      return true;
    }
  }

  function isInEmbeddedFrame(element) {
    return tagOf(element) === 'iframe' || tagOf(element) === 'frame' || viewOf(element) !== window;
  }

  // The visual viewport pins the screenshot's true scale and origin (pinch-zoom
  // offsets, classic scrollbars); read fresh per payload so a zoom between picks
  // cannot go stale.
  function readVisualViewport() {
    const vv = window.visualViewport;
    if (!vv || !(vv.width > 0)) return null;
    return {
      offsetLeft: vv.offsetLeft || 0,
      offsetTop: vv.offsetTop || 0,
      width: vv.width,
      height: vv.height || 0,
    };
  }

  // Best-effort theme provenance: a palette measured under dark mode is a
  // theme-specific truth, not "the brand's only colors". This reflects the
  // user-agent preference, which is what theme-aware sites key on.
  function readColorScheme() {
    try {
      return typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (_err) {
      return 'light';
    }
  }

  // Shared element measurement for the hover chip and the click payload, so what
  // the chip announces ("pixels sampled" vs "styles measured") is decided by the
  // exact same rules that build the capture.
  function measureElementSubject(element, cachedFullBleed = null) {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const selectionRect = clampRectToViewport(topRectOf(element), viewportWidth, viewportHeight);
    const fullBleed = cachedFullBleed || largestPixelDescendant(element, selectionRect);
    const subjectType = classifySubject({
      mode: 'element',
      viewportCoverage: (selectionRect.w * selectionRect.h) / (viewportWidth * viewportHeight),
      isCrossOriginFrame: isCrossOriginFrame(element),
      isPixelTag: PIXEL_TAGS.has(tagOf(element)),
      isInlineSvg: tagOf(element) === 'svg',
      hasBackgroundImage: hasBackgroundImage(element),
      textChars: subtreeTextChars(element),
      pixelDescendantCoverage: fullBleed.coverage,
    });
    return { selectionRect, fullBleed, subjectType, viewportWidth, viewportHeight };
  }

  // ---- overlay -------------------------------------------------------------

  function buildOverlay() {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-enhancivity-picker', 'true');
    overlay.setAttribute('tabindex', '-1');
    // pointer-events:auto is deliberate: every pointer event lands on the overlay,
    // so clicks can NEVER reach the page or any embedded iframe (a pointer-events:
    // none overlay lets clicks over embeds hit the embed for real — playing videos
    // and following links mid-pick). Trade-off, accepted: the page stops receiving
    // hover, so :hover styling is not active in the screenshot.
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:auto;cursor:crosshair;outline:none;background:transparent;';

    const highlightBox = document.createElement('div');
    highlightBox.style.cssText = 'position:fixed;display:none;pointer-events:none;border:2px solid #6c2bd9;background:rgba(108,43,217,0.12);border-radius:2px;box-sizing:border-box;';

    const chip = document.createElement('div');
    chip.style.cssText = 'position:fixed;display:none;pointer-events:none;background:#1a1a2e;color:#ffffff;font:12px/1.6 system-ui,sans-serif;padding:2px 8px;border-radius:4px;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

    const rectBox = document.createElement('div');
    rectBox.style.cssText = 'position:fixed;display:none;pointer-events:none;border:2px dashed #6c2bd9;background:rgba(108,43,217,0.08);box-sizing:border-box;';

    overlay.append(highlightBox, chip, rectBox);
    (document.body || document.documentElement).appendChild(overlay);
    state.overlay = overlay;
    state.highlightBox = highlightBox;
    state.chip = chip;
    state.rectBox = rectBox;
    // Pull keyboard focus onto the overlay so Esc/Alt work even when focus was
    // inside an iframe when picking started (key events never cross frames).
    try {
      overlay.focus({ preventScroll: true });
    } catch (_err) { /* focus is best-effort */ }
  }

  function positionBox(box, rect) {
    box.style.display = 'block';
    box.style.left = `${rect.x}px`;
    box.style.top = `${rect.y}px`;
    box.style.width = `${rect.w}px`;
    box.style.height = `${rect.h}px`;
  }

  const SUBJECT_TYPE_CHIP_LABEL = {
    page: 'whole page',
    'pixel-subject': 'pixels sampled',
    'dom-subtree': 'styles measured',
  };

  function chipLabel(element, rect, subjectType, depthOffset) {
    const tag = tagOf(element);
    const className = typeof element.className === 'string'
      ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.')
      : '';
    const depth = depthOffset !== 0 ? ` (${depthOffset > 0 ? '+' : ''}${depthOffset})` : '';
    const size = `${Math.round(rect.w)}×${Math.round(rect.h)}`;
    const path = SUBJECT_TYPE_CHIP_LABEL[subjectType] || 'measured';
    return `${tag}${className ? `.${className}` : ''}${depth} · ${size} · ${path} — click captures · Alt/Shift+Alt depth · Esc cancels`;
  }

  function refreshHighlight() {
    if (!state.active || state.dragging) return;
    const target = currentTarget();
    if (!target || target === state.overlay || state.overlay.contains(target)) {
      state.highlightBox.style.display = 'none';
      state.chip.style.display = 'none';
      return;
    }
    // The descendant scan is the only expensive part of the measurement; memoize
    // it per target element (rect + classification stay fresh per refresh, so the
    // chip tracks scrolling and resizes).
    if (state.chipMetaElement !== target) {
      state.chipMetaElement = target;
      state.chipMetaFullBleed = null;
    }
    const measured = measureElementSubject(target, state.chipMetaFullBleed);
    state.chipMetaFullBleed = measured.fullBleed;
    const rect = measured.selectionRect;
    positionBox(state.highlightBox, rect);
    state.chip.textContent = chipLabel(target, rect, measured.subjectType, state.depthOffset);
    state.chip.style.display = 'block';
    state.chip.style.left = `${Math.max(4, rect.x)}px`;
    state.chip.style.top = `${Math.max(4, rect.y - 26)}px`;
  }

  // ---- selection -> payload --------------------------------------------------

  function buildElementPayload(element) {
    const measured = measureElementSubject(element);
    const { selectionRect, fullBleed, subjectType, viewportWidth, viewportHeight } = measured;
    if (selectionRect.w < MIN_SELECTION_CSS_PX || selectionRect.h < MIN_SELECTION_CSS_PX) {
      return { tooSmall: true };
    }

    // Full-bleed: the wrapped pixel content IS the subject — re-anchor metadata and
    // crop rect onto it instead of the wrapper.
    const subjectElement = subjectType === 'pixel-subject' && fullBleed.element && fullBleed.coverage >= FULL_BLEED_COVERAGE
      ? fullBleed.element
      : element;
    const subjectUnclampedRect = topRectOf(subjectElement);
    const subjectRect = subjectElement === element
      ? selectionRect
      : clampRectToViewport(subjectUnclampedRect, viewportWidth, viewportHeight);
    const shouldSegment = subjectType === 'pixel-subject'
      && !isInEmbeddedFrame(subjectElement)
      && subjectUnclampedRect.h > viewportHeight * 1.15;
    const docRectCss = shouldSegment
      ? {
        x: subjectUnclampedRect.x + window.scrollX,
        y: subjectUnclampedRect.y + window.scrollY,
        w: subjectUnclampedRect.w,
        h: subjectUnclampedRect.h,
      }
      : null;

    const payload = {
      subjectType,
      selection: {
        mode: 'element',
        rectCss: subjectRect,
        ...(docRectCss ? { docRectCss, scrollY: window.scrollY } : {}),
        viewport: { w: viewportWidth, h: viewportHeight },
        visualViewport: readVisualViewport(),
      },
      sourceElement: describeSourceElement(subjectElement),
      colorScheme: readColorScheme(),
      capturedAt: new Date().toISOString(),
    };
    if (subjectType === 'dom-subtree') {
      payload.domTokens = collectDomTokens(subjectElement);
    } else if (subjectType === 'page') {
      payload.domTokens = collectDomTokens(document.body || document.documentElement);
    }
    return { payload, subjectElement };
  }

  function buildDragRectPayload(dragRect) {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const selectionRect = clampRectToViewport(normalizeRect(dragRect), viewportWidth, viewportHeight);
    if (selectionRect.w < MIN_SELECTION_CSS_PX || selectionRect.h < MIN_SELECTION_CSS_PX) {
      return { tooSmall: true };
    }
    // Best-effort element metadata when exactly the rect maps onto one element.
    const center = deepElementFromPoint(
      selectionRect.x + (selectionRect.w / 2),
      selectionRect.y + (selectionRect.h / 2)
    );
    let sourceElement = { tag: null, src: null, alt: null, naturalSize: null };
    if (center) {
      const centerRect = clampRectToViewport(topRectOf(center), viewportWidth, viewportHeight);
      const union = (centerRect.w * centerRect.h) + (selectionRect.w * selectionRect.h) - intersectionArea(centerRect, selectionRect);
      const iou = union > 0 ? intersectionArea(centerRect, selectionRect) / union : 0;
      if (iou >= 0.85) sourceElement = describeSourceElement(center);
    }
    return {
      payload: {
        subjectType: classifySubject({ mode: 'drag-rect' }),
        selection: {
          mode: 'drag-rect',
          rectCss: selectionRect,
          viewport: { w: viewportWidth, h: viewportHeight },
          visualViewport: readVisualViewport(),
        },
        sourceElement,
        colorScheme: readColorScheme(),
        capturedAt: new Date().toISOString(),
      },
    };
  }

  // ---- lifecycle -------------------------------------------------------------

  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    state.listeners.push(() => target.removeEventListener(type, handler, options));
  }

  function teardown() {
    state.listeners.forEach(remove => {
      try {
        remove();
      } catch (_err) { /* listener already gone */ }
    });
    state.listeners = [];
    state.overlay?.remove();
    state.overlay = null;
    state.highlightBox = null;
    state.chip = null;
    state.rectBox = null;
    state.deepest = null;
    state.chain = [];
    state.snapIndex = 0;
    state.depthOffset = 0;
    state.chipMetaElement = null;
    state.chipMetaFullBleed = null;
    state.dragStart = null;
    state.dragging = false;
    state.dragRect = null;
    state.active = false;
  }

  function notify(message) {
    try {
      chrome.runtime.sendMessage(message);
    } catch (_err) { /* extension context gone (panel closed) */ }
  }

  function cancelPicking(reason) {
    if (!state.active) return;
    lastPickedSubjectElement = null;
    lastPickedDocRectCss = null;
    teardown();
    notify({ type: 'MEMORY_LAYER_SUBJECT_PICK_CANCELLED', reason: reason || 'cancelled' });
  }

  function waitForScrollSettle() {
    return new Promise(resolve => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setTimeout(resolve, 350));
      });
    });
  }

  async function scrollToSegment(scrollY) {
    if (!lastPickedSubjectElement || !lastPickedSubjectElement.isConnected) {
      return { success: false, cancelled: 'selection_moved' };
    }
    const targetY = Math.max(0, Number(scrollY) || 0);
    try {
      window.scrollTo({ top: targetY, behavior: 'instant' });
    } catch (_err) {
      window.scrollTo(0, targetY);
    }
    await waitForScrollSettle();
    if (!lastPickedSubjectElement || !lastPickedSubjectElement.isConnected) {
      return { success: false, cancelled: 'selection_moved' };
    }
    const fresh = topRectOf(lastPickedSubjectElement);
    const freshDocRect = {
      x: fresh.x + window.scrollX,
      y: fresh.y + window.scrollY,
      w: fresh.w,
      h: fresh.h,
    };
    if (
      lastPickedDocRectCss
      && (
        Math.abs(freshDocRect.x - lastPickedDocRectCss.x) > REMEASURE_TOLERANCE_PX
        || Math.abs(freshDocRect.w - lastPickedDocRectCss.w) > REMEASURE_TOLERANCE_PX
      )
    ) {
      return { success: false, cancelled: 'selection_moved' };
    }
    return {
      success: true,
      rectCss: fresh,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      visualViewport: readVisualViewport(),
      scrollY: window.scrollY,
    };
  }

  // Overlay must be fully gone and repainted away BEFORE the side panel triggers
  // captureVisibleTab, or the highlight appears inside the screenshot. The subject
  // rect is RE-MEASURED at the last moment for element picks: carousels, momentum
  // scroll, and late layout shifts otherwise leave the crop pointing at pixels the
  // subject no longer occupies.
  function confirmSelection(payload, subjectElement = null) {
    teardown();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (subjectElement) {
            if (!subjectElement.isConnected) {
              notify({ type: 'MEMORY_LAYER_SUBJECT_PICK_CANCELLED', reason: 'selection_moved' });
              return;
            }
            const freshRaw = topRectOf(subjectElement);
            const fresh = clampRectToViewport(freshRaw, window.innerWidth, window.innerHeight);
            if (fresh.w < MIN_SELECTION_CSS_PX || fresh.h < MIN_SELECTION_CSS_PX) {
              notify({ type: 'MEMORY_LAYER_SUBJECT_PICK_CANCELLED', reason: 'selection_moved' });
              return;
            }
            if (rectsDifferBeyond(payload.selection.rectCss, fresh)) {
              payload.selection.rectCss = fresh;
              payload.selection.viewport = { w: window.innerWidth, h: window.innerHeight };
              payload.selection.visualViewport = readVisualViewport();
              if (payload.selection.docRectCss) {
                payload.selection.docRectCss = {
                  x: freshRaw.x + window.scrollX,
                  y: freshRaw.y + window.scrollY,
                  w: freshRaw.w,
                  h: freshRaw.h,
                };
              }
            }
            lastPickedSubjectElement = subjectElement;
            lastPickedDocRectCss = payload.selection.docRectCss || null;
          } else {
            lastPickedSubjectElement = null;
            lastPickedDocRectCss = null;
          }
          notify({ type: 'MEMORY_LAYER_SUBJECT_PICKED', payload });
        }, 40);
      });
    });
  }

  function flashChipMessage(text) {
    if (!state.chip) return;
    state.chip.textContent = text;
    state.chip.style.display = 'block';
  }

  function startPicking() {
    if (state.active) teardown();
    lastPickedSubjectElement = null;
    lastPickedDocRectCss = null;
    state.active = true;
    buildOverlay();

    on(window, 'pointermove', event => {
      if (state.dragging) {
        state.dragRect = { left: state.dragStart.x, top: state.dragStart.y, right: event.clientX, bottom: event.clientY };
        positionBox(state.rectBox, normalizeRect(state.dragRect));
        return;
      }
      if (state.dragStart) {
        const moved = Math.hypot(event.clientX - state.dragStart.x, event.clientY - state.dragStart.y);
        if (moved > DRAG_THRESHOLD_PX) {
          state.dragging = true;
          state.highlightBox.style.display = 'none';
          state.chip.style.display = 'none';
          return;
        }
      }
      const next = deepElementFromPoint(event.clientX, event.clientY);
      if (next !== state.deepest) {
        rebuildChainFor(next);
      }
      refreshHighlight();
    }, { capture: true, passive: true });

    on(window, 'pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
      state.dragStart = { x: event.clientX, y: event.clientY };
    }, { capture: true });

    on(window, 'pointerup', event => {
      event.preventDefault();
      event.stopPropagation();
      const wasDragging = state.dragging;
      const dragRect = state.dragRect;
      state.dragStart = null;
      state.dragging = false;
      state.dragRect = null;
      state.rectBox.style.display = 'none';

      const target = currentTarget();
      const built = wasDragging && dragRect
        ? buildDragRectPayload(dragRect)
        : (target ? buildElementPayload(target) : null);
      if (!built) return;
      if (built.tooSmall) {
        flashChipMessage('Selection too small — pick a larger area.');
        return;
      }
      confirmSelection(built.payload, built.subjectElement || null);
    }, { capture: true });

    on(window, 'click', event => {
      event.preventDefault();
      event.stopPropagation();
    }, { capture: true });

    on(window, 'contextmenu', event => {
      event.preventDefault();
      event.stopPropagation();
      cancelPicking('context_menu');
    }, { capture: true });

    on(window, 'keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelPicking('escape');
        return;
      }
      if (event.key === 'Alt') {
        event.preventDefault(); // keep Windows from focusing the browser menu
        adjustDepth(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.key === 'Shift' && event.altKey) {
        adjustDepth(-1);
      }
    }, { capture: true });

    // Alt+wheel surfs the ancestor chain; a plain wheel keeps scrolling the page.
    on(window, 'wheel', event => {
      if (!event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      adjustDepth(event.deltaY < 0 ? 1 : -1);
    }, { capture: true, passive: false });

    on(window, 'scroll', () => refreshHighlight(), { capture: true, passive: true });
    on(window, 'resize', () => refreshHighlight(), { passive: true });
    on(window, 'pagehide', () => cancelPicking('navigation'));
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'MEMORY_LAYER_START_SUBJECT_PICKER') {
      if (!isTopFrame) {
        sendResponse({ success: false, error: 'not_top_frame' });
        return false;
      }
      startPicking();
      sendResponse({ success: true });
      return false;
    }
    if (message?.type === 'MEMORY_LAYER_SCROLL_TO_SEGMENT') {
      scrollToSegment(message.scrollY)
        .then(sendResponse)
        .catch(error => sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'segment_scroll_failed',
        }));
      return true;
    }
    if (message?.type === 'MEMORY_LAYER_CANCEL_SUBJECT_PICKER') {
      cancelPicking('panel_cancelled');
      sendResponse({ success: true });
      return false;
    }
    return false;
  });

  return core;
});
