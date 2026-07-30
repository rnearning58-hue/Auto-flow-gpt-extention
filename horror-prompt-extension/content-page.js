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

  // ── Step 2: Insert via paste event (primary — handles large text without freezing) ──
  let inserted = false;
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await _delay(600);
    inserted = (el.innerText || el.textContent || '').trim().length > 2;
  } catch (_) {}

  // ── Step 3: Fallback — execCommand insertText (for older ChatGPT builds) ──
  if (!inserted) {
    try {
      document.execCommand('insertText', false, text);
      await _delay(500);
      inserted = (el.innerText || el.textContent || '').trim().length > 2;
    } catch (_) {}
  }

  // ── Step 4: Last resort — direct textContent + React fiber trigger ──
  if (!inserted) {
    _safeClear(el);
    await _delay(100);
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await _delay(400);
  }

  // Click send button
  await _clickSend();
  return true;
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

async function _clickSend() {
  const start = Date.now();
  while (Date.now() - start < 6000) {
    const btn =
      document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label="Send prompt"]') ||
      document.querySelector('button[aria-label="Send message"]') ||
      document.querySelector('button[aria-label*="Send"]');
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
      btn.click();
      return;
    }
    await _delay(300);
  }
  // Fallback: Enter key
  const el = await _findInput(3000);
  if (el) {
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true
    }));
  }
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
