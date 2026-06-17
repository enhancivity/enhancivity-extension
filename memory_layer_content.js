(function initEnhancivityMemoryLayerContent() {
  if (window.__enhancivityMemoryLayerContentLoaded) return;
  window.__enhancivityMemoryLayerContentLoaded = true;

  let lastFocusedEditable = null;
  let lastFocusedDocumentSurface = null;
  let lastFocusedTargetKind = null;

  function isSupportedEditable(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    const tagName = element.tagName.toLowerCase();
    const type = String(element.getAttribute("type") || "").toLowerCase();
    return (
      tagName === "textarea" ||
      (tagName === "input" && ["", "text", "search"].includes(type)) ||
      element.isContentEditable ||
      element.getAttribute("role") === "textbox"
    );
  }

  function isNodeInDocument(node) {
    if (!node) return false;
    if (node.isConnected === true) return true;
    const root = typeof node.getRootNode === "function" ? node.getRootNode() : null;
    if (root?.host) return document.contains(root.host);
    return document.contains(node);
  }

  function deepActiveElement(root = document) {
    let active = root.activeElement || null;
    let guard = 0;
    while (active?.shadowRoot?.activeElement && guard < 8) {
      active = active.shadowRoot.activeElement;
      guard += 1;
    }
    return active;
  }

  function findEditableInEventPath(event) {
    const path = typeof event?.composedPath === "function" ? event.composedPath() : [];
    return path.find(node => isSupportedEditable(node)) || null;
  }

  function querySelectorAllDeep(root, selector, output = []) {
    if (!root?.querySelectorAll) return output;
    root.querySelectorAll(selector).forEach(element => output.push(element));
    root.querySelectorAll("*").forEach(element => {
      if (element.shadowRoot) querySelectorAllDeep(element.shadowRoot, selector, output);
    });
    return output;
  }

  function queryElementByIdDeep(id) {
    if (!id) return null;
    return querySelectorAllDeep(document, `#${CSS.escape(id)}`)[0] || null;
  }

  function editableSelector() {
    return [
      "textarea",
      "input:not([type])",
      "input[type='text']",
      "input[type='search']",
      "[contenteditable='true']",
      "[role='textbox']",
    ].join(",");
  }

  function findEditableNearElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    if (isSupportedEditable(element) && isVisibleElement(element)) return element;

    let current = element;
    let depth = 0;
    while (current && current !== document.documentElement && depth < 6) {
      const candidates = querySelectorAllDeep(current, editableSelector())
        .filter(candidate => isSupportedEditable(candidate) && isVisibleElement(candidate));
      const preferred = candidates.find(candidate => (
        /prompt|describe|idea|message|body|title|subject|editor|compose/i.test(fieldSignal(candidate))
      ));
      if (preferred) return preferred;
      if (candidates[0]) return candidates[0];
      if (isDocumentSurfaceElement(current)) return null;
      current = current.parentElement || current.getRootNode?.().host || null;
      depth += 1;
    }
    return null;
  }

  function documentSurfaceSignal(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return "";
    return [
      element.getAttribute("role"),
      element.getAttribute("aria-label"),
      element.getAttribute("data-automation-id"),
      element.getAttribute("data-testid"),
      element.getAttribute("data-memory-layer-editor"),
      element.id,
      element.className,
      element.tagName,
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function isDocumentSurfaceElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE || isSupportedEditable(element)) return false;
    const tagName = element.tagName?.toLowerCase();
    const signal = documentSurfaceSignal(element);
    return (
      tagName === "canvas" ||
      /(document|editor|canvas|page|word|office|docx|composer|markdown|rich.?text|post.?body|body.?text|text.?body)/.test(signal)
    );
  }

  function findDocumentSurface(element) {
    let current = element && element.nodeType === Node.ELEMENT_NODE ? element : null;
    let depth = 0;
    while (current && current !== document.documentElement && depth < 8) {
      const tagName = current.tagName?.toLowerCase();
      if (tagName === "iframe" || tagName === "frame") {
        current = current.parentElement;
        depth += 1;
        continue;
      }
      if (isSupportedEditable(current)) return null;
      if (isDocumentSurfaceElement(current)) {
        return current;
      }
      current = current.parentElement;
      depth += 1;
    }
    return null;
  }

  function rememberEditable(element) {
    const activeElement = deepActiveElement();
    const focusedElement = isSupportedEditable(element)
      ? element
      : findEditableNearElement(element) || findEditableNearElement(activeElement) || activeElement;
    if (isSupportedEditable(focusedElement)) {
      lastFocusedEditable = focusedElement;
      lastFocusedDocumentSurface = null;
      lastFocusedTargetKind = "editable";
      return;
    }
    const documentSurface = findDocumentSurface(focusedElement || element);
    if (documentSurface) {
      lastFocusedDocumentSurface = documentSurface;
      lastFocusedEditable = null;
      lastFocusedTargetKind = "document_surface";
    }
  }

  function rememberEditableFromEvent(event) {
    rememberEditable(findEditableInEventPath(event) || event.target);
  }

  function getEditable() {
    const active = deepActiveElement();
    const nearbyEditable = isSupportedEditable(active) ? active : findEditableNearElement(active);
    if (isSupportedEditable(nearbyEditable)) {
      lastFocusedEditable = nearbyEditable;
      lastFocusedDocumentSurface = null;
      lastFocusedTargetKind = "editable";
    } else if (findDocumentSurface(active)) {
      return null;
    }
    if (isSupportedEditable(lastFocusedEditable) && isNodeInDocument(lastFocusedEditable)) {
      return lastFocusedEditable;
    }
    return null;
  }

  function getDocumentSurface() {
    const activeSurface = findDocumentSurface(document.activeElement);
    if (activeSurface) {
      lastFocusedDocumentSurface = activeSurface;
    }
    if (lastFocusedDocumentSurface && isNodeInDocument(lastFocusedDocumentSurface)) {
      return lastFocusedDocumentSurface;
    }
    return null;
  }

  function getInsertionTarget() {
    if (lastFocusedTargetKind === "document_surface") {
      const documentSurface = getDocumentSurface();
      const editable = resolveDocumentSurfaceEditable(documentSurface, { preferredKind: "document_surface" });
      if (editable) {
        lastFocusedEditable = editable;
        lastFocusedTargetKind = "editable";
        return { kind: "editable", element: editable };
      }
      if (documentSurface) return { kind: "document_surface", element: documentSurface };
    }
    const editable = getEditable();
    if (editable) return { kind: "editable", element: editable };
    const documentSurface = getDocumentSurface();
    const surfaceEditable = resolveDocumentSurfaceEditable(documentSurface, { preferredKind: "document_surface" });
    if (surfaceEditable) {
      lastFocusedEditable = surfaceEditable;
      lastFocusedTargetKind = "editable";
      return { kind: "editable", element: surfaceEditable };
    }
    if (documentSurface) return { kind: "document_surface", element: documentSurface };
    return null;
  }

  function findTargetFromHint(targetHint) {
    const focusedField = targetHint?.focusedField;
    if (!focusedField || typeof focusedField !== "object") return null;

    const hintedElement = queryElementByIdDeep(focusedField.id);
    if (hintedElement) {
      if (isSupportedEditable(hintedElement)) return { kind: "editable", element: hintedElement };
      const documentSurface = findDocumentSurface(hintedElement);
      const resolvedEditable = resolveDocumentSurfaceEditable(documentSurface, {
        preferredRole: focusedField.role,
        preferredKind: targetHint.focusedTargetKind,
      });
      if (resolvedEditable) return { kind: "editable", element: resolvedEditable };
      if (documentSurface) return { kind: "document_surface", element: documentSurface };
    }

    const candidates = querySelectorAllDeep(document, [
      "textarea",
      "input:not([type])",
      "input[type='text']",
      "input[type='search']",
      "[contenteditable='true']",
      "[role='textbox']",
      "[tabindex]",
      "[aria-label]",
      "[data-testid]",
    ].join(","));

    for (const candidate of candidates) {
      if (!isVisibleElement(candidate)) continue;
      const role = inferFieldRole(candidate, targetHint.focusedTargetKind === "document_surface" ? "document_surface" : editableKind(candidate));
      if (role !== focusedField.role) continue;
      if (isSupportedEditable(candidate)) return { kind: "editable", element: candidate };
      const documentSurface = findDocumentSurface(candidate);
      if (documentSurface) return { kind: "document_surface", element: documentSurface };
    }

    const bestEditable = findBestVisibleEditableCandidate({
      preferredRole: focusedField.role,
      preferredKind: targetHint.focusedTargetKind,
    });
    if (bestEditable) return { kind: "editable", element: bestEditable };

    return null;
  }

  function getEditableText(element) {
    if (!element) return "";
    if ("value" in element) return String(element.value || "");
    return String(element.textContent || "");
  }

  function normalizeInlineText(value, limit = 240) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function getAssociatedLabelText(element) {
    const id = element?.id;
    const root = typeof element?.getRootNode === "function" ? element.getRootNode() : document;
    if (id) {
      const label = root?.querySelector?.(`label[for="${CSS.escape(id)}"]`) ||
        document.querySelector(`label[for="${CSS.escape(id)}"]`);
      const text = normalizeInlineText(label?.textContent, 180);
      if (text) return text;
    }
    const wrappingLabel = element?.closest?.("label");
    return normalizeInlineText(wrappingLabel?.textContent, 180);
  }

  function fieldSignal(element) {
    if (!element) return "";
    return [
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.getAttribute("name"),
      element.getAttribute("data-testid"),
      element.getAttribute("data-qa"),
      getAssociatedLabelText(element),
      element.id,
      element.className,
    ].filter(Boolean).join(" ");
  }

  function inferFieldRole(element, kind = "editable") {
    const tagName = element?.tagName?.toLowerCase() || "";
    const type = String(element?.getAttribute?.("type") || "").toLowerCase();
    const signal = fieldSignal(element).toLowerCase();
    if (/(title|headline|subject)/.test(signal)) return type === "search" ? "search" : "title";
    if (/(body|description|details|content|post text|text body|message body|markdown|editor)/.test(signal)) return "body";
    if (/(comment|reply|response)/.test(signal)) return "reply";
    if (/(message|composer|chat|slack|teams)/.test(signal)) return "message";
    if (/(prompt|ask|question)/.test(signal)) return "prompt";
    if (/(search|query)/.test(signal) || type === "search") return "search";
    if (kind === "document_surface") return "document";
    if (tagName === "textarea") return "body";
    return "generic";
  }

  function editableKind(element) {
    if (!element) return "unknown";
    const tagName = element.tagName?.toLowerCase() || "element";
    if (tagName === "input") return "input";
    if (tagName === "textarea") return "textarea";
    if (element.isContentEditable) return "contenteditable";
    if (element.getAttribute("role") === "textbox") return "textbox";
    return "editable";
  }

  function scoreEditableCandidate(element, options = {}) {
    if (!isSupportedEditable(element) || !isVisibleElement(element)) return -1;
    const preferredRole = String(options.preferredRole || "").toLowerCase();
    const preferredKind = String(options.preferredKind || "").toLowerCase();
    const sourceTool = String(options.sourceTool || detectSourceTool() || "").toLowerCase();
    const role = inferFieldRole(element, editableKind(element));
    const signal = fieldSignal(element).toLowerCase();
    let score = 0;

    if (preferredRole && role === preferredRole) score += 120;
    if (preferredKind === "document_surface" && ["prompt", "message", "body", "reply"].includes(role)) score += 70;
    if (/prompt|ask|question/.test(signal)) score += 45;
    if (/message|composer|chat|reply/.test(signal)) score += 35;
    if (/body|details|content|editor/.test(signal)) score += 20;
    if (sourceTool === "gemini" && /gemini|ask gemini/.test(signal)) score += 45;
    if (sourceTool === "chatgpt" && /chatgpt|message/.test(signal)) score += 35;
    if (sourceTool === "claude" && /claude|message/.test(signal)) score += 35;
    if (element.getAttribute("role") === "textbox") score += 20;
    if (element.isContentEditable) score += 20;
    if (!normalizeInlineText(getEditableText(element), 200)) score += 5;
    return score;
  }

  function findBestVisibleEditableCandidate(options = {}) {
    const root = options.root || document;
    return querySelectorAllDeep(root, editableSelector())
      .filter(candidate => isSupportedEditable(candidate) && isVisibleElement(candidate))
      .map(candidate => ({
        element: candidate,
        score: scoreEditableCandidate(candidate, options),
      }))
      .filter(entry => entry.score >= 0)
      .sort((left, right) => right.score - left.score)[0]?.element || null;
  }

  function resolveDocumentSurfaceEditable(surface, options = {}) {
    if (!surface || !isNodeInDocument(surface)) return null;
    return findBestVisibleEditableCandidate({
      ...options,
      root: surface,
      preferredKind: options.preferredKind || "document_surface",
    });
  }

  function describeField(element, options = {}) {
    const kind = options.kind || editableKind(element);
    const text = getEditableText(element);
    return {
      role: inferFieldRole(element, kind),
      kind,
      label: normalizeInlineText(fieldSignal(element), 240),
      name: normalizeInlineText(element?.getAttribute?.("name"), 120) || null,
      id: normalizeInlineText(element?.id, 120) || null,
      tagName: normalizeInlineText(element?.tagName, 40).toLowerCase() || null,
      placeholder: normalizeInlineText(element?.getAttribute?.("placeholder"), 180) || null,
      text: normalizeInlineText(text, 1200),
      isEmpty: !normalizeInlineText(text, 1200),
      isFocused: options.isFocused === true,
    };
  }

  function isVisibleElement(element) {
    if (!element || !isNodeInDocument(element)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getRelatedEditableFields(focusedElement) {
    if (!focusedElement) return [];
    const rootNode = typeof focusedElement.getRootNode === "function" ? focusedElement.getRootNode() : document;
    const host = rootNode?.host || null;
    const root = focusedElement.closest?.("form, [role='form'], [aria-label*='composer' i], [aria-label*='compose' i], main, article") ||
      host?.closest?.("form, [role='form'], [aria-label*='composer' i], [aria-label*='compose' i], main, article") ||
      host ||
      document.body;
    const fields = querySelectorAllDeep(root, editableSelector())
      .filter(element => isSupportedEditable(element) && isVisibleElement(element))
      .slice(0, 8);

    if (!fields.includes(focusedElement) && isSupportedEditable(focusedElement)) {
      fields.unshift(focusedElement);
    }

    return fields.map(element => describeField(element, {
      isFocused: element === focusedElement,
    }));
  }

  function dispatchEditableEvents(element) {
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function insertIntoInputLike(element, text) {
    const value = String(element.value || "");
    const start = Number.isFinite(element.selectionStart) ? element.selectionStart : value.length;
    const end = Number.isFinite(element.selectionEnd) ? element.selectionEnd : start;
    element.value = `${value.slice(0, start)}${text}${value.slice(end)}`;
    const cursor = start + text.length;
    if (typeof element.setSelectionRange === "function") {
      element.setSelectionRange(cursor, cursor);
    }
    dispatchEditableEvents(element);
  }

  function insertIntoContentEditable(element, text) {
    element.focus();
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && element.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const textNode = document.createTextNode(text);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      element.appendChild(document.createTextNode(text));
    }
    dispatchEditableEvents(element);
  }

  function dispatchTextInputFallback(element, text) {
    if (typeof InputEvent === "function") {
      const beforeInputEvent = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: "insertText",
        data: text,
      });
      if (!element.dispatchEvent(beforeInputEvent)) return true;
    }

    const dataTransfer = typeof DataTransfer === "function" ? new DataTransfer() : null;
    if (dataTransfer) {
      dataTransfer.setData("text/plain", text);
      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: dataTransfer,
      });
      if (!element.dispatchEvent(pasteEvent)) return true;
    }

    return false;
  }

  function insertIntoDocumentSurface(element, text) {
    const beforeText = getEditableText(element);
    if (typeof element.focus === "function") element.focus();

    const canUseSelectionInsertion = element.isContentEditable || element.getAttribute("role") === "textbox";
    if (canUseSelectionInsertion && document.queryCommandSupported?.("insertText") && document.execCommand?.("insertText", false, text)) {
      dispatchEditableEvents(element);
      return true;
    }

    const handledByEditor = dispatchTextInputFallback(element, text);
    const afterText = getEditableText(element);
    if (handledByEditor || afterText !== beforeText) {
      dispatchEditableEvents(element);
      return true;
    }
    return false;
  }

  function insertIntoResolvedEditable(element, text) {
    if (!element) return false;
    if (typeof element.focus === "function") element.focus();
    if ("value" in element) {
      insertIntoInputLike(element, text);
      return true;
    }
    insertIntoContentEditable(element, text);
    return true;
  }

  function insertContext(text, targetHint = null) {
    const target = findTargetFromHint(targetHint) || getInsertionTarget();
    if (!target) {
      return { success: false, error: "No focused supported input found." };
    }
    const normalizedText = String(text || "");
    if (!normalizedText.trim()) {
      return { success: false, error: "No context text provided." };
    }
    const element = target.element;
    if (typeof element.focus === "function") element.focus();
    if (target.kind === "editable") {
      insertIntoResolvedEditable(element, normalizedText);
    } else if (!insertIntoDocumentSurface(element, normalizedText)) {
      const fallbackEditable = resolveDocumentSurfaceEditable(element, {
        preferredRole: targetHint?.focusedField?.role,
        preferredKind: targetHint?.focusedTargetKind || target.kind,
      });
      if (fallbackEditable && insertIntoResolvedEditable(fallbackEditable, normalizedText)) {
        return {
          success: true,
          insertedLength: normalizedText.length,
          focusedInputText: getEditableText(fallbackEditable),
        };
      }
      return {
        success: false,
        error: "The focused document surface did not accept insertion. Click inside the document and try again.",
      };
    }
    return {
      success: true,
      insertedLength: normalizedText.length,
      focusedInputText: getEditableText(element),
    };
  }

  function detectSourceTool() {
    const extractorTool = window.EnhancivityMemoryLayerExtractors?.detectSourceTool?.();
    if (extractorTool) return extractorTool;
    const forcedTool = document.documentElement?.dataset?.memoryLayerTool ||
      document.querySelector('meta[name="enhancivity-memory-tool"]')?.getAttribute("content");
    if (forcedTool) return truncate(forcedTool, 80).toLowerCase();
    const host = location.hostname.replace(/^www\./, "");
    const titleSignal = truncate(document.title || "", 200).toLowerCase();
    if ((host === "google.com" || host.endsWith(".google.com")) && /[?&]udm=50(?:[&#]|$)/.test(location.search || "")) {
      return "google_ai_mode";
    }
    if ((host === "google.com" || host.endsWith(".google.com")) && /\bgoogle ai mode\b|\bai mode\b/.test(titleSignal)) {
      return "google_ai_mode";
    }
    if (host.includes("chatgpt.com") || host.includes("chat.openai.com")) return "chatgpt";
    if (host.includes("claude.ai")) return "claude";
    if (host.includes("gemini.google.com")) return "gemini";
    if (host.includes("gamma.app")) return "gamma";
    if (host.includes("mail.google.com")) return "gmail";
    if (host.includes("slack.com")) return "slack";
    if (host.includes("notion.so")) return "notion";
    if (host.includes("figma.com")) return "figma";
    if (host.includes("canva.com")) return "canva";
    if (host.includes("github.com")) return "github";
    if (host.includes("linear.app")) return "linear";
    if (host.includes("docs.google.com")) return "google_docs";
    if (
      host.includes("word.cloud.microsoft") ||
      host.includes("word.office.com") ||
      host.includes("officeapps.live.com") ||
      (host.includes("microsoft.com") && /word|\.docx|document/i.test(document.title || ""))
    ) {
      return "microsoft_word";
    }
    if (/\bgoogle ai mode\b|\bai mode\b/.test(titleSignal)) return "google_ai_mode";
    if (/\bgamma\b/.test(titleSignal)) return "gamma";
    return host || "browser";
  }

  function getPageContext(userNote) {
    const target = getInsertionTarget();
    const focusedInputText = getEditableText(target?.element);
    const focusedField = target?.element
      ? describeField(target.element, {
          kind: target.kind === "document_surface" ? "document_surface" : editableKind(target.element),
          isFocused: true,
        })
      : null;
    const relatedFields = target?.kind === "editable" ? getRelatedEditableFields(target.element) : [];
    if (window.EnhancivityMemoryLayerExtractors?.buildPageContext) {
      return {
        ...window.EnhancivityMemoryLayerExtractors.buildPageContext({ userNote, focusedInputText, focusedField, relatedFields }),
        hasFocusedInput: !!target,
        focusedTargetKind: target?.kind || null,
        frameHasFocus: document.hasFocus(),
      };
    }
    return { sourceType: "browser_visible_context", sourceTool: detectSourceTool(), sourceUrl: location.href, pageTitle: document.title || "", focusedInputText, focusedField, relatedFields, userNote: String(userNote || ""), captureInstruction: String(userNote || ""), hasFocusedInput: !!target, focusedTargetKind: target?.kind || null, frameHasFocus: document.hasFocus() };
  }

  function truncate(value, limit) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function getInsertContext() {
    const pageContext = getPageContext("");
    return {
      sourceTool: truncate(pageContext.sourceTool || detectSourceTool(), 80),
      surfaceType: truncate(pageContext.surfaceType, 80),
      surfaceCapabilities: Array.isArray(pageContext.surfaceCapabilities)
        ? pageContext.surfaceCapabilities.map(value => truncate(value, 80)).filter(Boolean).slice(0, 12)
        : [],
      capabilityHints: pageContext.capabilityHints && typeof pageContext.capabilityHints === "object"
        ? {
            interactionMode: truncate(pageContext.capabilityHints.interactionMode, 80),
            resultExpectation: truncate(pageContext.capabilityHints.resultExpectation, 80),
            memoryDetailHint: truncate(pageContext.capabilityHints.memoryDetailHint, 80),
          }
        : null,
      sourceUrl: truncate(pageContext.sourceUrl || location.href, 500),
      pageTitle: truncate(pageContext.pageTitle || document.title || "", 200),
      selectedText: truncate(pageContext.selectedText, 2000),
      focusedInputText: truncate(pageContext.focusedInputText, 1200),
      visibleText: truncate(pageContext.visibleText, 3000),
      toolSpecificContext: pageContext.toolSpecificContext || {},
      focusedField: pageContext.focusedField || null,
      relatedFields: Array.isArray(pageContext.relatedFields) ? pageContext.relatedFields.slice(0, 8) : [],
      hasFocusedInput: pageContext.hasFocusedInput === true,
      focusedTargetKind: pageContext.focusedTargetKind || null,
      frameHasFocus: pageContext.frameHasFocus === true,
    };
  }

  document.addEventListener("focusin", rememberEditableFromEvent, true);
  document.addEventListener("pointerdown", rememberEditableFromEvent, true);
  document.addEventListener("keyup", rememberEditableFromEvent, true);

  function handleMessage(message) {
    if (!message || typeof message !== "object") return false;

    if (message.type === "MEMORY_LAYER_PING") {
      const target = getInsertionTarget();
      return {
        success: true,
        sourceTool: detectSourceTool(),
        hasFocusedInput: !!target,
        focusedInputText: getEditableText(target?.element),
        focusedTargetKind: target?.kind || null,
        frameHasFocus: document.hasFocus(),
      };
    }

    if (message.type === "MEMORY_LAYER_GET_PAGE_CONTEXT") {
      return { success: true, context: getPageContext(message.userNote) };
    }

    if (message.type === "MEMORY_LAYER_GET_INSERT_CONTEXT") {
      return { success: true, context: getInsertContext() };
    }

    if (message.type === "MEMORY_LAYER_INSERT_CONTEXT") {
      return insertContext(message.text, message.targetHint);
    }

    return false;
  }

  window.EnhancivityMemoryLayerContent = {
    handleMessage,
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const response = handleMessage(message);
    if (response === false) return false;
    sendResponse(response);
    return true;
  });
})();
