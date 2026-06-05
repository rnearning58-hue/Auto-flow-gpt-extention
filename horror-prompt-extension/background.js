// Save status to storage so popup can poll it

chrome.runtime.onMessage.addListener((msg) => {

  // ── ChatGPT Automation ──────────────────────────────────────────────────
  if (msg.type === 'AUTOMATION_STATUS') {
    const { type, ...statusData } = msg;

    if (statusData.status === 'scene_done') {
      chrome.storage.local.get(['automationResults', 'automationStatus'])
        .then(data => {
          const results = data.automationResults || [];
          results.push({ scene: statusData.scene, output: statusData.output });

          // Safety: never overwrite a terminal status (all_done/error) with scene_done
          const currentStatus = data.automationStatus?.status;
          const update = (currentStatus === 'all_done' || currentStatus === 'error')
            ? { automationResults: results }
            : { automationResults: results, automationStatus: statusData };

          chrome.storage.local.set(update).catch(err => {
            // Storage quota exceeded — retry saving without raw output to preserve scene list
            const slim = results.map(r => ({
              scene: r.scene,
              output: r.output ? r.output.substring(0, 8000) : ''
            }));
            chrome.storage.local.set({ ...update, automationResults: slim }).catch(() => {
              // Last resort: save only scene names so the project is not completely lost
              const minimal = results.map(r => ({ scene: r.scene, output: '' }));
              chrome.storage.local.set({ ...update, automationResults: minimal }).catch(() => {});
            });
          });
        })
        .catch(() => {});
      return;
    }

    const update = { automationStatus: statusData };
    if (statusData.status === 'all_done' || statusData.status === 'error') {
      update.automationRunning = false;
    }
    chrome.storage.local.set(update).catch(() => {});
  }

  // ── Google Flow Automation ──────────────────────────────────────────────
  if (msg.type === 'FLOW_STATUS') {
    const { type, ...statusData } = msg;
    const update = { flowStatus: statusData };
    if (statusData.status === 'all_done' || statusData.status === 'error' || statusData.status === 'stopped') {
      update.flowRunning = false;
    }
    chrome.storage.local.set(update).catch(() => {});
  }
});
