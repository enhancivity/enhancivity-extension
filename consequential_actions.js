'use strict';

// Prevent double-injection crash — `const` redeclaration throws SyntaxError
if (window.__enhConsequentialActionsLoaded) {
  // Already loaded — skip
} else {
window.__enhConsequentialActionsLoaded = true;

/**
 * Consequential Action Detection — Shared Constants & Utilities
 *
 * Central source of truth for what constitutes a dangerous (irreversible) click.
 * Used by both content_explore.js (EXPLORE mode) and content_replay.js (recipe replay).
 *
 * Core Principle: Block ONLY when data irreversibly leaves the user's local
 * environment to a third-party system. Intermediate saves, draft submissions,
 * and multi-step wizard "Next/Submit" buttons are SAFE to click freely.
 *
 * Architecture:
 *   Layer 1  — ALWAYS_BLOCK: hardcoded words that are always dangerous
 *   Layer 2  — ALWAYS_SAFE: hardcoded words that are never dangerous
 *   Layer 3  — Structural Finality Detection: page signals (currency, payment forms, URL patterns)
 *   Layer 4  — LLM Decision (EXPLORE only, never during replay)
 *   Layer 5  — Recipe recording stores requiresHumanConfirmation per step
 */

// ═══════════════════════════════════════════════════════════════
// LAYER 1: ALWAYS-BLOCK LIST (Zero Tolerance — Never Click Automatically)
// ═══════════════════════════════════════════════════════════════

const ALWAYS_BLOCK_ACTIONS = {
  // === SENDING / COMMUNICATING (data leaves to another person) ===
  sending: [
    'send', 'send email', 'send message', 'reply', 'reply all',
    'forward', 'send now',
  ],

  // === PURCHASING / MONEY (irreversible financial transaction) ===
  purchasing: [
    'buy now', 'buy', 'place order', 'place your order',
    'confirm purchase', 'complete purchase', 'pay', 'pay now',
    'confirm payment', 'authorize payment', 'send money', 'transfer',
    'wire transfer', 'place bid', 'checkout', 'complete checkout',
    'subscribe', 'start trial', 'upgrade now',
  ],

  // === PUBLISHING / PUBLIC POSTING (content becomes public) ===
  publishing: [
    'publish', 'go live', 'launch', 'launch campaign',
    'post', 'tweet', 'share publicly',
    'submit application', 'submit review', 'make public',
  ],

  // === DESTRUCTIVE / PERMANENT (cannot be undone) ===
  destructive: [
    'delete permanently', 'permanently delete',
    'remove permanently', 'delete account', 'close account',
    'deactivate account', 'unsubscribe', 'cancel subscription',
    'revoke', 'terminate',
  ],

  // === APPROVAL / SIGNING (legal or financial commitment) ===
  approval: [
    'approve', 'sign', 'e-sign', 'sign and submit',
    'authorize', 'confirm and pay', 'agree and pay', 'accept and pay',
  ],
};

// Flatten for quick lookup — both exact and "contains" checks
const ALL_ALWAYS_BLOCK = Object.values(ALWAYS_BLOCK_ACTIONS).flat();
const ALWAYS_BLOCK_SET = new Set(ALL_ALWAYS_BLOCK.map(w => w.toLowerCase()));

// Build a regex from the full list for fast "contains" matching
// Sorted longest-first so "send email" matches before "send"
const _blockSorted = [...ALL_ALWAYS_BLOCK].sort((a, b) => b.length - a.length);
const ALWAYS_BLOCK_REGEX = new RegExp(
  '\\b(' + _blockSorted.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i'
);

// ═══════════════════════════════════════════════════════════════
// LAYER 1B: TRANSLATIONS — Top Languages
// ═══════════════════════════════════════════════════════════════
// Loaded inline (not lazy) because total size is ~3KB — well within budget.

const ALWAYS_BLOCK_TRANSLATIONS = {
  de: [
    'senden', 'absenden', 'nachricht senden', 'antworten', 'weiterleiten',
    'jetzt kaufen', 'kaufen', 'bestellung aufgeben', 'bezahlen', 'jetzt bezahlen',
    'zahlung bestätigen', 'überweisen', 'veröffentlichen', 'posten',
    'endgültig löschen', 'konto löschen', 'genehmigen', 'unterschreiben',
    'abonnieren', 'kündigen',
  ],
  fr: [
    'envoyer', 'répondre', 'transférer',
    'acheter', 'acheter maintenant', 'passer la commande', 'payer', 'payer maintenant',
    'confirmer le paiement', 'publier', 'poster', 'tweeter',
    'supprimer définitivement', 'supprimer le compte', 'approuver', 'signer',
    "s'abonner", 'résilier',
  ],
  es: [
    'enviar', 'responder', 'reenviar',
    'comprar', 'comprar ahora', 'realizar pedido', 'pagar', 'pagar ahora',
    'confirmar pago', 'publicar', 'postear', 'tuitear',
    'eliminar permanentemente', 'eliminar cuenta', 'aprobar', 'firmar',
    'suscribirse', 'cancelar suscripción',
  ],
  pt: [
    'enviar', 'responder', 'encaminhar',
    'comprar', 'comprar agora', 'fazer pedido', 'pagar', 'pagar agora',
    'confirmar pagamento', 'publicar', 'postar',
    'excluir permanentemente', 'excluir conta', 'aprovar', 'assinar',
    'inscrever-se', 'cancelar assinatura',
  ],
  it: [
    'invia', 'inviare', 'rispondi', 'inoltra',
    'acquista', 'acquista ora', 'effettua ordine', 'paga', 'paga ora',
    'conferma pagamento', 'pubblica', 'posta',
    'elimina definitivamente', 'elimina account', 'approva', 'firma',
    'iscriviti', 'annulla abbonamento',
  ],
  nl: [
    'verzenden', 'versturen', 'beantwoorden', 'doorsturen',
    'kopen', 'nu kopen', 'bestelling plaatsen', 'betalen', 'nu betalen',
    'betaling bevestigen', 'publiceren', 'plaatsen',
    'permanent verwijderen', 'account verwijderen', 'goedkeuren', 'ondertekenen',
    'abonneren', 'opzeggen',
  ],
  tr: [
    'gönder', 'yanıtla', 'ilet',
    'satın al', 'şimdi al', 'sipariş ver', 'öde', 'şimdi öde',
    'ödemeyi onayla', 'yayınla', 'paylaş',
    'kalıcı olarak sil', 'hesabı sil', 'onayla', 'imzala',
    'abone ol', 'aboneliği iptal et',
  ],
  ja: [
    '送信', '返信', '転送',
    '購入', '今すぐ購入', '注文を確定', '支払う', '今すぐ支払う',
    '支払いを確認', '公開', '投稿', 'ツイート',
    '完全に削除', 'アカウントを削除', '承認', '署名',
    '登録', '解約',
  ],
  zh: [
    '发送', '回复', '转发',
    '购买', '立即购买', '提交订单', '支付', '立即支付',
    '确认支付', '发布', '发帖',
    '永久删除', '删除账户', '批准', '签署',
    '订阅', '取消订阅',
  ],
  ko: [
    '보내기', '답장', '전달',
    '구매', '지금 구매', '주문하기', '결제', '지금 결제',
    '결제 확인', '게시', '게시하기', '트윗',
    '영구 삭제', '계정 삭제', '승인', '서명',
    '구독', '구독 취소',
  ],
  ar: [
    'إرسال', 'رد', 'إعادة توجيه',
    'شراء', 'اشترِ الآن', 'تأكيد الطلب', 'دفع', 'ادفع الآن',
    'تأكيد الدفع', 'نشر', 'تغريد',
    'حذف نهائي', 'حذف الحساب', 'موافقة', 'توقيع',
    'اشتراك', 'إلغاء الاشتراك',
  ],
  hi: [
    'भेजें', 'जवाब दें', 'अग्रेषित करें',
    'खरीदें', 'अभी खरीदें', 'ऑर्डर दें', 'भुगतान', 'अभी भुगतान करें',
    'भुगतान की पुष्टि', 'प्रकाशित', 'पोस्ट',
    'स्थायी रूप से हटाएं', 'खाता हटाएं', 'स्वीकृत', 'हस्ताक्षर',
    'सदस्यता', 'सदस्यता रद्द',
  ],
  ru: [
    'отправить', 'ответить', 'переслать',
    'купить', 'купить сейчас', 'оформить заказ', 'оплатить', 'оплатить сейчас',
    'подтвердить оплату', 'опубликовать', 'разместить',
    'удалить навсегда', 'удалить аккаунт', 'утвердить', 'подписать',
    'подписаться', 'отменить подписку',
  ],
  pl: [
    'wyślij', 'odpowiedz', 'przekaż',
    'kup', 'kup teraz', 'złóż zamówienie', 'zapłać', 'zapłać teraz',
    'potwierdź płatność', 'opublikuj', 'publikuj',
    'usuń na stałe', 'usuń konto', 'zatwierdź', 'podpisz',
    'subskrybuj', 'anuluj subskrypcję',
  ],
};

const ALL_TRANSLATED_BLOCKS = new Set(
  Object.values(ALWAYS_BLOCK_TRANSLATIONS).flat().map(w => w.toLowerCase())
);


// ═══════════════════════════════════════════════════════════════
// LAYER 2: ALWAYS-SAFE LIST (Never Block These)
// ═══════════════════════════════════════════════════════════════

const ALWAYS_SAFE_ACTIONS = [
  // Navigation
  'next', 'continue', 'back', 'previous', 'skip', 'close', 'dismiss',
  'cancel', 'go back', 'return',

  // Saving (reversible)
  'save', 'save draft', 'save changes', 'save as draft', 'save progress',
  'save and continue', 'auto-save', 'update', 'apply changes',

  // Selection / Filtering
  'apply', 'apply filter', 'apply filters', 'select', 'choose',
  'set', 'change', 'modify', 'edit', 'customize',

  // Adding (to local state, not purchasing)
  'add', 'add to cart', 'add to list', 'add to wishlist', 'add to favorites',
  'add item', 'insert', 'attach', 'upload',

  // Viewing / Previewing
  'preview', 'review', 'view', 'show', 'expand', 'collapse',
  'more details', 'read more', 'see more', 'load more',

  // Searching
  'search', 'find', 'filter', 'sort', 'look up',

  // Acknowledgment (no data sent)
  'ok', 'okay', 'got it', 'understood', 'accept cookies',
  'allow', 'agree', 'i agree', 'accept', 'confirm selection',
  'yes', 'no', 'maybe later',

  // Form intermediate steps
  'calculate', 'estimate', 'check availability', 'verify',
  'validate', 'check', 'refresh', 'reload', 'retry',

  // Common safe words in other languages
  'weiter', 'zurück', 'speichern', 'anwenden',       // German
  'suivant', 'retour', 'sauvegarder', 'appliquer',    // French
  'siguiente', 'atrás', 'guardar', 'aplicar',         // Spanish
  'avanti', 'indietro', 'salva', 'applica',           // Italian
  '次へ', '戻る', '保存', '適用',                       // Japanese
  '下一步', '返回', '保存', '应用',                      // Chinese
  '다음', '뒤로', '저장', '적용',                        // Korean
];

const ALWAYS_SAFE_SET = new Set(ALWAYS_SAFE_ACTIONS.map(w => w.toLowerCase()));


// ═══════════════════════════════════════════════════════════════
// CATEGORY CLASSIFICATION & PAUSE BEHAVIOR
// ═══════════════════════════════════════════════════════════════

const CATEGORY_PATTERNS = {
  purchasing: /\b(buy|purchase|place\s*order|confirm\s*order|checkout|complete\s*purchase|place\s*your\s*order|start\s*trial|upgrade\s*now|subscribe)\b/i,
  approval:   /\b(pay|confirm\s*payment|authorize|transfer|wire|approve|sign|e-sign|confirm\s*and\s*pay|agree\s*and\s*pay|accept\s*and\s*pay)\b/i,
  destructive:/\b(delete|remove|unsubscribe|cancel\s*subscription|close\s*account|deactivate|revoke|terminate|permanently)\b/i,
  sending:    /\b(send|reply|forward|send\s*email|send\s*message|reply\s*all|send\s*now)\b/i,
  publishing: /\b(publish|go\s*live|launch|post|tweet|share\s*publicly|submit\s*application|submit\s*review|make\s*public)\b/i,
};

function classifyCategory(text) {
  const lower = (text || '').toLowerCase();
  if (CATEGORY_PATTERNS.purchasing.test(lower)) return 'purchasing';
  if (CATEGORY_PATTERNS.approval.test(lower))   return 'approval';
  if (CATEGORY_PATTERNS.destructive.test(lower)) return 'destructive';
  if (CATEGORY_PATTERNS.sending.test(lower))     return 'sending';
  if (CATEGORY_PATTERNS.publishing.test(lower))  return 'publishing';
  return 'unknown';
}

const PAUSE_BEHAVIOR = {
  purchasing:  { timeout: 0,     autoSkip: false, message: (name) => `Ready to purchase — click "${name}" when you want to buy` },
  approval:    { timeout: 0,     autoSkip: false, message: (name) => `Payment ready — click "${name}" to confirm when ready` },
  sending:     { timeout: 20000, autoSkip: true,  message: (name) => `Message ready — click "${name}" to send, or I'll move on in 20s` },
  publishing:  { timeout: 20000, autoSkip: true,  message: (name) => `Ready to publish — click "${name}" when ready, or I'll move on in 20s` },
  destructive: { timeout: 15000, autoSkip: true,  message: (name) => `This will delete permanently — click "${name}" to confirm, or I'll skip in 15s` },
  unknown:     { timeout: 15000, autoSkip: true,  message: (name) => `This action may be irreversible — click "${name}" to confirm, or I'll move on in 15s` },
};


// ═══════════════════════════════════════════════════════════════
// CHATBOT ALLOWLIST
// ═══════════════════════════════════════════════════════════════
// On chatbot sites, "send" and "submit" are safe (just sending a chat message).
// But purchases, payments, and deletions remain blocked even on these sites.

const CHATBOT_ALLOWLIST = [
  'chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com',
  'copilot.microsoft.com', 'poe.com', 'perplexity.ai',
];

function isOnChatbotSite() {
  try {
    const hostname = window.location.hostname;
    return CHATBOT_ALLOWLIST.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch { return false; }
}

// Categories that remain dangerous even on chatbot sites
const CHATBOT_STILL_DANGEROUS = new Set(['purchasing', 'approval', 'destructive']);


// ═══════════════════════════════════════════════════════════════
// LAYER 3: STRUCTURAL FINALITY DETECTION
// ═══════════════════════════════════════════════════════════════
// Language-independent signals that indicate irreversible action.
// Scoped to nearest container (form/dialog/section) for performance.

function detectFinalitySignals(element) {
  const signals = { isFinal: false, confidence: 0, reasons: [] };

  // Scope: walk the nearest container, NOT the entire document.body
  const container = element.closest('form, [role="dialog"], [role="alertdialog"], dialog, section, [class*="checkout"], [class*="payment"]')
    || element.parentElement;
  const containerText = (container?.textContent || '').toLowerCase();

  // Also check a small radius of nearby visible text (lightweight: just container text)
  const nearbyText = containerText.slice(0, 3000); // cap to avoid huge DOM trees
  const pageUrl = (window.location?.href || '').toLowerCase();

  // === SIGNAL 1: Currency amounts nearby ===
  const currencyPattern = /[$€£¥₹₩₽¢₱₿]\s*\d+|(\d+[.,]\d{2})\s*(usd|eur|gbp|jpy|inr|krw)/i;
  if (currencyPattern.test(nearbyText)) {
    signals.confidence += 30;
    signals.reasons.push('currency_amount_nearby');
  }

  // === SIGNAL 2: Payment form fields in the same form ===
  const formElement = element.closest('form');
  if (formElement) {
    const inputs = formElement.querySelectorAll('input');
    for (const input of inputs) {
      const autocomplete = (input.autocomplete || '').toLowerCase();
      const name = (input.name || '').toLowerCase();
      if (autocomplete.includes('cc-') || /card|cvv|cvc|expir/.test(name)) {
        signals.confidence += 45;
        signals.reasons.push('payment_form_detected');
        break;
      }
    }
  }

  // === SIGNAL 3: Checkout/payment URL patterns ===
  const dangerousUrlPatterns = [
    /checkout\/(?:complete|confirm|review)/i,
    /payment\/confirm/i,
    /order\/(?:confirm|place|complete)/i,
    /\/pay(?:ment)?\//i,
    /billing\/confirm/i,
  ];
  if (dangerousUrlPatterns.some(p => p.test(pageUrl))) {
    signals.confidence += 25;
    signals.reasons.push('dangerous_url_pattern');
  }

  // === SIGNAL 4: Finality language near the button ===
  const finalityPhrases = [
    /you will be charged/i,
    /your (?:credit |debit )?card will be/i,
    /total:?\s*[$€£¥₹]/i,
    /order total/i,
    /amount due/i,
    /payment summary/i,
    /billing summary/i,
    /this action cannot be undone/i,
    /this is irreversible/i,
    /cannot be reversed/i,
    /are you sure\??/i,
    /final step/i,
    /review your order/i,
    /confirm your (?:order|purchase|payment)/i,
  ];
  if (finalityPhrases.some(p => p.test(nearbyText))) {
    signals.confidence += 30;
    signals.reasons.push('finality_language_nearby');
  }

  // === SIGNAL 5: No forward navigation visible (might be last step) ===
  // Only a boost — never enough on its own to block
  if (container && signals.confidence > 0) {
    const hasNextStep = container.querySelector(
      'button:not([disabled])[class*="next"], ' +
      'a[href*="next"], ' +
      '[class*="step"]:not(.active):not(.completed):not(.current), ' +
      '[class*="progress"]:not(:last-child)'
    );
    if (!hasNextStep) {
      signals.confidence += 10;
      signals.reasons.push('no_next_step_found');
    }
  }

  // === SIGNAL 6: Destructive button styling (red background) ===
  try {
    const bgColor = window.getComputedStyle(element).backgroundColor;
    const match = bgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (match) {
      const [, r, g, b] = match.map(Number);
      if (r > 180 && g < 100 && b < 100) {
        signals.confidence += 10;
        signals.reasons.push('destructive_button_color');
      }
    }
  } catch { /* style access can fail in edge cases */ }

  // === SIGNAL 7: ARIA / tooltip attributes match block list ===
  const ariaLabel = (element.getAttribute('aria-label') || '').toLowerCase();
  const dataTooltip = (element.getAttribute('data-tooltip') || '').toLowerCase();
  const title = (element.getAttribute('title') || '').toLowerCase();
  const allAria = `${ariaLabel} ${dataTooltip} ${title}`;
  if (ALWAYS_BLOCK_REGEX.test(allAria)) {
    signals.confidence += 40;
    signals.reasons.push('aria_matches_block_list');
  }

  // === DECISION: confidence >= 40 = block ===
  signals.isFinal = signals.confidence >= 40;
  return signals;
}


// ═══════════════════════════════════════════════════════════════
// UNIFIED DETECTION API
// ═══════════════════════════════════════════════════════════════

/**
 * Get the effective text of a button/link element.
 * Priority: aria-label → textContent → title → data-tooltip → value → alt
 */
function getButtonText(element) {
  return (
    element.getAttribute('aria-label') ||
    (element.textContent || '').trim().slice(0, 60) ||
    element.getAttribute('title') ||
    element.getAttribute('data-tooltip') ||
    element.value ||
    element.getAttribute('alt') ||
    ''
  );
}

/**
 * Check if button text matches the always-block list (any language).
 * Checks both exact match and "text starts/ends with" for multi-word phrases.
 */
function matchesAlwaysBlock(text) {
  const lower = text.toLowerCase().trim();
  if (!lower) return false;

  // Exact match (English)
  if (ALWAYS_BLOCK_SET.has(lower)) return true;

  // Exact match (translations)
  if (ALL_TRANSLATED_BLOCKS.has(lower)) return true;

  // Regex "contains" match for multi-word phrases (English)
  // e.g., button text "Send Email Now" should match "send email"
  if (ALWAYS_BLOCK_REGEX.test(lower)) return true;

  return false;
}

/**
 * Master detection function — runs the full layered system.
 *
 * @param {HTMLElement} element — the button/link being clicked
 * @param {Object} [actionMeta] — optional recipe action metadata (description, semanticContext)
 * @param {Object} [options]
 * @param {boolean} [options.skipStructural=false] — skip Layer 3 (for performance in hot paths)
 * @returns {{ isDangerous: boolean, category: string, reason: string, confidence: number, pauseBehavior: Object }}
 */
function assessAction(element, actionMeta, options) {
  const opts = options || {};

  // Gather all text signals
  const elText = getButtonText(element);
  const metaHints = actionMeta ? [
    actionMeta.description,
    actionMeta.semanticContext?.label,
    actionMeta.semanticContext?.ariaLabel,
    actionMeta.semanticContext?.text,
    actionMeta.semanticContext?.placeholder,
  ].filter(Boolean).join(' ') : '';

  const combinedText = `${elText} ${metaHints}`.trim();
  const elTextLower = elText.toLowerCase().trim();

  // ── Layer 2 first: ALWAYS-SAFE (fast exit) ──
  if (ALWAYS_SAFE_SET.has(elTextLower)) {
    return { isDangerous: false, category: 'safe', reason: 'always_safe_list', confidence: 0, pauseBehavior: null };
  }

  // ── Chatbot site exemption ──
  if (isOnChatbotSite()) {
    // Check if it's a category that remains dangerous even on chatbot sites
    const chatCategory = classifyCategory(combinedText);
    if (!CHATBOT_STILL_DANGEROUS.has(chatCategory)) {
      return { isDangerous: false, category: 'chatbot_safe', reason: 'chatbot_site_exemption', confidence: 0, pauseBehavior: null };
    }
  }

  // ── Layer 1: ALWAYS-BLOCK ──
  if (matchesAlwaysBlock(elText) || matchesAlwaysBlock(metaHints)) {
    const category = classifyCategory(combinedText);
    return {
      isDangerous: true,
      category,
      reason: 'always_block_list',
      confidence: 100,
      pauseBehavior: PAUSE_BEHAVIOR[category] || PAUSE_BEHAVIOR.unknown,
    };
  }

  // ── Gmail-specific: Send button via role/tooltip (icon buttons with no text) ──
  if (element) {
    const roleBtn = element.closest?.('[role="button"]');
    const roleAria = roleBtn?.getAttribute('aria-label')?.toLowerCase() || '';
    const tooltip = element.closest?.('[data-tooltip]')?.getAttribute('data-tooltip')?.toLowerCase() || '';
    if (roleAria.includes('send') || tooltip.includes('send')) {
      return {
        isDangerous: true,
        category: 'sending',
        reason: 'gmail_send_button_detected',
        confidence: 95,
        pauseBehavior: PAUSE_BEHAVIOR.sending,
      };
    }
  }

  // ── Layer 3: Structural Finality Detection ──
  if (!opts.skipStructural && element) {
    const finality = detectFinalitySignals(element);
    if (finality.isFinal) {
      const category = classifyCategory(combinedText) || 'unknown';
      return {
        isDangerous: true,
        category,
        reason: `structural_finality: ${finality.reasons.join(', ')}`,
        confidence: finality.confidence,
        pauseBehavior: PAUSE_BEHAVIOR[category] || PAUSE_BEHAVIOR.unknown,
      };
    }
  }

  // ── Default: NOT dangerous ──
  return { isDangerous: false, category: 'safe', reason: 'no_signals', confidence: 0, pauseBehavior: null };
}


// ═══════════════════════════════════════════════════════════════
// RECIPE RECORDING HELPER — Classify clicks during training
// ═══════════════════════════════════════════════════════════════

/**
 * Called during recipe recording to classify each click.
 * Stores the result in the recipe step for deterministic replay.
 */
function classifyRecordedClick(element, stepIndex, totalStepsRecorded) {
  const result = assessAction(element, null, { skipStructural: false });

  if (result.isDangerous) {
    return {
      requiresHumanConfirmation: true,
      classification: result.reason,
      category: result.category,
      confidence: result.confidence,
    };
  }

  // If this is the very last recorded step, flag for review but don't auto-block
  if (stepIndex === totalStepsRecorded - 1) {
    return {
      requiresHumanConfirmation: false,
      classification: 'last_step_possible_final',
      category: 'unknown',
      confidence: 0,
      needsReview: true,
    };
  }

  return {
    requiresHumanConfirmation: false,
    classification: 'intermediate',
    category: 'safe',
    confidence: 0,
  };
}


// ═══════════════════════════════════════════════════════════════
// EXPORTS (for content scripts that import via globalThis)
// ═══════════════════════════════════════════════════════════════
// Content scripts can't use ES modules — we attach to globalThis
// and each script picks up what it needs.

if (typeof globalThis !== 'undefined') {
  globalThis.__enhancivityConsequentialActions = {
    // Core detection
    assessAction,
    classifyCategory,
    getButtonText,
    matchesAlwaysBlock,
    detectFinalitySignals,

    // Recording helper
    classifyRecordedClick,

    // Constants (for direct access if needed)
    ALWAYS_BLOCK_SET,
    ALL_TRANSLATED_BLOCKS,
    ALWAYS_SAFE_SET,
    ALWAYS_BLOCK_REGEX,
    PAUSE_BEHAVIOR,
    CHATBOT_ALLOWLIST,

    // Chatbot check
    isOnChatbotSite,
  };
}

} // end double-injection guard
