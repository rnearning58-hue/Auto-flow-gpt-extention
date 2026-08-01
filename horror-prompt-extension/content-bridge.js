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

  // ── Intermediate status updates (e.g. file_uploading) ──
  // content-page.js sends { hpaSource:'main', type:'STATUS', status:'...' }
  // outside the normal RPC channel so the popup can show real-time state.
  if (event.data.type === 'STATUS') {
    const { type, hpaSource, ...rest } = event.data;
    sendStatus(rest.status, rest);
    return;
  }

  // ── Normal RPC reply ──
  const { id, result, error, ok } = event.data;
  const resolve = pending.get(id);
  if (resolve) {
    pending.delete(id);
    resolve({ result, error, ok });
  }
});

// RPC: call a function in MAIN world, wait for result.
// argsArray: arguments to pass to the page-side function (as an array).
// timeoutMs: how long to wait before giving up. Use a long value for operations
//   that may block (e.g. typeAndSend during a file upload) so the bridge never
//   cancels a still-running page-side operation and triggers a spurious retry.
function callPage(fn, argsArray = [], timeoutMs = 30000) {
  return new Promise((resolve) => {
    const id = ++reqCounter;
    pending.set(id, resolve);
    window.postMessage({ hpaSource: 'isolated', id, fn, args: argsArray }, '*');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        // ok: false means timeout — NOT the same as "streaming stopped"
        resolve({ ok: false, error: 'Timeout: ' + fn, result: undefined });
      }
    }, timeoutMs);
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

    // Step 3: Numbered scenes list — preserve original scene numbers
    sendStatus('sending_scenes_list');
    await delay(1500);
    const numberedList = scenes
      .map((s, i) => `${getSceneNumber(s, i + 1)}. ${stripLeadingNumber(s)}`)
      .join('\n');
    await sendAndWaitForReply(numberedList, 120);
    if (stopRequested) return;

    // Step 4: Each scene one by one
    for (let i = 0; i < scenes.length; i++) {
      if (stopRequested) return;

      const sceneNum = getSceneNumber(scenes[i], i + 1);
      sendStatus('scene_sent', { sceneIndex: i, scene: scenes[i] });
      await delay(1500);

      let output = '';

      try {
        // ── Get reply count BEFORE sending — so we can verify a NEW reply appeared
        const beforeCountRes = await callPage('getReplyCount', [], 10000);
        const beforeCount = (beforeCountRes.ok && beforeCountRes.result != null)
          ? beforeCountRes.result
          : -1;

        // Send scene number + full scene text.
        // Use a 12-minute RPC timeout (> the 10-min page-side _clickSend wait) so the
        // bridge never cancels a still-running upload and triggers a spurious retry.
        const sceneMsg = `${sceneNum}. ${stripLeadingNumber(scenes[i])}`;
        let sendRes = await callPage('typeAndSend', [sceneMsg], 720000);
        if (!sendRes.ok) {
          // The page-side _typeAndSend truly failed (not still in progress) — retry once.
          await delay(2000);
          sendRes = await callPage('typeAndSend', [sceneMsg], 720000);
          if (!sendRes.ok) throw new Error(sendRes.error || 'Message পাঠানো যায়নি');
        }

        sendStatus('waiting', {
          detail: `Scene ${sceneNum}-এর output আসছে...`,
          current: i
        });

        // Wait for a NEW reply to appear and fully stream
        await waitForNewReplyComplete(beforeCount, 210);
        if (stopRequested) return;

        const replyRes = await callPage('getLastReply', [], 10000);
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
  const beforeCountRes = await callPage('getReplyCount', [], 10000);
  const beforeCount = (beforeCountRes.ok && beforeCountRes.result != null)
    ? beforeCountRes.result
    : -1;

  // 12-minute RPC timeout — must exceed the 10-min page-side _clickSend wait so the
  // bridge never cancels a still-running file upload and reports a false failure.
  const res = await callPage('typeAndSend', [text], 720000);
  if (!res.ok) throw new Error(res.error || 'Message পাঠানো যায়নি');
  await waitForNewReplyComplete(beforeCount, timeoutSec);
}

// ── New reliable reply-waiting logic ──────────────────────────────────────

// Wait for a brand-new reply to appear (count increases) then wait for it to finish streaming.
// beforeCount: number of assistant messages that existed BEFORE sending.
// This guarantees we never read a stale/previous reply.
async function waitForNewReplyComplete(beforeCount, timeoutSec = 210) {
  const totalDeadline = Date.now() + timeoutSec * 1000;

  // ── Phase 1: Wait for a NEW reply message to appear in the DOM (up to 30s)
  // Detection method: reply count increases OR streaming starts (stop-button appears).
  // NOTE: In long conversations (40+ messages) ChatGPT virtualizes old DOM nodes, so
  // the reply count may NOT increase even when a new reply appears. We fall through to
  // Phase 2 in that case rather than returning early — Phase 2's content-stability
  // check will still fire correctly once the new reply's text stabilises.
  const newReplyDeadline = Date.now() + 30000;
  let newReplyAppeared = false;

  while (Date.now() < newReplyDeadline) {
    if (stopRequested) return;

    // Primary: count increased → new reply in DOM
    const countRes = await callPage('getReplyCount', [], 8000);
    if (countRes.ok && countRes.result != null && countRes.result > beforeCount) {
      newReplyAppeared = true;
      break;
    }

    // Secondary: stop-button appeared → ChatGPT started streaming (count may be stale)
    const streamRes = await callPage('isStreaming', [], 8000);
    if (streamRes.ok && streamRes.result === true) {
      newReplyAppeared = true;
      break;
    }

    await delay(350);
  }

  if (!newReplyAppeared) {
    // Neither signal fired — long conversation virtualisation likely caused count to stall.
    // Do NOT return here: fall through to Phase 2 so content-stability still runs.
    // A short pause lets ChatGPT finish any pending render before we start polling text.
    await delay(3000);
  }

  // ── Phase 2: Wait for streaming to fully END
  // Two independent signals — whichever fires first wins:
  //   A) isStreaming() returns false (stop-button gone, voice/send-button visible)
  //   B) Content stability — NEW reply text unchanged for 1.5 s
  //
  // KEY INVARIANT: Signal B only starts counting once content has CHANGED from
  // what was present at Phase 2 start. This prevents the bug where a slow/delayed
  // network causes Phase 1 to fall through, Phase 2 reads the PREVIOUS scene's
  // stable output, and exits prematurely — skipping the scene entirely.

  // Capture whatever is in the last reply RIGHT NOW (before the new reply arrives).
  // Signal B stability timer will not start until content diverges from this value.
  const initRes = await callPage('getLastReply', [], 10000);
  const initialContent = (initRes.ok && initRes.result) ? initRes.result : null;

  let lastContent = null;
  let stableStart = null;
  let newContentSeen = false; // true once content has changed from initialContent
  const STABLE_MS = 1500;     // content must be unchanged for this long → done
  const phase2Start = Date.now();
  const PHASE2_SAFETY_MS = 30000; // safety cap — only fires if new content was seen

  while (Date.now() < totalDeadline) {
    if (stopRequested) return;

    // Signal A: DOM-based streaming indicator (stop-button / voice-button / send-button)
    // Only trust "not streaming" if new content has appeared — guards against the case
    // where ChatGPT hasn't started generating yet (no stop-button = "not streaming"
    // before the response begins, which would be a false positive).
    const s = await callPage('isStreaming', [], 10000);
    if (s.ok === true && s.result === false && newContentSeen) {
      // Brief pause to rule out transient UI state between stop→voice button swap
      await delay(300);
      const s2 = await callPage('isStreaming', [], 10000);
      if (s2.ok === true && s2.result === false) {
        return; // Confirmed: new reply fully received, ChatGPT now idle
      }
    }

    // Signal B: Content stability check
    const r = await callPage('getLastReply', [], 10000);
    if (r.ok && r.result) {
      const content = r.result;

      // Detect when NEW content first appears (different from what was there before send)
      if (!newContentSeen && content !== initialContent) {
        newContentSeen = true;
      }

      // Only run the stability timer after new content has arrived
      if (newContentSeen) {
        if (content !== lastContent) {
          lastContent = content;
          stableStart = Date.now();
        } else if (stableStart !== null && Date.now() - stableStart >= STABLE_MS) {
          return; // New content stable for STABLE_MS — streaming done
        }
      }
    }

    // Safety net: only applies once new content has been seen.
    // If network is slow and no new content yet, keep waiting (don't skip the scene).
    if (newContentSeen && Date.now() - phase2Start > PHASE2_SAFETY_MS) {
      return;
    }

    await delay(400);
  }
  // Global timeout reached (210 s) — move on with whatever output arrived
}

// ── Utils ──────────────────────────────────────────────────────────────────

function stripLeadingNumber(s) {
  // Remove leading "1." or "1. " or "১." etc
  return s.trim().replace(/^[\d]+[\.\)]\s*/, '');
}

// Extract leading scene number (e.g. "40. সমুদ্র..." → 40), fallback if none
function getSceneNumber(s, fallback) {
  const m = s.trim().match(/^(\d+)[\.\)]\s*/);
  return m ? parseInt(m[1]) : fallback;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

} // end guard
