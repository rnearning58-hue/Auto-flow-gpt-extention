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
    if      (fn === 'typeAndSend')    result = await _typeAndSend(args[0]);
    else if (fn === 'isStreaming')    result = _isStreaming();
    else if (fn === 'getLastReply')   result = _getLastReply();
    else if (fn === 'getReplyCount')  result = _getReplyCount();
    else if (fn === 'isLastReplyDone') result = _isLastReplyDone();
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

    // ── Case B: ChatGPT converted the text into a file attachment card ──
    // Check this FIRST — file conversion takes priority because it needs a much
    // longer send timeout (upload can take minutes).
    // DO NOT run any further text-injection fallbacks — they interfere with the
    // file upload and cause the page to freeze.
    if (_hasFileAttachment()) {
      _sendPageStatus('file_uploading'); // inform popup
      const sent = await _clickSend(600000); // wait (no fixed time) for upload + button
      if (!sent) throw new Error('ফাইল আপলোড ব্যর্থ হয়েছে বা ChatGPT প্রত্যাখ্যান করেছে');
      return true;
    }

    // ── Case A: Text landed in the editor as normal text ──
    if ((el.innerText || el.textContent || '').trim().length > 2) {
      // Fire an input event so React registers the pasted content and enables Send
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await _delay(800);

      // Send strategy: every iteration tries BOTH the send button AND the Enter key.
      // Enter key is the most reliable because it's what a human presses — tried
      // immediately rather than waiting as a last resort.
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        // Switch to file-upload mode if ChatGPT converted the text to a card
        if (_hasFileAttachment()) {
          _sendPageStatus('file_uploading');
          const fileSent = await _clickSend(600000);
          if (!fileSent) throw new Error('ফাইল আপলোড ব্যর্থ হয়েছে বা ChatGPT প্রত্যাখ্যান করেছে');
          return true;
        }
        // Note: _hasFileError() is intentionally NOT checked here.
        // In text mode (Case A) there is no file card, so a false positive would
        // silently return false and let the automation skip this message entirely.

        // Attempt 1: click the send button if found
        const btn = _findSendButton();
        if (btn) {
          btn.click();
          return true;
        }

        // Attempt 2: simulate Enter key press (keydown + keypress + keyup)
        // This mirrors exactly what happens when a user presses Enter on the keyboard.
        _pressEnter(el);
        await _delay(700);

        // If ChatGPT started streaming, the Enter key worked — return success
        if (_isStreaming()) return true;

        await _delay(300);
      }
      throw new Error('Send বাটন সক্রিয় হয়নি — ChatGPT প্রস্তুত নয়');
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
    // Secondary signals: specific file-card selectors only.
    // Intentionally avoid broad selectors like [data-testid*="file"] or [class*="attachment"]
    // because those match ChatGPT's own file-upload (+) button, causing false positives.
    return !!(
      root.querySelector('[class*="FileCard"]') ||
      root.querySelector('[class*="file-card"]') ||
      root.querySelector('[data-testid="file-attachment"]') ||
      root.querySelector('[data-testid*="attachment-card"]')
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

// Find the send button using multiple strategies.
// ChatGPT changes its button attributes frequently; this tries every known approach.
function _findSendButton() {
  // Strategy 1: specific known attribute selectors (ordered by specificity)
  const byAttr =
    document.querySelector('button[data-testid="send-button"]') ||
    document.querySelector('button[data-testid*="send"]') ||
    document.querySelector('button[aria-label="Send prompt"]') ||
    document.querySelector('button[aria-label="Send message"]') ||
    document.querySelector('button[aria-label="Send"]') ||
    document.querySelector('button[aria-label*="Send"]');
  if (byAttr && !byAttr.disabled && byAttr.getAttribute('aria-disabled') !== 'true') {
    return byAttr;
  }

  // Strategy 2 is SKIPPED when a file attachment card is present.
  // During file upload the send button is disabled, so any other enabled SVG button
  // in the composer (e.g. "Show in text field") would be returned by mistake.
  // In that state, callers must wait for the send button to enable via Strategy 1.
  if (_hasFileAttachment()) return null;

  // Strategy 2: walk UP from the text input to find the send button.
  // Scanning the whole page/form is unreliable on ChatGPT's home page (many stray
  // buttons with SVGs pass the filter). Instead, start from the input element itself
  // and expand outward — the send button is always in the same tight container as
  // the input area, never far away in the page hierarchy.
  const input =
    document.querySelector('#prompt-textarea') ||
    document.querySelector('div[contenteditable="true"][id*="prompt"]') ||
    document.querySelector('div[contenteditable="true"].ProseMirror') ||
    document.querySelector('div[contenteditable="true"]');
  if (!input) return null;

  const skip = ['attach', 'file', 'voice', 'mic', 'microphone',
                'stop', 'search', 'browse', 'photo', 'image', 'upload', 'tool'];

  // Walk up at most 8 levels from the input, find the first ancestor that contains
  // exactly the send button (after filtering out known non-send buttons).
  let container = input.parentElement;
  for (let depth = 0; depth < 8 && container && container !== document.body; depth++) {
    const buttons = Array.from(container.querySelectorAll('button'));
    const candidates = buttons.filter(btn => {
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
      if (!btn.querySelector('svg')) return false;
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      const testid = (btn.getAttribute('data-testid') || '').toLowerCase();
      return !skip.some(w => label.includes(w) || testid.includes(w));
    });
    if (candidates.length >= 1) {
      // Take the last candidate (send button is the rightmost icon button)
      return candidates[candidates.length - 1];
    }
    container = container.parentElement;
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

    const btn = _findSendButton();
    if (btn) {
      btn.click();
      return true; // ✓ clicked an enabled send button
    }
    await _delay(400);
  }
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
  // ── "Still generating" signals ──
  // Only use very specific selectors — broad ones (e.g. aria-label*="Stop") match
  // the voice-input stop button and cause false positives.
  if (document.querySelector('button[data-testid="stop-button"]')) return true;
  if (document.querySelector('[data-testid="stop-button"]')) return true;
  if (document.querySelector('button[aria-label="Stop streaming"]')) return true;
  if (document.querySelector('button[aria-label="Stop generating"]')) return true;
  // NOTE: [class*="result-streaming"] intentionally removed — in current ChatGPT
  // builds this class persists on code blocks after generation ends, causing a
  // permanent false "still streaming" state that blocks completion detection.

  // ── "Done / idle" signals ──
  // The voice/microphone input button appears in the composer ONLY when ChatGPT is
  // idle (not generating). It is mutually exclusive with the stop button.
  if (document.querySelector('button[data-testid="composer-speech-button"]')) return false;
  if (document.querySelector('button[data-testid="voice-mode-button"]')) return false;
  if (document.querySelector('button[data-testid="voice-mode-toggle"]')) return false;
  if (document.querySelector('button[aria-label="Start voice input"]')) return false;
  if (document.querySelector('button[aria-label="Use microphone"]')) return false;
  if (document.querySelector('button[aria-label="Voice input"]')) return false;

  // If the send button is present and enabled, ChatGPT is ready → not streaming
  if (_findSendButton()) return false;

  return false;
}

// Detect whether the last assistant reply has completed generation.
// ChatGPT only adds action buttons (copy, thumbs up/down) AFTER streaming ends —
// their presence is the most reliable "done" signal available.
function _isLastReplyDone() {
  try {
    const els = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (!els.length) return false;
    const last = els[els.length - 1];
    return !!(
      last.querySelector('button[data-testid="copy-turn-action-button"]') ||
      last.querySelector('button[data-testid*="copy-turn"]') ||
      last.querySelector('button[data-testid="thumbs-up-button"]') ||
      last.querySelector('button[data-testid="thumbs-down-button"]') ||
      last.querySelector('button[aria-label="Good response"]') ||
      last.querySelector('button[aria-label="Bad response"]') ||
      last.querySelector('button[aria-label="Copy"]') ||
      last.querySelector('[data-testid="conversation-turn-action-bar"]')
    );
  } catch (_) { return false; }
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

  // Try dedicated prose/content selectors first — these contain ONLY the generated
  // text and don't include action-bar button labels (Copy, Good response, etc.).
  // Action-bar text in innerText would reset the stability timer every time ChatGPT
  // adds/updates buttons after generation, causing false "still changing" readings.
  const prose =
    last.querySelector('[class*="prose"]') ||
    last.querySelector('[class*="markdown"]') ||
    last.querySelector('.markdown') ||
    last.querySelector('[data-message-content]') ||
    last.querySelector('[class*="whitespace-pre-wrap"]');
  if (prose) return (prose.innerText || '').trim() || null;

  // Fallback: walk direct children and return the first one with substantial text.
  // Content is always the first major child; the action bar (buttons) comes last.
  const children = Array.from(last.children);
  for (const child of children) {
    const text = (child.innerText || '').trim();
    if (text.length > 20) return text;
  }

  return (last.innerText || '').trim() || null;
}

// Simulate a keyboard Enter press to trigger ChatGPT's send action.
// Dispatches on BOTH the form and the input element so the event reaches
// ChatGPT's send handler regardless of where it is attached.
// Dispatching on the form first bypasses ProseMirror's keymap (which would
// otherwise intercept Enter on the contenteditable and insert a newline).
function _pressEnter(el) {
  const opts = {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    bubbles: true, cancelable: true
  };
  // 1. Form level — bypasses ProseMirror, reaches ChatGPT's submit handler
  const form = el.closest('form') || document.querySelector('form');
  if (form) {
    form.dispatchEvent(new KeyboardEvent('keydown',  opts));
    form.dispatchEvent(new KeyboardEvent('keypress', opts));
    form.dispatchEvent(new KeyboardEvent('keyup',    opts));
  }
  // 2. Input element level — covers cases where the handler IS on the editor
  el.dispatchEvent(new KeyboardEvent('keydown',  opts));
  el.dispatchEvent(new KeyboardEvent('keypress', opts));
  el.dispatchEvent(new KeyboardEvent('keyup',    opts));
  // 3. Document level — catches any global keyboard shortcut listeners
  document.dispatchEvent(new KeyboardEvent('keydown',  { ...opts, bubbles: false }));
}

function _delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

} // end guard
