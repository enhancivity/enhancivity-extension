# Consequential Action System — One-Inch Rule Implementation

## Philosophy

The Enhancivity agent does 99% of the work. The user touches only the final 1% — the irreversible action. This is the **One-Inch Rule**: the agent brings every task to the absolute edge of completion, then pauses for human confirmation on actions that have real-world consequences.

**Non-consequential** (agent acts freely): reading, searching, navigating, scrolling, scraping, form pre-filling, clicking navigation links.

**Consequential** (agent pauses for user): sending email, buying, deleting data, submitting forms with irreversible outcomes, payment authorization.

---

## Architecture Overview

The system has **three independent layers** that enforce consent, each operating at a different level of the stack:

```
┌──────────────────────────────────────────────────────────────┐
│  LAYER 1: Backend (agentProcess.js)                          │
│  Server-enforced consent_level on every AI response          │
│  CONSENT_MAP assigns: auto / soft / hard per action_type     │
│  AI never decides consent — server overwrites it             │
├──────────────────────────────────────────────────────────────┤
│  LAYER 2: EXPLORE Mode (content_explore.js)                  │
│  isDangerousClick() — hardcoded button text matching          │
│  BLOCKED unless AI sent needsConsent=true AND user approved  │
│  → Returns error string that tells AI to set needsConsent    │
├──────────────────────────────────────────────────────────────┤
│  LAYER 3: Recipe Replay (content_replay.js)                  │
│  isConsequentialClick() — hardcoded patterns + live element   │
│  Overlay banner + pulsing highlight + countdown/Skip         │
│  Replay STOPS — user must click the button themselves        │
└──────────────────────────────────────────────────────────────┘
```

**Key design: these layers are redundant on purpose.** If one layer fails to catch a dangerous action, the next layer catches it. The agent cannot send an email, make a purchase, or delete data without passing through at least one (usually two) consent gates.

---

## Layer 1: Backend Consent Map

**File:** `enhancivity-main/routes/agentProcess.js` (lines 219-261)

The backend assigns a `consent_level` to every AI response based on the `action_type`. The AI model never decides the consent tier — the server overwrites whatever the AI returns.

```
CONSENT_MAP = {
  // auto = execute immediately, no user confirmation
  RECOMMENDATION:   'auto'
  NAVIGATE:         'auto'
  USE_EXISTING_TAB: 'auto'
  SEARCH_SITE:      'auto'
  ORCHESTRATE:      'auto'
  FILL_FORM:        'auto'    // pre-fill only, never submits
  MULTI_STEP:       'auto'
  EXPLORE:          'auto'    // consent handled mid-loop by Layer 2
  CLARIFY:          'auto'
  PARALLEL_EXPLORE: 'auto'

  // soft = one consent click required
  TASK_DRAFT:       'soft'
  EXTRACT_TASKS:    'soft'
  COMPOSE_EMAIL:    'soft'    // shows preview before inserting into compose
  FIND_AND_REPLY:   'soft'    // pre-fills reply, user clicks Send manually

  // hard = hard confirmation required
  ADD_TO_CART:      'hard'
}
```

**What this controls:** The extension's popup/side panel shows a consent card (Approve/Cancel) for `soft` and `hard` actions before executing. `auto` actions execute immediately after the AI responds.

**Important:** EXPLORE is `auto` at the top level because consent is handled *inside* the exploration loop (Layer 2), not at the initial action level.

---

## Layer 2: EXPLORE Mode Safety — `isDangerousClick()`

**File:** `enhancivity-extension/content_explore.js` (lines 420-462)

This is the runtime safety net for the EXPLORE autonomous loop. When the AI agent clicks buttons during exploration, every click passes through `isDangerousClick()`.

### The Hardcoded Lists

```javascript
// EXACT MATCH — entire button text must be exactly this word
DANGEROUS_EXACT = new Set([
  'send', 'submit', 'post', 'publish', 'pay', 'delete', 'remove'
]);

// PHRASE MATCH — button text must CONTAIN this phrase
DANGEROUS_PHRASE = [
  'purchase', 'buy now', 'place order', 'confirm order',
  'complete purchase', 'checkout', 'place your order'
];
```

### Two-Tier Matching Strategy

1. **Exact match** — The ENTIRE visible text of the button must be exactly one of the `DANGEROUS_EXACT` words. This prevents false positives like "Create Post" or "Post Launch" from being blocked — only a button whose full text is literally "Post" gets caught.

2. **Phrase match** — The button text must CONTAIN one of the `DANGEROUS_PHRASE` strings. These are multi-word phrases specific enough to avoid false positives (nobody has a navigation link called "place order").

### Chatbot Allowlist

```javascript
CHATBOT_ALLOWLIST = [
  'chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com'
];
```

On chatbot sites, "send" and "submit" are safe (they just send a chat message). But `pay`, `delete`, `remove`, and all `DANGEROUS_PHRASE` entries remain blocked even on chatbot sites.

### What Happens When Blocked

When `isDangerousClick()` returns `true` and the AI hasn't set `needsConsent=true`:

```
→ Returns: { success: false, error: 'BLOCKED: This button performs a
  consequential action (submit/post/send/delete). Set needsConsent=true
  to request user approval first.', blocked: true }
```

The AI sees this error in its next step's observation and must retry with `needsConsent: true`. This triggers a **consent card** in the extension UI:

```
background.js → detects decision.needsConsent === true
  → Sends consent card to side panel / popup
  → User clicks Approve or Cancel
  → If approved: decision.nextAction.consentApproved = true
  → Re-executes the click with consentApproved flag
  → isDangerousClick() is bypassed when consentApproved === true
```

### The AI's Prompt Instructions (agentExploreStep.js)

The AI is explicitly told in its system prompt:

- "Buttons labeled Send, Pay, Submit, Post, Buy, Place Order, Confirm Purchase, Delete, Remove are BLOCKED by default."
- "Set needsConsent=true ONLY for actions that modify data, submit forms, or navigate to payment pages."
- "SUBMISSION FLOW (One-Inch Rule): After typing ALL content into all fields, you MUST attempt to click the Submit/Post/Send/Publish button with needsConsent=true."

---

## Layer 3: Recipe Replay Safety — `isConsequentialClick()`

**File:** `enhancivity-extension/content_replay.js` (lines 531-596)

This layer protects against consequential actions during **recipe replay** (deterministic workflows). Unlike EXPLORE, which has AI-in-the-loop, recipe replay is fully automated — so the safety net must be hardcoded and self-contained.

### The Hardcoded Patterns

```javascript
// Master detection pattern — catches the button in the first place
CONSEQUENTIAL_CLICK_PATTERNS = /\b(send|submit|purchase|buy\s*now|place\s*order|
  confirm\s*order|pay\s*now|checkout|delete|remove|unsubscribe|
  cancel\s*subscription|sign\s*out|log\s*out)\b/i;

// ARIA-specific pattern (for buttons with aria-label but no visible text)
CONSEQUENTIAL_ARIA_PATTERNS = /\b(send|submit|purchase|buy|place.order|
  pay|delete|remove)\b/i;
```

### Category Classification

```javascript
PURCHASE_KEYWORDS = /\b(buy|purchase|place\s*order|confirm\s*order|checkout)\b/i;
PAYMENT_KEYWORDS  = /\b(pay|confirm\s*payment|authorize|transfer|wire)\b/i;
SEND_KEYWORDS     = /\b(send|reply|forward|post|publish|tweet|share)\b/i;
DELETE_KEYWORDS   = /\b(delete|remove|unsubscribe|cancel\s*subscription|
                       close\s*account|deactivate)\b/i;
```

If none match: defaults to `'confirm'` category.

### Timeouts Per Category

| Category   | Timeout  | Behavior                                              |
|-----------|----------|-------------------------------------------------------|
| purchase  | 0 (∞)    | Wait indefinitely — never auto-skip a purchase        |
| payment   | 0 (∞)    | Wait indefinitely — never auto-skip a payment         |
| delete    | 20 sec   | Auto-skip after 20s (user had time to review)         |
| send      | 15 sec   | Auto-skip after 15s (email/message already composed)  |
| confirm   | 15 sec   | Generic fallback — 15s                                |

**"Auto-skip" means the replay reports `skippedConsequential: true` and stops.** It does NOT click the button. The button stays highlighted for the user to click manually.

### Detection Logic (`isConsequentialClick`)

The function checks **three sources** for consequential signals:

1. **Recipe action metadata** — `action.description`, `action.semanticContext.label`, `action.semanticContext.ariaLabel`, `action.semanticContext.text`

2. **Live DOM element** — The actual button's `textContent`, `aria-label`, and `type` attribute at execution time

3. **Gmail-specific deep check** — For Gmail's Send button which uses `role="button"` with `aria-label="Send"` or `data-tooltip="Send"` (the button text may be an icon, not text)

```javascript
// Gmail-specific: Send button detection
if (element.closest('[role="button"]')?.getAttribute('aria-label')
    ?.toLowerCase().includes('send')) return true;
if (element.closest('[data-tooltip]')?.getAttribute('data-tooltip')
    ?.toLowerCase().includes('send')) return true;
```

### The Overlay Banner UI

When a consequential action is detected, the system creates:

1. **Full-width overlay banner** at the top of the page (z-index: max) with glassmorphism styling and amber border
2. **Category-specific message**: "Message ready — click 'Send' when you want to send"
3. **Countdown timer** (if timeout > 0): shows remaining seconds in amber
4. **Skip button**: user can skip the action (replay stops, button stays highlighted)
5. **Pulsing highlight** on the target button: amber outline with red pulse animation

### Three Resolution Paths

| User Action       | Result                                                |
|------------------|-------------------------------------------------------|
| Clicks the button | `{ action: 'clicked' }` — action executes, replay continues |
| Clicks Skip      | `{ action: 'skipped' }` — replay stops, button stays highlighted |
| Timeout expires  | `{ action: 'timeout' }` — same as Skip (replay stops) |

After Skip or Timeout, the replay returns `{ success: true, skippedConsequential: true }` and the chain executor records the step as "awaiting user action."

---

## How the Three Layers Interact

### Scenario: User says "send email to john@gmail.com about the meeting"

```
1. Backend (Layer 1):
   → AI returns action_type: COMPOSE_EMAIL
   → CONSENT_MAP['COMPOSE_EMAIL'] = 'soft'
   → Extension shows consent card: "Draft email to john@gmail.com?"
   → User clicks Approve

2. Recipe Replay (Layer 3) — if a "compose email" recipe exists:
   → Fills To field, Subject, Body
   → Reaches the Send button step
   → isConsequentialClick() → TRUE (SEND_KEYWORDS matches)
   → classifyConsequentialCategory() → 'send'
   → getTimeoutForCategory('send') → 15000ms
   → Overlay banner: "Message ready — click 'Send' when you want to send"
   → Replay STOPS. User clicks Send manually.

3. EXPLORE Mode (Layer 2) — if no recipe, EXPLORE composes the email:
   → AI types in To, Subject, Body
   → AI tries to click Send button
   → isDangerousClick() → TRUE ('send' in DANGEROUS_EXACT)
   → Returns BLOCKED error to AI
   → AI retries with needsConsent=true
   → Consent card shown: "Ready to send your reply. Approve to send."
   → User clicks Approve → button click executes
```

### Scenario: User says "buy this laptop on Amazon"

```
1. Backend (Layer 1):
   → action_type: EXPLORE (or ADD_TO_CART)
   → ADD_TO_CART = 'hard' consent

2. EXPLORE Mode (Layer 2):
   → isDangerousClick() → TRUE ('buy now', 'place order', 'purchase')
   → BLOCKED unless needsConsent was set
   → Consent card with payment warning

3. Recipe Replay (Layer 3):
   → PURCHASE_KEYWORDS match
   → Timeout: 0 (waits FOREVER — never auto-skips a purchase)
   → User must physically click the Buy button
```

---

## Edge Cases and Known Behaviors

### False Negatives (Dangerous button NOT caught)

| Risk                               | Mitigation                                              |
|-----------------------------------|---------------------------------------------------------|
| Button text in non-English language | Not caught — keywords are English-only. Future: use AI classification |
| Button is an icon with no text/ARIA | Layer 3 has Gmail-specific check for `data-tooltip`. Other sites may miss icon-only buttons |
| Button text uses synonyms ("Dispatch", "Transmit") | Not caught. The hardcoded lists cover common patterns only |
| Custom web app with unusual button text | Missed. EXPLORE Layer 2 relies on AI also setting needsConsent=true as backup |

### False Positives (Safe button incorrectly blocked)

| Risk                               | Mitigation                                              |
|-----------------------------------|---------------------------------------------------------|
| "Send" button on chatbot sites     | CHATBOT_ALLOWLIST exempts known chatbot domains         |
| Navigation link containing "submit" | Layer 2 uses EXACT match ("submit" must be the full text) |
| "Delete" in a non-destructive context | Rare — "delete" almost always means destructive intent  |
| "Post" as in "blog post" nav link  | EXACT match: only blocked if full button text is "Post" |

### The Gmail Send Button Specifically

Gmail's Send button is notoriously hard to detect because:
- The visible text may just be "Send" or may be localized
- The button uses `role="button"` with `aria-label="Send \u202A(⌘Enter)\u202C"` (includes keyboard shortcut)
- It sometimes uses `data-tooltip="Send"` instead of visible text

Layer 3 (recipe replay) has **two Gmail-specific checks**:
```javascript
element.closest('[role="button"]')?.getAttribute('aria-label')?.includes('send')
element.closest('[data-tooltip]')?.getAttribute('data-tooltip')?.includes('send')
```

Layer 2 (EXPLORE) relies on `isDangerousClick()` which reads `element.innerText` — if Gmail renders "Send" as visible text, it matches `DANGEROUS_EXACT`. If it's an icon, the AI must set `needsConsent=true` (the system prompt instructs it to do so for send buttons).

### Facebook "Post" / "Submit" Buttons

Facebook uses various button text: "Post", "Share", "Send", "Publish". All of these are in `DANGEROUS_EXACT` (Layer 2) and `CONSEQUENTIAL_CLICK_PATTERNS` / `SEND_KEYWORDS` (Layer 3). They will be caught.

Facebook Ads "Submit" button → caught by `DANGEROUS_EXACT` ("submit") and `CONSEQUENTIAL_CLICK_PATTERNS` ("submit").

---

## The One Fundamental Hardcoded Truth

**There is ONE central source of truth for what constitutes a dangerous click, but it exists in TWO places** (one per execution mode):

| Mode          | File                | Function              | Lists Used                                           |
|--------------|--------------------|-----------------------|------------------------------------------------------|
| EXPLORE      | content_explore.js | `isDangerousClick()`  | `DANGEROUS_EXACT` + `DANGEROUS_PHRASE`               |
| Recipe Replay | content_replay.js  | `isConsequentialClick()` | `CONSEQUENTIAL_CLICK_PATTERNS` + `CONSEQUENTIAL_ARIA_PATTERNS` |

**These two lists are NOT identical** — they use different matching strategies (exact vs regex) because EXPLORE and Recipe Replay have different risk profiles:

- **EXPLORE** can always retry (AI sees the BLOCKED error and adjusts) → stricter exact matching to minimize false positives
- **Recipe Replay** is automated with no AI in the loop → broader regex matching to minimize false negatives

Both lists cover the same core dangerous words: **send, submit, purchase, buy, pay, delete, remove, post, publish, checkout, place order, confirm order**.

---

## Summary: Why This System Is Safe

1. **Defense in depth** — Three independent layers, each with its own detection logic
2. **Server-enforced** — The AI never decides consent level; the backend overwrites it
3. **Purchase protection** — Purchases and payments wait FOREVER (timeout: 0)
4. **Predictable behavior** — The hardcoded keyword lists ensure the same button always triggers the same response, regardless of AI model changes or prompt drift
5. **Fail-safe default** — In recipe replay, unknown consequential actions default to 15s timeout + stop. In EXPLORE, unknown dangerous buttons return a BLOCKED error that the AI must handle
6. **No silent execution** — When a consequential action is detected, there is ALWAYS visible UI (overlay banner or consent card). The agent never clicks a dangerous button in the background
