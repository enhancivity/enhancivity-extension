// Deterministic palette quantization for selection-first design capture.
// Runs on the UNCOMPRESSED screenshot crop (PNG ImageData) in the background
// service worker — never on the page's own canvas (tainted-canvas SecurityError on
// tools compositing cross-origin user images). No dependencies and no randomness:
// the extension has no bundler, and the same crop must always yield the same
// palette. Median-cut + MODE SNAP (each cluster reports its most frequent exact
// sampled RGB, never a box mean — anti-aliasing and JPEG decode noise around a
// flat brand color otherwise shift the mean off the true value, so every reported
// color is a pixel that actually exists in the design) + Lab-distance dedupe (a
// population floor alone would drop small-but-distinct accent colors;
// near-identical shades merge instead) + role heuristics (background =
// border-ring majority, accent = saturated minority).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EnhancivityMemoryLayerQuantizer = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    maxSwatches: 8,
    internalSwatches: 12,
    internalBoxes: 16,
    targetSamples: 40000,
    minPopulation: 0.004,
    dedupeDeltaE: 10,
    backgroundRingShare: 0.25,
    accentMinSaturation: 0.25,
    neutralMaxSaturation: 0.12,
  });

  function toHex(r, g, b) {
    const part = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return `#${part(r)}${part(g)}${part(b)}`;
  }

  function saturation(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return max === 0 ? 0 : (max - min) / max;
  }

  function srgbToLab(r, g, b) {
    const lin = v => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const rl = lin(r);
    const gl = lin(g);
    const bl = lin(b);
    // sRGB D65
    const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
    const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175;
    const z = (rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041) / 1.08883;
    const f = t => (t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + (16 / 116));
    const fx = f(x);
    const fy = f(y);
    const fz = f(z);
    return [(116 * fy) - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  // CIE76 — coarse but monotonic, plenty for merge-or-keep decisions.
  function deltaE(labA, labB) {
    const dl = labA[0] - labB[0];
    const da = labA[1] - labB[1];
    const db = labA[2] - labB[2];
    return Math.sqrt((dl * dl) + (da * da) + (db * db));
  }

  function samplePixels(image, targetSamples) {
    const data = image && image.data;
    const width = image && image.width;
    const height = image && image.height;
    if (!data || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      return { samples: [], border: [] };
    }
    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / Math.max(1, targetSamples))));
    const ring = Math.max(1, Math.round(Math.min(width, height) * 0.05));
    const samples = [];
    const border = [];
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = ((y * width) + x) * 4;
        if (data[i + 3] < 128) continue; // skip transparent
        const pixel = [data[i], data[i + 1], data[i + 2]];
        samples.push(pixel);
        if (x < ring || y < ring || x >= width - ring || y >= height - ring) {
          border.push(pixel);
        }
      }
    }
    return { samples, border };
  }

  function channelRange(samples, indices, channel) {
    let min = 255;
    let max = 0;
    for (const idx of indices) {
      const v = samples[idx][channel];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min, max, range: max - min };
  }

  function splitBox(samples, box) {
    const ranges = [0, 1, 2].map(channel => channelRange(samples, box.indices, channel));
    let widest = 0;
    if (ranges[1].range >= ranges[widest].range) widest = 1;
    if (ranges[2].range >= ranges[widest].range) widest = 2;
    if (ranges[widest].range === 0 || box.indices.length < 2) return null;

    const sorted = [...box.indices].sort((a, b) => samples[a][widest] - samples[b][widest]);
    const mid = Math.floor(sorted.length / 2);
    return [
      { indices: sorted.slice(0, mid) },
      { indices: sorted.slice(mid) },
    ];
  }

  function medianCut(samples, maxBoxes) {
    if (samples.length === 0) return [];
    let boxes = [{ indices: samples.map((_, i) => i) }];
    while (boxes.length < maxBoxes) {
      // Split the most populous splittable box; stable order keeps this deterministic.
      let target = -1;
      for (let i = 0; i < boxes.length; i += 1) {
        if (boxes[i].unsplittable) continue;
        if (boxes[i].indices.length < 2) continue;
        if (target === -1 || boxes[i].indices.length > boxes[target].indices.length) target = i;
      }
      if (target === -1) break;
      const parts = splitBox(samples, boxes[target]);
      if (!parts || parts[0].indices.length === 0 || parts[1].indices.length === 0) {
        boxes[target].unsplittable = true;
        if (boxes.every(box => box.unsplittable || box.indices.length < 2)) break;
        continue;
      }
      boxes.splice(target, 1, parts[0], parts[1]);
    }
    // Mode snap: report each box's most frequent EXACT sampled color, not the
    // box mean. A mean is a synthetic value that may exist nowhere in the crop;
    // the mode is always a real design pixel. Ties break to the lowest packed
    // RGB so identical input always yields the identical palette.
    return boxes.map(box => {
      const counts = new Map();
      for (const idx of box.indices) {
        const s = samples[idx];
        const key = (s[0] << 16) | (s[1] << 8) | s[2];
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      let bestKey = -1;
      let bestCount = 0;
      for (const [key, count] of counts) {
        if (count > bestCount || (count === bestCount && key < bestKey)) {
          bestKey = key;
          bestCount = count;
        }
      }
      return {
        r: (bestKey >> 16) & 255,
        g: (bestKey >> 8) & 255,
        b: bestKey & 255,
        count: box.indices.length,
      };
    });
  }

  // Maps a selection rect in TOP-window CSS px onto the captured bitmap.
  // captureVisibleTab covers the VISUAL viewport, so when the visual viewport is
  // known it is the source of truth for both scale and origin — one rule that is
  // correct under devicePixelRatio, browser zoom, classic (space-reserving)
  // scrollbars, and pinch-zoom. The 1-device-px inset trims rounding bleed at
  // the crop edges, where neighbor pixels otherwise skew edge colors.
  function computeCropRect({
    rectCss,
    viewport,
    visualViewport = null,
    bitmapWidth,
    bitmapHeight,
    insetPx = 1,
  } = {}) {
    if (!rectCss || !(bitmapWidth > 0) || !(bitmapHeight > 0)) return null;
    const vv = visualViewport && visualViewport.width > 0
      ? visualViewport
      : { offsetLeft: 0, offsetTop: 0, width: viewport && viewport.w > 0 ? viewport.w : 0 };
    if (!(vv.width > 0)) return null;
    const scale = bitmapWidth / vv.width;
    let x = Math.round((rectCss.x - (vv.offsetLeft || 0)) * scale);
    let y = Math.round((rectCss.y - (vv.offsetTop || 0)) * scale);
    const right = Math.min(bitmapWidth, x + Math.round(rectCss.w * scale));
    const bottom = Math.min(bitmapHeight, y + Math.round(rectCss.h * scale));
    x = Math.max(0, x);
    y = Math.max(0, y);
    let w = Math.max(0, right - x);
    let h = Math.max(0, bottom - y);
    const inset = Number.isFinite(insetPx) && insetPx > 0 ? Math.floor(insetPx) : 0;
    if (inset > 0 && w > (inset * 2) + 4 && h > (inset * 2) + 4) {
      x += inset;
      y += inset;
      w -= inset * 2;
      h -= inset * 2;
    }
    return { x, y, w, h, scale: Math.round(scale * 1000) / 1000 };
  }

  function assignRoles(clusters, border, options) {
    if (clusters.length === 0) return clusters;
    // Background: the cluster that owns the border ring, when it owns enough of it.
    if (border.length > 0) {
      const borderCounts = new Array(clusters.length).fill(0);
      for (const pixel of border) {
        const lab = srgbToLab(pixel[0], pixel[1], pixel[2]);
        let best = 0;
        let bestDistance = Infinity;
        for (let i = 0; i < clusters.length; i += 1) {
          const distance = deltaE(clusters[i].lab, lab);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = i;
          }
        }
        borderCounts[best] += 1;
      }
      let ringOwner = 0;
      for (let i = 1; i < clusters.length; i += 1) {
        if (borderCounts[i] > borderCounts[ringOwner]) ringOwner = i;
      }
      if (borderCounts[ringOwner] / border.length >= options.backgroundRingShare) {
        clusters[ringOwner].role = 'background';
      }
    }

    // Accent before dominant: a saturated MINORITY color (a logo, a CTA) is the
    // design's accent even when it is the largest non-background cluster.
    let accent = null;
    for (const cluster of clusters) {
      if (cluster.role) continue;
      if (cluster.saturation < options.accentMinSaturation) continue;
      if (cluster.population >= 0.5) continue; // majority color is never the accent
      const score = cluster.saturation * Math.sqrt(cluster.population);
      if (!accent || score > accent.score) accent = { cluster, score };
    }
    if (accent) accent.cluster.role = 'accent';

    const unassigned = clusters.filter(cluster => !cluster.role);
    if (unassigned.length > 0) unassigned[0].role = 'dominant'; // already population-sorted

    for (const cluster of clusters) {
      if (cluster.role) continue;
      cluster.role = cluster.saturation < options.neutralMaxSaturation ? 'neutral' : 'color';
    }
    return clusters;
  }

  // image: {data: RGBA byte array, width, height}. Returns [{hex, population, role}]
  // sorted by population, deterministic for identical input.
  function quantize(image, opts = {}) {
    const options = { ...DEFAULTS, ...opts };
    const { samples, border } = samplePixels(image, options.targetSamples);
    if (samples.length === 0) return [];

    const raw = medianCut(samples, options.internalBoxes)
      .map(cluster => ({
        ...cluster,
        population: cluster.count / samples.length,
        lab: srgbToLab(cluster.r, cluster.g, cluster.b),
        saturation: saturation(cluster.r, cluster.g, cluster.b),
      }))
      .filter(cluster => cluster.population >= options.minPopulation)
      .sort((a, b) => b.population - a.population);

    const kept = [];
    for (const cluster of raw) {
      const duplicate = kept.find(existing => deltaE(existing.lab, cluster.lab) < options.dedupeDeltaE);
      if (duplicate) {
        duplicate.population += cluster.population; // merge shade into the stronger swatch
        continue;
      }
      kept.push(cluster);
      if (kept.length >= options.internalSwatches) break;
    }
    kept.sort((a, b) => b.population - a.population);

    assignRoles(kept, border, options);

    return kept.slice(0, options.maxSwatches).map(cluster => ({
      hex: toHex(cluster.r, cluster.g, cluster.b),
      population: Math.round(cluster.population * 1000) / 1000,
      role: cluster.role,
    }));
  }

  return {
    quantize,
    computeCropRect,
    _internal: { srgbToLab, deltaE, medianCut, samplePixels, toHex, saturation },
  };
});
