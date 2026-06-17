(function initEnhancivityMemoryLayerExtractors() {
  if (window.EnhancivityMemoryLayerExtractors) return;

  function normalizeText(value, limit = 3000) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function isKeyboardShortcutArtifact(value) {
    const text = normalizeText(value, 120).toLowerCase();
    if (!text || text.length > 80) return false;
    if (!/(ctrl|control|shift|alt|option|cmd|command|meta|win|windows|fn|⌘|⌥|⇧)/i.test(text)) return false;
    const tokens = text
      .replace(/[()[\]{}]/g, " ")
      .replace(/[+]/g, " ")
      .replace(/[–—]/g, "-")
      .split(/[\s/\\-]+/)
      .map(token => token.trim())
      .filter(Boolean);
    const known = new Set([
      "ctrl", "control", "shift", "alt", "option", "cmd", "command", "meta", "win", "windows", "fn",
      "esc", "escape", "enter", "return", "tab", "space", "backspace", "delete", "del",
      "home", "end", "pageup", "pagedown", "page", "up", "down", "left", "right",
      "plus", "minus", "hyphen", "dash", "period", "comma",
    ]);
    return tokens.length > 0 && tokens.every(token => known.has(token) || /^[a-z0-9]$/.test(token));
  }

  function isNoisyExtractedText(value) {
    return isKeyboardShortcutArtifact(value);
  }

  function detectSourceTool() {
    const forcedTool = document.documentElement?.dataset?.memoryLayerTool ||
      document.querySelector('meta[name="enhancivity-memory-tool"]')?.getAttribute("content");
    if (forcedTool) return normalizeText(forcedTool, 80).toLowerCase();

    const host = location.hostname.replace(/^www\./, "");
    const titleSignal = normalizeText(document.title || "", 200).toLowerCase();
    const urlSignal = `${location.pathname || ""} ${location.search || ""}`.toLowerCase();
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
    if (host.includes("reddit.com")) return "reddit";
    if (
      host.includes("word.cloud.microsoft") ||
      host.includes("word.office.com") ||
      host.includes("officeapps.live.com") ||
      (host.includes("microsoft.com") && /word|\.docx|document/i.test(document.title || ""))
    ) {
      return "microsoft_word";
    }
    if (/\bgoogle ai mode\b|\bai mode\b/.test(titleSignal) || /\budm=50\b/.test(urlSignal)) return "google_ai_mode";
    if (/\bgamma\b/.test(titleSignal)) return "gamma";
    return host || "browser";
  }

  function getSelectedText() {
    return normalizeText(window.getSelection?.().toString() || "", 8000);
  }

  function elementContextSignal(element) {
    return [
      element?.tagName,
      element?.getAttribute?.("role"),
      element?.getAttribute?.("aria-label"),
      element?.getAttribute?.("data-testid"),
      element?.getAttribute?.("data-qa"),
      element?.id,
      element?.className,
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function isSkippableVisibleTextElement(element) {
    let current = element;
    let depth = 0;
    while (current && current !== document.body && depth < 8) {
      const tagName = current.tagName?.toLowerCase();
      if (["nav", "aside", "header", "footer"].includes(tagName)) return true;
      const signal = elementContextSignal(current);
      if (/(sidebar|side.?nav|navigation|chat history|conversation list|recent chats|account menu|toolbar|menubar|breadcrumb)/.test(signal)) {
        return true;
      }
      current = current.parentElement;
      depth += 1;
    }
    return false;
  }

  // Item 7 (extension side): grab generously by character; the BACKEND token budget
  // is the real single source of truth. This is the cheap client-side ceiling.
  const VISIBLE_TEXT_CHAR_BUDGET = 12000;
  // Bound the DOM walk so a huge/virtualized page cannot stall the capture (no agent
  // behavior, no scrolling — we only read what is already mounted).
  const MAX_WALK_ELEMENTS = 20000;
  const MAX_TEXT_CHUNKS = 4000;

  function isHiddenElement(element) {
    const view = (element.ownerDocument && element.ownerDocument.defaultView) || window;
    const style = view.getComputedStyle(element);
    return !style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0;
  }

  // Item 9: walk the mounted DOM in document order, descending into OPEN shadow roots
  // and SAME-ORIGIN iframes (cross-origin frames are skipped gracefully). Returns
  // cleaned text chunks with their vertical position in top-window coordinates.
  function collectVisibleTextChunks() {
    const chunks = [];
    const counters = { elements: 0 };

    const visit = (node, offsetY) => {
      if (!node || chunks.length >= MAX_TEXT_CHUNKS || counters.elements >= MAX_WALK_ELEMENTS) return;
      const childNodes = node.childNodes || [];
      for (const child of childNodes) {
        if (chunks.length >= MAX_TEXT_CHUNKS || counters.elements >= MAX_WALK_ELEMENTS) return;

        if (child.nodeType === Node.TEXT_NODE) {
          const text = normalizeText(child.nodeValue, 1000);
          if (!text || isNoisyExtractedText(text)) continue;
          const parent = child.parentElement || node.host || null;
          if (!parent || isSkippableVisibleTextElement(parent) || isHiddenElement(parent)) continue;
          const rect = parent.getBoundingClientRect();
          if (!rect || (rect.width === 0 && rect.height === 0)) continue;
          chunks.push({ text, top: rect.top + offsetY, bottom: rect.bottom + offsetY });
          continue;
        }

        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        counters.elements += 1;

        // Open shadow root shares the top document's layout -> same offset.
        if (child.shadowRoot) visit(child.shadowRoot, offsetY);

        if (child.tagName === "IFRAME") {
          try {
            const doc = child.contentDocument;
            if (doc && doc.body) {
              const frameRect = child.getBoundingClientRect();
              visit(doc.body, offsetY + frameRect.top);
            }
          } catch (_error) {
            // Cross-origin iframe: inaccessible by design. Skip without erroring.
          }
        }

        visit(child, offsetY);
      }
    };

    visit(document.body || document.documentElement, 0);
    return chunks;
  }

  // Item 8: anchor on the visible region and expand outward roughly equally up and
  // down, accumulating cleaned text up to the budget. If one side runs out of mounted
  // content first, the remaining budget is spent on the other side. Mounted DOM only;
  // no scrolling, no automation. boundedByDom is true when there was more mounted (or
  // scrollable) content than we could include, so the UI can offer an honest note.
  function getVisibleRegion(budget = VISIBLE_TEXT_CHAR_BUDGET) {
    const chunks = collectVisibleTextChunks();
    if (chunks.length === 0) return { text: "", boundedByDom: false };

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const inView = [];
    const above = []; // entirely above the viewport, document order
    const below = []; // entirely below the viewport, document order
    for (const chunk of chunks) {
      if (chunk.bottom < 0) above.push(chunk);
      else if (chunk.top > viewportHeight) below.push(chunk);
      else inView.push(chunk);
    }
    above.reverse(); // nearest-to-viewport first

    const selected = new Set();
    let used = 0;
    let bounded = false;
    const add = chunk => {
      if (!chunk || selected.has(chunk)) return true;
      if (used + chunk.text.length + 1 > budget) {
        bounded = true;
        return false;
      }
      selected.add(chunk);
      used += chunk.text.length + 1;
      return true;
    };

    for (const chunk of inView) {
      if (!add(chunk)) break;
    }

    let upIndex = 0;
    let downIndex = 0;
    while ((upIndex < above.length || downIndex < below.length) && !bounded) {
      if (downIndex < below.length && !add(below[downIndex++])) break;
      if (bounded) break;
      if (upIndex < above.length && !add(above[upIndex++])) break;
    }
    if (upIndex < above.length || downIndex < below.length) bounded = true;

    const scrollHeight = (document.documentElement && document.documentElement.scrollHeight) || 0;
    const scrollable = scrollHeight > viewportHeight + 200;
    const text = chunks
      .filter(chunk => selected.has(chunk))
      .map(chunk => chunk.text)
      .join("\n")
      .slice(0, budget);
    return { text, boundedByDom: bounded || scrollable };
  }

  function getVisibleText() {
    return getVisibleRegion(VISIBLE_TEXT_CHAR_BUDGET).text;
  }

  function uniqueElements(selectors) {
    const seen = new Set();
    const elements = [];
    selectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(element => {
        if (!seen.has(element)) {
          seen.add(element);
          elements.push(element);
        }
      });
    });
    return elements.sort((a, b) => {
      if (a === b) return 0;
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1;
    });
  }

  function roleFromElement(element, fallback = "unknown") {
    const explicitRole =
      element.getAttribute("data-message-author-role") ||
      element.getAttribute("data-role") ||
      element.getAttribute("data-author") ||
      element.getAttribute("aria-label") ||
      element.getAttribute("data-testid") ||
      element.className ||
      fallback;
    const normalized = String(explicitRole).toLowerCase();
    if (/(assistant|model|response|answer|claude|gemini)/.test(normalized)) return "assistant";
    if (/(user|human|query|prompt|request)/.test(normalized)) return "user";
    return fallback;
  }

  // Item 8: instead of "last N turns by recency", anchor turn selection on the
  // viewport and expand outward symmetrically, so we keep the turns the user is
  // actually looking at plus equal context above and below. Falls back to the most
  // recent turns only when nothing is currently in view.
  function selectViewportAnchoredTurns(turns, max) {
    if (turns.length <= max) return turns;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const positioned = turns.map((turn, index) => {
      let top = Infinity;
      let bottom = Infinity;
      try {
        const rect = turn.element.getBoundingClientRect();
        top = rect.top;
        bottom = rect.bottom;
      } catch (_error) { /* detached node: treat as off-screen */ }
      return { index, top, bottom };
    });
    const inView = positioned.filter(turn => turn.bottom >= 0 && turn.top <= viewportHeight);
    if (inView.length === 0) return turns.slice(-max);

    const selected = new Set();
    const low = Math.min(...inView.map(turn => turn.index));
    const high = Math.max(...inView.map(turn => turn.index));
    for (let i = low; i <= high && selected.size < max; i += 1) selected.add(i);
    let up = low - 1;
    let down = high + 1;
    while (selected.size < max && (up >= 0 || down < turns.length)) {
      if (down < turns.length && selected.size < max) selected.add(down++);
      if (up >= 0 && selected.size < max) selected.add(up--);
    }
    return [...selected].sort((a, b) => a - b).map(index => turns[index]);
  }

  function extractTurnsFromSelectors(selectors, fallbackRole = "unknown") {
    const turns = uniqueElements(selectors)
      .map(element => ({
        element,
        role: roleFromElement(element, fallbackRole),
        text: normalizeText(element.textContent, 3000),
      }))
      .filter(turn => turn.text);
    return selectViewportAnchoredTurns(turns, 12).map(turn => ({ role: turn.role, text: turn.text }));
  }

  function extractChatGptTurns() {
    return extractTurnsFromSelectors([
      "[data-message-author-role]",
      "[data-testid^='conversation-turn'] [data-message-author-role]",
      "[data-testid^='conversation-turn']",
      "article",
    ]);
  }

  function extractClaudeTurns() {
    const explicitTurns = extractTurnsFromSelectors([
      "[data-testid='user-message']",
      "[data-testid='assistant-message']",
      "[data-testid*='user-message']",
      "[data-testid*='assistant-message']",
      "[class*='font-claude-message']",
      "[class*='claude-message']",
      "[data-role='user']",
      "[data-role='assistant']",
    ]);
    if (explicitTurns.length) return explicitTurns;
    return extractTurnsFromSelectors(["article", "[class*='message']"]);
  }

  function extractGeminiTurns() {
    const explicitTurns = extractTurnsFromSelectors([
      "[data-testid='user-query']",
      "[data-testid='model-response']",
      "[data-test-id='user-query']",
      "[data-test-id='model-response']",
      "user-query",
      "model-response",
      "[data-role='user']",
      "[data-role='assistant']",
    ]);
    if (explicitTurns.length) return explicitTurns;
    return extractTurnsFromSelectors(["article", "[class*='query']", "[class*='response']"]);
  }

  function extractConversationTurns(tool = detectSourceTool()) {
    if (tool === "chatgpt") return extractChatGptTurns();
    if (tool === "claude") return extractClaudeTurns();
    if (tool === "gemini") return extractGeminiTurns();
    return [];
  }

  function inferSurfaceCapabilities(options = {}) {
    const sourceTool = normalizeText(options.sourceTool, 80).toLowerCase();
    const focusedInputText = normalizeText(options.focusedInputText, 1200);
    const focusedField = options.focusedField && typeof options.focusedField === "object" ? options.focusedField : null;
    const relatedFields = Array.isArray(options.relatedFields) ? options.relatedFields : [];
    const visibleText = normalizeText(options.visibleText, 4000);
    const conversationTurns = Array.isArray(options.conversationTurns) ? options.conversationTurns : [];
    const signal = normalizeText([
      sourceTool,
      location.hostname,
      location.pathname,
      document.title,
      editableSignalText(),
      focusedInputText,
      focusedField?.role,
      focusedField?.label,
      ...relatedFields.flatMap(field => [field?.role, field?.label, field?.text]),
      visibleText,
      ...conversationTurns.slice(-4).flatMap(turn => [turn?.role, turn?.text]),
    ].filter(Boolean).join(" "), 12000).toLowerCase();

    const capabilities = [];
    const add = capability => {
      if (capability && !capabilities.includes(capability)) capabilities.push(capability);
    };

    if (["chatgpt", "claude", "gemini", "google_ai_mode"].includes(sourceTool)) add("ai_chat_prompting");
    if (["figma", "canva"].includes(sourceTool)) add("design_iteration");
    if (sourceTool === "gmail") add("email_drafting");
    if (sourceTool === "slack") add("team_reply");
    if (["github", "linear"].includes(sourceTool)) add("implementation_guidance");
    if (sourceTool === "gamma") {
      add("presentation_generation");
      add("document_drafting");
      add("structured_generation");
    }
    if (["notion", "google_docs", "microsoft_word"].includes(sourceTool)) add("document_drafting");
    if (sourceTool === "google_ai_mode") {
      add("live_web_research");
      add("source_backed_answering");
    }

    if (/(chatgpt|claude|gemini|assistant|ask anything|conversation|model response|ai mode|copilot)/.test(signal)) {
      add("ai_chat_prompting");
    }
    if (/(latest web|web results|cited sources|citations|source cards|sources|source collection|current public|search the web|research workspace|ai overview|browse results|compare products)/.test(signal)) {
      add("live_web_research");
      add("source_backed_answering");
      add("ai_chat_prompting");
    }
    if (/(presentation|slides?|slide deck|deck|pitch deck|storyboard|generate outline|presentation editor|speaker notes)/.test(signal)) {
      add("presentation_generation");
      add("document_drafting");
      add("structured_generation");
    }
    if (/(document|draft|outline|brief|editor|page|write|rewrite|summarize)/.test(signal)) {
      add("document_drafting");
    }
    if (/(design|mockup|wireframe|prototype|hero section|brand|logo|\bui\b|\bux\b|figma|canva)/.test(signal)) {
      add("design_iteration");
      add("structured_generation");
    }
    if (/(implementation|code|repository|github|pull request|bug|fix|architecture|engineering|ship)/.test(signal)) {
      add("implementation_guidance");
    }
    if (/(email|reply|subject|recipient|inbox|compose email|sender)/.test(signal)) {
      add("email_drafting");
    }
    if (/(slack|team chat|channel|thread reply|message composer|reply in thread)/.test(signal)) {
      add("team_reply");
    }

    return capabilities;
  }

  function inferInteractionMode(surfaceCapabilities = [], conversationTurns = []) {
    const capabilities = new Set(Array.isArray(surfaceCapabilities) ? surfaceCapabilities : []);
    if (capabilities.has("live_web_research")) return "source_backed_research";
    if (capabilities.has("presentation_generation") || capabilities.has("structured_generation")) return "structured_generation";
    if (capabilities.has("ai_chat_prompting") || (Array.isArray(conversationTurns) && conversationTurns.length >= 2)) {
      return "iterative_chat";
    }
    return "single_prompt";
  }

  function inferResultExpectation(surfaceCapabilities = []) {
    const capabilities = new Set(Array.isArray(surfaceCapabilities) ? surfaceCapabilities : []);
    if (capabilities.has("presentation_generation")) return "presentation";
    if (capabilities.has("live_web_research")) return "comparison_or_research_answer";
    if (capabilities.has("design_iteration")) return "design_concept";
    if (capabilities.has("implementation_guidance")) return "implementation_help";
    if (capabilities.has("email_drafting")) return "reply_draft";
    if (capabilities.has("team_reply")) return "team_message";
    if (capabilities.has("document_drafting")) return "document_draft";
    return "general_assistance";
  }

  function inferMemoryDetailHint(surfaceCapabilities = []) {
    const capabilities = new Set(Array.isArray(surfaceCapabilities) ? surfaceCapabilities : []);
    if (capabilities.has("implementation_guidance")) return "high";
    if (capabilities.has("live_web_research") || capabilities.has("presentation_generation") || capabilities.has("design_iteration")) {
      return "medium";
    }
    if (capabilities.has("email_drafting") || capabilities.has("team_reply")) return "low";
    return "medium";
  }

  function activeEditable() {
    const active = document.activeElement;
    if (!active || active.nodeType !== Node.ELEMENT_NODE) return null;
    if (
      active.tagName?.toLowerCase() === "textarea" ||
      active.tagName?.toLowerCase() === "input" ||
      active.isContentEditable ||
      active.getAttribute("role") === "textbox"
    ) {
      return active;
    }
    return null;
  }

  function editableSignalText() {
    const editable = activeEditable();
    if (!editable) return "";
    return normalizeText([
      editable.getAttribute("aria-label"),
      editable.getAttribute("placeholder"),
      editable.getAttribute("name"),
      editable.getAttribute("data-qa"),
      editable.getAttribute("data-testid"),
      editable.className,
      editable.id,
    ].filter(Boolean).join(" "), 1000).toLowerCase();
  }

  function firstText(selectors, limit = 1000) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const text = normalizeText(element?.textContent || element?.getAttribute?.("aria-label") || "", limit);
      if (text && !isNoisyExtractedText(text)) return text;
    }
    return "";
  }

  function elementText(element, limit = 1000, includeLabels = false) {
    const labelText = includeLabels
      ? [
          element.getAttribute?.("aria-label"),
          element.getAttribute?.("alt"),
          element.getAttribute?.("title"),
        ].filter(Boolean).join(" ")
      : "";
    return normalizeText([labelText, element.textContent || ""].filter(Boolean).join(" "), limit);
  }

  function textsFromSelectors(selectors, limit = 2400, includeLabels = false) {
    return uniqueElements(selectors)
      .map(element => elementText(element, 1000, includeLabels))
      .filter(text => text && !isNoisyExtractedText(text))
      .join("\n")
      .slice(0, limit);
  }

  function stripQuotedEmailText(text) {
    return normalizeText(String(text || "").replace(/On .+ wrote:.+$/is, ""), 2000);
  }

  function extractGmailContext(focusedInputText = "") {
    const senderElement = document.querySelector(".gD[email], [email].gD, [data-hovercard-id]");
    const senderLabel = normalizeText(
      senderElement?.getAttribute?.("email") ||
      senderElement?.getAttribute?.("data-hovercard-id") ||
      senderElement?.textContent ||
      "",
      200
    );
    return {
      emailSubject: firstText([".hP", "[data-thread-perm-id] h2", "h1", "h2"], 200),
      emailFrom: senderLabel,
      emailTo: firstText([".hb .g2", "[aria-label*='To:']", "[email][name='to']"], 300),
      emailBody: textsFromSelectors([".a3s", ".ii.gt", "[role='listitem'] .a3s", "[data-message-id]"], 2200),
      focusedReplyText: stripQuotedEmailText(focusedInputText),
    };
  }

  function extractGenericEmailContext(focusedInputText = "") {
    const labelText = editableSignalText();
    const subject = firstText([
      "[aria-label*='Subject']",
      "[placeholder*='Subject']",
      "[name*='subject' i]",
      "h1",
      "h2",
    ], 200);
    return {
      emailSubject: subject,
      emailFrom: firstText(["[data-sender]", "[class*='sender' i]", "[class*='from' i]", "[aria-label*='From']"], 200),
      emailTo: firstText(["[data-recipient]", "[class*='recipient' i]", "[class*='to' i]", "[aria-label*='To']"], 300),
      emailBody: textsFromSelectors(["[class*='message' i]", "[class*='email' i]", "article", "main"], 2200),
      focusedReplyText: stripQuotedEmailText(focusedInputText),
      inputSignal: labelText,
    };
  }

  function extractTeamChatContext() {
    return {
      teamChannel: firstText([
        "[data-qa='channel_name']",
        "[data-qa='channel_name_button']",
        "[aria-label*='Channel']",
        "[class*='channel' i]",
        "h1",
      ], 120),
      teamThread: textsFromSelectors([
        "[data-qa='message_content']",
        ".c-message_kit__text",
        "[data-qa='virtual-list-item']",
        "[role='listitem']",
        "[class*='message' i]",
      ], 2200),
    };
  }

  function extractDocumentContext(focusedInputText = "", surfaceCapabilities = []) {
    const capabilities = new Set(Array.isArray(surfaceCapabilities) ? surfaceCapabilities : []);
    const documentContext = firstText([
      "[contenteditable='true']",
      "[role='textbox']",
      "[role='document']",
      "[aria-label*='document' i]",
      "[aria-label*='editor' i]",
      "article",
      "main",
    ], 1600);
    const currentSurfaceContext = capabilities.has("presentation_generation")
      ? "Presentation generation surface for building slide decks, outlines, and narrative structure."
      : capabilities.has("document_drafting")
        ? "Document drafting surface for creating or revising structured written content."
        : null;
    return {
      documentPrompt: normalizeText(focusedInputText, 1200),
      documentContext,
      currentSurfaceContext,
    };
  }

  function extractDesignContext(focusedInputText = "") {
    const designConversation = textsFromSelectors([
      "[data-testid*='message' i]",
      "[data-testid*='chat' i]",
      "[data-test-id*='message' i]",
      "[data-test-id*='chat' i]",
      "[class*='message' i]",
      "[class*='chat' i]",
      "article",
    ], 3200, true);
    const designCurrentState = textsFromSelectors([
      "[data-testid*='generated' i]",
      "[data-testid*='result' i]",
      "[data-testid*='design' i]",
      "[data-test-id*='generated' i]",
      "[data-test-id*='result' i]",
      "[data-test-id*='design' i]",
      "[aria-label*='generated' i]",
      "[aria-label*='design' i]",
      "[class*='generated' i]",
      "[class*='result' i]",
      "[class*='design' i]",
      "figure",
      "[role='img']",
    ], 2200, true);

    return {
      designPrompt: normalizeText(focusedInputText, 1200),
      designConversation,
      designCurrentState,
      currentSurfaceContext: normalizeText([designConversation, designCurrentState].filter(Boolean).join("\n"), 3600),
    };
  }

  function inferAiMode(options = {}) {
    const tool = options.tool;
    const conversationTurns = Array.isArray(options.conversationTurns) ? options.conversationTurns : [];
    const surfaceCapabilities = Array.isArray(options.surfaceCapabilities) ? options.surfaceCapabilities : [];
    if (!["chatgpt", "claude", "gemini", "google_ai_mode"].includes(tool) && !surfaceCapabilities.includes("ai_chat_prompting")) {
      return null;
    }

    const explicitMode = String(document.documentElement?.dataset?.memoryLayerAiMode || "").trim().toLowerCase();
    if (explicitMode === "deep_research" || explicitMode === "chat") {
      return explicitMode;
    }

    const signal = [
      location.pathname,
      document.title,
      ...conversationTurns.slice(-2).map(turn => turn?.text || ""),
      firstText(["main", "article", "[role='main']"], 1200),
    ].join(" ").toLowerCase();

    if (/(deep research|research mode|research plan|source collection|research report)/.test(signal)) {
      return "deep_research";
    }

    if (surfaceCapabilities.includes("live_web_research")) return "chat";
    return "chat";
  }

  function extractAiChatContext(options = {}) {
    const latestUserPrompt = normalizeText(options.latestUserTurn?.text || "", 1200);
    const latestAssistantAnswer = normalizeText(options.latestAssistantTurn?.text || "", 1600);
    const surfaceCapabilities = Array.isArray(options.surfaceCapabilities) ? options.surfaceCapabilities : [];
    const aiMode = options.aiMode || inferAiMode({
      tool: options.tool,
      conversationTurns: options.conversationTurns || [],
      surfaceCapabilities,
    });
    const currentSurfaceContext = surfaceCapabilities.includes("live_web_research")
      ? "AI research surface with live web results, citations, and current-information answering."
      : surfaceCapabilities.includes("source_backed_answering")
        ? "AI answer surface that uses cited sources and external references."
        : aiMode === "deep_research"
          ? "Deep research mode with source collection and a research plan."
          : "Standard AI chat conversation.";
    return {
      aiMode: aiMode || null,
      conversationTitle: normalizeText(document.title || "", 200),
      latestUserPrompt,
      latestAssistantAnswer,
      currentSurfaceContext,
    };
  }

  function inferSurfaceType(tool, focusedInputText = "", focusedField = null, relatedFields = [], surfaceCapabilities = []) {
    if (tool === "gmail") return "email";
    if (tool === "slack") return "team_chat";
    const capabilities = new Set(Array.isArray(surfaceCapabilities) ? surfaceCapabilities : []);
    if (["figma", "canva"].includes(tool)) return "design";
    if (["github", "linear"].includes(tool)) return "engineering";
    if (tool === "google_ai_mode") return "ai_chat";
    if (["gamma", "notion", "google_docs", "microsoft_word"].includes(tool)) return "document";
    if (["chatgpt", "claude", "gemini"].includes(tool)) return "ai_chat";

    if (capabilities.has("email_drafting")) return "email";
    if (capabilities.has("team_reply")) return "team_chat";
    if (capabilities.has("design_iteration")) return "design";
    if (capabilities.has("implementation_guidance")) return "engineering";
    if (capabilities.has("presentation_generation") || capabilities.has("document_drafting")) return "document";
    if (capabilities.has("ai_chat_prompting") || capabilities.has("live_web_research") || capabilities.has("source_backed_answering")) {
      return "ai_chat";
    }

    const signal = [
      tool,
      location.hostname,
      document.title,
      editableSignalText(),
      focusedInputText,
      focusedField?.role,
      focusedField?.label,
      ...(Array.isArray(relatedFields) ? relatedFields.flatMap(field => [field.role, field.label]) : []),
    ].join(" ").toLowerCase();
    if (/(slack|teams|discord|team chat|channel|thread|message composer|reply in thread)/.test(signal)) return "team_chat";
    if (/(email|mail|inbox|compose email|email reply|subject|recipient|sender|message body)/.test(signal)) return "email";
    if (/(presentation|slides?|slide deck|deck|pitch deck|powerpoint|gamma)/.test(signal)) return "document";
    if (/(google ai mode|ai mode|web results|sources|research assistant|live web)/.test(signal)) return "ai_chat";
    if (/(chatgpt|claude|gemini|ai chat|assistant|model response)/.test(signal)) return "ai_chat";
    if (/(figma|\bcanva\b|design|\bui\b|\bux\b|logo|brand|mockup)/.test(signal)) return "design";
    if (/(notion|docs|document|editor|draft|outline|page)/.test(signal)) return "document";
    return "generic_work";
  }

  function extractToolSpecificContext(tool, focusedInputText = "", surfaceType = inferSurfaceType(tool, focusedInputText), options = {}) {
    const surfaceCapabilities = Array.isArray(options.surfaceCapabilities) ? options.surfaceCapabilities : [];
    if (tool === "gmail") return extractGmailContext(focusedInputText);
    if (surfaceType === "ai_chat") return extractAiChatContext({ ...options, tool, surfaceCapabilities });
    if (surfaceType === "email") return extractGenericEmailContext(focusedInputText);
    if (surfaceType === "team_chat") return extractTeamChatContext();
    if (surfaceType === "document") return extractDocumentContext(focusedInputText, surfaceCapabilities);
    if (surfaceType === "design") return extractDesignContext(focusedInputText);
    return {};
  }

  function buildPageContext(options = {}) {
    const sourceTool = detectSourceTool();
    const conversationTurns = extractConversationTurns(sourceTool);
    const latestUserTurn = [...conversationTurns].reverse().find(turn => turn.role === "user");
    const latestAssistantTurn = [...conversationTurns].reverse().find(turn => turn.role === "assistant");
    // Item 7: cap focusedInputText (previously uncapped on the extension side) to the
    // same generous client budget; the backend token cap remains the real limit.
    const focusedInputText = normalizeText(options.focusedInputText, VISIBLE_TEXT_CHAR_BUDGET);
    const focusedField = options.focusedField && typeof options.focusedField === "object" ? options.focusedField : null;
    const relatedFields = Array.isArray(options.relatedFields) ? options.relatedFields : [];
    const visibleRegion = getVisibleRegion(VISIBLE_TEXT_CHAR_BUDGET);
    const visibleText = visibleRegion.text;
    const surfaceCapabilities = inferSurfaceCapabilities({
      sourceTool,
      focusedInputText,
      focusedField,
      relatedFields,
      visibleText,
      conversationTurns,
    });
    const surfaceType = inferSurfaceType(sourceTool, focusedInputText, focusedField, relatedFields, surfaceCapabilities);
    const aiMode = inferAiMode({ tool: sourceTool, conversationTurns, surfaceCapabilities });
    const toolSpecificContext = extractToolSpecificContext(sourceTool, focusedInputText, surfaceType, {
      conversationTurns,
      latestUserTurn,
      latestAssistantTurn,
      aiMode,
      surfaceCapabilities,
    });

    return {
      sourceType: conversationTurns.length ? "ai_conversation_visible_context" : "browser_visible_context",
      sourceTool,
      surfaceType,
      surfaceCapabilities,
      capabilityHints: {
        interactionMode: inferInteractionMode(surfaceCapabilities, conversationTurns),
        resultExpectation: inferResultExpectation(surfaceCapabilities),
        memoryDetailHint: inferMemoryDetailHint(surfaceCapabilities),
      },
      sourceUrl: location.href,
      pageTitle: document.title || "",
      selectedText: getSelectedText(),
      focusedInputText,
      focusedField,
      relatedFields,
      visibleText,
      // Item 8: signals the capture was bounded by the mounted DOM (likely more
      // content above/below than the region around the user's view).
      visibleTextBoundedByDom: visibleRegion.boundedByDom === true,
      toolSpecificContext,
      userNote: String(options.userNote || ""),
      captureInstruction: String(options.captureInstruction || options.userNote || ""),
      conversationTitle: document.title || "",
      latestUserPrompt: latestUserTurn?.text || "",
      latestAssistantAnswer: latestAssistantTurn?.text || "",
      conversationTurns,
    };
  }

  window.EnhancivityMemoryLayerExtractors = {
    buildPageContext,
    detectSourceTool,
    extractConversationTurns,
    extractToolSpecificContext,
    inferSurfaceCapabilities,
    inferSurfaceType,
    getSelectedText,
    getVisibleText,
  };
})();
