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

  // ── Phase 2: Wait for streaming to fully END
  // Two independent signals — whichever fires first wins:
  //   A) isLastReplyDone() — action buttons (👍👎 copy) appeared on last reply.
  //      PRIMARY signal. ChatGPT only renders these AFTER streaming is fully done.
  //      Screenshot-verifiable. Immune to stop-button selector staleness — this is
  //      the root cause of both known Phase 2 bugs:
  //        • Signal A (old _isStreaming()==false) exited early → next scene sent while
  //          still generating → voice button misclick (Problem 2).
  //        • strict newContentSeen guard blocked by same selector staleness → loop
  //          never exited even with complete output on screen (Problem 1).
  //   B) Content stability — reply text unchanged for 1.5 s (fallback for edge cases
  //      where action buttons render slowly or are not detected).
  //
  // NOTE: _isStreaming() is intentionally NOT used as an exit signal in Phase 2.
  // ChatGPT frequently changes stop-button testid/aria-label; when those selectors
  // are stale, _isStreaming() returns false even while the model is still generating,
  // which caused premature exits and the voice-button misclick.

  // Capture the last reply content RIGHT NOW so Signal B's stability timer only
  // starts once the reply has actually changed (prevents reading a stale prior scene).
  const initRes = await callPage('getLastReply', [], 10000);
  const initialContent = (initRes.ok && initRes.result) ? initRes.result : null;

  let lastContent = null;
  let stableStart = null;
  // newContentSeen: true once the NEW scene's reply text is actually in the DOM.
  //
  // ── Root cause of two bugs this logic fixes ──────────────────────────────
  //
  // BUG A — "scene complete too early" (first scene in screenshot):
  //   Phase 1 sees streaming start → newReplyAppeared=true → old code set
  //   newContentSeen=true immediately. But in virtualised 40+ turn convos the
  //   new reply DOM node hasn't rendered yet; last DOM element is still the
  //   PREVIOUS scene's reply with its action buttons already visible.
  //   Signal A fires on those old buttons → loop exits → extension marks done
  //   while ChatGPT is still generating.
  //
  // BUG B — "waiting forever" (second scene in screenshot):
  //   ChatGPT responded so fast that generate was complete before Phase 1 even
  //   ran. Phase 1 saw streaming=false, count didn't increase (virtualised) →
  //   newReplyAppeared=false → old code set newContentSeen=false. In Phase 2
  //   initialContent = the already-complete new reply; it never changes →
  //   newContentSeen never becomes true → loop runs until 210s timeout.
  //
  // ── Fix: compare against beforeContent ───────────────────────────────────
  //   beforeContent = last reply text captured BEFORE typeAndSend was called.
  //   initialContent = last reply text captured at Phase 2 start (may be same
  //   as beforeContent if virtualised, or already the new reply if fast network).
  //
  //   newContentSeen = true  iff  initialContent already differs from beforeContent
  //   → the new reply rendered before Phase 2 started (fast generation). ✓
  //   newContentSeen = false iff  initialContent === beforeContent
  //   → DOM still shows the old reply; wait for content to change. ✓
  //
  //   This handles both bugs:
  //   • BUG A: initialContent===beforeContent (old reply) → newContentSeen=false
  //     → Signals A/C blocked until content actually changes. ✓
  //   • BUG B: initialContent!==beforeContent (new reply already done)
  //     → newContentSeen=true immediately → Signal A fires on correct reply. ✓
  //
  // Edge cases:
  //   • beforeContent===null (very first reply ever): any non-null initialContent
  //     counts as new. ✓
  //   • initialContent===null: DOM has no reply yet; wait as before. ✓
  let newContentSeen = initialContent !== null &&
                       (beforeContent === null || initialContent !== beforeContent);
  const STABLE_MS = 1500; // content must be unchanged for this long → done

  while (Date.now() < totalDeadline) {
    if (stopRequested) return;

    // ── Signal A (PRIMARY): action buttons appeared on the last reply ─────────
    // Only checked once newContentSeen is true (new reply text has appeared).
    if (newContentSeen) {
      const done = await callPage('isLastReplyDone', [], 10000);
      if (done.ok && done.result === true) {
        // Brief confirmation pause to rule out transient button flicker
        await delay(300);
        const done2 = await callPage('isLastReplyDone', [], 10000);
        if (done2.ok && done2.result === true) {
          return; // Action buttons confirmed — reply fully generated ✓
        }
      }
    }

    // ── Signal C (SECONDARY): composer state button shows idle / done ─────────
    // Uses the new SVG-based _isStreaming() which detects the stop button by its
    // <rect> element rather than data-testid/aria-label (selector-independent).
    // Sound-wave button (🔵) visible = idle = generation complete.
    // Requires two consecutive false readings 600 ms apart to guard against the
    // brief visual transition between stop → send → idle states.
    // Only active once newContentSeen is true so we never exit on a stale prior state.
    if (newContentSeen) {
      const s1 = await callPage('isStreaming', [], 8000);
      if (s1.ok && s1.result === false) {
        await delay(600);
        const s2 = await callPage('isStreaming', [], 8000);
        if (s2.ok && s2.result === false) {
          return; // Idle/sound-wave button confirmed twice → generation complete ✓
        }
      }
    }

    // ── Signal B (FALLBACK): content stability check ──────────────────────────
    const r = await callPage('getLastReply', [], 10000);
    if (r.ok && r.result) {
      const content = r.result;

      if (!newContentSeen && content !== initialContent) {
        newContentSeen = true;
      }

      if (newContentSeen) {
        if (content !== lastContent) {
          lastContent = content;
          stableStart = Date.now();
        } else if (stableStart !== null && Date.now() - stableStart >= STABLE_MS) {
          return; // Content stable for STABLE_MS → streaming done ✓
        }
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
