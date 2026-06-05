// ISOLATED WORLD — handles chrome.runtime messaging & automation flow

// Guard: prevent double-execution (manifest + programmatic injection both run this)
if (window.__hpaBridgeLoaded) {
  // Already registered — do nothing
} else {
window.__hpaBridgeLoaded = true;

let stopRequested = false;
const pending = new Map();
let reqCounter = 0;

// Listen for responses from MAIN world (content-page.js)
window.addEventListener('message', (event) => {
  if (!event.data || event.data.hpaSource !== 'main') return;
  const { id, result, error, ok } = event.data;
  const resolve = pending.get(id);
  if (resolve) {
    pending.delete(id);
    resolve({ result, error, ok });
  }
});

// RPC: call a function in MAIN world, wait for result
function callPage(fn, ...args) {
  return new Promise((resolve) => {
    const id = ++reqCounter;
    pending.set(id, resolve);
    window.postMessage({ hpaSource: 'isolated', id, fn, args }, '*');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        // ok: false means timeout — NOT the same as "streaming stopped"
        resolve({ ok: false, error: 'Timeout: ' + fn, result: undefined });
      }
    }, 30000);
  });
}

function sendStatus(status, extra = {}) {
  try {
    chrome.runtime.sendMessage({ type: 'AUTOMATION_STATUS', status, ...extra });
  } catch (e) {}
}

// ── Entry point ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'START_AUTOMATION') {
    stopRequested = false;
    runAutomation(msg.masterPrompt, msg.storyText, msg.scenes);
  }
  if (msg.type === 'STOP_AUTOMATION') {
    stopRequested = true;
  }
});

// ── Automation flow ────────────────────────────────────────────────────────

async function runAutomation(masterPrompt, storyText, scenes) {
  try {
    // Step 1: Master Prompt
    sendStatus('sending_master');
    await sendAndWaitForReply(masterPrompt, 90);
    if (stopRequested) return;

    // Step 2: Story — wait for ChatGPT to ask for it
    sendStatus('sending_story');
    await delay(1500);
    await sendAndWaitForReply(storyText, 120);
    if (stopRequested) return;

    // Step 3: Numbered scenes list
    sendStatus('sending_scenes_list');
    await delay(1500);
    const numberedList = scenes
      .map((s, i) => `${i + 1}. ${stripLeadingNumber(s)}`)
      .join('\n');
    await sendAndWaitForReply(numberedList, 120);
    if (stopRequested) return;

    // Step 4: Each scene one by one
    for (let i = 0; i < scenes.length; i++) {
      if (stopRequested) return;

      sendStatus('scene_sent', { sceneIndex: i, scene: scenes[i] });
      await delay(1500);

      let output = '';

      try {
        // ── Get reply count BEFORE sending — so we can verify a NEW reply appeared
        const beforeCountRes = await callPage('getReplyCount');
        const beforeCount = (beforeCountRes.ok && beforeCountRes.result != null)
          ? beforeCountRes.result
          : -1;

        // Send scene number + full scene text (retry once on failure)
        const sceneMsg = `${i + 1}. ${stripLeadingNumber(scenes[i])}`;
        let sendRes = await callPage('typeAndSend', sceneMsg);
        if (!sendRes.ok) {
          // Wait a bit and retry once
          await delay(2000);
          sendRes = await callPage('typeAndSend', sceneMsg);
          if (!sendRes.ok) throw new Error(sendRes.error || 'Message পাঠানো যায়নি');
        }

        sendStatus('waiting', {
          detail: `Scene ${i + 1}-এর output আসছে...`,
          current: i
        });

        // Wait for a NEW reply to appear and fully stream
        await waitForNewReplyComplete(beforeCount, 210);
        if (stopRequested) return;

        const replyRes = await callPage('getLastReply');
        output = (replyRes.ok && replyRes.result) ? replyRes.result : '';

      } catch (sceneErr) {
        // One scene failing must NOT stop the whole loop
        output = '';
      }

      sendStatus('scene_done', { sceneIndex: i, scene: scenes[i], output });

      // Always wait after scene_done — ensures background.js finishes saving
      // before all_done is sent (prevents race condition on last scene).
      await delay(2500);
    }

    sendStatus('all_done');
  } catch (err) {
    sendStatus('error', { message: err.message });
  }
}

// ── Core helpers ───────────────────────────────────────────────────────────

// Type text into chatbox AND send, then wait for full reply
async function sendAndWaitForReply(text, timeoutSec = 90) {
  // Get current reply count so we can detect the new reply
  const beforeCountRes = await callPage('getReplyCount');
  const beforeCount = (beforeCountRes.ok && beforeCountRes.result != null)
    ? beforeCountRes.result
    : -1;

  const res = await callPage('typeAndSend', text);
  if (!res.ok) throw new Error(res.error || 'Message পাঠানো যায়নি');
  await waitForNewReplyComplete(beforeCount, timeoutSec);
}

// ── New reliable reply-waiting logic ──────────────────────────────────────

// Wait for a brand-new reply to appear (count increases) then wait for it to finish streaming.
// beforeCount: number of assistant messages that existed BEFORE sending.
// This guarantees we never read a stale/previous reply.
async function waitForNewReplyComplete(beforeCount, timeoutSec = 210) {
  const totalDeadline = Date.now() + timeoutSec * 1000;

  // ── Phase 1: Wait for a NEW reply message to appear in the DOM (up to 35s)
  const newReplyDeadline = Date.now() + 35000;
  let newReplyAppeared = false;

  while (Date.now() < newReplyDeadline) {
    if (stopRequested) return;
    const countRes = await callPage('getReplyCount');
    if (countRes.ok && countRes.result != null && countRes.result > beforeCount) {
      newReplyAppeared = true;
      break;
    }
    await delay(350);
  }

  if (!newReplyAppeared) {
    // No new reply detected — ChatGPT may have responded instantly (count didn't change
    // because we started polling after it already appeared) OR there's a real failure.
    // Either way, wait a few seconds and continue — don't skip the scene.
    await delay(4000);
    return;
  }

  // ── Phase 2: Wait for streaming to fully END
  while (Date.now() < totalDeadline) {
    if (stopRequested) return;

    const s = await callPage('isStreaming');

    // CRITICAL FIX: only treat as "stopped" when callPage succeeded (ok === true)
    // AND streaming is actually false. A callPage timeout (ok === false) means
    // the page was busy — do NOT interpret that as "streaming finished".
    if (s.ok === true && s.result === false) {
      // Double-check after 1.2s to rule out brief UI flickers
      await delay(1200);
      const s2 = await callPage('isStreaming');
      if (s2.ok === true && s2.result === false) {
        return; // Confirmed: streaming fully ended
      }
    }

    await delay(400);
  }
  // Timeout reached — move on anyway (ChatGPT might still be generating,
  // but we capture whatever has been output so far)
}

// ── Utils ──────────────────────────────────────────────────────────────────

function stripLeadingNumber(s) {
  // Remove leading "1." or "1. " or "১." etc
  return s.trim().replace(/^[\d]+[\.\)]\s*/, '');
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

} // end guard
