// ============================================================
// Enhancivity Gmail Content Script
// Lies dormant until the background script sends a message.
// On trigger: extracts the open email's subject, sender, body.
// ============================================================

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {

  // ── Gmail Compose: Fill compose window with AI draft ─────
  if (request.type === 'gmail_compose') {
    handleGmailCompose(request.data)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // ── Gmail Reply: Fill reply box with AI draft ────────────
  if (request.type === 'gmail_reply') {
    handleGmailReply(request.data)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // ── Gmail Open First Search Result + Pre-fill Reply ──────
  // Agent searched Gmail (via URL navigation), now clicks the first
  // thread and pre-fills the reply box. NEVER clicks Send.
  if (request.type === 'gmail_open_first_and_reply') {
    handleOpenFirstAndReply(request.data)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.type !== 'scrape_email') return;

  try {
    // Gmail renders the open email in a focused message pane.
    // These selectors target the current open/expanded email thread.

    const subjectEl = document.querySelector('h2.hP');
    const subject = subjectEl ? subjectEl.innerText.trim() : '';

    // Sender name + email live in the "from" field of the expanded message
    const senderEl = document.querySelector('.gD');
    const sender = senderEl
      ? (senderEl.getAttribute('email') || senderEl.innerText.trim())
      : '';

    // The email body — Gmail uses .a3s for the message body container.
    // We grab the last expanded message in the thread (most recent).
    const bodyEls = document.querySelectorAll('.a3s.aiL');
    const lastBody = bodyEls.length ? bodyEls[bodyEls.length - 1] : null;

    // Strip excessive whitespace but preserve paragraph breaks
    let emailBody = '';
    if (lastBody) {
      emailBody = lastBody.innerText
        .replace(/\n{3,}/g, '\n\n') // collapse triple+ newlines
        .trim()
        .slice(0, 3000); // cap at 3000 chars to keep payload lean
    }

    sendResponse({ subject, sender, emailBody });
  } catch (e) {
    console.warn('Enhancivity: Gmail scrape failed', e.message);
    sendResponse({ subject: '', sender: '', emailBody: '' });
  }

  return true;
});

// ── Gmail Compose Handler ────────────────────────────────────
// Opens a new compose window and fills To, Subject, Body.
// NEVER clicks Send — the user always sends manually.

async function handleGmailCompose(data) {
  const { to, subject, body } = data || {};

  // Click Gmail's Compose button
  const composeBtn = document.querySelector('.T-I.T-I-KE.L3');
  if (!composeBtn) {
    return { success: false, error: 'Compose button not found. Are you on Gmail?' };
  }
  composeBtn.click();

  // Wait for compose window to open
  await new Promise(r => setTimeout(r, 1000));

  // Fill To field
  if (to) {
    const toField = document.querySelector('textarea[name="to"], input[name="to"]');
    if (toField) {
      toField.focus();
      toField.value = to;
      toField.dispatchEvent(new Event('input', { bubbles: true }));
      // Gmail needs a slight delay to process the To field
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Fill Subject
  if (subject) {
    const subjectField = document.querySelector('input[name="subjectbox"]');
    if (subjectField) {
      subjectField.focus();
      subjectField.value = subject;
      subjectField.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // Fill Body (contenteditable div)
  if (body) {
    const bodyField = document.querySelector('.Am.Al.editable[role="textbox"]');
    if (bodyField) {
      bodyField.focus();
      bodyField.innerHTML = escapeHtml(body).replace(/\n/g, '<br>');
      bodyField.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  return { success: true };
}

// ── Gmail Reply Handler ──────────────────────────────────────
// Clicks the reply button on the current email and fills the body.
// NEVER clicks Send — the user always sends manually.

async function handleGmailReply(data) {
  const { body } = data || {};

  // Click the Reply button on the last message in the thread
  const replyBtns = document.querySelectorAll('[data-tooltip="Reply"]');
  const replyBtn = replyBtns.length ? replyBtns[replyBtns.length - 1] : null;
  if (!replyBtn) {
    return { success: false, error: 'Reply button not found. Is an email open?' };
  }
  replyBtn.click();

  // Wait for reply box to open
  await new Promise(r => setTimeout(r, 1000));

  // Fill the reply body
  if (body) {
    // The reply compose body is the last editable div
    const bodyFields = document.querySelectorAll('.Am.Al.editable[role="textbox"]');
    const bodyField = bodyFields.length ? bodyFields[bodyFields.length - 1] : null;
    if (bodyField) {
      bodyField.focus();
      bodyField.innerHTML = escapeHtml(body).replace(/\n/g, '<br>');
      bodyField.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  return { success: true };
}

// ── Open First Search Result + Pre-fill Reply ────────────────
// Called after background navigated to a Gmail search URL.
// Clicks the first email thread in the results list, waits for it
// to open, then pre-fills the reply box with the AI-drafted body.
// NEVER clicks Send — the user always sends manually.

async function handleOpenFirstAndReply(data) {
  const { replyBody } = data || {};

  // Gmail search results: threads are listed as table rows with role="link"
  // or as .zA rows. Try multiple selectors for robustness.
  const threadSelectors = [
    'tr.zA',           // standard inbox thread row
    '[role="link"]',   // accessible role on thread rows
    '.y6 span',        // sender span inside a thread row
  ];

  let firstThread = null;
  for (const sel of threadSelectors) {
    const el = document.querySelector(sel);
    if (el) { firstThread = el; break; }
  }

  if (!firstThread) {
    return { success: false, error: 'No email threads found in search results.' };
  }

  // Click the first thread to open it
  firstThread.click();

  // Wait for the email to open and render
  await new Promise(r => setTimeout(r, 2000));

  // Now pre-fill the reply using the existing reply handler
  return await handleGmailReply({ body: replyBody });
}
