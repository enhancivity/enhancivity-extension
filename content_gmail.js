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

  // Click the Reply button on the last message in the thread.
  // Gmail uses different elements across views — try multiple selectors.
  let replyBtn = null;

  // Strategy 1: data-tooltip="Reply" (most common)
  const tooltipBtns = document.querySelectorAll('[data-tooltip="Reply"]');
  if (tooltipBtns.length) replyBtn = tooltipBtns[tooltipBtns.length - 1];

  // Strategy 2: aria-label containing "Reply" (accessibility)
  if (!replyBtn) {
    const ariaBtns = document.querySelectorAll('[aria-label="Reply"], [aria-label="Reply to sender"]');
    if (ariaBtns.length) replyBtn = ariaBtns[ariaBtns.length - 1];
  }

  // Strategy 3: The inline Reply/Forward bar at the bottom of an email (.ams)
  if (!replyBtn) {
    const inlineReplyLinks = document.querySelectorAll('.ams span, .ams a, .ams div');
    for (const el of inlineReplyLinks) {
      if ((el.textContent || '').trim().toLowerCase() === 'reply') {
        replyBtn = el;
        break;
      }
    }
  }

  // Strategy 4: Any clickable element with exact "Reply" text near the email body
  if (!replyBtn) {
    const allClickables = document.querySelectorAll('span[role="link"], td[role="link"], div[role="button"], span.ams, [role="button"]');
    for (const el of allClickables) {
      const text = (el.textContent || '').trim();
      if (text === 'Reply' || text === 'Reply all') {
        replyBtn = el;
        break;
      }
    }
  }

  // Strategy 5: Last resort — find any element with "Reply" text
  if (!replyBtn) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        const text = (node.textContent || '').trim();
        if (text === 'Reply' && node.children.length === 0 && node.offsetWidth > 0) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      }
    });
    if (walker.nextNode()) replyBtn = walker.currentNode;
  }

  if (!replyBtn) {
    return { success: false, error: 'Reply button not found. Is an email open?' };
  }
  replyBtn.click();

  // Wait for reply box to open
  await new Promise(r => setTimeout(r, 1500));

  // Fill the reply body
  if (body) {
    // Wait a bit more for the compose area to fully initialize
    await new Promise(r => setTimeout(r, 500));

    // The reply compose body is the last editable div — try multiple selectors
    const bodySelectors = [
      '.Am.Al.editable[role="textbox"]',
      '[role="textbox"][contenteditable="true"]',
      '[g_editable="true"]',
      '.editable[contenteditable="true"]',
      'div[aria-label="Message Body"]',
      'div[aria-label*="message" i][contenteditable="true"]',
    ];

    let bodyField = null;
    for (const sel of bodySelectors) {
      const fields = document.querySelectorAll(sel);
      if (fields.length) {
        bodyField = fields[fields.length - 1];
        break;
      }
    }

    if (bodyField) {
      bodyField.focus();

      // Method 1: innerHTML (works on most Gmail versions)
      const htmlBody = escapeHtml(body).replace(/\n/g, '<br>');
      bodyField.innerHTML = htmlBody;
      bodyField.dispatchEvent(new Event('input', { bubbles: true }));
      bodyField.dispatchEvent(new Event('change', { bubbles: true }));

      // Method 2: If innerHTML didn't visibly work, try execCommand (legacy but reliable in contenteditable)
      if (!bodyField.textContent.trim()) {
        bodyField.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertHTML', false, htmlBody);
      }

      // Method 3: Last resort — use clipboard-like approach
      if (!bodyField.textContent.trim()) {
        bodyField.textContent = body;
        bodyField.dispatchEvent(new Event('input', { bubbles: true }));
      }
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
  const { replyBody, searchQuery } = data || {};

  // Gmail search results: threads are listed as table rows (.zA class).
  // Each row has a sender span (.yW/.yX/.y2) and a subject snippet.
  // Gmail SPA may not reload if we're already on search — retry with waits.
  let threadRows = document.querySelectorAll('tr.zA');

  // Retry up to 3 times (Gmail SPA may need time to render search results)
  for (let attempt = 0; attempt < 3 && !threadRows.length; attempt++) {
    await new Promise(r => setTimeout(r, 1500));
    threadRows = document.querySelectorAll('tr.zA');
  }

  if (!threadRows.length) {
    // Fallback: try role="link" rows
    const roleLinks = document.querySelectorAll('[role="main"] [role="link"]');
    if (!roleLinks.length) {
      return { success: false, error: 'No email threads found in search results. Try refreshing Gmail.' };
    }
    // Just click the first one as fallback
    roleLinks[0].click();
    await new Promise(r => setTimeout(r, 2000));
    return await handleGmailReply({ body: replyBody });
  }

  // Try to match the sender from searchQuery
  // searchQuery may be "circlenomy@gmail.com", "circlenomy", or "from:circlenomy"
  const queryRaw = (searchQuery || '').toLowerCase().replace(/^from:\s*/i, '');
  // Extract just the name part (before @) for flexible matching
  const queryName = queryRaw.includes('@') ? queryRaw.split('@')[0] : queryRaw;
  let bestMatch = null;

  if (queryName) {
    for (const row of threadRows) {
      // Gmail sender elements: .yW contains sender name spans with [email] attribute
      // .zF is the sender name text, .y2 is sender in condensed view
      const senderEls = row.querySelectorAll('.yW span[email], .yX span[email], .zF, .y2, .bA4 span, .yP, .zF');
      let senderName = '';
      let senderEmail = '';
      for (const el of senderEls) {
        const email = (el.getAttribute('email') || '').toLowerCase();
        const name = (el.getAttribute('name') || el.textContent || '').toLowerCase();
        if (email) senderEmail += ' ' + email;
        if (name) senderName += ' ' + name;
      }

      // Match against sender name or email — NOT full row text (avoids false positives)
      const senderInfo = (senderName + ' ' + senderEmail).trim();
      if (senderInfo && (senderInfo.includes(queryName) || senderInfo.includes(queryRaw))) {
        bestMatch = row;
        break;
      }
    }

    // Second pass: if strict sender match failed, check the first column (sender area) only
    if (!bestMatch) {
      for (const row of threadRows) {
        // The sender column is typically the first few cells
        const firstCells = row.querySelectorAll('td:nth-child(-n+4)');
        let cellText = '';
        for (const cell of firstCells) {
          cellText += ' ' + (cell.textContent || '').toLowerCase();
        }
        if (cellText.includes(queryName)) {
          bestMatch = row;
          break;
        }
      }
    }
  }

  // If no sender match found, click the first thread (search already filtered)
  const targetThread = bestMatch || threadRows[0];
  targetThread.click();

  // Wait for the email to open and render
  await new Promise(r => setTimeout(r, 2000));

  // Now pre-fill the reply using the existing reply handler
  return await handleGmailReply({ body: replyBody });
}
