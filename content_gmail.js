// ============================================================
// Enhancivity Gmail Content Script
// Lies dormant until the background script sends a message.
// On trigger: extracts the open email's subject, sender, body.
// ============================================================

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
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
