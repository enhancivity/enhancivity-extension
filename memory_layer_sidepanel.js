(function initEnhancivityMemoryLayerPanel() {
  const MEMORY_TYPES = [
    "goal",
    "decision",
    "requirement",
    "note",
    "fact",
    "code_snippet",
    "design",
    "open_question",
    "status",
    "constraint",
  ];

  /** Dev-only: `chrome.storage.local.memoryLayerDevPrimaryAiWriter` → Prepare sends `primaryAiWriter: true` (explicit opt-in). */
  const STORAGE_DEV_PRIMARY_AI_WRITER = "memoryLayerDevPrimaryAiWriter";
  const DEFAULT_MEMORY_LAYER_API_BASE = "https://api.enhancivity.com";
  const MEMORY_LAYER_CAPTURE_SUBJECT_SEGMENTS = true;
  const SEGMENT_CAPTURE_THROTTLE_MS = 650;
  const MAX_CAPTURE_SEGMENTS = 4;

  function parseDevBooleanFlag(value) {
    if (value === true) return true;
    if (value === false || value == null) return false;
    if (typeof value === "string") {
      return ["true", "1", "yes"].includes(value.trim().toLowerCase());
    }
    return false;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function makeCapturePickId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

  const MEMORY_SCOPE_OPTIONS = [
    { value: "", label: "All project memory" },
    { value: "scope:project_overview", label: "Project overview" },
    { value: "scope:design_philosophy", label: "Design philosophy" },
    { value: "scope:marketing", label: "Marketing" },
    { value: "scope:technical_architecture", label: "Technical architecture" },
    { value: "scope:capture_system", label: "Capture system" },
    { value: "scope:prompt_preparation", label: "Prompt preparation" },
    { value: "scope:user_research", label: "User research" },
    { value: "scope:database_structure", label: "Database structure" },
  ];

  const state = {
    token: "",
    apiBase: DEFAULT_MEMORY_LAYER_API_BASE,
    user: null,
    awake: false,
    wakeRequested: false,
    activeTabId: null,
    activeFrameId: null,
    selectedProjectId: "",
    authMode: "login",
    hasStoredApiBase: false,
    projects: [],
    contextPack: null,
    lastInsertContext: null,
    lastPreparedInsertInstruction: "",
    lastContextPreparedAt: 0,
    lastInsertCompletedAt: 0,
    // Unit 3d (part 2/2) — the request + timestamp of the LAST inserted prepared prompt.
    // Sent as `priorInsert` on the next prepare so the backend can detect a re-request
    // (rephrasing a just-inserted task = negative evidence on that first output).
    lastInsert: null,
    // Unit 3f — the at-most-one prepared-prompt (delivery-stage) disclosure notice for the
    // current prepare (id + lint-clean copy + surface only).
    deliveryNotice: null,
    deliveryNoticeShownSession: false, // client one-per-session marker (§7.3)
    memoryScopeSelection: "",
    events: [],
    proposals: [],
    // Adaptive capture feedback: identity of the current proposal batch plus the
    // ORIGINAL (pre-edit) snapshot of each proposal, so the backend can diff what
    // the user saved against what was proposed. No UI of its own.
    captureSession: null,
    // Unit 2c — the at-most-one Tier-2 disclosure notice for the current review panel
    // (id + lint-clean copy + surface only; never any attribute internals). Null when the
    // backend returned none (notices off, nothing armed, or already shown this session).
    captureNotice: null,
    captureNoticeShownSession: false, // client one-per-session marker (§7.3)
    providerKeysStatus: {
      supportedProviders: ["enhancivity", "openai", "anthropic"],
      activeProvider: "enhancivity",
      providers: [],
    },
    tabSyncTimer: null,
    primaryAiWriterDevEnabled: false,
  };

  const el = {
    authCard: document.getElementById("auth-card"),
    authForm: document.getElementById("auth-form"),
    authTitle: document.getElementById("auth-title"),
    authName: document.getElementById("auth-name"),
    authNameLabel: document.getElementById("auth-name-label"),
    authEmail: document.getElementById("auth-email"),
    authPassword: document.getElementById("auth-password"),
    authConfirmPassword: document.getElementById("auth-confirm-password"),
    authConfirmPasswordLabel: document.getElementById("auth-confirm-password-label"),
    authSubmit: document.getElementById("auth-submit"),
    authGoogleBtn: document.getElementById("auth-google-btn"),
    authStatus: document.getElementById("auth-status"),
    authLoginTab: document.getElementById("auth-login-tab"),
    authSignupTab: document.getElementById("auth-signup-tab"),
    app: document.getElementById("memory-app"),
    profileBtn: document.getElementById("profile-btn"),
    profilePanel: document.getElementById("profile-panel"),
    profileAccountCard: document.getElementById("profile-account-card"),
    workflowPanel: document.getElementById("workflow-panel"),
    signedInEmail: document.getElementById("signed-in-email"),
    logoutBtn: document.getElementById("logout-btn"),
    settingsBtn: document.getElementById("settings-btn"),
    computeSettingsPanel: document.getElementById("compute-settings-panel"),
    closeSettingsBtn: document.getElementById("close-settings-btn"),
    computeCurrent: document.getElementById("compute-current"),
    providerKeyForm: document.getElementById("provider-key-form"),
    providerSelect: document.getElementById("provider-select"),
    providerKeyField: document.getElementById("provider-key-field"),
    providerKeyInput: document.getElementById("provider-key-input"),
    saveProviderKeyBtn: document.getElementById("save-provider-key-btn"),
    removeProviderKeyBtn: document.getElementById("remove-provider-key-btn"),
    providerKeyStatus: document.getElementById("provider-key-status"),
    devPrimaryAiWriter: document.getElementById("dev-primary-ai-writer"),
    wakeState: document.getElementById("wake-state"),
    projectSelect: document.getElementById("project-select"),
    memoryScopeSelect: document.getElementById("memory-scope-select"),
    noProjectOnboarding: document.getElementById("no-project-onboarding"),
    openDashboardBtn: document.getElementById("open-dashboard-btn"),
    wakeBtn: document.getElementById("wake-btn"),
    refreshBtn: document.getElementById("refresh-btn"),
    toolStatus: document.getElementById("tool-status"),
    prepareContextBtn: document.getElementById("prepare-context-btn"),
    addContextBtn: document.getElementById("add-context-btn"),
    insertInstruction: document.getElementById("insert-instruction"),
    insertProgress: document.getElementById("insert-progress"),
    insertProgressBar: document.getElementById("insert-progress-bar"),
    insertProgressLabel: document.getElementById("insert-progress-label"),
    insertDiagnostics: document.getElementById("insert-diagnostics"),
    insertReview: document.getElementById("insert-review"),
    insertReviewLabel: document.getElementById("insert-review-label"),
    contextReview: document.getElementById("context-review"),
    contextCount: document.getElementById("context-count"),
    insertReviewedBtn: document.getElementById("insert-reviewed-btn"),
    expandReviewBtn: document.getElementById("expand-review-btn"),
    insertReviewNotice: document.getElementById("insert-review-notice"),
    captureNote: document.getElementById("capture-note"),
    captureBtn: document.getElementById("capture-btn"),
    captureDesignBtn: document.getElementById("capture-design-btn"),
    captureReview: document.getElementById("capture-review"),
    eventHistory: document.getElementById("event-history"),
  };

  function setBusy(button, busy) {
    if (!button) return;
    button.disabled = !!busy;
  }

  function setStatus(message, options = {}) {
    el.toolStatus.textContent = message;
    el.toolStatus.classList.toggle("status-error", Boolean(options.error));
  }

  function setAuthStatus(message) {
    el.authStatus.textContent = message;
  }

  function formatMemoryUsedCount(count) {
    const value = Math.max(0, Number(count) || 0);
    return `${value} ${value === 1 ? "memory" : "memories"} used`;
  }

  function isLocalDevMemoryLayerApiBase() {
    const base = state.apiBase || "";
    try {
      const u = new URL(base);
      return u.hostname === "localhost" || u.hostname === "127.0.0.1";
    } catch (_err) {
      return /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(base.trim());
    }
  }

  function shouldSendPrimaryAiWriterForPrepareContext() {
    return Boolean(state.primaryAiWriterDevEnabled);
  }

  function requestErrorMessage(error, fallback = "Memory layer request failed.") {
    const message = error instanceof Error ? error.message : "";
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      return `Cannot reach the Memory Layer backend at ${state.apiBase}. Check the API deployment, then try again.`;
    }
    return message || fallback;
  }

  function accountLabel() {
    return state.user?.email || state.user?.name || "Enhancivity account";
  }

  function renderAccount() {
    el.signedInEmail.textContent = accountLabel();
  }

  function clearAccountScopedState() {
    state.awake = false;
    state.wakeRequested = false;
    state.activeTabId = null;
    state.activeFrameId = null;
    if (state.tabSyncTimer) {
      clearTimeout(state.tabSyncTimer);
      state.tabSyncTimer = null;
    }
    state.selectedProjectId = "";
    state.projects = [];
    state.contextPack = null;
    state.lastInsertContext = null;
    state.lastPreparedInsertInstruction = "";
    state.lastContextPreparedAt = 0;
    state.lastInsertCompletedAt = 0;
    state.lastInsert = null;
    state.deliveryNotice = null;
    state.deliveryNoticeShownSession = false;
    state.memoryScopeSelection = "";
    state.proposals = [];
    state.captureSession = null;
    state.captureNotice = null;
    state.captureNoticeShownSession = false;
    state.providerKeysStatus = {
      supportedProviders: ["enhancivity", "openai", "anthropic"],
      activeProvider: "enhancivity",
      providers: [],
    };
    el.wakeState.textContent = "Sleeping";
    el.wakeState.classList.remove("awake");
    el.contextReview.value = "";
    el.contextCount.textContent = formatMemoryUsedCount(0);
    clearInsertDiagnostics();
    el.insertReview.classList.add("hidden");
    el.captureReview.innerHTML = "";
  }

  function syncProfilePanel() {
    const signedIn = !!state.token;
    el.profileAccountCard.classList.toggle("hidden", !signedIn);
    el.authCard.classList.toggle("hidden", signedIn);
    if (signedIn) renderAccount();
  }

  function closeProfilePanel() {
    el.profilePanel.classList.add("hidden");
    el.profileBtn.setAttribute("aria-expanded", "false");
  }

  function toggleProfilePanel(forceOpen) {
    const shouldOpen = typeof forceOpen === "boolean"
      ? forceOpen
      : el.profilePanel.classList.contains("hidden");
    if (shouldOpen) {
      toggleSettingsPanel(false);
      syncProfilePanel();
    }
    el.profilePanel.classList.toggle("hidden", !shouldOpen);
    el.profileBtn.setAttribute("aria-expanded", String(shouldOpen));
  }

  function addEvent(label) {
    const timestamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    state.events.unshift({ label, timestamp });
    state.events = state.events.slice(0, 12);
    renderEvents();
  }

  function renderEvents() {
    el.eventHistory.innerHTML = "";
    if (state.events.length === 0) {
      const empty = document.createElement("div");
      empty.className = "event-item";
      empty.textContent = "No memory-layer events yet.";
      el.eventHistory.appendChild(empty);
      return;
    }
    state.events.forEach(event => {
      const item = document.createElement("div");
      item.className = "event-item";
      item.textContent = `${event.timestamp} - ${event.label}`;
      el.eventHistory.appendChild(item);
    });
  }

  function setInsertProgress(step, label) {
    const progressByStep = {
      hidden: 0,
      page: 25,
      memory: 55,
      ai: 82,
      ready: 100,
    };
    if (step === "hidden") {
      el.insertProgress.classList.add("hidden");
      el.insertProgressBar.style.width = "0%";
      el.insertProgressLabel.textContent = "";
      return;
    }
    el.insertProgress.classList.remove("hidden");
    el.insertProgressBar.style.width = `${progressByStep[step] || 25}%`;
    el.insertProgressLabel.textContent = label || "Preparing context...";
  }

  function clearInsertDiagnostics() {
    el.insertDiagnostics.textContent = "";
    el.insertDiagnostics.classList.add("hidden");
  }

  function renderInsertDiagnostics(contextPack) {
    clearInsertDiagnostics();
    return;

    const metadata = contextPack?.metadata || {};
    const preparationMode = metadata.preparationMode || null;
    const skippedReason = metadata.aiRefinementSkippedReason || null;
    const fallbackReason = metadata.fallbackReason || null;
    const aiAttemptCount = Number(metadata.ai?.attemptCount || 0);
    const rejectedCandidateCount = Number(metadata.qualityGate?.rejectedCandidateCount || 0);
    const safetyReview = metadata.safetyReview || {};
    const finalSanitation = metadata.finalSanitation || {};
    const finalCleanupCount = [
      ...(finalSanitation.typoFixes || []),
      ...(finalSanitation.removedBrokenFragments || []),
      ...(finalSanitation.rewrittenSystemInternalTerms || []),
      ...(finalSanitation.removedAudienceInappropriateMemory || []),
    ].length;
    const parts = [];

    if (state.primaryAiWriterDevEnabled) {
      const hostNote = isLocalDevMemoryLayerApiBase() ? "" : " (non-localhost API)";
      parts.push(`Dev flag:${hostNote} client sends primaryAiWriter on Prepare`);
    }
    const routing = metadata.primaryAiWriterRouting;
    if (routing && typeof routing === "object") {
      const r = routing;
      parts.push(
        `Server routing: lead=${r.leadRequested} pipeline=${r.aiFinalPipelineEnabled}`
          + ` ctx=${r.hasAiPreparationContext} body=${r.bodyPrimaryFlag}`
          + ` sideSrc=${r.sidePanelSource} env=${r.envPrimaryAiWriter}`,
      );
    } else if (preparationMode === "deterministic") {
      parts.push(
        "Server routing: (missing primaryAiWriterRouting - restart the memory-layer API from the latest private workspace)",
      );
    }
    if (
      routing && typeof routing === "object"
      && routing.bodyPrimaryFlag === false
      && preparationMode === "deterministic"
      && skippedReason === "disabled_by_default"
      && !state.primaryAiWriterDevEnabled
    ) {
      parts.push(
        "Tip: open Settings (gear), turn on “Primary AI writer on Prepare (dev)”, close Settings, then Prepare again.",
      );
    }
    if (skippedReason) parts.push(`AI skipped: ${skippedReason}`);
    if (preparationMode) parts.push(`Preparation: ${preparationMode}`);
    if (metadata.semanticAuthority?.mode || metadata.llmOwnedSemanticPipeline === true || metadata.finalWriterInput) {
      const writerInput = metadata.finalWriterInput || {};
      const diag = metadata.semanticPipelineDiagnostics || {};
      const intentSource = diag.intentContractSource
        || metadata.intentContract?.source
        || "unknown";
      const aiAvailable = diag.aiAvailable != null ? diag.aiAvailable : metadata.aiAvailable;
      const draftIgnored = diag.deterministicPreparedPromptIgnored != null
        ? diag.deterministicPreparedPromptIgnored
        : metadata.deterministicPreparedPromptIgnored;
      parts.push(
        `LLM-owned: ${metadata.llmOwnedSemanticPipeline === true} `
          + `authority=${diag.semanticAuthorityMode || metadata.semanticAuthority?.mode || "unknown"} `
          + `reason=${diag.semanticAuthorityReason || metadata.semanticAuthority?.reason || "n/a"} `
          + `writer=${diag.writerProfile || writerInput.writerProfile || metadata.writerProfile || "unknown"} `
          + `aiAvailable=${aiAvailable == null ? "unknown" : aiAvailable} `
          + `aiReason=${diag.aiAvailableReason || metadata.aiAvailableReason || "n/a"} `
          + `intentSource=${intentSource} `
          + `fallback=${diag.fallbackType || metadata.fallbackType || "none"} `
          + `draft=${writerInput.deterministicPreparedPrompt == null ? "null" : "present"} `
          + `draftIgnored=${draftIgnored == null ? "unknown" : draftIgnored} `
          + `draftAuthority=${writerInput.deterministicPreparedPromptAuthority || "unknown"} `
          + `route=${diag.routeReceivedLlmOwnedFlag == null ? "?" : diag.routeReceivedLlmOwnedFlag} `
          + `env=${diag.envLlmOwnedFlag == null ? "?" : diag.envLlmOwnedFlag} `
          + `contractHash=${(diag.contractHash || metadata.semanticAuthority?.contractHash || "").slice(0, 8) || "none"}`,
      );
    }
    if (fallbackReason) parts.push(`Fallback: ${fallbackReason}`);
    if (aiAttemptCount > 0) parts.push(`AI attempts: ${aiAttemptCount}`);
    if (safetyReview.attempted) parts.push(`Safety review: ${safetyReview.accepted ? "accepted" : "fallback"}`);
    if (finalSanitation.applied) parts.push(`Final cleanup: ${finalCleanupCount} changes`);
    if ((finalSanitation.rejectedReasons || []).length > 0) {
      parts.push(`Final risks: ${finalSanitation.rejectedReasons.slice(0, 3).join(", ")}`);
    }
    parts.push(`Rejected before AI: ${rejectedCandidateCount}`);

    el.insertDiagnostics.textContent = parts.join(" · ");
    el.insertDiagnostics.classList.remove("hidden");
  }

  function outputModeLabel(outputMode) {
    if (outputMode === "email_reply") return "email reply draft";
    if (outputMode === "slack_message") return "Slack message draft";
    if (outputMode === "document_text") return "document draft";
    if (outputMode === "design_context") return "design context";
    if (outputMode === "prompt_context") return "prompt context";
    return "work context";
  }

  function syncInsertReviewLabels(contextPack) {
    const outputMode = contextPack?.metadata?.intent?.outputMode || "generic_work_context";
    const label = outputModeLabel(outputMode);
    el.insertReviewLabel.textContent = `Review ${label} before inserting`;
    el.insertReviewedBtn.textContent = outputMode === "prompt_context"
      ? "Insert Reviewed Context"
      : "Insert Reviewed Draft";
  }

  function providerLabel(provider) {
    if (provider === "enhancivity") return "Enhancivity";
    if (provider === "openai") return "OpenAI";
    if (provider === "anthropic") return "Anthropic";
    return provider || "Provider";
  }

  function providerRecord(provider) {
    return (state.providerKeysStatus.providers || []).find(record => record.provider === provider) || null;
  }

  function hasProviderKey(provider) {
    return providerRecord(provider)?.hasKey === true;
  }

  function activeProviderKeyRecord() {
    return (state.providerKeysStatus.providers || []).find(record => record.hasKey === true) || null;
  }

  function activeComputeProvider() {
    return state.providerKeysStatus.activeProvider || activeProviderKeyRecord()?.provider || "enhancivity";
  }

  function normalizeProviderKeyStatus(data) {
    const providerKeys = data.providerKeys || data.providerKeyStatus || data.data?.providerKeys || {};
    const supportedProviders = Array.isArray(providerKeys.supportedProviders) && providerKeys.supportedProviders.length
      ? providerKeys.supportedProviders
      : ["enhancivity", "openai", "anthropic"];
    const providers = Array.isArray(providerKeys.providers)
      ? providerKeys.providers.map(record => ({
          provider: record.provider,
          hasKey: record.hasKey === true,
          keyPreview: record.keyPreview || null,
          status: record.status || (record.hasKey ? "active" : "not_set"),
          lastUsedAt: record.lastUsedAt || null,
          updatedAt: record.updatedAt || null,
        }))
      : [];

    const activeProvider = providerKeys.activeProvider
      || providers.find(record => record.hasKey)?.provider
      || "enhancivity";

    return { supportedProviders, activeProvider, providers };
  }

  function updateProviderKeyControls() {
    const selectedProvider = el.providerSelect.value;
    const activeProvider = activeComputeProvider();
    const hasActiveKey = activeProvider !== "enhancivity";
    const selectedNeedsKey = selectedProvider === "openai" || selectedProvider === "anthropic";

    el.providerKeyField.classList.toggle("hidden", !selectedNeedsKey || hasActiveKey);
    el.providerKeyInput.required = selectedNeedsKey && !hasActiveKey;
    el.providerKeyInput.disabled = !selectedNeedsKey || hasActiveKey;
    el.providerSelect.disabled = hasActiveKey;
    el.removeProviderKeyBtn.disabled = !hasActiveKey;
    el.saveProviderKeyBtn.disabled = hasActiveKey;
  }

  function renderProviderKeyStatus() {
    const activeProvider = activeComputeProvider();
    el.computeCurrent.textContent = `Current: ${providerLabel(activeProvider)}`;
    el.providerSelect.value = activeProvider;
    el.providerKeyInput.value = "";
    updateProviderKeyControls();
  }

  function syncDevPrimaryAiWriterCheckbox() {
    if (!el.devPrimaryAiWriter) return;
    el.devPrimaryAiWriter.checked = state.primaryAiWriterDevEnabled === true;
  }

  function toggleSettingsPanel(forceOpen) {
    const shouldOpen = typeof forceOpen === "boolean"
      ? forceOpen
      : el.computeSettingsPanel.classList.contains("hidden");
    if (shouldOpen) closeProfilePanel();
    el.computeSettingsPanel.classList.toggle("hidden", !shouldOpen);
    el.workflowPanel.classList.toggle("hidden", shouldOpen);
    el.settingsBtn.setAttribute("aria-expanded", String(shouldOpen));
    if (shouldOpen) syncDevPrimaryAiWriterCheckbox();
  }

  function authHeaders() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.token}`,
    };
  }

  function dashboardUrl() {
    return "https://enhancivity.com/dashboard/memory-layer";
  }

  function setProjectControlsEnabled(enabled) {
    el.wakeBtn.disabled = !enabled;
    el.prepareContextBtn.disabled = !enabled;
    el.addContextBtn.disabled = !enabled;
    el.captureBtn.disabled = !enabled;
    if (el.captureDesignBtn) el.captureDesignBtn.disabled = !enabled;
  }

  function setAuthMode(mode) {
    state.authMode = mode === "signup" ? "signup" : "login";
    const isSignup = state.authMode === "signup";
    el.authTitle.textContent = isSignup ? "Create account" : "Sign in";
    el.authSubmit.textContent = isSignup ? "Create account" : "Log in";
    el.authName.classList.toggle("hidden", !isSignup);
    el.authNameLabel.classList.toggle("hidden", !isSignup);
    el.authConfirmPassword.classList.toggle("hidden", !isSignup);
    el.authConfirmPasswordLabel.classList.toggle("hidden", !isSignup);
    el.authName.required = isSignup;
    el.authConfirmPassword.required = isSignup;
    if (!isSignup) el.authConfirmPassword.value = "";
    el.authPassword.autocomplete = isSignup ? "new-password" : "current-password";
    el.authLoginTab.classList.toggle("active", !isSignup);
    el.authSignupTab.classList.toggle("active", isSignup);
    setAuthStatus("Connects to the memory-layer backend.");
  }

  function showAuth() {
    el.app.classList.add("hidden");
    el.settingsBtn.classList.add("hidden");
    toggleSettingsPanel(false);
    syncProfilePanel();
    toggleProfilePanel(true);
  }

  function showApp() {
    el.app.classList.remove("hidden");
    el.settingsBtn.classList.remove("hidden");
    syncProfilePanel();
    closeProfilePanel();
    renderAccount();
  }

  function extractAuthToken(data) {
    return data.token || data.authToken || data.data?.token;
  }

  function extractAuthUser(data, fallback = {}) {
    return data.user || data.data?.user || {
      name: fallback.name || "",
      email: fallback.email || "",
    };
  }

  async function persistAuthSession({ token, user }) {
    if (!token) {
      throw new Error("Authentication succeeded without a token.");
    }

    clearAccountScopedState();
    state.token = token;
    state.user = user || null;
    if (!state.hasStoredApiBase) {
      state.apiBase = DEFAULT_MEMORY_LAYER_API_BASE;
    }

    await chrome.storage.local.remove([
      "memoryLayerSelectedProjectId",
      "memoryLayerMemoryScope",
    ]);
    await chrome.storage.local.set({
      token: state.token,
      memoryLayerUser: state.user,
      ...(!state.hasStoredApiBase ? { memoryLayerApiBase: state.apiBase } : {}),
    });
    state.hasStoredApiBase = true;
  }

  async function clearAuthSession(message = "Signed out.") {
    state.token = "";
    state.user = null;
    clearAccountScopedState();
    el.providerKeyInput.value = "";
    renderProviderKeyStatus();
    await chrome.storage.local.remove([
      "token",
      "memoryLayerUser",
      "memoryLayerSelectedProjectId",
      "memoryLayerMemoryScope",
    ]);
    showAuth();
    setAuthMode("login");
    setAuthStatus(message);
  }

  async function loginOrSignup(event) {
    event.preventDefault();
    const email = el.authEmail.value.trim();
    const password = el.authPassword.value;
    const confirmPassword = el.authConfirmPassword.value;
    const name = el.authName.value.trim();
    if (!email || !password || (state.authMode === "signup" && !name)) {
      setAuthStatus("Enter your account details first.");
      return;
    }
    if (state.authMode === "signup" && password !== confirmPassword) {
      setAuthStatus("Passwords do not match.");
      return;
    }

    try {
      setBusy(el.authSubmit, true);
      setAuthStatus(state.authMode === "signup" ? "Creating account..." : "Signing in...");
      const body = state.authMode === "signup"
        ? { name, email, password }
        : { email, password };
      const response = await fetch(`${state.apiBase}/api/auth/extension/${state.authMode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || data.message || "Authentication failed.");
      }

      await persistAuthSession({
        token: extractAuthToken(data),
        user: extractAuthUser(data, { email, name }),
      });
      showApp();
      renderEvents();
      await loadProjects();
      await loadProviderKeyStatus();
      if (state.selectedProjectId) {
        setStatus("Choose a project, then wake Enhancivity when you want to use memory on this page.");
      }
      addEvent(state.authMode === "signup" ? "Created account" : "Signed in");
    } catch (error) {
      setAuthStatus(requestErrorMessage(error, "Could not sign in."));
    } finally {
      setBusy(el.authSubmit, false);
    }
  }

  function requestGoogleAccessToken() {
    return new Promise((resolve, reject) => {
      if (!chrome.identity?.getAuthToken) {
        reject(new Error("Google sign-in is not available in this Chrome profile."));
        return;
      }

      chrome.identity.getAuthToken({ interactive: true }, token => {
        const runtimeError = chrome.runtime?.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || "Google sign-in was cancelled."));
          return;
        }
        if (!token) {
          reject(new Error("Google did not return an access token."));
          return;
        }
        resolve(token);
      });
    });
  }

  async function loginWithGoogle() {
    let googleAccessToken = "";
    try {
      setBusy(el.authGoogleBtn, true);
      setAuthStatus("Opening Google sign-in...");
      googleAccessToken = await requestGoogleAccessToken();
      setAuthStatus("Connecting Google account to Enhancivity...");
      const response = await fetch(`${state.apiBase}/api/auth/extension/google`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: googleAccessToken }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || data.message || "Google sign-in failed.");
      }

      await persistAuthSession({
        token: extractAuthToken(data),
        user: extractAuthUser(data),
      });
      showApp();
      renderEvents();
      await loadProjects();
      await loadProviderKeyStatus();
      setStatus("Choose a project, then wake Enhancivity when you want to use memory on this page.");
      addEvent("Signed in with Google");
    } catch (error) {
      if (googleAccessToken && chrome.identity?.removeCachedAuthToken) {
        chrome.identity.removeCachedAuthToken({ token: googleAccessToken }, () => {});
      }
      setAuthStatus(requestErrorMessage(error, "Could not sign in with Google."));
    } finally {
      setBusy(el.authGoogleBtn, false);
    }
  }

  async function apiRequest(path, options = {}) {
    let response;
    try {
      response = await fetch(`${state.apiBase}/api/memory-layer${path}`, {
        ...options,
        headers: {
          ...authHeaders(),
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      throw new Error(requestErrorMessage(error));
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        await clearAuthSession("Session expired. Sign in again.");
      }
      const error = new Error(data.error || data.message || "Memory layer request failed.");
      if (data.code) error.code = data.code;
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function safeApiRequest(path, options = {}, fallback = "Memory layer request failed.") {
    try {
      return await apiRequest(path, options);
    } catch (error) {
      throw new Error(requestErrorMessage(error, fallback));
    }
  }

  // Parse one SSE event block ("event: X\ndata: {...}") into { event, data }.
  function parseSseBlock(block) {
    let event = "message";
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return { event, data: null };
    try {
      return { event, data: JSON.parse(dataLines.join("\n")) };
    } catch (_parseErr) {
      return { event, data: null };
    }
  }

  // Stream a prepared prompt over SSE, rendering the writer's text live as a PREVIEW
  // and returning the authoritative final payload ({ contextPack, attributeNotice? }).
  // Throws with `streamUnavailable=true` when the stream cannot be established (e.g.
  // an older backend without the endpoint) so the caller can fall back to the plain
  // non-streaming request. A pipeline `error` event throws a normal error (no fallback).
  async function streamPrepareContext(streamPath, requestBody) {
    let response;
    try {
      response = await fetch(`${state.apiBase}/api/memory-layer${streamPath}`, {
        method: "POST",
        headers: authHeaders(),
        body: requestBody,
      });
    } catch (error) {
      const err = new Error(requestErrorMessage(error));
      err.streamUnavailable = true;
      throw err;
    }
    if (!response.ok || !response.body || typeof response.body.getReader !== "function") {
      if (response.status === 401) await clearAuthSession("Session expired. Sign in again.");
      const err = new Error("Streaming prepare is unavailable.");
      err.streamUnavailable = true;
      err.status = response.status;
      throw err;
    }

    // We have a live stream — start the preview fresh.
    el.contextReview.value = "";
    el.insertReview.classList.remove("hidden");

    let finalData = null;
    let streamError = null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const handle = (evt) => {
      if (evt.event === "progress") {
        if (evt.data && evt.data.stage === "writing") {
          if (evt.data.reset) el.contextReview.value = "";
          setInsertProgress("ai", "Writing your prompt...");
        } else if (evt.data && evt.data.stage === "selecting") {
          setInsertProgress("memory", "Selecting relevant memory...");
        }
      } else if (evt.event === "token") {
        el.contextReview.value += (evt.data && evt.data.text) || "";
      } else if (evt.event === "final") {
        finalData = evt.data;
      } else if (evt.event === "error") {
        streamError = evt.data || {};
      }
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const evt = parseSseBlock(block);
        if (evt) handle(evt);
      }
    }

    if (streamError) {
      el.contextReview.value = "";
      const err = new Error(streamError.error || "Could not prepare context.");
      if (streamError.code) err.code = streamError.code;
      throw err;
    }
    if (!finalData) {
      const err = new Error("The prepare stream ended unexpectedly.");
      err.streamUnavailable = true;
      throw err;
    }
    return finalData;
  }

  async function loadProviderKeyStatus() {
    const data = await safeApiRequest("/provider-keys/status");
    state.providerKeysStatus = normalizeProviderKeyStatus(data);
    renderProviderKeyStatus();
  }

  async function saveProviderKey(event) {
    event.preventDefault();
    const provider = el.providerSelect.value;
    const activeProvider = activeComputeProvider();
    if (activeProvider !== "enhancivity") {
      el.providerKeyStatus.textContent = `Remove the ${providerLabel(activeProvider)} key before changing providers.`;
      return;
    }

    if (provider === "enhancivity") {
      await safeApiRequest("/provider-keys", {
        method: "POST",
        body: JSON.stringify({ provider }),
      });
      el.providerKeyInput.value = "";
      await loadProviderKeyStatus();
      renderProviderKeyStatus();
      el.providerKeyStatus.textContent = "Enhancivity provider saved.";
      addEvent("Selected Enhancivity provider");
      return;
    }

    const apiKey = el.providerKeyInput.value.trim();
    if (!apiKey) {
      el.providerKeyStatus.textContent = "Paste a provider key before saving.";
      return;
    }

    try {
      setBusy(el.saveProviderKeyBtn, true);
      el.providerKeyStatus.textContent = `Saving ${providerLabel(provider)} key...`;
      await safeApiRequest("/provider-keys", {
        method: "POST",
        body: JSON.stringify({ provider, apiKey }),
      });
      el.providerKeyInput.value = "";
      await loadProviderKeyStatus();
      el.providerKeyStatus.textContent = `${providerLabel(provider)} provider saved.`;
      addEvent(`Saved ${providerLabel(provider)} key`);
    } catch (error) {
      el.providerKeyStatus.textContent = error instanceof Error ? error.message : "Could not save provider key.";
    } finally {
      setBusy(el.saveProviderKeyBtn, false);
    }
  }

  async function removeProviderKey() {
    const provider = activeComputeProvider();
    if (provider === "enhancivity") return;

    try {
      setBusy(el.removeProviderKeyBtn, true);
      el.providerKeyStatus.textContent = `Removing ${providerLabel(provider)} key...`;
      await safeApiRequest(`/provider-keys/${encodeURIComponent(provider)}`, {
        method: "DELETE",
      });
      await loadProviderKeyStatus();
      el.providerSelect.value = "enhancivity";
      updateProviderKeyControls();
      el.providerKeyStatus.textContent = `${providerLabel(provider)} key removed.`;
      addEvent(`Removed ${providerLabel(provider)} key`);
    } catch (error) {
      el.providerKeyStatus.textContent = error instanceof Error ? error.message : "Could not remove provider key.";
    } finally {
      setBusy(el.removeProviderKeyBtn, false);
      updateProviderKeyControls();
    }
  }

  function flattenProjects(projects) {
    return projects.flatMap(project => [project, ...(project.children || [])]);
  }

  /**
   * Subprojects shown in the scope dropdown must belong only to the currently selected
   * top-level project. Other projects’ subprojects never appear here (children come from
   * that project’s `children` array from the API).
   */
  function subprojectsForSelectedTopLevelProject() {
    const selectedTopId = state.selectedProjectId;
    if (!selectedTopId) return [];
    const top = topLevelProjects().find(project => project.id === selectedTopId);
    if (!top) return [];
    const raw = Array.isArray(top.children) ? top.children : [];
    return raw.filter(child => {
      if (!child || !child.id) return false;
      if (child.parentId == null) return true;
      return child.parentId === top.id;
    });
  }

  function renderMemoryScopeSelect() {
    if (!el.memoryScopeSelect) return;
    el.memoryScopeSelect.innerHTML = "";
    const selectedTopId = state.selectedProjectId;
    const top = topLevelProjects().find(project => project.id === selectedTopId);
    const disabled = !top;
    el.memoryScopeSelect.disabled = disabled;
    MEMORY_SCOPE_OPTIONS.forEach(option => {
      const opt = document.createElement("option");
      opt.value = option.value;
      opt.textContent = option.label;
      el.memoryScopeSelect.appendChild(opt);
    });
    const children = subprojectsForSelectedTopLevelProject();
    if (children.length > 0) {
      const group = document.createElement("optgroup");
      group.label = top?.name
        ? `Subprojects of ${top.name}`
        : "Subprojects";
      children.forEach(child => {
        const opt = document.createElement("option");
        opt.value = `sub:${child.id}`;
        opt.textContent = child.name || "Subproject";
        group.appendChild(opt);
      });
      el.memoryScopeSelect.appendChild(group);
    }
    const allowed = new Set(Array.from(el.memoryScopeSelect.options).map(o => o.value));
    if (!allowed.has(state.memoryScopeSelection)) {
      state.memoryScopeSelection = "";
    }
    el.memoryScopeSelect.value = state.memoryScopeSelection || "";
  }

  function parseMemoryScopeSelection(value) {
    const raw = String(value || "").trim();
    const out = {
      selectedSubprojectId: "",
      selectedSubprojectName: "",
      selectedMemoryScopeId: "",
      selectedMemoryScopeName: "",
    };
    if (!raw) return out;
    if (raw.startsWith("sub:")) {
      out.selectedSubprojectId = raw.slice(4).trim();
      const opt = el.memoryScopeSelect?.selectedOptions?.[0];
      out.selectedSubprojectName = opt?.textContent?.trim() || "";
      return out;
    }
    if (raw.startsWith("scope:")) {
      out.selectedMemoryScopeId = raw;
      const opt = el.memoryScopeSelect?.selectedOptions?.[0];
      out.selectedMemoryScopeName = opt?.textContent?.trim() || "";
      return out;
    }
    return out;
  }

  function topLevelProjects() {
    return (Array.isArray(state.projects) ? state.projects : []).filter(project => !project.parentId);
  }

  function findProject(projectId) {
    return flattenProjects(state.projects).find(project => project.id === projectId) || null;
  }

  function topLevelProjectFor(projectId) {
    const project = findProject(projectId);
    if (!project) return null;
    if (!project.parentId) return project;
    return findProject(project.parentId) || null;
  }

  function renderProjects() {
    el.projectSelect.innerHTML = "";
    const topProjects = topLevelProjects();
    const hasProjects = topProjects.length > 0;
    el.noProjectOnboarding.classList.toggle("hidden", hasProjects);
    setProjectControlsEnabled(hasProjects);

    if (topProjects.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No projects yet";
      el.projectSelect.appendChild(option);
      state.selectedProjectId = "";
      el.projectSelect.disabled = true;
      el.contextCount.textContent = formatMemoryUsedCount(0);
      clearInsertDiagnostics();
      el.insertReview.classList.add("hidden");
      setStatus("Create a project in the dashboard, then sync projects here before waking Enhancivity.");
      return;
    }

    topProjects.forEach(project => {
      const option = document.createElement("option");
      option.value = project.id;
      option.textContent = project.name;
      el.projectSelect.appendChild(option);
    });

    const selectedTopProject = topLevelProjectFor(state.selectedProjectId);
    if (topProjects.length === 1) {
      state.selectedProjectId = topProjects[0].id;
    } else if (!selectedTopProject || !topProjects.some(project => project.id === selectedTopProject.id)) {
      state.selectedProjectId = topProjects[0].id;
    } else {
      state.selectedProjectId = selectedTopProject.id;
    }
    el.projectSelect.disabled = topProjects.length === 1;
    el.projectSelect.value = state.selectedProjectId;
    renderMemoryScopeSelect();
  }

  async function loadProjects() {
    const data = await safeApiRequest("/projects");
    state.projects = data.projects || [];
    renderProjects();
    await chrome.storage.local.set({ memoryLayerSelectedProjectId: state.selectedProjectId });
  }

  async function refreshMemoryLayerData() {
    try {
      await loadProjects();
      await loadProviderKeyStatus();
      setStatus("Projects and memory settings synced.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not sync projects and memory settings.");
    }
  }

  async function openDashboard() {
    await chrome.tabs.create({ url: dashboardUrl(), active: true });
    addEvent("Opened memory dashboard");
  }

  async function logout() {
    await clearAuthSession("Logged out. Sign in with your Enhancivity account when you are ready.");
  }

  function isUsableWorkTab(tab) {
    const url = String(tab?.url || "");
    return Boolean(
      tab?.id
      && !url.startsWith("chrome-extension://")
      && !url.startsWith("chrome://")
    );
  }

  function mostRecentWorkTab(tabs = []) {
    return tabs
      .filter(isUsableWorkTab)
      .sort((left, right) => {
        const rightAccessed = Number(right.lastAccessed || 0);
        const leftAccessed = Number(left.lastAccessed || 0);
        if (rightAccessed !== leftAccessed) return rightAccessed - leftAccessed;
        return Number(right.id || 0) - Number(left.id || 0);
      })[0] || null;
  }

  async function getActiveTab() {
    const activeQueries = [
      { active: true, currentWindow: true },
      { active: true, lastFocusedWindow: true },
    ];
    for (const query of activeQueries) {
      const [tab] = await chrome.tabs.query(query);
      if (isUsableWorkTab(tab)) return tab;
    }
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return mostRecentWorkTab(tabs);
  }

  async function sendTabMessage(message) {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("No active tab found.");
    if (state.activeTabId !== tab.id) {
      state.activeFrameId = null;
    }
    state.activeTabId = tab.id;
    let response;
    const sendOptions = Number.isInteger(state.activeFrameId)
      ? { frameId: state.activeFrameId }
      : undefined;
    try {
      response = await deliverTabMessage(tab.id, message, sendOptions);
    } catch (error) {
      if (!isMissingContentScriptError(error)) {
        throw error;
      }
      await injectMemoryLayerContent(tab.id);
      response = await deliverTabMessage(tab.id, message, sendOptions);
    }

    if (!shouldTryFrameFallback(message, response)) {
      return response;
    }

    const frameResponse = await sendTabFrameMessage(tab.id, message);
    if (isBetterFrameResponse(message, frameResponse, response)) {
      if (Number.isInteger(frameResponse.frameId)) {
        state.activeFrameId = frameResponse.frameId;
      }
      return frameResponse;
    }
    return response;
  }

  function deliverTabMessage(tabId, message, options) {
    return options
      ? chrome.tabs.sendMessage(tabId, message, options)
      : chrome.tabs.sendMessage(tabId, message);
  }

  function isMissingContentScriptError(error) {
    const message = error instanceof Error ? error.message : String(error || "");
    return /receiving end does not exist|could not establish connection/i.test(message);
  }

  function responseHasFocusedTarget(response) {
    return response?.hasFocusedInput === true || response?.context?.hasFocusedInput === true;
  }

  function shouldTryFrameFallback(message, response) {
    if (!chrome.scripting?.executeScript) return false;
    if (message?.type === "MEMORY_LAYER_PING") return !responseHasFocusedTarget(response);
    if (message?.type === "MEMORY_LAYER_GET_INSERT_CONTEXT") return !responseHasFocusedTarget(response);
    if (message?.type === "MEMORY_LAYER_GET_PAGE_CONTEXT") return !responseHasFocusedTarget(response);
    if (message?.type === "MEMORY_LAYER_INSERT_CONTEXT") {
      return !response?.success && /No focused supported input|focused document surface did not accept insertion/i.test(response?.error || "");
    }
    return false;
  }

  function frameResponseScore(message, response) {
    if (!response || typeof response !== "object") return -1;
    if (message?.type === "MEMORY_LAYER_INSERT_CONTEXT") return response.success ? 100 : -1;

    let score = response.success ? 10 : 0;
    if (response.hasFocusedInput === true || response.context?.hasFocusedInput === true) score += 100;
    if (response.frameHasFocus === true || response.context?.frameHasFocus === true) score += 30;
    if (response.focusedInputText || response.context?.focusedInputText) score += 20;
    const sourceTool = response.sourceTool || response.context?.sourceTool;
    if (sourceTool && sourceTool !== "browser" && sourceTool !== "localhost") score += 10;
    return score;
  }

  function selectBestFrameResponse(message, results) {
    return (Array.isArray(results) ? results : [])
      .map(result => ({
        ...(result?.result || {}),
        frameId: result?.frameId,
      }))
      .sort((left, right) => frameResponseScore(message, right) - frameResponseScore(message, left))[0] || null;
  }

  function isBetterFrameResponse(message, frameResponse, originalResponse) {
    return frameResponseScore(message, frameResponse) > frameResponseScore(message, originalResponse);
  }

  async function sendTabFrameMessage(tabId, message) {
    try {
      await injectMemoryLayerContent(tabId, { allFrames: true });
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        args: [message],
        func: frameMessage => {
          try {
            const handler = window.EnhancivityMemoryLayerContent?.handleMessage;
            if (typeof handler !== "function") {
              return { success: false, error: "Memory layer content script unavailable in this frame." };
            }
            return handler(frameMessage);
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : "Frame message failed.",
            };
          }
        },
      });
      return selectBestFrameResponse(message, results);
    } catch (_error) {
      return null;
    }
  }

  async function injectMemoryLayerContent(tabId, options = {}) {
    if (!chrome.scripting?.executeScript) {
      throw new Error("Refresh this page, then wake Enhancivity again.");
    }
    const target = options.allFrames ? { tabId, allFrames: true } : { tabId };
    try {
      await chrome.scripting.executeScript({
        target,
        files: ["memory_layer_extractors.js"],
      });
      await chrome.scripting.executeScript({
        target,
        files: ["memory_layer_content.js"],
      });
      await chrome.scripting.executeScript({
        target,
        files: ["memory_layer_picker.js"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      throw new Error(message || "Refresh this page, then wake Enhancivity again.");
    }
  }

  function renderWakeState(awake, message) {
    state.awake = !!awake;
    el.wakeState.textContent = state.awake ? "Awake" : "Sleeping";
    el.wakeState.classList.toggle("awake", state.awake);
    if (message && Date.now() - state.lastInsertCompletedAt > 2500) setStatus(message);
  }

  function wakeStatusMessage(response) {
    return response?.sourceTool
      ? `Awake on ${response.sourceTool}. Focused input: ${response.hasFocusedInput ? "yes" : "no"}.`
      : "Awake.";
  }

  async function syncWakeWithActiveTab() {
    if (!state.token || !state.selectedProjectId || !state.wakeRequested) return;
    try {
      const response = await sendTabMessage({ type: "MEMORY_LAYER_PING" });
      if (!response?.success) throw new Error(response?.error || "Could not wake this tab.");
      renderWakeState(true, wakeStatusMessage(response));
    } catch (error) {
      state.activeTabId = null;
      renderWakeState(false, error instanceof Error ? error.message : "Wake Enhancivity on this tab.");
    }
  }

  function scheduleWakeSync() {
    if (state.tabSyncTimer) clearTimeout(state.tabSyncTimer);
    state.tabSyncTimer = setTimeout(() => {
      state.tabSyncTimer = null;
      syncWakeWithActiveTab();
    }, 250);
  }

  async function wakeMemoryLayer() {
    if (!state.selectedProjectId) {
      setStatus("Select a project before waking Enhancivity.");
      return;
    }
    state.wakeRequested = true;
    try {
      const response = await sendTabMessage({ type: "MEMORY_LAYER_PING" });
      if (!response?.success) throw new Error(response?.error || "Could not wake this tab.");
      renderWakeState(!!response?.success, wakeStatusMessage(response));
      addEvent("Woke memory layer");
    } catch (error) {
      renderWakeState(false, error instanceof Error ? error.message : "Could not wake this tab.");
    }
  }

  function assertReady() {
    if (!state.awake) throw new Error("Wake Enhancivity first.");
    if (!state.selectedProjectId) throw new Error("Select a project first.");
  }

  function proposalTargetProjectId(proposal) {
    const suggestedProjectId = proposal?.projectId || proposal?.metadata?.suggestedProjectId;
    return findProject(suggestedProjectId)?.id || state.selectedProjectId;
  }

  function proposalTargetLabel(proposal) {
    const evolutionMetadata = proposal?.evolutionMetadata || null;
    if (evolutionMetadata?.willCreateSubproject && evolutionMetadata?.plannedTargetProjectName) {
      return `Will create subproject: ${evolutionMetadata.plannedTargetProjectName}`;
    }
    const targetProject = findProject(proposalTargetProjectId(proposal));
    if (!targetProject) return "";
    return targetProject.parentId
      ? `Will be saved to subproject: ${targetProject.name}`
      : `Will be saved project-wide: ${targetProject.name}`;
  }

  async function prepareContext(limit) {
    try {
      assertReady();
      setBusy(el.prepareContextBtn, true);
      setBusy(el.addContextBtn, true);
      setInsertProgress("page", "Reading the current page...");
      const insertContextResponse = await sendTabMessage({ type: "MEMORY_LAYER_GET_INSERT_CONTEXT" });
      if (!insertContextResponse?.success) {
        throw new Error(insertContextResponse?.error || "Could not read current page context.");
      }
      state.lastInsertContext = insertContextResponse.context || null;
      const insertionInstruction = el.insertInstruction.value.trim();
      setInsertProgress("memory", "Finding relevant project memory...");
      const activeTop = topLevelProjectFor(state.selectedProjectId);
      const scopeFields = parseMemoryScopeSelection(state.memoryScopeSelection);
      const requestBody = JSON.stringify({
        limit,
        llmOwnedSemanticPipeline: true,
        ...(shouldSendPrimaryAiWriterForPrepareContext() ? { primaryAiWriter: true } : {}),
        // Unit 3d (part 2/2) — the prior inserted request (if any), for backend re-request
        // detection. The backend's window/overlap gate decides whether it is a re-request;
        // a stale or unrelated value simply produces no signal.
        ...(state.lastInsert ? { priorInsert: state.lastInsert } : {}),
        clientContext: {
          ...(insertContextResponse.context || {}),
          insertionInstruction,
          selectedProjectId: state.selectedProjectId,
          selectedProjectName: activeTop?.name || "",
          ...(scopeFields.selectedSubprojectId ? { selectedSubprojectId: scopeFields.selectedSubprojectId } : {}),
          ...(scopeFields.selectedSubprojectName ? { selectedSubprojectName: scopeFields.selectedSubprojectName } : {}),
          ...(scopeFields.selectedMemoryScopeId ? { selectedMemoryScopeId: scopeFields.selectedMemoryScopeId } : {}),
          ...(scopeFields.selectedMemoryScopeName ? { selectedMemoryScopeName: scopeFields.selectedMemoryScopeName } : {}),
          capabilityHints: {
            ...(insertContextResponse.context?.capabilityHints && typeof insertContextResponse.context.capabilityHints === "object"
              ? insertContextResponse.context.capabilityHints
              : {}),
            authoritativeRequestSource: "side_panel",
          },
        },
      });
      // Stream the prepared prompt live (perceived speed); fall back to the plain
      // request if the stream can't be established (older backend / no SSE). The
      // final payload is authoritative either way — the rendering below snaps the
      // review box to the validated preparedText (so the kept text is always final).
      let data;
      try {
        data = await streamPrepareContext(
          `/projects/${encodeURIComponent(state.selectedProjectId)}/context-pack/stream`,
          requestBody
        );
      } catch (streamErr) {
        if (streamErr && streamErr.streamUnavailable) {
          data = await apiRequest(`/projects/${encodeURIComponent(state.selectedProjectId)}/context-pack`, {
            method: "POST",
            body: requestBody,
          });
        } else {
          throw streamErr;
        }
      }
      state.contextPack = data.contextPack || null;
      state.lastPreparedInsertInstruction = insertionInstruction;
      state.lastContextPreparedAt = Date.now();
      const contractBlocked = state.contextPack?.finalContractBlocked === true
        || state.contextPack?.metadata?.finalContractBlocked === true;
      el.contextReview.disabled = contractBlocked;
      el.insertReviewedBtn.disabled = contractBlocked;
      el.contextReview.value = contractBlocked ? "" : (state.contextPack?.preparedText || "");
      el.contextCount.textContent = formatMemoryUsedCount(state.contextPack?.metadata?.itemCount);
      syncInsertReviewLabels(state.contextPack);
      el.insertReview.classList.remove("hidden");
      setInsertProgress("hidden");
      // Unit 3f — at most one prepared-prompt disclosure notice per session (§7.3); absent /
      // notices-off -> stays null -> nothing renders.
      if (data.attributeNotice && !state.deliveryNoticeShownSession) {
        state.deliveryNotice = data.attributeNotice;
        state.deliveryNoticeShownSession = true;
      } else {
        state.deliveryNotice = null;
      }
      renderDeliveryNotice();
      if (contractBlocked) {
        clearInsertDiagnostics();
        setStatus(state.contextPack?.message || "Enhancivity could not prepare this prompt safely. Please adjust the instruction and try again.");
      } else {
        renderInsertDiagnostics(state.contextPack);
        setStatus("Review the prepared text, then insert it into the focused input.");
      }
      addEvent(`Prepared context pack (${limit})`);
    } catch (error) {
      setInsertProgress("hidden");
      setStatus(error instanceof Error ? error.message : "Could not prepare context.", { error: true });
    } finally {
      setBusy(el.prepareContextBtn, false);
      setBusy(el.addContextBtn, false);
      setTimeout(() => {
        if (!el.insertReview.classList.contains("hidden")) return;
        setInsertProgress("hidden");
      }, 500);
    }
  }

  function invalidatePreparedInsertReview(message = "Instruction changed. Prepare context again before inserting.") {
    if (!state.contextPack && el.insertReview.classList.contains("hidden")) return;
    state.contextPack = null;
    state.lastPreparedInsertInstruction = "";
    state.lastContextPreparedAt = 0;
    el.contextReview.value = "";
    el.contextReview.disabled = false;
    el.insertReviewedBtn.disabled = false;
    el.contextCount.textContent = formatMemoryUsedCount(0);
    clearInsertDiagnostics();
    el.insertReview.classList.add("hidden");
    setStatus(message);
  }

  function insertFeedbackMetadata(contextPack) {
    const metadata = contextPack?.metadata || {};
    return {
      itemCount: metadata.itemCount || 0,
      limit: metadata.limit || null,
      candidateCount: metadata.candidateCount || 0,
      preparationMode: metadata.preparationMode || null,
      fallbackReason: metadata.fallbackReason || null,
      rejectedCandidateCount: Number(metadata.qualityGate?.rejectedCandidateCount || 0),
      safetyReview: metadata.safetyReview || null,
      finalSanitation: metadata.finalSanitation || null,
      intent: metadata.intent || null,
      matchedSubprojects: metadata.matchedSubprojects || [],
      clientContext: metadata.clientContext || null,
    };
  }

  function buildInsertFeedbackPayload(finalText, insertionResponse, insertedAt) {
    const contextPack = state.contextPack || {};
    const metadata = contextPack.metadata || {};
    const clientContext = state.lastInsertContext || metadata.clientContext || {};
    const preparedAt = state.lastContextPreparedAt || insertedAt;
    const preparedText = contextPack.preparedText || "";
    const insertedText = typeof insertionResponse?.focusedInputText === "string"
      ? insertionResponse.focusedInputText
      : finalText;

    return {
      outcome: "inserted",
      sessionId: clientContext.sourceSessionId || `insert-${preparedAt}`,
      sourceTool: clientContext.sourceTool || metadata.intent?.sourceTool || "browser",
      sourceUrl: clientContext.sourceUrl || null,
      sourceSessionId: clientContext.sourceSessionId || null,
      surfaceType: clientContext.surfaceType || metadata.intent?.surfaceType || null,
      preparedText,
      finalText,
      insertedText,
      insertionInstruction: el.insertInstruction.value.trim(),
      clientContext,
      contextPackMetadata: insertFeedbackMetadata(contextPack),
      attributeInfluencePlan: metadata.attributeInfluencePlan || null,
      attributeSignals: [],
      timing: {
        preparedAt,
        insertedAt,
        reviewDurationMs: Math.max(0, insertedAt - preparedAt),
      },
      insertResult: {
        success: insertionResponse?.success === true,
        insertedLength: insertionResponse?.insertedLength || finalText.length,
        focusedTargetKind: clientContext.focusedTargetKind || null,
      },
    };
  }

  async function recordReviewedInsertFeedback(finalText, insertionResponse, insertedAt) {
    if (!state.contextPack || !state.selectedProjectId) return;
    const payload = buildInsertFeedbackPayload(finalText, insertionResponse, insertedAt);
    await apiRequest(`/projects/${encodeURIComponent(state.selectedProjectId)}/insert-feedback`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async function insertReviewedContext() {
    try {
      assertReady();
      const text = el.contextReview.value;
      if (state.contextPack?.finalContractBlocked || state.contextPack?.metadata?.finalContractBlocked) {
        setStatus(state.contextPack?.message || "Enhancivity could not prepare this prompt safely. Please adjust the instruction and try again.");
        return;
      }
      if (!text.trim()) {
        setStatus("There is no prepared text to insert.");
        return;
      }
      const response = await sendTabMessage({
        type: "MEMORY_LAYER_INSERT_CONTEXT",
        text,
        targetHint: {
          focusedField: state.lastInsertContext?.focusedField || null,
          focusedTargetKind: state.lastInsertContext?.focusedTargetKind || null,
        },
      });
      if (!response?.success) throw new Error(response?.error || "Insertion failed.");
      state.lastInsertCompletedAt = Date.now();
      // Unit 3d (part 2/2) — remember the request that produced this inserted prompt, so the
      // NEXT prepare can be checked for a near-duplicate re-request (the backend runs the
      // deterministic gate + decides). Replaced on each insert; the backend's time window
      // discards anything stale.
      const insertedInstruction = (state.lastPreparedInsertInstruction || "").trim();
      state.lastInsert = insertedInstruction
        ? { instruction: insertedInstruction, insertedAt: state.lastInsertCompletedAt }
        : null;
      recordReviewedInsertFeedback(text, response, state.lastInsertCompletedAt).catch(error => {
        console.warn("[MemoryLayer] Insert feedback learning skipped:", error);
      });
      setStatus("Inserted into the focused input. Submit manually in the tool.");
      addEvent("Inserted reviewed context");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not insert context.");
    }
  }

  function updateProposal(index, field, value) {
    state.proposals[index] = {
      ...state.proposals[index],
      [field]: value,
    };
  }

  // Fix 2 (show + confirm): a manual edit to the draft invalidates any
  // already-fetched recommendations/placement, because each recommendation snapshots
  // the proposal at fetch time. Clearing them (without a re-render, to avoid losing
  // textarea focus) means the next Save recomputes the destination from the edited
  // content before the user confirms.
  function editProposalField(index, field, value) {
    const proposal = state.proposals[index];
    if (!proposal) return;
    const next = { ...proposal, [field]: value };
    if (proposal.recommendations) {
      next.recommendations = undefined;
      next.evolutionMetadata = undefined;
    }
    state.proposals[index] = next;
  }

  function setProposalRecommendations(index, recommendations) {
    updateProposal(index, "recommendations", recommendations.map(recommendation => ({
      ...recommendation,
      confirmed: false,
    })));
    renderCaptureProposals();
  }

  function updateRecommendation(index, recommendationIndex, confirmed) {
    const proposal = state.proposals[index];
    if (!proposal?.recommendations) return;
    const recommendations = [...proposal.recommendations];
    recommendations[recommendationIndex] = {
      ...recommendations[recommendationIndex],
      confirmed,
    };
    updateProposal(index, "recommendations", recommendations);
  }

  function recommendationLabel(recommendation) {
    if (!recommendation) return "Change memory";
    if (recommendation.action === "update") {
      return `Update ${recommendation.targetMemoryItem?.title || "existing memory"}`;
    }
    if (recommendation.action === "supersede") {
      return `Supersede ${recommendation.targetMemoryItem?.title || "older memory"}`;
    }
    if (recommendation.action === "archive") {
      return `Archive ${recommendation.targetMemoryItem?.title || "lower-value memory"}`;
    }
    return "Save as new memory";
  }

  function renderRecommendationCards(card, proposal, index) {
    if (!Array.isArray(proposal.recommendations) || proposal.recommendations.length === 0) {
      return;
    }

    const list = document.createElement("div");
    list.className = "recommendation-list";

    proposal.recommendations.forEach((recommendation, recommendationIndex) => {
      const recommendationCard = document.createElement("label");
      recommendationCard.className = "recommendation-card";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = recommendation.confirmed === true;
      checkbox.addEventListener("change", event => {
        updateRecommendation(index, recommendationIndex, event.target.checked);
      });

      const text = document.createElement("span");
      text.className = "recommendation-copy";

      const title = document.createElement("strong");
      title.textContent = recommendationLabel(recommendation);

      const detail = document.createElement("span");
      detail.textContent = recommendation.rationale || recommendation.operation || "Review and apply this memory change.";

      text.append(title, detail);
      recommendationCard.append(checkbox, text);
      list.appendChild(recommendationCard);
    });

    card.appendChild(list);
  }

  function fallbackCaptureProposal(pageContext = {}) {
    return {
      type: "note",
      title: pageContext.pageTitle || "Captured memory",
      content: pageContext.userNote || pageContext.visibleText || "Captured visible context.",
      sourceType: pageContext.sourceType || "browser_visible_context",
      sourceTool: pageContext.sourceTool || "browser",
      sourceUrl: pageContext.sourceUrl || null,
      sourceSessionId: pageContext.sourceSessionId || null,
      importance: 3,
      sensitivity: "standard",
      status: "ACTIVE",
      metadata: { combinedProposalCount: 0 },
    };
  }

  function normalizeCaptureProposalsForReview(proposals, pageContext = {}) {
    const safeProposals = Array.isArray(proposals) ? proposals.filter(Boolean) : [];
    if (safeProposals.length === 0) return [fallbackCaptureProposal(pageContext)];
    const comparableText = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    return safeProposals.map((proposal, index) => {
      const title = String(proposal.title || "").trim() || `Captured memory ${index + 1}`;
      const body = String(proposal.content || "").trim();
      return {
        ...proposal,
        title,
        content: body || title,
        summary: proposal.summary || null,
        type: MEMORY_TYPES.includes(proposal.type) ? proposal.type : "note",
        sourceType: proposal.sourceType || pageContext.sourceType || "browser_visible_context",
        sourceTool: proposal.sourceTool || pageContext.sourceTool || "browser",
        sourceUrl: proposal.sourceUrl || pageContext.sourceUrl || null,
        sourceSessionId: proposal.sourceSessionId || pageContext.sourceSessionId || null,
        importance: proposal.importance || 3,
        sensitivity: proposal.sensitivity || "standard",
        status: proposal.status || "ACTIVE",
        metadata: {
          ...(proposal.metadata || {}),
          reviewProposalIndex: index,
          titleMatchedContent: title && body && comparableText(title) === comparableText(body),
        },
      };
    });
  }

  // Fix 2: surface capture failures where the user is actually looking — directly
  // under the Capture button, in red — instead of only the shared status line at the
  // top of the panel (which sits in a different card and is easily missed).
  function renderCaptureError(message) {
    state.proposals = [];
    el.captureReview.innerHTML = "";
    const block = document.createElement("p");
    block.className = "capture-error";
    block.setAttribute("role", "alert");
    block.textContent = message;
    el.captureReview.appendChild(block);
  }

  // Selection-first design capture: measured-vs-estimated provenance, real color
  // chips, and the LOCAL crop thumbnail (never uploaded for display — it only ever
  // rode the one extraction call) so the user can visually confirm fidelity
  // before anything becomes memory.
  function renderBrandSnapshotProvenance(card, proposal, index) {
    const snapshot = proposal?.metadata?.brandSnapshot;
    if (!snapshot || typeof snapshot !== "object") return;

    const tokens = Array.isArray(snapshot.tokens) ? snapshot.tokens : [];
    const sampledCount = tokens.filter(token => token.source === "pixel-sampled").length;
    const styledCount = tokens.filter(token => token.source === "computed-style").length;
    const parts = [];
    if (sampledCount > 0) parts.push(`${sampledCount} sampled from the design`);
    if (styledCount > 0) parts.push(`${styledCount} from page styles`);

    const badge = document.createElement("p");
    badge.className = "proposal-target";
    badge.textContent = `Design subject — measured values${parts.length ? `: ${parts.join(", ")}` : ""}`
      + (snapshot.visionUsed ? " · visual description from screenshot" : "")
      + (snapshot.colorScheme === "dark" ? " · captured in dark mode" : "");
    card.appendChild(badge);

    const swatches = tokens.filter(token => /^#[0-9a-f]{6}$/i.test(token.value || "")).slice(0, 8);
    if (swatches.length > 0) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:4px;margin:2px 0 6px;flex-wrap:wrap;";
      swatches.forEach(token => {
        const chip = document.createElement("span");
        chip.title = `${token.value} ${token.name || "color"} (${token.source})`;
        chip.style.cssText = `width:18px;height:18px;border-radius:4px;border:1px solid rgba(0,0,0,0.25);display:inline-block;background:${token.value};`;
        row.appendChild(chip);
      });
      card.appendChild(row);
    }

    if (state.lastDesignCrop) {
      const thumb = document.createElement("img");
      thumb.src = `data:image/jpeg;base64,${state.lastDesignCrop}`;
      thumb.alt = "Captured design crop";
      thumb.style.cssText = "max-width:100%;max-height:90px;object-fit:contain;border-radius:4px;margin:0 0 6px;display:block;";
      card.appendChild(thumb);
    }

    // A wrong pick should be a two-second correction, not a dismissal: drop this
    // draft (silently — mis-picks must not train the capture profile as
    // "dismissed") and restart the picker.
    if (Number.isInteger(index)) {
      const repick = document.createElement("button");
      repick.type = "button";
      repick.className = "ghost-btn";
      repick.textContent = "Re-pick design";
      repick.style.cssText = "margin:0 0 6px;";
      repick.addEventListener("click", () => repickDesign(index));
      card.appendChild(repick);
    }
  }

  function repickDesign(index) {
    if (state.subjectPick) return; // a pick is already in progress
    if (state.proposals[index]) {
      state.proposals.splice(index, 1);
      renderCaptureProposals();
    }
    captureDesign();
  }

  function renderCaptureProposals() {
    el.captureReview.innerHTML = "";
    if (state.proposals.length === 0) return;

    renderAttributeNotice();

    if (state.proposals.length > 1) {
      const bulkActions = document.createElement("div");
      bulkActions.className = "proposal-bulk-actions";

      const saveAll = document.createElement("button");
      saveAll.className = "primary-btn full";
      saveAll.type = "button";
      saveAll.textContent = "Save All Reviewed";
      saveAll.addEventListener("click", saveAllReviewedProposals);

      bulkActions.appendChild(saveAll);
      el.captureReview.appendChild(bulkActions);
    }

    state.proposals.forEach((proposal, index) => {
      const card = document.createElement("div");
      card.className = "proposal-card";

      const target = document.createElement("p");
      target.className = "proposal-target";
      target.textContent = proposalTargetLabel(proposal);

      const type = document.createElement("select");
      MEMORY_TYPES.forEach(memoryType => {
        const option = document.createElement("option");
        option.value = memoryType;
        option.textContent = memoryType;
        type.appendChild(option);
      });
      type.value = proposal.type || "note";
      type.addEventListener("change", event => editProposalField(index, "type", event.target.value));

      const title = document.createElement("input");
      title.value = proposal.title || "";
      title.placeholder = "Title";
      title.addEventListener("input", event => editProposalField(index, "title", event.target.value));

      const content = document.createElement("textarea");
      content.rows = 5;
      content.value = proposal.content || "";
      content.placeholder = "Memory content";
      content.addEventListener("input", event => editProposalField(index, "content", event.target.value));

      const actions = document.createElement("div");
      actions.className = "proposal-actions";

      const dismiss = document.createElement("button");
      dismiss.className = "ghost-btn";
      dismiss.type = "button";
      dismiss.textContent = "Dismiss";
      dismiss.addEventListener("click", () => {
        sendCaptureFeedback([buildCaptureFeedbackEvent(state.proposals[index], "dismissed")]);
        state.proposals.splice(index, 1);
        renderCaptureProposals();
      });

      const save = document.createElement("button");
      save.className = "primary-btn";
      save.type = "button";
      save.textContent = proposal.recommendations ? "Confirm Save" : "Save Reviewed Memory";
      save.addEventListener("click", () => saveProposal(index));

      actions.append(dismiss, save);
      card.append(target);
      renderBrandSnapshotProvenance(card, proposal, index);
      card.append(type, title, content);
      renderRecommendationCards(card, proposal, index);
      card.appendChild(actions);
      el.captureReview.appendChild(card);
    });
  }

  // --- Unit 2c: Tier-2 disclosure notice (non-blocking; never disturbs save/dismiss) ---

  // One small line above the cards with [Keep] / [Undo]. Renders only when the backend
  // handed us a notice (notices flag on + an attribute just armed). With no notice it adds
  // nothing, so the panel is identical to before.
  function renderAttributeNotice() {
    const notice = state.captureNotice;
    if (!notice || !notice.copy) return;

    const banner = document.createElement("div");
    banner.className = "attribute-notice";

    const copy = document.createElement("p");
    copy.className = "attribute-notice-copy";
    copy.textContent = notice.copy;

    const actions = document.createElement("div");
    actions.className = "attribute-notice-actions";

    const keep = document.createElement("button");
    keep.className = "ghost-btn";
    keep.type = "button";
    keep.textContent = "Keep";
    keep.addEventListener("click", () => respondToAttributeNotice("keep"));

    const undo = document.createElement("button");
    undo.className = "ghost-btn";
    undo.type = "button";
    undo.textContent = "Undo";
    undo.addEventListener("click", () => respondToAttributeNotice("undo"));

    actions.append(keep, undo);
    banner.append(copy, actions);
    el.captureReview.appendChild(banner);
  }

  // Fire-and-forget notice response (shared by capture + prepared-prompt notices). A failure
  // is silent — a disclosure response must never surface an error.
  function postNoticeResponse(noticeId, action) {
    if (!noticeId || !state.token) return;
    try {
      fetch(`${state.apiBase}/api/memory-layer/attribute-notices/${encodeURIComponent(noticeId)}/respond`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ action }),
      }).catch(() => {});
    } catch (_error) {
      // Disclosure response only — never surface an error for it.
    }
  }

  // Keep / Undo -> clear the line immediately so the tap feels instant, then post.
  function respondToAttributeNotice(action) {
    const notice = state.captureNotice;
    state.captureNotice = null;
    renderCaptureProposals();
    postNoticeResponse(notice && notice.id, action);
  }

  // --- Unit 3f: prepared-prompt (delivery-stage) disclosure notice, in #insert-review ---

  function renderDeliveryNotice() {
    if (!el.insertReviewNotice) return;
    el.insertReviewNotice.innerHTML = "";
    const notice = state.deliveryNotice;
    if (!notice || !notice.copy) return;

    const banner = document.createElement("div");
    banner.className = "attribute-notice";
    const copy = document.createElement("p");
    copy.className = "attribute-notice-copy";
    copy.textContent = notice.copy;
    const actions = document.createElement("div");
    actions.className = "attribute-notice-actions";
    const keep = document.createElement("button");
    keep.className = "ghost-btn";
    keep.type = "button";
    keep.textContent = "Keep";
    keep.addEventListener("click", () => respondToDeliveryNotice("keep"));
    const undo = document.createElement("button");
    undo.className = "ghost-btn";
    undo.type = "button";
    undo.textContent = "Undo";
    undo.addEventListener("click", () => respondToDeliveryNotice("undo"));
    actions.append(keep, undo);
    banner.append(copy, actions);
    el.insertReviewNotice.appendChild(banner);
  }

  function respondToDeliveryNotice(action) {
    const notice = state.deliveryNotice;
    state.deliveryNotice = null;
    renderDeliveryNotice();
    postNoticeResponse(notice && notice.id, action);
  }

  // --- Adaptive capture feedback (fire-and-forget; failures never disturb the UI) ---

  function captureProposalFingerprint(proposal) {
    return proposal?.metadata?.capture?.fingerprint
      || `idx-${proposal?.metadata?.reviewProposalIndex ?? "unknown"}`;
  }

  function captureProposalSnapshot(proposal) {
    return {
      type: proposal?.type || "note",
      title: proposal?.title || "",
      content: proposal?.content || "",
      summary: proposal?.summary || null,
      importance: proposal?.importance || null,
    };
  }

  function buildCaptureFeedbackEvent(proposal, action) {
    const fingerprint = captureProposalFingerprint(proposal);
    const original = state.captureSession?.originals?.get(fingerprint) || null;
    const event = {
      action,
      proposalFingerprint: proposal?.metadata?.capture?.fingerprint || null,
      // The proposal AS PROPOSED; the backend diffs finalProposal against it and
      // decides saved vs edited_saved itself.
      proposal: original || captureProposalSnapshot(proposal),
      timeToActionMs: state.captureSession?.proposedAt
        ? Date.now() - state.captureSession.proposedAt
        : undefined,
    };
    if (action === "saved") event.finalProposal = captureProposalSnapshot(proposal);
    return event;
  }

  function sendCaptureFeedback(events, { keepalive = false } = {}) {
    if (!Array.isArray(events) || events.length === 0) return;
    if (!state.token || !state.selectedProjectId || !state.captureSession) return;
    try {
      fetch(`${state.apiBase}/api/memory-layer/projects/${encodeURIComponent(state.selectedProjectId)}/capture-feedback`, {
        method: "POST",
        keepalive,
        headers: authHeaders(),
        body: JSON.stringify({
          captureId: state.captureSession.captureId || null,
          contextSignals: state.captureSession.contextSignals || null,
          events,
        }),
      }).catch(() => {});
    } catch (_error) {
      // Learning signal only — never surface an error for it.
    }
  }

  // "ignored" = proposals were shown but the user walked away (closed the panel or
  // started a fresh capture) without saving or dismissing them.
  function flushIgnoredCaptureProposals({ keepalive = false } = {}) {
    if (!state.captureSession || state.proposals.length === 0) return;
    const events = state.proposals
      .filter(proposal => proposal?.metadata?.capture?.fingerprint)
      .map(proposal => buildCaptureFeedbackEvent(proposal, "ignored"));
    sendCaptureFeedback(events, { keepalive });
    state.captureSession = null;
  }

  window.addEventListener("pagehide", () => {
    flushIgnoredCaptureProposals({ keepalive: true });
  });

  async function captureMemory(options = {}) {
    try {
      assertReady();
      setBusy(el.captureBtn, true);
      // A new capture abandons any leftover proposals from the previous one.
      flushIgnoredCaptureProposals();
      if (!options.captureSubject) state.lastDesignCrop = null;
      const pageResponse = await sendTabMessage({
        type: "MEMORY_LAYER_GET_PAGE_CONTEXT",
        userNote: el.captureNote.value,
      });
      if (!pageResponse?.success) throw new Error(pageResponse?.error || "Could not read visible page context.");
      let body = pageResponse.context;
      if (options.captureSubject) {
        // Selection-first design capture: measured values + (optional) transient
        // crop ride the same reviewed capture call. Tool identity comes from the
        // page context the extractor already detected.
        body = {
          ...pageResponse.context,
          captureSubject: {
            ...options.captureSubject,
            toolContext: {
              sourceTool: pageResponse.context?.sourceTool || null,
              surfaceKind: pageResponse.context?.surfaceType || null,
            },
          },
        };
      }
      const data = await apiRequest(`/projects/${encodeURIComponent(state.selectedProjectId)}/captures`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      state.proposals = normalizeCaptureProposalsForReview(
        data.capture?.proposedMemoryItems || data.proposedMemoryItems || [],
        pageResponse.context
      );
      // Remember this batch + the pre-edit snapshots for capture feedback.
      state.captureSession = {
        captureId: data.capture?.captureId || null,
        contextSignals: data.capture?.contextSignals || null,
        proposedAt: Date.now(),
        originals: new Map(state.proposals.map(proposal => [
          captureProposalFingerprint(proposal),
          captureProposalSnapshot(proposal),
        ])),
      };
      // Unit 2c — accept at most ONE disclosure notice per panel session (§7.3). The
      // backend already returns only the oldest queued; this client marker is the
      // session cap. Absent/notices-off -> stays null -> nothing renders.
      if (data.attributeNotice && !state.captureNoticeShownSession) {
        state.captureNotice = data.attributeNotice;
        state.captureNoticeShownSession = true;
      } else {
        state.captureNotice = null;
      }
      renderCaptureProposals();
      // Item 8: honest note when the capture was bounded by the mounted DOM, so the
      // user knows there may be more above/below than the region around their view.
      const regionNote = pageResponse.context?.visibleTextBoundedByDom
        ? " Captured the region around your view — scroll or select to capture more."
        : "";
      if (options.captureSubject) {
        // Honest design-capture outcome: say whether measured values actually came
        // back, instead of letting a values-less text capture look like success.
        const designCard = state.proposals.find(p => p?.metadata?.brandSnapshot);
        const measuredCount = designCard?.metadata?.brandSnapshot?.tokens?.length || 0;
        setStatus(designCard
          ? `Design memory draft ready — ${measuredCount} measured value${measuredCount === 1 ? "" : "s"}. Review and save.`
          : "Captured page text only — the design values did not come back. Pick the design itself (not its container) and try again.");
        addEvent(designCard ? "Captured design subject" : "Design capture fell back to page text");
      } else {
        setStatus(`Prepared ${state.proposals.length} memory ${state.proposals.length === 1 ? "draft" : "drafts"} for review.${regionNote}`);
        addEvent("Captured visible context");
      }
    } catch (error) {
      // Item 1: capture is 100% LLM-driven with no fake fallback. When the LLM is
      // unavailable the backend returns CAPTURE_AI_UNAVAILABLE; show an honest retry
      // message rather than a degraded result.
      const message = error?.code === "CAPTURE_AI_UNAVAILABLE"
        ? "Capture is temporarily unavailable, please try again."
        : (error instanceof Error ? error.message : "Could not capture memory.");
      setStatus(message);
      renderCaptureError(message);
    } finally {
      setBusy(el.captureBtn, false);
    }
  }

  // ---- Selection-first design capture --------------------------------------

  function cancelPendingSubjectPick(reason) {
    const pending = state.subjectPick;
    if (!pending) return;
    clearTimeout(pending.timer);
    state.subjectPick = null;
    pending.resolve({ cancelled: true, reason });
  }

  function waitForSubjectPick(tabId, timeoutMs = 180000) {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (state.subjectPick?.tabId !== tabId) return;
        state.subjectPick = null;
        chrome.tabs.sendMessage(tabId, { type: "MEMORY_LAYER_CANCEL_SUBJECT_PICKER" }, { frameId: 0 })
          .catch(() => {});
        resolve({ cancelled: true, reason: "timeout" });
      }, timeoutMs);
      state.subjectPick = { tabId, resolve, timer };
    });
  }

  // Push completion from the picker content script (user-paced, so it cannot be a
  // synchronous sendMessage response).
  chrome.runtime.onMessage.addListener((message, sender) => {
    const pending = state.subjectPick;
    if (!pending || sender?.tab?.id !== pending.tabId) return false;
    if (message?.type === "MEMORY_LAYER_SUBJECT_PICKED") {
      clearTimeout(pending.timer);
      state.subjectPick = null;
      pending.resolve({ cancelled: false, payload: message.payload || {} });
    } else if (message?.type === "MEMORY_LAYER_SUBJECT_PICK_CANCELLED") {
      clearTimeout(pending.timer);
      state.subjectPick = null;
      pending.resolve({ cancelled: true, reason: message.reason || "cancelled" });
    }
    return false;
  });

  async function startPickerOnTab(tab) {
    const message = { type: "MEMORY_LAYER_START_SUBJECT_PICKER" };
    try {
      return await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
    } catch (error) {
      if (!isMissingContentScriptError(error)) throw error;
      await injectMemoryLayerContent(tab.id);
      return chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
    }
  }

  async function captureSingleSubjectPixels(tab, captureSubject) {
    return chrome.runtime.sendMessage({
      type: "MEMORY_LAYER_CAPTURE_SUBJECT_PIXELS",
      windowId: tab.windowId,
      rectCss: captureSubject.selection?.rectCss,
      viewport: captureSubject.selection?.viewport,
      visualViewport: captureSubject.selection?.visualViewport || null,
    });
  }

  async function captureSegmentedSubjectPixels(tab, captureSubject) {
    const layout = computeSegmentLayout({
      docRectCss: captureSubject.selection?.docRectCss,
      viewportH: captureSubject.selection?.viewport?.h,
    });
    if (layout.length <= 1) return captureSingleSubjectPixels(tab, captureSubject);

    const pickId = makeCapturePickId();
    const originalScrollY = Number.isFinite(Number(captureSubject.selection?.scrollY))
      ? Number(captureSubject.selection.scrollY)
      : null;
    let completed = false;
    let finalPixels = null;

    try {
      for (let index = 0; index < layout.length; index += 1) {
        if (index > 0) await sleep(SEGMENT_CAPTURE_THROTTLE_MS);
        setStatus(`Sampling design colors (segment ${index + 1} of ${layout.length})...`);
        const measured = await chrome.tabs.sendMessage(tab.id, {
          type: "MEMORY_LAYER_SCROLL_TO_SEGMENT",
          scrollY: layout[index].scrollY,
        }, { frameId: 0 });
        if (!measured?.success) {
          throw new Error(measured?.cancelled === "selection_moved"
            ? "The selection moved during segmented capture - pick it again."
            : "Could not scroll the selected design for segmented capture.");
        }
        const pixels = await chrome.runtime.sendMessage({
          type: "MEMORY_LAYER_CAPTURE_SUBJECT_PIXELS",
          windowId: tab.windowId,
          rectCss: measured.rectCss,
          viewport: measured.viewport,
          visualViewport: measured.visualViewport || null,
          segment: { index, count: layout.length, pickId },
        });
        if (!pixels?.success) {
          throw new Error("Could not sample one of the design segments - pick it again.");
        }
        if (index === layout.length - 1) finalPixels = pixels;
      }
      completed = true;
      return finalPixels;
    } finally {
      if (originalScrollY != null) {
        try {
          await chrome.tabs.sendMessage(tab.id, {
            type: "MEMORY_LAYER_SCROLL_TO_SEGMENT",
            scrollY: originalScrollY,
          }, { frameId: 0 });
        } catch (_err) {
          // Best effort: capture has already succeeded or failed honestly.
        }
      }
      if (!completed) {
        chrome.runtime.sendMessage({
          type: "MEMORY_LAYER_CANCEL_SUBJECT_PIXEL_SEGMENTS",
          pickId,
        }).catch(() => {});
      }
    }
  }

  async function captureDesign() {
    // Second press while a pick is pending = cancel (toggle).
    if (state.subjectPick) {
      const pendingTabId = state.subjectPick.tabId;
      cancelPendingSubjectPick("panel_cancelled");
      chrome.tabs.sendMessage(pendingTabId, { type: "MEMORY_LAYER_CANCEL_SUBJECT_PICKER" }, { frameId: 0 })
        .catch(() => {});
      setStatus("Design pick cancelled.");
      return;
    }
    try {
      assertReady();
      const tab = await getActiveTab();
      if (!tab?.id) throw new Error("No active tab found.");
      const started = await startPickerOnTab(tab);
      if (!started?.success) throw new Error(started?.error || "Could not start the design picker on this page.");
      // Button stays ENABLED while the user is picking — pressing it again is the
      // cancel toggle above. It only goes busy once real work starts.
      el.captureDesignBtn.textContent = "Cancel Design Pick";
      setStatus("Pick the design on the page: click it. Alt/Shift+Alt (or Alt+wheel) walk parent/child, drag selects a region, Esc cancels.");

      const picked = await waitForSubjectPick(tab.id);
      el.captureDesignBtn.textContent = "Capture This Design";
      if (picked.cancelled) {
        const cancelMessages = {
          timeout: "Design pick timed out — try again.",
          selection_moved: "The selection moved before the shot was taken — pick it again.",
        };
        setStatus(cancelMessages[picked.reason] || "Design pick cancelled.");
        return;
      }
      setBusy(el.captureDesignBtn, true);

      const captureSubject = { ...picked.payload };
      state.lastDesignCrop = null; // no stale thumbnail from a previous pick

      if (captureSubject.subjectType === "pixel-subject") {
        setStatus("Sampling design colors…");
        const shouldSegment = MEMORY_LAYER_CAPTURE_SUBJECT_SEGMENTS
          && captureSubject.selection?.docRectCss;
        const pixels = shouldSegment
          ? await captureSegmentedSubjectPixels(tab, captureSubject)
          : await captureSingleSubjectPixels(tab, captureSubject);
        if (!pixels?.success || !Array.isArray(pixels.palette) || pixels.palette.length === 0) {
          // Honest failure: a pixel subject without sampled colors has no measured
          // values to carry — never send a hollow design capture.
          throw new Error("Could not sample the design pixels — bring the design fully into view and try again.");
        }
        captureSubject.palette = pixels.palette;
        if (pixels.imageJpegBase64) captureSubject.imageJpegBase64 = pixels.imageJpegBase64;
        if (pixels.segmentCount > 1 && captureSubject.selection) {
          captureSubject.selection.segments = pixels.segmentCount;
        }
        // Kept locally only, for the review-panel thumbnail.
        state.lastDesignCrop = pixels.imageJpegBase64 || null;
      }

      setStatus("Preparing design memory…");
      await captureMemory({ captureSubject });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not capture the design.");
    } finally {
      el.captureDesignBtn.textContent = "Capture This Design";
      setBusy(el.captureDesignBtn, false);
    }
  }

  async function prepareProposalRecommendations(proposal, index) {
    const targetProjectId = proposalTargetProjectId(proposal);
    const recommendationData = await apiRequest(`/projects/${encodeURIComponent(targetProjectId)}/memory/evolution-recommendations`, {
      method: "POST",
      body: JSON.stringify({ proposedMemoryItem: proposal }),
    });
    const recommendations = recommendationData.memoryEvolution?.recommendations || [];
    const evolutionMetadata = recommendationData.memoryEvolution?.metadata || null;
    if (recommendations.length === 0) {
      throw new Error("No memory recommendation was returned.");
    }

    updateProposal(index, "evolutionMetadata", evolutionMetadata);
    setProposalRecommendations(index, recommendations);
    return recommendations;
  }

  async function applyReviewedRecommendations(proposal) {
    const targetProjectId = proposalTargetProjectId(proposal);
    const acceptedRecommendations = Array.isArray(proposal.recommendations)
      ? proposal.recommendations
      : [];
    if (!acceptedRecommendations.some(recommendation => recommendation.confirmed)) {
      return { appliedCount: 0, skippedCount: acceptedRecommendations.length };
    }

    const applyData = await apiRequest(`/projects/${encodeURIComponent(targetProjectId)}/memory/evolution-recommendations/apply`, {
      method: "POST",
      body: JSON.stringify({ acceptedRecommendations }),
    });
    return applyData.memoryEvolutionApply?.metadata || { appliedCount: 0, skippedCount: 0 };
  }

  async function saveProposal(index, options = {}) {
    const proposal = state.proposals[index];
    if (!proposal) return false;
    try {
      if (!proposal.recommendations) {
        const recommendations = await prepareProposalRecommendations(proposal, index);
        if (recommendations.length === 0) {
          throw new Error("No memory recommendation was returned.");
        }
        // Pre-confirm the recommended actions so the user can apply with a single
        // confirm click (they can still uncheck a destructive action first).
        updateProposal(index, "recommendations", state.proposals[index].recommendations.map(recommendation => ({
          ...recommendation,
          confirmed: true,
        })));
        // Fix 2: show + confirm. Stop here on the individual Save so the user can see
        // WHERE it will be saved (the destination label + actions just rendered) and
        // confirm with a second click. The bulk "Save All" path passes autoApply.
        if (!options.autoApply) {
          // Re-render so the checkboxes reflect the pre-confirmed state and the button
          // shows "Confirm Save".
          renderCaptureProposals();
          if (!options.quiet) {
            const targetLabel = proposalTargetLabel(state.proposals[index]);
            setStatus(targetLabel
              ? `${targetLabel}. Review and click Confirm Save.`
              : "Review where this will be saved, then click Confirm Save.");
          }
          return false;
        }
      }

      const result = await applyReviewedRecommendations(state.proposals[index]);
      if (!result.appliedCount) {
        if (!options.quiet) setStatus("No memory changes were applied.");
        addEvent("Skipped memory proposal");
        return false;
      }
      // The backend diffs this final version against the original proposal and
      // records saved vs edited_saved itself.
      sendCaptureFeedback([buildCaptureFeedbackEvent(state.proposals[index], "saved")]);
      await loadProjects();
      state.proposals.splice(index, 1);
      renderCaptureProposals();
      if (!options.quiet) {
        const autoCreatedSubprojectNames = Array.isArray(result.autoCreatedSubprojectNames)
          ? result.autoCreatedSubprojectNames.filter(Boolean)
          : [];
        if (autoCreatedSubprojectNames.length > 0) {
          setStatus(`Saved reviewed memory. Auto-created subprojects: ${autoCreatedSubprojectNames.join(", ")}.`);
        } else {
          setStatus("Saved reviewed memory.");
        }
      }
      addEvent("Saved memory proposal");
      return true;
    } catch (error) {
      if (!options.quiet) setStatus(error instanceof Error ? error.message : "Could not save memory.");
      return false;
    }
  }

  async function saveAllReviewedProposals() {
    if (state.proposals.length === 0) return;
    const startingCount = state.proposals.length;
    setBusy(el.captureBtn, true);
    setStatus(`Saving ${startingCount} reviewed memories...`);
    let savedCount = 0;

    try {
      while (state.proposals.length > 0) {
        const saved = await saveProposal(0, { quiet: true, autoApply: true });
        if (!saved) break;
        savedCount += 1;
      }
      renderCaptureProposals();
      if (state.proposals.length === 0) {
        setStatus(`Saved ${savedCount} reviewed ${savedCount === 1 ? "memory" : "memories"}.`);
      } else {
        setStatus(`Saved ${savedCount} reviewed ${savedCount === 1 ? "memory" : "memories"}. Review the remaining ${state.proposals.length}.`);
      }
    } finally {
      setBusy(el.captureBtn, false);
    }
  }

  async function init() {
    renderEvents();
    const storage = await chrome.storage.local.get([
      "token",
      "memoryLayerUser",
      "memoryLayerApiBase",
      "memoryLayerSelectedProjectId",
      "memoryLayerMemoryScope",
      STORAGE_DEV_PRIMARY_AI_WRITER,
    ]);
    state.token = storage.token || "";
    state.user = storage.memoryLayerUser || null;
    state.hasStoredApiBase = Object.prototype.hasOwnProperty.call(storage, "memoryLayerApiBase");
    state.apiBase = storage.memoryLayerApiBase || state.apiBase;
    if (isLocalDevMemoryLayerApiBase()) {
      state.apiBase = DEFAULT_MEMORY_LAYER_API_BASE;
      state.hasStoredApiBase = true;
      await chrome.storage.local.set({ memoryLayerApiBase: state.apiBase });
    }
    state.selectedProjectId = storage.memoryLayerSelectedProjectId || "";
    state.memoryScopeSelection = storage.memoryLayerMemoryScope || "";
    state.primaryAiWriterDevEnabled = parseDevBooleanFlag(storage[STORAGE_DEV_PRIMARY_AI_WRITER]);

    if (!state.token) {
      showAuth();
      return;
    }

    showApp();
    syncDevPrimaryAiWriterCheckbox();
    try {
      await loadProjects();
      await loadProviderKeyStatus();
      if (state.selectedProjectId) {
        setStatus("Choose a project, then wake Enhancivity when you want to use memory on this page.");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load projects.");
    }
  }

  el.projectSelect.addEventListener("change", async event => {
    state.selectedProjectId = event.target.value;
    await chrome.storage.local.set({ memoryLayerSelectedProjectId: state.selectedProjectId });
    renderMemoryScopeSelect();
    addEvent("Selected project");
    setStatus("Selected active project for insert and capture. Wake Enhancivity when ready.");
  });
  if (el.memoryScopeSelect) {
    el.memoryScopeSelect.addEventListener("change", async () => {
      state.memoryScopeSelection = el.memoryScopeSelect.value || "";
      await chrome.storage.local.set({ memoryLayerMemoryScope: state.memoryScopeSelection });
      invalidatePreparedInsertReview("Memory scope changed. Prepare context again before inserting.");
      addEvent("Updated memory scope");
    });
  }
  el.wakeBtn.addEventListener("click", wakeMemoryLayer);
  el.refreshBtn.addEventListener("click", refreshMemoryLayerData);
  el.prepareContextBtn.addEventListener("click", () => prepareContext(12));
  el.addContextBtn.addEventListener("click", () => prepareContext(24));
  el.insertInstruction.addEventListener("input", () => {
    if (!state.contextPack) return;
    if (el.insertInstruction.value.trim() === state.lastPreparedInsertInstruction) return;
    invalidatePreparedInsertReview();
  });
  el.insertReviewedBtn.addEventListener("click", insertReviewedContext);
  // Unit 3e — expand the prepared prompt into a large, readable, EDITABLE view so review +
  // edit happen HERE (on our surface), not blind downstream. Same #context-review textarea,
  // so copy/insert and the generated-vs-edited diff (-> prompt_edited) are unchanged.
  if (el.expandReviewBtn) {
    el.expandReviewBtn.addEventListener("click", () => {
      const expanded = el.insertReview.classList.toggle("expanded");
      el.expandReviewBtn.textContent = expanded ? "Collapse" : "Expand";
      el.expandReviewBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
      if (expanded) el.contextReview.focus();
    });
  }
  el.captureBtn.addEventListener("click", () => captureMemory());
  if (el.captureDesignBtn) el.captureDesignBtn.addEventListener("click", captureDesign);
  el.settingsBtn.addEventListener("click", () => toggleSettingsPanel());
  el.closeSettingsBtn.addEventListener("click", () => toggleSettingsPanel(false));
  el.profileBtn.addEventListener("click", event => {
    event.stopPropagation();
    toggleProfilePanel();
  });
  el.profilePanel.addEventListener("click", event => {
    event.stopPropagation();
  });
  el.providerKeyForm.addEventListener("submit", saveProviderKey);
  el.removeProviderKeyBtn.addEventListener("click", removeProviderKey);
  el.providerSelect.addEventListener("change", updateProviderKeyControls);
  el.openDashboardBtn.addEventListener("click", openDashboard);
  el.logoutBtn.addEventListener("click", logout);
  el.authForm.addEventListener("submit", loginOrSignup);
  el.authGoogleBtn.addEventListener("click", loginWithGoogle);
  el.authLoginTab.addEventListener("click", () => setAuthMode("login"));
  el.authSignupTab.addEventListener("click", () => setAuthMode("signup"));

  if (el.devPrimaryAiWriter) {
    el.devPrimaryAiWriter.addEventListener("change", async () => {
      const on = el.devPrimaryAiWriter.checked === true;
      state.primaryAiWriterDevEnabled = on;
      await chrome.storage.local.set({ [STORAGE_DEV_PRIMARY_AI_WRITER]: on });
    });
  }

  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (!changes[STORAGE_DEV_PRIMARY_AI_WRITER]) return;
      state.primaryAiWriterDevEnabled = parseDevBooleanFlag(changes[STORAGE_DEV_PRIMARY_AI_WRITER].newValue);
      syncDevPrimaryAiWriterCheckbox();
    });
  }

  if (chrome.tabs?.onActivated) {
    chrome.tabs.onActivated.addListener(scheduleWakeSync);
  }
  if (chrome.tabs?.onUpdated) {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (tabId === state.activeTabId || changeInfo.status === "complete") {
        scheduleWakeSync();
      }
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleWakeSync();
  });
  document.addEventListener("click", closeProfilePanel);

  setAuthMode("login");
  init();
})();
