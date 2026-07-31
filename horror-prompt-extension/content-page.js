// MAIN WORLD — runs inside page's JS context
// Can use document.execCommand, React internals, etc.

// Guard: prevent double-execution if injected more than once
if (!window.__hpaPageLoaded) {
window.__hpaPageLoaded = true;

window.addEventListener('message', async (event) => {
  if (!event.data || event.data.hpaSource !== 'isolated') return;
  const { id, fn, args } = event.data;
  try {
    let result;
    if      (fn === 'typeAndSend')  result = await _typeAndSend(args[0]);
    else if (fn === 'isStreaming')  result = _isStreaming();
    else if (fn === 'getLastReply') result = _getLastReply();
    else if (fn === 'getReplyCount') result = _getReplyCount();
    window.postMessage({ hpaSource: 'main', id, result, ok: true }, '*');
  } catch (e) {
    window.postMessage({ hpaSource: 'main', id, error: e.message, ok: false }, '*');
  }
});

async function _typeAndSend(text) {
  const el = await _findInput(15000);
  if (!el) throw new Error('ChatGPT input box পাওয়া যায়নি');

  el.focus();
  await _delay(300);

  // ── Step 1: Clear safely (no execCommand, no el.click — avoids React freeze) ──
  _safeClear(el);
  await _delay(250);

  // ── Step 2: Try paste event (primary approach) ──
  // Only the ClipboardEvent construction/dispatch is inside try/catch.
  // All result handling runs OUTSIDE so intentional errors can propagate.
  let pasteDispatched = false;
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    pasteDispatched = true;
  } catch (_) {
    // ClipboardEvent not supported — fall through to execCommand
  }

  if (pasteDispatched) {
    // Give ChatGPT time to process the paste (text insertion OR file conversion)
    await _delay(1000);

    // ── Case A: Text landed in the editor as normal text ──
    if ((el.innerText || el.textContent || '').trim().length > 2) {
      const sent = await _clickSend(30000);
      if (!sent) throw new Error('Send বাটন সক্রিয় হয়নি — ChatGPT প্রস্তুত নয়');
      return true;
    }

    // ── Case B: ChatGPT converted the text into a file attachment card ──
    // DO NOT run any further text-injection fallbacks — they interfere with the
    // file upload and cause the page to freeze.
    if (_hasFileAttachment()) {
      _sendPageStatus('file_uploading'); // inform popup
      const sent = await _clickSend(600000); // wait (no fixed time) for upload + button
      if (!sent) throw new Error('ফাইল আপলোড ব্যর্থ হয়েছে বা ChatGPT প্রত্যাখ্যান করেছে');
      return true;
    }

    // Paste dispatched but produced neither text nor a file card — fall through to alternatives
  }

  // ── Step 3: Fallback — execCommand insertText (for older ChatGPT builds) ──
  let inserted = false;
  try {
    document.execCommand('insertText', false, text);
    await _delay(500);
    inserted = (el.innerText || el.textContent || '').trim().length > 2;
  } catch (_) {}

  // ── Step 4: Last resort — direct textContent + React fiber trigger ──
  if (!inserted) {
    _safeClear(el);
    await _delay(100);
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await _delay(400);
  }

  // After any fallback injection, re-check for a file card before sending
  if (_hasFileAttachment()) {
    _sendPageStatus('file_uploading');
    const sent = await _clickSend(600000);
    if (!sent) throw new Error('ফাইল আপলোড ব্যর্থ হয়েছে বা ChatGPT প্রত্যাখ্যান করেছে');
    return true;
  }

  const sent = await _clickSend(30000);
  if (!sent) throw new Error('Send বাটন সক্রিয় হয়নি — ChatGPT প্রস্তুত নয়');
  return true;
}

// Detect when ChatGPT converted pasted text into a file attachment card.
// ChatGPT shows a card with a "Show in text field" link when this happens.
function _hasFileAttachment() {
  try {
    const form = document.querySelector('form') ||
                 document.querySelector('[class*="composer"]') ||
                 document.querySelector('main');
    const root = form || document.body;
    // Primary signal: the "Show in text field" link that appears on file cards
    const allEls = root.querySelectorAll('*');
    for (const node of allEls) {
      const t = node.childNodes.length === 1 && node.firstChild?.nodeType === 3
        ? node.textContent
        : node.innerText;
      if (t && (t.includes('Show in text field') || t.includes('text ফিল্ডে দেখুন'))) {
        return true;
      }
    }
    // Secondary signals: generic file/attachment card selectors
    return !!(
      root.querySelector('[data-testid*="file"]') ||
      root.querySelector('[class*="FileCard"]') ||
      root.querySelector('[class*="file-card"]') ||
      root.querySelector('[class*="attachment"]')
    );
  } catch (_) {
    return false;
  }
}

// Clear contenteditable safely — patches removeChild to prevent React NotFoundError
function _safeClear(el) {
  try {
    const orig = el.removeChild.bind(el);
    el.removeChild = function(child) {
      try { return orig(child); } catch(e) { if (e.name === 'NotFoundError') return child; throw e; }
    };
    el.textContent = '';
    setTimeout(() => { el.removeChild = orig; }, 2000);
  } catch(_) {
    el.innerHTML = '';
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}


function _setReactValue(el, text) {
  try {
    // Find React fiber
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    if (!key) return;
    const fiber = el[key];
    const props = fiber?.memoizedProps || fiber?.pendingProps;
    if (props?.onChange) {
      // Simulate change event
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'innerHTML');
      el.innerHTML = text;
      props.onChange({ target: el, currentTarget: el });
    }
  } catch (e) {}
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function _findInput(timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el =
      document.querySelector('#prompt-textarea') ||
      document.querySelector('div[contenteditable="true"][id*="prompt"]') ||
      document.querySelector('div[contenteditable="true"].ProseMirror') ||
      document.querySelector('div[contenteditable="true"]');
    if (el && el.isConnected) return el;
    await _delay(400);
  }
  return null;
}

// Returns true if the send button became enabled and was clicked.
// Returns false if: (a) a file-card error/rejection was detected, or
//                   (b) maxWaitMs elapsed without the button enabling.
// Callers MUST check the return value — false means nothing was sent.
async function _clickSend(maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    // Fast-fail: detect file-card rejection or upload error before polling the button
    if (_hasFileError()) return false;

    const btn =
      document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label="Send prompt"]') ||
      document.querySelector('button[aria-label="Send message"]') ||
      document.querySelector('button[aria-label*="Send"]');
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
      btn.click();
      return true; // ✓ actually clicked an enabled button
    }
    await _delay(400);
  }
  // Timed out — do NOT dispatch Enter as a fallback "send"; that would hide the failure.
  return false;
}

// Detect when ChatGPT shows a rejection or error state on the file attachment card
// (e.g. "File too large", "Upload failed").  Used inside _clickSend to fail fast
// instead of waiting the full maxWaitMs.
function _hasFileError() {
  try {
    const root = document.querySelector('form') ||
                 document.querySelector('[class*="composer"]') ||
                 document.querySelector('main') ||
                 document.body;
    // Check leaf text nodes for specific error phrases ChatGPT shows on rejected cards
    const errorPhrases = [
      'too large', 'file too large', 'upload failed',
      'could not upload', 'failed to upload', 'not supported',
      'unsupported file'
    ];
    const allEls = root.querySelectorAll('*');
    for (const node of allEls) {
      // Only inspect leaf-ish text nodes to avoid matching unrelated page text
      if (node.children.length <= 2) {
        const t = (node.innerText || node.textContent || '').toLowerCase().trim();
        if (t && errorPhrases.some(p => t.includes(p))) return true;
      }
    }
    // CSS-class signals (error variant of the file card)
    return !!(
      root.querySelector('[class*="file"][class*="error"]') ||
      root.querySelector('[class*="error"][class*="file"]') ||
      root.querySelector('[class*="upload"][class*="error"]') ||
      root.querySelector('[class*="FileCard--error"]') ||
      root.querySelector('[data-upload-error]')
    );
  } catch (_) { return false; }
}

// Send an intermediate status update to the isolated world (content-bridge.js)
// without going through the normal RPC reply channel.
function _sendPageStatus(status, extra = {}) {
  try {
    window.postMessage({ hpaSource: 'main', type: 'STATUS', status, ...extra }, '*');
  } catch (_) {}
}

function _isStreaming() {
  // Specific stop-button selectors used by ChatGPT during active generation
  if (document.querySelector('button[data-testid="stop-button"]')) return true;
  if (document.querySelector('[data-testid="stop-button"]')) return true;
  if (document.querySelector('button[aria-label="Stop streaming"]')) return true;
  if (document.querySelector('button[aria-label="Stop generating"]')) return true;
  if (document.querySelector('[class*="result-streaming"]')) return true;

  // If the send button is present and enabled, ChatGPT is ready → not streaming
  const sendBtn =
    document.querySelector('button[data-testid="send-button"]') ||
    document.querySelector('button[aria-label="Send prompt"]') ||
    document.querySelector('button[aria-label="Send message"]');
  if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true') {
    return false;
  }

  return false;
}

// Returns the total number of assistant reply messages in the DOM.
// Used by content-bridge.js to detect when a NEW reply appears after sending a scene.
function _getReplyCount() {
  return document.querySelectorAll('[data-message-author-role="assistant"]').length;
}

function _getLastReply() {
  const els = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (!els.length) return null;
  const last = els[els.length - 1];
  const prose =
    last.querySelector('[class*="prose"]') ||
    last.querySelector('[class*="markdown"]') ||
    last.querySelector('.markdown');
  return ((prose || last).innerText || '').trim() || null;
}

function _delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

} // end guard
