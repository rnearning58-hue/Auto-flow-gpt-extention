// MAIN WORLD — runs inside page's JS context
// Can use document.execCommand, React internals, etc.

// Guard: prevent double-execution if injected more than once
if (!window.__hpaPageLoaded) {
window.__hpaPageLoaded = true;

// ── Fetch interceptor: network-level stream detection ─────────────────────
// Patches window.fetch to watch ChatGPT's SSE stream directly.
// When the stream begins  → __hpaIsStreaming = true
// When [DONE] is received → __hpaIsStreaming = false
// This is far more reliable than DOM polling: it is immune to selector
// changes, virtualisation, and action-button render timing.
(function _initStreamInterceptor() {
  if (window.__hpaStreamInterceptorActive) return;
  window.__hpaStreamInterceptorActive = true;
  window.__hpaIsStreaming = false;

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string'
      ? args[0]
      : (args[0]?.url ?? '');

    const response = await origFetch.apply(this, args);

    // Only intercept ChatGPT's conversation / backend API endpoints
    const isConvoCall =
      url.includes('/conversation') ||
      url.includes('backend-api')   ||
      url.includes('backend-anon');

    if (isConvoCall && response.body) {
      window.__hpaIsStreaming = true;

      let clone;
      try { clone = response.clone(); }
      catch (_) { window.__hpaIsStreaming = false; return response; }

      // Drain the cloned stream asynchronously — original body is untouched
      (async () => {
        try {
          const reader  = clone.body.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) { window.__hpaIsStreaming = false; return; }
            const chunk = decoder.decode(value, { stream: true });
            // SSE end-of-stream marker sent by all ChatGPT model variants
            if (chunk.includes('data: [DONE]')) {
              window.__hpaIsStreaming = false;
              return;
            }
          }
        } catch (_) {
          window.__hpaIsStreaming = false;
        }
      })();
    }

    return response;
  };
})();

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

  // Capture baseline state BEFORE we do anything.
  //
  // countBefore: used to detect when a new assistant node appears in the DOM.
  //   Reliable when DOM virtualisation is not in effect.
  //
  // wasStreamingOnEntry: true if ChatGPT was still generating the PREVIOUS scene's
  //   reply when typeAndSend was called (network delay / late output).
  //   Used to scope the count-rise fallback: if streaming was already active, a count
  //   increase might belong to that delayed prior reply, not our new message.
  //   In that case we only trust _composerCleared() as the acceptance signal.
  const countBefore = _getReplyCount();
  const wasStreamingOnEntry = _isStreaming();

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
          await _delay(600);
          // Acceptance check: did ChatGPT receive our message?
          // Signal 1 — Composer cleared (PRIMARY, always checked):
          //   When ChatGPT accepts a message it immediately empties the input box.
          //   Reliable even in virtualised 40+ turn conversations; does NOT fire on a
          //   pre-existing streaming state from the previous scene.
          // Signal 2 — Reply count increased (SECONDARY, scoped):
          //   Only used when ChatGPT was NOT already streaming when typeAndSend was called.
          //   If streaming was already active on entry, a count rise could belong to the
          //   delayed prior reply (not ours), so we skip it and rely solely on Signal 1.
          if (_composerCleared(el) || (!wasStreamingOnEntry && _getReplyCount() > countBefore)) return true;
          // Neither signal fired: wrong button may have been clicked (e.g. voice icon) or
          // ChatGPT isn't ready. Fall through to Enter attempt.
        }

        // Attempt 2: simulate Enter key press (keydown + keypress + keyup)
        // This mirrors exactly what happens when a user presses Enter on the keyboard.
        _pressEnter(el);
        await _delay(700);

        // Same dual-signal check after Enter (same scoping rationale as above):
        //   • Composer cleared → always sufficient regardless of streaming state.
        //   • Count increased → only when streaming was idle on typeAndSend entry.
        if (_composerCleared(el) || (!wasStreamingOnEntry && _getReplyCount() > countBefore)) return true;

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

  // Keywords checked against aria-label AND data-testid — any match skips the button.
  // 'speech', 'record', 'audio', 'dictate' cover the voice-input button variants
  // ChatGPT uses; without them the voice button (🎤) can be mistaken for the send button.
  const skip = ['attach', 'file', 'voice', 'mic', 'microphone',
                'stop', 'search', 'browse', 'photo', 'image', 'upload', 'tool',
                'speech', 'record', 'audio', 'dictate'];

  // Explicit voice/speech button selectors — excluded regardless of aria-label or
  // data-testid values (guards against buttons with empty/missing attributes that
  // would otherwise slip past the keyword filter above and receive a stray click).
  const VOICE_SELECTORS =
    '[data-testid="composer-speech-button"],' +
    '[data-testid="voice-mode-button"],' +
    '[data-testid="voice-mode-toggle"],' +
    '[aria-label*="voice" i],' +
    '[aria-label*="microphone" i],' +
    '[aria-label*="dictate" i],' +
    '[aria-label*="speech" i]';

  // Walk up at most 8 levels from the input, find the first ancestor that contains
  // exactly the send button (after filtering out known non-send buttons).
  let container = input.parentElement;
  for (let depth = 0; depth < 8 && container && container !== document.body; depth++) {
    const buttons = Array.from(container.querySelectorAll('button'));
    const candidates = buttons.filter(btn => {
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
      if (!btn.querySelector('svg')) return false;
      // Explicit voice button guard — checked before keyword filter so buttons with
      // empty aria-label/data-testid are still correctly excluded.
      try { if (btn.matches(VOICE_SELECTORS)) return false; } catch (_) {}
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

// Find the single button that cycles between stop / send / idle states.
// It is always the rightmost non-mic SVG button inside the composer input area.
// Selector-independent: survives data-testid / aria-label changes.
function _findComposerStateButton() {
  const input =
    document.querySelector('#prompt-textarea') ||
    document.querySelector('div[contenteditable="true"][id*="prompt"]') ||
    document.querySelector('div[contenteditable="true"].ProseMirror') ||
    document.querySelector('div[contenteditable="true"]');
  if (!input) return null;

  const voiceWords = ['mic', 'voice', 'speech', 'audio', 'dictate', 'record'];

  let container = input.parentElement;
  for (let depth = 0; depth < 8 && container && container !== document.body; depth++) {
    const buttons = Array.from(container.querySelectorAll('button'));
    const candidates = buttons.filter(btn => {
      if (!btn.querySelector('svg')) return false;
      const label  = (btn.getAttribute('aria-label')   || '').toLowerCase();
      const testid = (btn.getAttribute('data-testid')  || '').toLowerCase();
      return !voiceWords.some(w => label.includes(w) || testid.includes(w));
    });
    if (candidates.length >= 1) {
      return candidates[candidates.length - 1]; // rightmost = state-cycling button
    }
    container = container.parentElement;
  }
  return null;
}

function _isStreaming() {
  // ── Strategy 0: fetch interceptor (PRIMARY — network-level, selector-immune) ──
  // __hpaIsStreaming is set true when ChatGPT's SSE stream begins and false the
  // moment the stream sends data: [DONE] or the reader reports done.
  // This signal is completely independent of DOM structure and CSS class names.
  if (window.__hpaStreamInterceptorActive) {
    return window.__hpaIsStreaming === true;
  }

  // ── Strategy 1: known data-testid / aria-label selectors (fallback) ──
  if (document.querySelector('button[data-testid="stop-button"]')) return true;
  if (document.querySelector('[data-testid="stop-button"]'))        return true;
  if (document.querySelector('button[aria-label="Stop streaming"]')) return true;
  if (document.querySelector('button[aria-label="Stop generating"]')) return true;

  // ── Strategy 2: composer state button visual inspection (fallback) ──
  //   Idle/sound-wave → DARK background → not streaming
  //   Stop (square)   → LIGHT background + 1 SVG rect → streaming
  //   Send (arrow)    → LIGHT background + 0 SVG rects → not streaming
  const stateBtn = _findComposerStateButton();
  if (stateBtn) {
    try {
      const bg   = window.getComputedStyle(stateBtn).backgroundColor;
      const vals = bg.match(/[\d.]+/g);
      if (vals && vals.length >= 3) {
        const brightness = (parseInt(vals[0]) + parseInt(vals[1]) + parseInt(vals[2])) / 3;
        if (brightness < 100) return false; // dark → idle/sound-wave
      }
    } catch (_) {}
    const rectCount = stateBtn.querySelectorAll('svg rect').length;
    if (rectCount === 1) return true;
    return false;
  }

  // ── Strategy 3: known idle signals (last resort) ──
  if (document.querySelector('button[data-testid="composer-speech-button"]')) return false;
  if (document.querySelector('button[data-testid="voice-mode-button"]'))      return false;
  if (document.querySelector('button[data-testid="voice-mode-toggle"]'))      return false;
  if (document.querySelector('button[aria-label="Start voice input"]'))       return false;
  if (document.querySelector('button[aria-label="Use microphone"]'))          return false;
  if (document.querySelector('button[aria-label="Voice input"]'))             return false;
  if (_findSendButton()) return false;

  return false;
}

// Detect whether the last assistant reply has completed generation.
// ChatGPT only adds action buttons (copy, thumbs up/down) AFTER streaming ends.
//
// IMPORTANT: In some ChatGPT builds the action bar is a SIBLING of the content
// div, not a child — it sits outside [data-message-author-role="assistant"].
// We walk UP from the last assistant element, expanding the search container one
// level at a time, but STOP as soon as the container would include more than one
// assistant message (prevents false positives from previous replies' action bars).
function _isLastReplyDone() {
  try {
    const els = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (!els.length) return false;
    const last = els[els.length - 1];

    function hasActionButton(root) {
      return !!(
        root.querySelector('button[data-testid="copy-turn-action-button"]') ||
        root.querySelector('button[data-testid*="copy-turn"]') ||
        root.querySelector('button[data-testid="thumbs-up-button"]') ||
        root.querySelector('button[data-testid="thumbs-down-button"]') ||
        root.querySelector('button[aria-label="Good response"]') ||
        root.querySelector('button[aria-label="Bad response"]') ||
        root.querySelector('button[aria-label="Copy"]') ||
        root.querySelector('[data-testid="conversation-turn-action-bar"]')
      );
    }

    // Walk upward from the last assistant element, up to 5 levels.
    // Stop expanding if the container starts including OTHER assistant messages
    // (that would risk matching action buttons from a previous reply).
    let container = last;
    for (let i = 0; i < 5; i++) {
      if (hasActionButton(container)) return true;
      const parent = container.parentElement;
      if (!parent || parent === document.body) break;
      // If parent contains more than one assistant element it's too broad — stop.
      if (parent.querySelectorAll('[data-message-author-role="assistant"]').length > 1) break;
      container = parent;
    }
    return false;
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

// Returns true when the composer input box has been cleared by ChatGPT after accepting
// a message. This is the most reliable acceptance signal in virtualized long conversations
// (where _getReplyCount() may stay stale) and is immune to pre-existing streaming state
// (the previous scene's stop-button cannot cause a false positive here).
// Re-queries the DOM rather than trusting the passed-in reference, which may be stale.
function _composerCleared(hint) {
  try {
    const el =
      document.querySelector('#prompt-textarea') ||
      document.querySelector('div[contenteditable="true"][id*="prompt"]') ||
      document.querySelector('div[contenteditable="true"].ProseMirror') ||
      hint;
    if (!el) return false;
    return (el.innerText || el.textContent || '').trim().length === 0;
  } catch (_) {
    return false;
  }
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
