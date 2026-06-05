// MAIN WORLD — Google Flow page interactions v1.5.21
if (!window.__hpaFlowPageLoaded) {
window.__hpaFlowPageLoaded = true;

const LOG = (...a) => console.log('[HPA v1.5.21]', ...a);

window.addEventListener('message', async (event) => {
  if (!event.data || event.data.hpaSource !== 'flow-isolated') return;
  const { id, fn, args } = event.data;
  try {
    let result;
    if (fn === 'flowTypeAndSend')       result = await _flowTypeAndSend(args[0]);
    else if (fn === 'flowPasteImage')  result = await _flowPasteImage(args[0]);
    else if (fn === 'flowIsReady')     result = await _flowIsReady();
    else if (fn === 'flowWaitForImage') result = await _waitForImageUpload(args[0] || 12000);
    window.postMessage({ hpaSource: 'flow-main', id, result, ok: true }, '*');
  } catch (e) {
    LOG('ERROR in', fn, e.message);
    window.postMessage({ hpaSource: 'flow-main', id, error: e.message, ok: false }, '*');
  }
});

// ─────────────────────────────────────────────────────────────────
//  TYPE AND SEND  (v1.5.18)
// ─────────────────────────────────────────────────────────────────
async function _flowTypeAndSend(text) {
  LOG('Starting flowTypeAndSend, text length:', text.length);

  const el = await _findFlowInput(15000);
  if (!el) throw new Error('Google Flow chat input পাওয়া যায়নি। Page refresh করুন।');

  LOG('Input found:', el.tagName, el.className.slice(0, 60), 'placeholder:', el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '');

  const isTextArea = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';

  // ── 1. Focus ───────────────────────────────────────────────────
  el.click();
  el.focus();
  await _fd(300);

  // ── 2. Insert text ─────────────────────────────────────────────
  if (isTextArea) {
    LOG('Using native setter for textarea');
    _setNativeValue(el, text);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    LOG('contenteditable — textContent BEFORE:', JSON.stringify(el.textContent.slice(0, 60)));

    el.focus();
    await _fd(300);

    // ── APPROACH 1: Range.selectNodeContents → IMMEDIATE insertText ────────
    // Root cause of all previous failures:
    //   • execCommand('selectAll') selects the WHOLE PAGE, not just the editor —
    //     so insertText had no valid in-editor selection and appended to placeholder.
    //   • execCommand('delete') is intercepted and blocked by the editor.
    //   • Any await between select and insertText lets React re-render and lose selection.
    // Fix: use Range API (scoped to el) then IMMEDIATELY insertText — no await between.
    const rng = document.createRange();
    rng.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(rng);
    LOG('Range selection set, selected text:', JSON.stringify(sel.toString().slice(0, 50)));
    // IMMEDIATE — no await here
    const exec1 = document.execCommand('insertText', false, text);
    LOG('Range+insertText result:', exec1, '| textContent now:', JSON.stringify(el.textContent.slice(0, 80)));
    await _fd(150);

    // ── APPROACH 2: beforeinput insertFromPaste (ProseMirror/Lexical/Tiptap) ──
    // Modern custom editors listen to beforeinput events with dataTransfer.
    const after1 = el.textContent.trim();
    const clean1 = after1 === text.trim() ||
                   (after1.length > 0 && !after1.includes('What do you want'));
    if (!clean1) {
      LOG('Approach 1 left contamination — trying beforeinput insertFromPaste');
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      dt.setData('text/html',  text);
      // Re-select so paste replaces
      const rng2 = document.createRange();
      rng2.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(rng2);
      el.dispatchEvent(new InputEvent('beforeinput', {
        inputType:    'insertFromPaste',
        dataTransfer: dt,
        bubbles:      true,
        cancelable:   true,
      }));
      await _fd(200);
      LOG('beforeinput paste → textContent:', JSON.stringify(el.textContent.slice(0, 80)));
    }

    // ── APPROACH 3: safeSetTextContent + full fiber walk ─────────────────
    const after2 = el.textContent.trim();
    const clean2 = after2 === text.trim() ||
                   (after2.length > 0 && !after2.includes('What do you want'));
    if (!clean2 || after2.length < 2) {
      LOG('All direct methods contaminated — safeSetTextContent + fiber walk');
      _safeSetTextContent(el, text);
      await _fd(100);
      _walkFiberAndTrigger(el, text);
    }

    LOG('Final textContent:', JSON.stringify(el.textContent.slice(0, 80)));

    // ── Always fire events ─────────────────────────────────────────────────
    el.dispatchEvent(new InputEvent('input',  { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new InputEvent('change', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
    await _fd(100);
  }
  await _fd(200);

  // ── 3. Check current value ─────────────────────────────────────
  const currentVal = isTextArea ? el.value : el.textContent;
  LOG('Current value after injection:', JSON.stringify(currentVal.slice(0, 60)));

  // ── 4. blur → focus cycle ──────────────────────────────────────
  el.blur();
  await _fd(150);
  el.click();
  el.focus();
  await _fd(300);

  // ── 5. Wait for button to enable (up to 4s) ──────────────────
  LOG('Waiting for send button to enable...');
  const btn = await _waitForSendBtn(el, 4000);
  const btnState = btn
    ? `found (disabled:${btn.disabled} aria-disabled:${btn.getAttribute('aria-disabled')})`
    : 'not enabled';
  LOG('Button state:', btnState);

  // Helper: call a React fiber's event handler directly, bypassing the
  // browser event dispatch system entirely. This means isTrusted is
  // irrelevant — we are calling the handler function directly.
  function _callFiberHandler(domEl, handlerProp, fakeEvent) {
    try {
      const fk = Object.keys(domEl).find(k =>
        k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (!fk) { LOG('No React fiber on', domEl.tagName); return false; }
      let fiber = domEl[fk];
      while (fiber) {
        const props = fiber.memoizedProps;
        if (props && typeof props[handlerProp] === 'function') {
          LOG('React fiber', handlerProp, 'found on', fiber.type || domEl.tagName, '— calling directly');
          props[handlerProp](fakeEvent);
          return true;
        }
        fiber = fiber.return;
      }
      LOG('React fiber', handlerProp, 'not found walking tree');
    } catch (e) { LOG('_callFiberHandler error:', e.message); }
    return false;
  }

  // Fake event objects — plain JS objects (not browser Events), so
  // isTrusted is whatever we set. React handlers receive SyntheticEvent
  // wrappers but many also read nativeEvent.isTrusted.
  const noop = () => {};
  const fakeKeyEnter = {
    type: 'keydown', key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    isTrusted: true, bubbles: true, cancelable: true,
    shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
    target: el, currentTarget: el,
    preventDefault: noop, stopPropagation: noop, stopImmediatePropagation: noop,
    nativeEvent: { isTrusted: true, key: 'Enter', keyCode: 13 },
  };
  const fakeClick = {
    type: 'click', isTrusted: true, bubbles: true, cancelable: true,
    button: 0, buttons: 1,
    target: btn, currentTarget: btn,
    preventDefault: noop, stopPropagation: noop, stopImmediatePropagation: noop,
    nativeEvent: { isTrusted: true },
  };

  el.focus();
  await _fd(150);

  // ── PRIMARY A: React onKeyDown on input via fiber (isTrusted:true) ──────
  const kbOk = _callFiberHandler(el, 'onKeyDown', fakeKeyEnter);
  LOG('React onKeyDown fiber call result:', kbOk);
  await _fd(700);

  // ── PRIMARY B: React onClick on button via fiber (isTrusted:true) ───────
  if (btn) {
    const clickOk = _callFiberHandler(btn, 'onClick', fakeClick);
    LOG('React onClick fiber call result:', clickOk);
    await _fd(700);
  }

  // ── SECONDARY: Ctrl+Enter (bypasses rich-text editor's newline handler) ─
  const mkOpts = extra => Object.assign(
    { key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true, cancelable:true }, extra);
  el.dispatchEvent(new KeyboardEvent('keydown',  mkOpts({ ctrlKey:true })));
  el.dispatchEvent(new KeyboardEvent('keyup',    mkOpts({ ctrlKey:true })));
  LOG('Ctrl+Enter dispatched');
  await _fd(500);

  // ── TERTIARY: plain Enter ─────────────────────────────────────
  _fireEnter(el);
  LOG('Plain Enter dispatched');
  await _fd(500);

  // ── QUATERNARY: DOM button click ──────────────────────────────
  const btn2 = _findSendBtn(el);
  if (btn2 && !btn2.disabled && btn2.getAttribute('aria-disabled') !== 'true') {
    const r = btn2.getBoundingClientRect();
    LOG('DOM click on button at:', Math.round(r.left), Math.round(r.top));
    _fullClick(btn2);
    await _fd(400);
  }

  // ── QUINARY: form.requestSubmit() ────────────────────────────
  const form = el.closest('form');
  if (form) {
    try { form.requestSubmit(); } catch (_) {}
  }

  LOG('Submission sequence complete');
  return true;
}

// ─────────────────────────────────────────────────────────────────
//  Safe textContent setter — patches removeChild to prevent the
//  React "NotFoundError: removeChild" crash that happens when we
//  replace all child nodes via textContent.
// ─────────────────────────────────────────────────────────────────
function _safeSetTextContent(el, text) {
  // Patch: if React tries to removeChild a node we already replaced,
  // silently ignore the NotFoundError instead of crashing the page.
  const origRemove = el.removeChild.bind(el);
  el.removeChild = function(child) {
    try { return origRemove(child); }
    catch (e) { if (e.name === 'NotFoundError') return child; throw e; }
  };
  // Set the content
  el.textContent = text;
  // Move cursor to end so editor recognises it as active
  try {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  } catch (_) {}
  // Restore original removeChild after React has had a chance to reconcile
  setTimeout(() => { el.removeChild = origRemove; }, 3000);
}

// ─────────────────────────────────────────────────────────────────
//  Native value setter for <textarea> / <input>
// ─────────────────────────────────────────────────────────────────
function _setNativeValue(el, value) {
  try {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) { d.set.call(el, value); return; }
  } catch (_) {}
  el.value = value;
}

// ─────────────────────────────────────────────────────────────────
//  Walk React fiber tree — call onInput / onChange handlers
// ─────────────────────────────────────────────────────────────────
function _walkFiberAndTrigger(el, text) {
  try {
    const isTA = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
    const fakeTarget = isTA
      ? el
      : Object.create(el, {
          textContent: { get: () => text },
          innerText:   { get: () => text },
          value:       { get: () => text },
        });

    const fakeEvent = {
      target: fakeTarget, currentTarget: fakeTarget,
      bubbles: true, cancelable: true,
      preventDefault:  () => {},
      stopPropagation: () => {},
      nativeEvent: { data: text, inputType: 'insertText', target: fakeTarget },
    };

    const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps'));
    if (propsKey) {
      const p = el[propsKey];
      if (typeof p.onInput  === 'function') try { p.onInput(fakeEvent);  } catch (_) {}
      if (typeof p.onChange === 'function') try { p.onChange(fakeEvent); } catch (_) {}
    }

    const fiberKey = Object.keys(el).find(k =>
      k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    if (!fiberKey) { LOG('No React fiber found on input element'); return; }

    let fiber = el[fiberKey];
    let depth = 0;
    let handlersFound = 0;
    while (fiber && depth < 40) {
      depth++;
      const p = fiber.memoizedProps;
      if (p) {
        if (typeof p.onInput  === 'function') { try { p.onInput(fakeEvent);  } catch (_) {} handlersFound++; }
        if (typeof p.onChange === 'function') { try { p.onChange(fakeEvent); } catch (_) {} handlersFound++; }
      }
      fiber = fiber.return;
    }
    LOG('Fiber walk: depth', depth, '| handlers triggered:', handlersFound);
  } catch (e) {
    LOG('Fiber walk error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
//  PASTE IMAGE
// ─────────────────────────────────────────────────────────────────
async function _flowPasteImage(imageDataUrl) {
  const el = await _findFlowInput(8000);
  if (!el) throw new Error('Flow input not found');
  let success = false;

  // Count existing blob/data images BEFORE paste so we can detect a NEW one
  const prevBlobCount = [...document.querySelectorAll('img')].filter(img =>
    (img.src || '').startsWith('blob:') || (img.src || '').startsWith('data:')
  ).length;

  try {
    const res  = await fetch(imageDataUrl);
    const blob = await res.blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
    el.focus(); await _fd(200);
    const kv = { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', kv));
    document.dispatchEvent(new KeyboardEvent('keydown', kv));
    await _fd(800);
    success = true;
  } catch (e) {}

  if (!success) {
    try {
      const res2 = await fetch(imageDataUrl);
      const blob2 = await res2.blob();
      const dt = new DataTransfer();
      dt.items.add(new File([blob2], 'image.png', { type: blob2.type || 'image/png' }));
      el.focus();
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await _fd(800);
      success = true;
    } catch (e2) {}
  }

  // Wait until a NEW image appears in the page (count increases from prevBlobCount)
  const uploaded = await _waitForImageUpload(14000, prevBlobCount);
  if (!uploaded) await _fd(3000);
  return success;
}

// ─────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────

async function _flowIsReady() {
  return !!(await _findFlowInput(5000));
}

async function _findFlowInput(timeout = 10000) {
  const SELS = [
    'textarea[data-testid]',
    'textarea[aria-label]',
    'textarea[placeholder]',
    'div[contenteditable="true"][data-placeholder]',
    'div.ql-editor[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][aria-label]',
    'div[contenteditable="true"][aria-multiline]',
    'div[contenteditable="true"]',
    'textarea',
  ];
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of SELS) {
      const el = document.querySelector(sel);
      if (el && el.isConnected && _isVisible(el)) return el;
    }
    await _fd(400);
  }
  return null;
}

function _isVisible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

async function _waitForSendBtn(inputEl, timeout = 10000) {
  const start = Date.now();
  let logTick = 0;
  while (Date.now() - start < timeout) {
    const btn = _findSendBtn(inputEl);
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') return btn;

    // Log button state every 2 s for diagnosis
    if (logTick % 20 === 0) {
      if (btn) {
        LOG('Button still disabled — disabled:', btn.disabled,
            'aria-disabled:', btn.getAttribute('aria-disabled'),
            'input textContent:', document.querySelector('[contenteditable="true"]')?.textContent?.slice(0, 40));
      } else {
        // Dump all buttons for diagnosis
        const all = [...document.querySelectorAll('button,[role="button"]')];
        LOG('No button found. Total button-like elements:', all.length);
        all.slice(0, 8).forEach((b, i) => {
          const r = b.getBoundingClientRect();
          LOG(`  [${i}] tag:${b.tagName} svg:${!!b.querySelector('svg')} disabled:${b.disabled} aria-dis:${b.getAttribute('aria-disabled')} pos:${Math.round(r.left)},${Math.round(r.top)} size:${Math.round(r.width)}x${Math.round(r.height)}`);
        });
      }
    }
    logTick++;
    await _fd(100);
  }
  return null;
}

function _findSendBtn(inputEl) {
  const vw = window.innerWidth, vh = window.innerHeight;

  // helper: is a button visible in the viewport?
  function _inViewport(r) {
    return r.width >= 12 && r.height >= 12 &&
           r.top >= -10 && r.bottom <= vh + 10 &&
           r.left >= -10 && r.right <= vw + 10;
  }

  // 1. Named selectors — viewport-visible only
  const NAMED = [
    'button[aria-label*="Send"]', 'button[aria-label*="send"]',
    'button[aria-label*="Submit"]', 'button[aria-label*="submit"]',
    'button[aria-label*="Create"]', 'button[aria-label*="Generate"]',
    'button[aria-label*="Run"]',
    'button[type="submit"]',
    'button[data-testid*="send"]', 'button[data-testid*="submit"]',
    'button[data-testid*="generate"]',
  ];
  for (const sel of NAMED) {
    const b = document.querySelector(sel);
    if (b && _inViewport(b.getBoundingClientRect())) return b;
  }

  // 2. Walk UP from input through parent containers — most reliable
  //    Finds the button that is in the SAME ROW as the input (a sibling or
  //    cousin in the same flex/grid container).
  if (inputEl) {
    let container = inputEl.parentElement;
    for (let depth = 0; depth < 8 && container; depth++) {
      const btns = [...container.querySelectorAll('button,[role="button"]')];
      // Among buttons in this container, find the one closest to input's right edge
      // that is in the viewport
      const ir = inputEl.getBoundingClientRect();
      const iCy = ir.top + ir.height / 2;
      let best = null, bestDist = Infinity;
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        if (!_inViewport(r)) continue;
        // Must be in the same horizontal band as the input (within 60px vertically)
        if (Math.abs((r.top + r.height / 2) - iCy) > 60) continue;
        // Prefer buttons to the RIGHT of the input
        if (r.right < ir.left) continue;
        const dist = Math.abs(r.left - ir.right);
        if (dist < bestDist) { bestDist = dist; best = b; }
      }
      if (best) {
        const r = best.getBoundingClientRect();
        LOG('Container-walk button found at depth', depth,
            'pos:', Math.round(r.left), Math.round(r.top),
            'size:', Math.round(r.width), 'x', Math.round(r.height));
        return best;
      }
      container = container.parentElement;
    }
  }

  // 3. Fallback: visible SVG button in bottom 40% of viewport, rightmost
  const allBtns = [...document.querySelectorAll('button,[role="button"]')];
  let best2 = null, bestRight = -1;
  for (const b of allBtns) {
    const r = b.getBoundingClientRect();
    if (!_inViewport(r)) continue;
    if (r.top < vh * 0.6) continue; // bottom 40% of viewport
    if (r.width > 300) continue;
    if (!b.querySelector('svg')) continue;
    if (r.left > bestRight) { bestRight = r.left; best2 = b; }
  }
  if (best2) {
    const r = best2.getBoundingClientRect();
    LOG('Fallback SVG button at', Math.round(r.left), Math.round(r.top));
  }
  return best2;
}

async function _waitForImageUpload(timeout = 12000, prevBlobCount = -1) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const imgs = [...document.querySelectorAll('img')];
    const blobs = imgs.filter(img =>
      (img.src || '').startsWith('blob:') || (img.src || '').startsWith('data:')
    );
    if (prevBlobCount >= 0) {
      // Waiting for a NEW blob image to appear (count must increase)
      if (blobs.length > prevBlobCount) { await _fd(1000); return true; }
    } else {
      // Legacy check: any blob image present
      const btn = _findSendBtn();
      if (btn && !btn.disabled && blobs.length > 0) return true;
      if (blobs.length > 0) { await _fd(800); return true; }
    }
    await _fd(400);
  }
  return false;
}

function _fireEnter(el) {
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown',  opts));
  el.dispatchEvent(new KeyboardEvent('keypress', opts));
  el.dispatchEvent(new KeyboardEvent('keyup',    opts));
}

function _fullClick(el) {
  const opts = { bubbles: true, cancelable: true, buttons: 1, button: 0 };
  el.dispatchEvent(new MouseEvent('mouseover',  opts));
  el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
  el.dispatchEvent(new MouseEvent('mousedown',  opts));
  el.dispatchEvent(new MouseEvent('mouseup',    opts));
  el.dispatchEvent(new MouseEvent('click',      opts));
  el.click();
}

function _fd(ms) { return new Promise(r => setTimeout(r, ms)); }

} // end guard
