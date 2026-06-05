// ISOLATED WORLD — Google Flow automation bridge
if (window.__hpaFlowBridgeLoaded) {
  // Already loaded
} else {
window.__hpaFlowBridgeLoaded = true;

let flowStop = false;
const flowPending = new Map();
let flowReqId = 0;

// Listen for responses from MAIN world (flow-page.js)
window.addEventListener('message', (event) => {
  if (!event.data || event.data.hpaSource !== 'flow-main') return;
  const { id, result, error, ok } = event.data;
  const resolve = flowPending.get(id);
  if (resolve) { flowPending.delete(id); resolve({ result, error, ok }); }
});

function callPage(fn, ...args) {
  return new Promise((resolve) => {
    const id = ++flowReqId;
    flowPending.set(id, resolve);
    window.postMessage({ hpaSource: 'flow-isolated', id, fn, args }, '*');
    setTimeout(() => {
      if (flowPending.has(id)) { flowPending.delete(id); resolve({ ok: false, error: 'Timeout: ' + fn }); }
    }, 35000);
  });
}

function sendStatus(status, extra = {}) {
  try { chrome.runtime.sendMessage({ type: 'FLOW_STATUS', status, ...extra }); } catch (e) {}
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'START_FLOW') {
    flowStop = false;
    runFlow(msg.prompts, msg.delaySeconds);
  }
  if (msg.type === 'STOP_FLOW') {
    flowStop = true;
  }
});

async function runFlow(prompts, delaySeconds) {
  try {
    for (let i = 0; i < prompts.length; i++) {
      if (flowStop) { sendStatus('stopped'); return; }

      const item = prompts[i];
      sendStatus('sending', { index: i, total: prompts.length, label: item.label || '' });

      // If image data is provided, paste image first, then wait for it to load
      if (item.imageData) {
        sendStatus('pasting_image', { index: i, total: prompts.length });
        const imgRes = await callPage('flowPasteImage', item.imageData);
        if (flowStop) { sendStatus('stopped'); return; }
        if (!imgRes.ok) {
          sendStatus('image_warn', { index: i, total: prompts.length, message: imgRes.error });
        } else {
          // Wait until the image actually appears in the chatbox before sending text
          sendStatus('waiting_image', { index: i, total: prompts.length });
          await callPage('flowWaitForImage', 10000);
          if (flowStop) { sendStatus('stopped'); return; }
        }
        await wait(500);
        if (flowStop) { sendStatus('stopped'); return; }
      }

      if (flowStop) { sendStatus('stopped'); return; }

      // Type and send the prompt
      const res = await callPage('flowTypeAndSend', item.text);
      if (flowStop) { sendStatus('stopped'); return; }
      if (!res.ok) throw new Error(res.error || 'Prompt পাঠানো যায়নি');

      sendStatus('prompt_sent', { index: i, total: prompts.length });

      // Wait delay between prompts (skip delay after last one)
      if (i < prompts.length - 1) {
        for (let s = delaySeconds; s > 0; s--) {
          if (flowStop) { sendStatus('stopped'); return; }
          sendStatus('waiting', { index: i, total: prompts.length, remaining: s, delaySeconds });
          await wait(1000);
        }
      }
    }

    sendStatus('all_done', { total: prompts.length });

  } catch (err) {
    sendStatus('error', { message: err.message });
  }
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

} // end guard
