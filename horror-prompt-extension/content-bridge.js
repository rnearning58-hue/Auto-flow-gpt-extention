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
        // ── Get reply count AND last reply content BEFORE sending ─────────────
        // beforeCount: detect new reply via DOM node count (fast path, fails when virtualised)
        // beforeContent: detect new reply via content change (works even when virtualised
        //   because we compare DOM text directly — immune to ChatGPT's node recycling).
        const beforeCountRes = await callPage('getReplyCount', [], 10000);
        const beforeCount = (beforeCountRes.ok && beforeCountRes.result != null)
          ? beforeCountRes.result
          : -1;

        const beforeContentRes = await callPage('getLastReply', [], 10000);
        const beforeContent = (beforeContentRes.ok && beforeContentRes.result)
          ? beforeContentRes.result
          : null;

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
        await waitForNewReplyComplete(beforeCount, 210, beforeContent);
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

  // Capture the last reply's text BEFORE sending — Phase 2 uses this to know
  // when a genuinely NEW reply has appeared in the DOM (not the old one).
  const beforeContentRes = await callPage('getLastReply', [], 10000);
  const beforeContent = (beforeContentRes.ok && beforeContentRes.result)
    ? beforeContentRes.result
    : null;

  // 12-minute RPC timeout — must exceed the 10-min page-side _clickSend wait so the
  // bridge never cancels a still-running file upload and reports a false failure.
  const res = await callPage('typeAndSend', [text], 720000);
  if (!res.ok) throw new Error(res.error || 'Message পাঠানো যায়নি');
  await waitForNewReplyComplete(beforeCount, timeoutSec, beforeContent);
}

// ── New reliable reply-waiting logic ──────────────────────────────────────

// Wait for a brand-new reply to appear (count increases) then wait for it to finish streaming.
// beforeCount:   number of assistant messages that existed BEFORE sending.
// beforeContent: text of the last reply BEFORE sending — used to detect the new reply by
//                content change when DOM virtualisation keeps the count from increasing.
async function waitForNewReplyComplete(beforeCount, timeoutSec = 210, beforeContent = null) {
  const totalDeadline = Date.now() + timeoutSec * 1000;

  // ── Phase 1: Wait for a NEW reply message to appear in the DOM (up to 30s)
  // Detection method: reply count increases OR streaming STARTS (transitions to true).
  // NOTE: In long conversations (40+ messages) ChatGPT virtualizes old DOM nodes, so
  // the reply count may NOT increase even when a new reply appears. We fall through to
  // Phase 2 in that case rather than returning early — Phase 2's content-stability
  // check will still fire correctly once the new reply's text stabilises.

  // ── Streaming transition tracker ──────────────────────────────────────────
  // We detect a NEW reply via two independent signals:
  //   1. Reply count increases (direct, but fails in virtualised 40+ turn convos)
  //   2. Streaming state transitions to true (stop-button appears)
  //
  // Signal 2 needs careful qualification:
  //   • If streaming was IDLE at Phase 1 start: any transition to true = new reply. ✓
  //   • If streaming was ALREADY ACTIVE (previous scene still generating):
  //     a simple "is streaming = true" would fire immediately and be wrong.
  //     We must observe the full sequence  true → false → true:
  //       - true  (old stream running)
  //       - false (old stream ended)
  //       - true  (new scene started streaming)  ← this final true = new reply ✓
  //
  // The tracker below handles both cases with a single unified state machine.
  const prePhase1StreamRes = await callPage('isStreaming', [], 8000);
  let trackedStreaming = prePhase1StreamRes.ok && prePhase1StreamRes.result === true;
  // If we start NOT streaming: the very first true transition is the new reply.
  // If we start streaming: we need to see it go false first, then true again.
  let sawStreamingFalse = !trackedStreaming; // already false-phase satisfied if idle

  const newReplyDeadline = Date.now() + 30000;
  let newReplyAppeared = false;

  while (Date.now() < newReplyDeadline) {
    if (stopRequested) return;

    // Primary: count increased → new reply in DOM (fastest path when not virtualised)
    const countRes = await callPage('getReplyCount', [], 8000);
    if (countRes.ok && countRes.result != null && countRes.result > beforeCount) {
      newReplyAppeared = true;
      break;
    }

    // Secondary: streaming state transition — only accept a new-streaming event
    // after we've already seen streaming go false (old scene ended).
    const streamRes = await callPage('isStreaming', [], 8000);
    const currentStreaming = streamRes.ok && streamRes.result === true;

    if (!currentStreaming) {
      // Old (or any prior) stream has ended — we're now in the "false" phase.
      sawStreamingFalse = true;
    } else if (currentStreaming && sawStreamingFalse) {
      // Streaming is true AND we previously saw it go false → this is the new reply.
      newReplyAppeared = true;
      break;
    }
    trackedStreaming = currentStreaming;

    await delay(350);
  }

  if (!newReplyAppeared) {
    // Neither signal fired — long conversation virtualisation likely caused count to stall.
    // Do NOT return here: fall through to Phase 2 so content-stability still runs.
    // A short pause lets ChatGPT finish any pending render before we start polling text.
    await delay(3000);
  }

  // ── Phase 2: Wait for streaming to fully END ─────────────────────────────
  //
  // ── Why the old Signal A / B / C approach had bugs ────────────────────────
  //
  // Signal A (action buttons): Fired on the PREVIOUS scene's buttons when the
  //   new reply DOM node hadn't rendered yet (virtualised 40+ turn conversations).
  //   Also fired while streaming was still active if ChatGPT rendered buttons early.
  //
  // Signal B (content stability 1.5 s): Fired during a normal pause between
  //   JSON tokens — generation hadn't ended, just briefly slowed down.
  //
  // Signal C (isStreaming double-false): Even with a reference counter, the
  //   previous 2-check / 600 ms approach was fragile. The 3-check / 2 s approach
  //   worked but added 4 s latency on every scene.
  //
  // ── New unified approach ──────────────────────────────────────────────────
  //
  // PRIMARY — streaming reference counter stable at 0:
  //   _isStreaming() returns (__hpaStreamCount > 0).  When every backend-api
  //   fetch (including concurrent metadata calls) has fully closed, the counter
  //   reaches 0.  We require it to stay 0 for STREAM_STABLE_MS (1.5 s) to rule
  //   out the brief inter-chunk gaps that can appear on slow connections.
  //   Once the counter hits 0 and stays there, generation is definitively done —
  //   no DOM selector needed, no action-button timing dependency.
  //   Also resets whenever new content appears (content change means a stream
  //   chunk arrived, so the counter must be > 0 — reset is just a safety net).
  //
  // FALLBACK — content unchanged for CONTENT_STABLE_MS (5 s):
  //   Safety net for the rare case where [DONE] is never sent and the stream
  //   closes without properly decrementing the counter.  5 s is long enough
  //   to survive normal generation pauses without triggering prematurely.
  //
  // Both signals are gated behind newContentSeen (same logic as before) to
  // prevent acting on a stale prior-scene reply.

  const initRes = await callPage('getLastReply', [], 10000);
  const initialContent = (initRes.ok && initRes.result) ? initRes.result : null;

  // newContentSeen: the last DOM reply is already the NEW scene's reply.
  // True when initialContent already differs from beforeContent (fast network /
  // generation complete before Phase 2 started).  False when DOM still shows the
  // old reply — wait for content to change before trusting any exit signal.
  let newContentSeen = initialContent !== null &&
                       (beforeContent === null || initialContent !== beforeContent);

  let lastContent = null;       // last observed reply text (for content-change detection)
  let stableStart  = null;      // when lastContent last changed (for 5 s fallback)
  let streamZeroSince = null;   // when __hpaStreamCount first reached 0 (for primary signal)

  const STREAM_STABLE_MS  = 1500;  // counter must stay 0 for this long → done
  const CONTENT_STABLE_MS = 5000;  // content-unchanged fallback threshold

  while (Date.now() < totalDeadline) {
    if (stopRequested) return;

    // ── Update newContentSeen and content-stability tracker ────────────────
    const r = await callPage('getLastReply', [], 10000);
    if (r.ok && r.result) {
      const content = r.result;

      // Flip newContentSeen the moment DOM content differs from initial snapshot.
      if (!newContentSeen && content !== initialContent) {
        newContentSeen = true;
      }

      if (newContentSeen) {
        if (content !== lastContent) {
          lastContent     = content;
          stableStart     = Date.now();
          streamZeroSince = null; // new content arrived → a stream chunk just came in →
                                  // reset the stream-zero timer (counter must be > 0 right now)
        }
      }
    }

    if (newContentSeen) {
      // ── PRIMARY: streaming reference counter held at 0 ───────────────────
      const streamRes = await callPage('isStreaming', [], 8000);
      if (streamRes.ok) {
        if (streamRes.result === false) {
          // Counter is 0 — no active streams right now.
          if (streamZeroSince === null) streamZeroSince = Date.now();
          if (Date.now() - streamZeroSince >= STREAM_STABLE_MS) {
            return; // Counter at 0 for STREAM_STABLE_MS → generation complete ✓
          }
        } else {
          // Stream still active — reset the zero-stability timer.
          streamZeroSince = null;
        }
      }

      // ── FALLBACK: content unchanged for CONTENT_STABLE_MS ────────────────
      // Only fires when the primary signal hasn't fired (e.g. [DONE] was never
      // sent and the counter is stuck > 0).  5 s ensures this doesn't trigger
      // during normal mid-generation pauses.
      if (stableStart !== null && Date.now() - stableStart >= CONTENT_STABLE_MS) {
        return; // Content stable for 5 s → assume generation complete ✓
      }
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
