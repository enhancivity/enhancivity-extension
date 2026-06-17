importScripts("memory_layer_quantizer.js");

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({
    path: "memory_layer_sidepanel.html",
    enabled: true,
  });
});

chrome.action.onClicked.addListener(async tab => {
  if (!tab?.windowId) return;
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

// ---------------------------------------------------------------------------
// Selection-first design capture: crop + palette pipeline.
// Runs here (not in the content script) so quantizing a megapixel crop never
// janks the page's main thread — exactly the WebGL editors we target — and so
// captureVisibleTab has a single owner under its ~2/sec rate limit.
// The palette is quantized on the UNCOMPRESSED PNG crop; JPEG compression only
// happens afterwards, for the (Phase C) vision payload. Pixels are transient:
// nothing is written to storage here.
// ---------------------------------------------------------------------------

// Matches the backend cap (leaves headroom inside its 500kb JSON body limit).
const MAX_IMAGE_BASE64_CHARS = 280000;
const JPEG_LONG_EDGE_LADDER = [1024, 800, 640];
const JPEG_QUALITY_LADDER = [0.8, 0.65, 0.5];
const MAX_COMPOSITE_JPEG_HEIGHT = 4000;
const SEGMENT_ACCUMULATOR_TTL_MS = 30000;
const segmentAccumulators = new Map();

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function cropBitmap(bitmap, crop) {
  const canvas = new OffscreenCanvas(crop.w, crop.h);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
  return { canvas, context };
}

async function downscaleCanvasHeight(sourceCanvas, maxHeight) {
  if (!(sourceCanvas.height > maxHeight)) return sourceCanvas;
  const scale = maxHeight / sourceCanvas.height;
  const width = Math.max(1, Math.round(sourceCanvas.width * scale));
  const height = Math.max(1, Math.round(sourceCanvas.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").drawImage(sourceCanvas, 0, 0, width, height);
  return canvas;
}

async function encodeJpegWithinBudget(sourceCanvas) {
  for (const longEdge of JPEG_LONG_EDGE_LADDER) {
    const scale = Math.min(1, longEdge / Math.max(sourceCanvas.width, sourceCanvas.height));
    const width = Math.max(1, Math.round(sourceCanvas.width * scale));
    const height = Math.max(1, Math.round(sourceCanvas.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").drawImage(sourceCanvas, 0, 0, width, height);
    for (const quality of JPEG_QUALITY_LADDER) {
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
      const base64 = arrayBufferToBase64(await blob.arrayBuffer());
      if (base64.length <= MAX_IMAGE_BASE64_CHARS) return base64;
    }
  }
  return null; // pathological crop: ship palette without an image rather than fail
}

function getSegmentAccumulator(segment) {
  const pickId = typeof segment?.pickId === "string" ? segment.pickId.slice(0, 120) : "";
  const count = Number(segment?.count);
  if (!pickId || !Number.isInteger(count) || count < 2 || count > 6) return null;
  let entry = segmentAccumulators.get(pickId);
  if (!entry) {
    entry = {
      count,
      canvases: new Array(count),
      crops: new Array(count),
      timer: setTimeout(() => {
        segmentAccumulators.delete(pickId);
      }, SEGMENT_ACCUMULATOR_TTL_MS),
    };
    segmentAccumulators.set(pickId, entry);
  }
  if (entry.count !== count) return null;
  return entry;
}

function cleanupSegmentAccumulator(pickId) {
  const entry = segmentAccumulators.get(pickId);
  if (entry?.timer) clearTimeout(entry.timer);
  segmentAccumulators.delete(pickId);
}

async function captureVisibleCrop({ windowId, rectCss, viewport, visualViewport }) {
  if (!rectCss || !(rectCss.w > 0) || !(rectCss.h > 0) || !(viewport?.w > 0)) {
    return { error: "invalid_selection_rect" };
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  // Scale and origin come from the visual viewport when known (correct under
  // DPR, browser zoom, classic scrollbars, and pinch-zoom); the crop is inset
  // 1 device px so rounding never bleeds neighbor pixels into edge colors.
  const crop = self.EnhancivityMemoryLayerQuantizer.computeCropRect({
    rectCss,
    viewport,
    visualViewport: visualViewport || null,
    bitmapWidth: bitmap.width,
    bitmapHeight: bitmap.height,
  });
  if (!crop || crop.w < 8 || crop.h < 8) {
    bitmap.close();
    return { error: "selection_outside_viewport" };
  }

  const { canvas, context } = await cropBitmap(bitmap, crop);
  bitmap.close();
  return { canvas, context, crop };
}

async function captureSegmentedSubjectPixels(message) {
  const segment = message.segment || {};
  const index = Number(segment.index);
  const count = Number(segment.count);
  const pickId = typeof segment.pickId === "string" ? segment.pickId.slice(0, 120) : "";
  if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || index >= count || !pickId) {
    return { success: false, error: "invalid_segment" };
  }

  const entry = getSegmentAccumulator(segment);
  if (!entry) return { success: false, error: "invalid_segment_accumulator" };

  const captured = await captureVisibleCrop(message);
  if (captured.error) {
    cleanupSegmentAccumulator(pickId);
    return { success: false, error: captured.error };
  }
  entry.canvases[index] = captured.canvas;
  entry.crops[index] = captured.crop;

  if (index < count - 1) {
    return { success: true, pendingSegment: true, segmentIndex: index, segmentCount: count };
  }

  if (entry.canvases.some(canvas => !canvas)) {
    cleanupSegmentAccumulator(pickId);
    return { success: false, error: "missing_segment" };
  }

  const width = Math.min(...entry.canvases.map(canvas => canvas.width));
  const height = entry.canvases.reduce((sum, canvas) => sum + canvas.height, 0);
  if (!(width > 0) || !(height > 0)) {
    cleanupSegmentAccumulator(pickId);
    return { success: false, error: "invalid_segment_composite" };
  }

  const composite = new OffscreenCanvas(width, height);
  const context = composite.getContext("2d");
  let y = 0;
  for (const canvas of entry.canvases) {
    // V1 trade-off: sticky/fixed headers repeat per segment and can slightly
    // overweight their colors. We accept that instead of guessing at removal.
    context.drawImage(canvas, 0, 0, width, canvas.height, 0, y, width, canvas.height);
    y += canvas.height;
  }
  cleanupSegmentAccumulator(pickId);

  const imageData = context.getImageData(0, 0, width, height);
  const palette = self.EnhancivityMemoryLayerQuantizer.quantize(imageData);
  const jpegCanvas = await downscaleCanvasHeight(composite, MAX_COMPOSITE_JPEG_HEIGHT);
  const imageJpegBase64 = await encodeJpegWithinBudget(jpegCanvas);

  return {
    success: true,
    palette,
    imageJpegBase64,
    segmentCount: count,
    captureScale: entry.crops[0]?.scale,
    cropSize: { w: width, h: height },
  };
}

async function captureSubjectPixels({ windowId, rectCss, viewport, visualViewport, segment }) {
  if (segment) return captureSegmentedSubjectPixels({ windowId, rectCss, viewport, visualViewport, segment });

  const captured = await captureVisibleCrop({ windowId, rectCss, viewport, visualViewport });
  if (captured.error) return { success: false, error: captured.error };
  const { canvas, context, crop } = captured;

  const imageData = context.getImageData(0, 0, crop.w, crop.h);
  const palette = self.EnhancivityMemoryLayerQuantizer.quantize(imageData);
  const imageJpegBase64 = await encodeJpegWithinBudget(canvas);

  return {
    success: true,
    palette,
    imageJpegBase64,
    captureScale: crop.scale,
    cropSize: { w: crop.w, h: crop.h },
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "MEMORY_LAYER_CANCEL_SUBJECT_PIXEL_SEGMENTS") {
    cleanupSegmentAccumulator(message.pickId);
    sendResponse({ success: true });
    return false;
  }
  if (message?.type !== "MEMORY_LAYER_CAPTURE_SUBJECT_PIXELS") return false;
  captureSubjectPixels(message)
    .then(sendResponse)
    .catch(error => sendResponse({
      success: false,
      error: error instanceof Error ? error.message : "subject_pixel_capture_failed",
    }));
  return true; // async response
});
