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

  // Clear the input completely first
  await _clearInput(el);
  await _delay(200);

  // Insert text — works in MAIN world with React contenteditable
  document.execCommand('insertText', false, text);
  await _delay(500);

  // Check if text was actually inserted
  const typed = (el.innerText || el.textContent || '').trim();
  if (!typed || typed.length < 2) {
    // Fallback: clear again and use paste event
    await _clearInput(el);
    await _delay(200);
    await _pasteText(el, text);
    await _delay(400);
  }

  // Click send button
  await _clickSend();
  return true;
}

async function _clearInput(el) {
  el.focus();
  await _delay(150);

  // Select all and delete
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
  await _delay(80);
  document.execCommand('delete', false, null);
  await _delay(100);

  // Double-check: if still has content, clear innerHTML directly
  if ((el.innerText || el.textContent || '').trim().length > 0) {
    el.innerHTML = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await _delay(100);
  }
}

async function _pasteText(el, text) {
  el.focus();
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  } catch (e) {
    document.execCommand('insertText', false, text);
  }
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
  return !!(
    document.querySelector('button[data-testid="stop-button"]') ||
    document.querySelector('button[aria-label="Stop streaming"]') ||
    document.querySelector('button[aria-label*="Stop"]') ||
    document.querySelector('[class*="result-streaming"]') ||
    document.querySelector('[data-testid="stop-button"]')
  );
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
