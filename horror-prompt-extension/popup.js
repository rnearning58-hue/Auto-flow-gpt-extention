// ═══════════════════════════════════════════════════════
//  EXISTING ChatGPT Automation — UNCHANGED
// ═══════════════════════════════════════════════════════

const DEFAULT_MASTER_PROMPT = `You are a Professional Cinematic Horror Scene Prompt Generator AI.

Follow steps strictly:

━━━━━━━━━━━━━━━━━━
STEP 1
━━━━━━━━━━━━━━━━━━

Only say:
"Give me Your Full Story"

━━━━━━━━━━━━━━━━━━
STEP 2
━━━━━━━━━━━━━━━━━━

Only say:
"Paste Numbered Scenes From Your Story"

━━━━━━━━━━━━━━━━━━
STEP 3
━━━━━━━━━━━━━━━━━━

Only say:
"Enter Scene Number For Prompt"

━━━━━━━━━━━━━━━━━━
STEP 4 – OUTPUT
━━━━━━━━━━━━━━━━━━

Use EXACT scene line
Maintain smooth cinematic horror
Strong horror atmosphere MUST remain
Psychological horror + atmospheric horror preferred
NO explanation, NO jump scare, NO sudden movement

Each output MUST be inside separate fenced code blocks:
✔ Scene → text
✔ Image → json
✔ Video → json

Note: All visible humans MUST look Indian. All visible people are adults over 18 years old.`;

let pollInterval = null;
let _currentDetailProject = null;

// ── Audio state ─────────────────────────────────────────────────────────────
let _startAudioEl = null;
let _doneAudioEl  = null;

document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  await loadSavedData();
  setupEventListeners();
  setupSettingsListeners();
  updateSceneCount();
  await loadAudioSettings();
  await checkRunningState();
  await checkFlowRunningState();
});

function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

async function loadSavedData() {
  const data = await chrome.storage.local.get(['masterPrompt', 'storyText', 'scenesText']);
  document.getElementById('master-prompt').value = data.masterPrompt || DEFAULT_MASTER_PROMPT;
  document.getElementById('story-text').value = data.storyText || '';
  document.getElementById('scenes-text').value = data.scenesText || '';
}

function setupEventListeners() {
  document.getElementById('btn-save').addEventListener('click', saveSettings);
  document.getElementById('btn-start').addEventListener('click', startAutomation);
  document.getElementById('btn-stop').addEventListener('click', stopAutomation);
  document.getElementById('btn-open-saved').addEventListener('click', showSavedList);
  document.getElementById('btn-open-flow').addEventListener('click', showFlowPage);
  document.getElementById('btn-back-from-list').addEventListener('click', () => showPage('page-setup'));
  document.getElementById('btn-back-from-detail').addEventListener('click', () => showSavedList());
  document.getElementById('btn-back-from-flow').addEventListener('click', () => showPage('page-setup'));
  document.getElementById('btn-settings').addEventListener('click', () => showPage('page-settings'));
  document.getElementById('btn-back-from-settings').addEventListener('click', () => showPage('page-setup'));
  document.getElementById('scenes-text').addEventListener('input', updateSceneCount);

  // ── Export ──────────────────────────────────────────────────────────────────
  document.getElementById('btn-export-project').addEventListener('click', () => {
    if (!_currentDetailProject) return;
    const json = JSON.stringify(_currentDetailProject, null, 2);
    navigator.clipboard.writeText(json).then(() => {
      const btn = document.getElementById('btn-export-project');
      btn.textContent = '✅ Copied!';
      setTimeout(() => { btn.textContent = '📋 Export'; }, 2000);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = json; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      const btn = document.getElementById('btn-export-project');
      btn.textContent = '✅ Copied!';
      setTimeout(() => { btn.textContent = '📋 Export'; }, 2000);
    });
  });

  // ── Import ──────────────────────────────────────────────────────────────────
  document.getElementById('btn-import-project').addEventListener('click', () => {
    const panel = document.getElementById('import-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    if (panel.style.display === 'block') document.getElementById('import-textarea').focus();
  });
  document.getElementById('btn-import-cancel').addEventListener('click', () => {
    document.getElementById('import-panel').style.display = 'none';
    document.getElementById('import-textarea').value = '';
  });
  document.getElementById('btn-import-confirm').addEventListener('click', async () => {
    const raw = document.getElementById('import-textarea').value.trim();
    if (!raw) { alert('কিছু paste করুন!'); return; }
    let project;
    try { project = JSON.parse(raw); } catch (_) { alert('❌ Invalid data! সঠিক JSON paste করুন।'); return; }
    if (!project.title || !Array.isArray(project.scenes)) { alert('❌ Invalid project format!'); return; }
    project.id = Date.now().toString();
    const data = await chrome.storage.local.get('savedProjects');
    const saved = data.savedProjects || [];
    saved.unshift(project);
    await chrome.storage.local.set({ savedProjects: saved });
    document.getElementById('import-panel').style.display = 'none';
    document.getElementById('import-textarea').value = '';
    renderSavedList(saved);
    document.getElementById('no-saved').style.display = 'none';
  });

  setupFlowListeners();
}

// ── Settings: Audio ─────────────────────────────────────────────────────────

function setupSettingsListeners() {
  _setupAudioSlot('start');
  _setupAudioSlot('done');
}

function _setupAudioSlot(type) {
  const fileInput  = document.getElementById(`file-${type}-audio`);
  const uploadBtn  = document.getElementById(`btn-upload-${type}`);
  const previewBtn = document.getElementById(`btn-preview-${type}`);
  const removeBtn  = document.getElementById(`btn-remove-${type}`);
  const nameEl     = document.getElementById(`${type}-audio-name`);

  uploadBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      const dataUrl = e.target.result;
      const key = type === 'start' ? 'audioStartData' : 'audioDoneData';
      const nameKey = type === 'start' ? 'audioStartName' : 'audioDoneName';
      await chrome.storage.local.set({ [key]: dataUrl, [nameKey]: file.name });
      _buildAudioEl(type, dataUrl);
      _updateAudioUI(type, file.name, true);
      _showSaveStatus('✔ সেভ হয়েছে!');
    };
    reader.readAsDataURL(file);
    fileInput.value = '';
  });

  previewBtn.addEventListener('click', () => {
    const el = type === 'start' ? _startAudioEl : _doneAudioEl;
    if (!el) return;
    if (!el.paused) {
      el.pause();
      el.currentTime = 0;
      previewBtn.textContent = '▶';
      previewBtn.classList.remove('playing');
      return;
    }
    el.currentTime = 0;
    el.play().catch(() => {});
    previewBtn.textContent = '⏹';
    previewBtn.classList.add('playing');
    el.onended = () => {
      previewBtn.textContent = '▶';
      previewBtn.classList.remove('playing');
    };
  });

  removeBtn.addEventListener('click', async () => {
    const key = type === 'start' ? 'audioStartData' : 'audioDoneData';
    const nameKey = type === 'start' ? 'audioStartName' : 'audioDoneName';
    await chrome.storage.local.remove([key, nameKey]);
    if (type === 'start') _startAudioEl = null;
    else _doneAudioEl = null;
    _updateAudioUI(type, null, false);
    _showSaveStatus('🗑️ মুছে দেওয়া হয়েছে');
  });
}

function _buildAudioEl(type, dataUrl) {
  const el = new Audio(dataUrl);
  if (type === 'start') _startAudioEl = el;
  else _doneAudioEl = el;
}

function _updateAudioUI(type, fileName, hasAudio) {
  const nameEl     = document.getElementById(`${type}-audio-name`);
  const uploadBtn  = document.getElementById(`btn-upload-${type}`);
  const previewBtn = document.getElementById(`btn-preview-${type}`);
  const removeBtn  = document.getElementById(`btn-remove-${type}`);

  if (hasAudio && fileName) {
    nameEl.textContent = fileName;
    nameEl.classList.add('has-audio');
    uploadBtn.textContent = '🔄 Change';
    uploadBtn.classList.add('has-audio');
    previewBtn.style.display = 'inline-block';
    removeBtn.style.display = 'inline-block';
  } else {
    nameEl.textContent = 'কোনো অডিও সেট করা নেই';
    nameEl.classList.remove('has-audio');
    uploadBtn.textContent = '📂 Upload';
    uploadBtn.classList.remove('has-audio');
    previewBtn.style.display = 'none';
    removeBtn.style.display = 'none';
  }
}

function _showSaveStatus(msg) {
  const el = document.getElementById('settings-save-status');
  if (!el) return;
  el.textContent = msg;
  setTimeout(() => { el.textContent = ''; }, 2500);
}

async function loadAudioSettings() {
  const data = await chrome.storage.local.get(['audioStartData', 'audioStartName', 'audioDoneData', 'audioDoneName']);
  if (data.audioStartData) {
    _buildAudioEl('start', data.audioStartData);
    _updateAudioUI('start', data.audioStartName || 'start.mp3', true);
  }
  if (data.audioDoneData) {
    _buildAudioEl('done', data.audioDoneData);
    _updateAudioUI('done', data.audioDoneName || 'done.mp3', true);
  }
}

function playStartSound() {
  if (!_startAudioEl) return;
  try { _startAudioEl.currentTime = 0; _startAudioEl.play().catch(() => {}); } catch (_) {}
}

function playDoneSound() {
  if (!_doneAudioEl) return;
  try { _doneAudioEl.currentTime = 0; _doneAudioEl.play().catch(() => {}); } catch (_) {}
}

function updateSceneCount() {
  const text = document.getElementById('scenes-text').value.trim();
  const lines = text ? text.split('\n').filter(l => l.trim()) : [];
  const el = document.getElementById('scene-count');
  el.textContent = lines.length > 0 ? `✔ ${lines.length}টি সিন তৈরি আছে` : '';
}

async function saveSettings() {
  await chrome.storage.local.set({
    masterPrompt: document.getElementById('master-prompt').value.trim(),
    storyText: document.getElementById('story-text').value.trim(),
    scenesText: document.getElementById('scenes-text').value.trim(),
  });
  const status = document.getElementById('save-status');
  status.textContent = '✔ সেভ হয়েছে!';
  setTimeout(() => { status.textContent = ''; }, 2000);
}

async function startAutomation() {
  const masterPrompt = document.getElementById('master-prompt').value.trim();
  const storyText = document.getElementById('story-text').value.trim();
  const scenesText = document.getElementById('scenes-text').value.trim();

  if (!masterPrompt) return alert('Master Prompt দিন!');
  if (!storyText) return alert('Story দিন!');
  if (!scenesText) return alert('অন্তত একটি Scene দিন!');

  const scenes = scenesText.split('\n').filter(l => l.trim());
  if (scenes.length === 0) return alert('কোনো scene পাওয়া যায়নি!');

  await chrome.storage.local.set({ masterPrompt, storyText, scenesText });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  if (!url.includes('chatgpt.com') && !url.includes('chat.openai.com')) {
    alert('⚠️ ChatGPT tab খুলুন এবং সেই tab-এ থাকুন!\n\nhttps://chatgpt.com');
    return;
  }

  await chrome.storage.local.set({
    automationRunning: true,
    automationStep: 'master',
    automationScenes: scenes,
    automationCurrentScene: 0,
    automationResults: [],
    automationTabId: tab.id,
    automationStatus: { status: 'sending_master' },
  });

  showPage('page-running');
  startPolling(scenes.length);
  playStartSound();

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'START_AUTOMATION', masterPrompt, storyText, scenes });
  } catch (e) {
    await chrome.storage.local.set({
      automationRunning: false,
      automationStatus: { status: 'error', message: '⚠️ ChatGPT page টি একবার Refresh (F5) করুন, তারপর আবার Start করুন।' }
    });
    stopPolling();
    showPage('page-setup');
    alert('⚠️ ChatGPT page টি একবার Refresh (F5) করুন, তারপর আবার Start করুন।');
  }
}

async function stopAutomation() {
  const data = await chrome.storage.local.get('automationTabId');
  await chrome.storage.local.set({ automationRunning: false, automationResults: [], automationStatus: {} });
  stopPolling();
  if (data.automationTabId) {
    chrome.tabs.sendMessage(data.automationTabId, { type: 'STOP_AUTOMATION' }).catch(() => {});
  }
  showPage('page-setup');
}

function startPolling(totalScenes) {
  stopPolling();
  pollInterval = setInterval(async () => {
    const data = await chrome.storage.local.get(['automationRunning', 'automationStatus', 'automationResults', 'automationScenes']);
    const scenes = data.automationScenes || [];
    const total = scenes.length || totalScenes;
    const statusData = data.automationStatus || {};
    renderStatus(statusData, total);
    if (!data.automationRunning) {
      stopPolling();
      const results = data.automationResults || [];
      const isAllScenesComplete = results.length > 0 && results.length >= total;
      if (statusData.status === 'all_done' && results.length > 0) {
        await handleAllDone(results);
      } else if (isAllScenesComplete && (statusData.status === 'scene_done' || statusData.status === 'all_done')) {
        // Safety net: all scenes have results but status may have been overwritten by race condition
        await handleAllDone(results);
      } else if (statusData.status === 'error') {
        updateRunningStatus('❌', 'Error!', statusData.message || 'আবার চেষ্টা করুন', 0, total);
      }
    }
  }, 800);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

async function handleAllDone(results) {
  playDoneSound();
  updateRunningStatus('🎉', 'সব সম্পন্ন! সেভ হচ্ছে...', `${results.length}টি সিন`, results.length, results.length);
  const storeData = await chrome.storage.local.get('storyText');
  const project = await saveProject(results, storeData.storyText || '');
  await chrome.storage.local.set({ automationResults: [], automationStatus: {} });
  updateRunningStatus('✅', 'সেভ হয়ে গেছে!', `"${project.title}"`, results.length, results.length);
  setTimeout(() => {
    renderProjectDetail(project);
    showPage('page-saved-detail');
  }, 1200);
}

function renderStatus(s, total) {
  switch (s.status) {
    case 'sending_master':      updateRunningStatus('📤', 'Master Prompt পাঠানো হচ্ছে...', 'Step 1', 0, total); break;
    case 'sending_story':       updateRunningStatus('📖', 'Story পাঠানো হচ্ছে...', 'Step 2', 0, total); break;
    case 'sending_scenes_list': updateRunningStatus('📋', 'Scene তালিকা পাঠানো হচ্ছে...', 'Step 3', 0, total); break;
    case 'scene_sent':          updateRunningStatus('🎬', `Scene ${(s.sceneIndex||0)+1} পাঠানো হচ্ছে...`, `${(s.sceneIndex||0)+1} / ${total}`, s.sceneIndex||0, total); break;
    case 'waiting':             updateRunningStatus('⏳', 'ChatGPT reply-এর অপেক্ষায়...', s.detail || '', s.current||0, total); break;
    case 'scene_done':          updateRunningStatus('✅', `Scene ${(s.sceneIndex||0)+1} সম্পন্ন!`, `${(s.sceneIndex||0)+1} / ${total} হয়েছে`, (s.sceneIndex||0)+1, total); break;
    case 'all_done':            updateRunningStatus('🎉', 'সব সম্পন্ন!', `মোট ${total}টি সিন তৈরি`, total, total); break;
    case 'error':               updateRunningStatus('❌', 'Error!', s.message || '', 0, total); break;
  }
}

async function checkRunningState() {
  const data = await chrome.storage.local.get(['automationRunning', 'automationScenes', 'automationResults', 'automationStatus']);
  if (data.automationRunning) {
    showPage('page-running');
    startPolling((data.automationScenes || []).length);
  } else if (data.automationStatus?.status === 'all_done' && (data.automationResults || []).length > 0) {
    showPage('page-running');
    await handleAllDone(data.automationResults);
  }
}

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function updateRunningStatus(icon, text, step, current, total) {
  document.getElementById('status-icon').textContent = icon;
  document.getElementById('status-text').textContent = text;
  document.getElementById('status-step').textContent = step;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('progress-label').textContent = total > 0 ? `${current} / ${total} সিন সম্পন্ন` : '';
}

// ── Saved Projects ─────────────────────────────────────────────────────────

function parsePrompts(rawOutput) {
  if (!rawOutput) return { imagePrompt: '', videoPrompt: '' };
  const text = rawOutput.replace(/Copy code\r?\n?/gi, '');

  const fencedRe = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  const jsonFenced = [];
  let m;
  while ((m = fencedRe.exec(text)) !== null) {
    const c = m[1].trim();
    if (c.includes('{') && c.includes('"')) jsonFenced.push(c);
  }
  if (jsonFenced.length >= 2) return { imagePrompt: jsonFenced[0], videoPrompt: jsonFenced[1] };
  if (jsonFenced.length === 1) return { imagePrompt: jsonFenced[0], videoPrompt: '' };

  const jsonLabelRe = /(?:^|\n)json\s*\n(\{[\s\S]*?\n\})/g;
  const labelBlocks = [];
  while ((m = jsonLabelRe.exec(text)) !== null) labelBlocks.push(m[1].trim());
  if (labelBlocks.length >= 2) return { imagePrompt: labelBlocks[0], videoPrompt: labelBlocks[1] };
  if (labelBlocks.length === 1) return { imagePrompt: labelBlocks[0], videoPrompt: '' };

  const lines = text.split('\n');
  let depth = 0, blockLines = [], inBlock = false;
  const objBlocks = [];
  for (const line of lines) {
    for (const ch of line) {
      if (ch === '{') { if (depth === 0) { inBlock = true; blockLines = []; } depth++; }
      if (ch === '}') depth--;
    }
    if (inBlock) blockLines.push(line);
    if (inBlock && depth === 0) {
      const block = blockLines.join('\n').trim();
      if (block.includes('"') && block.split('\n').length > 2) objBlocks.push(block);
      inBlock = false; blockLines = [];
    }
  }
  if (objBlocks.length >= 2) return { imagePrompt: objBlocks[0], videoPrompt: objBlocks[1] };
  if (objBlocks.length === 1) return { imagePrompt: objBlocks[0], videoPrompt: '' };

  return { imagePrompt: rawOutput, videoPrompt: '' };
}

function extractTitle(storyText) {
  const firstLine = (storyText || '').trim().split('\n')[0].trim();
  const clean = firstLine.replace(/^[#*\-=\s]+/, '').trim();
  return clean.slice(0, 55) || 'Untitled Project';
}

async function saveProject(results, storyText) {
  const title = extractTitle(storyText);
  const now = new Date();
  const date = `${now.getDate().toString().padStart(2,'0')}/${(now.getMonth()+1).toString().padStart(2,'0')}/${now.getFullYear()}`;
  const scenes = results.map(r => {
    const { imagePrompt, videoPrompt } = parsePrompts(r.output || '');
    return { scene: r.scene || '', imagePrompt, videoPrompt, rawOutput: r.output || '' };
  });
  const project = { id: Date.now().toString(), title, date, sceneCount: scenes.length, scenes };
  const data = await chrome.storage.local.get('savedProjects');
  const saved = data.savedProjects || [];
  saved.unshift(project);
  await chrome.storage.local.set({ savedProjects: saved });
  return project;
}

async function showSavedList() {
  showPage('page-saved-list');
  const data = await chrome.storage.local.get('savedProjects');
  renderSavedList(data.savedProjects || []);
}

function renderSavedList(projects) {
  const list = document.getElementById('saved-projects-list');
  const empty = document.getElementById('no-saved');
  list.innerHTML = '';
  if (projects.length === 0) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  projects.forEach(project => {
    const card = document.createElement('div');
    card.className = 'saved-project-card';
    card.innerHTML = `
      <div class="saved-project-info">
        <div class="saved-project-title">📁 ${escapeHtml(project.title)}</div>
        <div class="saved-project-meta">${project.sceneCount}টি সিন &bull; ${project.date}</div>
      </div>
      <button class="btn-delete-project" title="Delete">🗑️</button>`;
    card.querySelector('.saved-project-info').addEventListener('click', async () => {
      const d = await chrome.storage.local.get('savedProjects');
      const p = (d.savedProjects || []).find(x => x.id === project.id);
      if (p) { renderProjectDetail(p); showPage('page-saved-detail'); }
    });
    card.querySelector('.btn-delete-project').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`"${project.title}" ডিলিট করবেন?`)) {
        const d = await chrome.storage.local.get('savedProjects');
        const updated = (d.savedProjects || []).filter(p => p.id !== project.id);
        await chrome.storage.local.set({ savedProjects: updated });
        renderSavedList(updated);
      }
    });
    list.appendChild(card);
  });
}

function renderProjectDetail(project) {
  _currentDetailProject = project;
  document.getElementById('detail-title').textContent = project.title;
  document.getElementById('detail-scene-count').textContent = `${project.sceneCount}টি সিন \u2022 ${project.date}`;
  const list = document.getElementById('scene-cards-list');
  list.innerHTML = '';
  project.scenes.forEach((s, i) => {
    const card = document.createElement('div');
    card.className = 'scene-card';
    card.innerHTML = `
      <div class="scene-card-header">
        <span class="scene-card-number">${i + 1}.</span>
        <span class="scene-card-text">${escapeHtml(s.scene)}</span>
        <button class="btn-copy-both" title="Copy All Prompts">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          Both
        </button>
      </div>
      <div class="prompt-panels">
        <div class="prompt-panel image-panel">
          <div class="panel-header">
            <span class="panel-label">Image Prompt</span>
            <button class="btn-copy-panel btn-copy-img">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copy
            </button>
          </div>
          <div class="panel-content">${escapeHtml(s.imagePrompt || '—')}</div>
        </div>
        <div class="prompt-panel video-panel">
          <div class="panel-header">
            <span class="panel-label">Video Prompt</span>
            <button class="btn-copy-panel btn-copy-vid">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copy
            </button>
          </div>
          <div class="panel-content">${escapeHtml(s.videoPrompt || '—')}</div>
        </div>
      </div>`;
    card.querySelector('.btn-copy-both').addEventListener('click', () => copyToClipboard(s.imagePrompt + '\n\n' + s.videoPrompt, card.querySelector('.btn-copy-both')));
    card.querySelector('.btn-copy-img').addEventListener('click', () => copyToClipboard(s.imagePrompt || '', card.querySelector('.btn-copy-img')));
    card.querySelector('.btn-copy-vid').addEventListener('click', () => copyToClipboard(s.videoPrompt || '', card.querySelector('.btn-copy-vid')));
    list.appendChild(card);
  });
}

function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const prev = btn.innerHTML;
    btn.textContent = '✔'; btn.style.color = '#66ff66';
    setTimeout(() => { btn.innerHTML = prev; btn.style.color = ''; }, 1500);
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    const prev = btn.innerHTML; btn.textContent = '✔';
    setTimeout(() => { btn.innerHTML = prev; }, 1500);
  });
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}


// ═══════════════════════════════════════════════════════
//  NEW: Google Flow Automation
// ═══════════════════════════════════════════════════════

let flowPollInterval   = null;
let flowActiveMode     = null;
let flowVidItemCounter = 0;
let flowImgItemCounter = 0;
const flowVidImgData   = {};
let activeVidItemId    = null;
let flowSaveTimer      = null;

// ── Setup listeners ─────────────────────────────────────────────────────────

function setupFlowListeners() {
  // Mode tabs
  document.querySelectorAll('.flow-mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.flow-mode-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.flow-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`flow-content-${tab.dataset.flow}`).classList.add('active');
      debouncedFlowSave();
    });
  });

  // Image source radio
  document.querySelectorAll('input[name="img-src"]').forEach(r => {
    r.addEventListener('change', () => {
      const isProject = r.value === 'project';
      document.getElementById('img-project-row').style.display = isProject ? 'flex' : 'none';
      document.getElementById('img-manual-add').style.display  = isProject ? 'none'  : 'block';
      if (!isProject) {
        document.getElementById('img-prompt-list').innerHTML = '';
        imgAddItem();
      }
      debouncedFlowSave();
    });
  });

  // Video source radio
  document.querySelectorAll('input[name="vid-src"]').forEach(r => {
    r.addEventListener('change', () => {
      const isProject = r.value === 'project';
      document.getElementById('vid-project-row').style.display = isProject ? 'flex' : 'none';
      document.getElementById('vid-manual-add').style.display  = isProject ? 'none'  : 'block';
      if (!isProject) {
        document.getElementById('vid-prompt-list').innerHTML = '';
        vidAddItem(true);
      }
      debouncedFlowSave();
    });
  });

  document.getElementById('img-project-sel').addEventListener('change', (e) => {
    const id = e.target.value;
    if (id) loadImgPromptsFromProject(id);
    else document.getElementById('img-prompt-list').innerHTML = '';
    debouncedFlowSave();
  });

  document.getElementById('vid-project-sel').addEventListener('change', (e) => {
    const id = e.target.value;
    if (id) loadVidPromptsFromProject(id);
    else document.getElementById('vid-prompt-list').innerHTML = '';
    debouncedFlowSave();
  });

  document.querySelectorAll('input[name="vid-type"]').forEach(r => {
    r.addEventListener('change', () => {
      const id = document.getElementById('vid-project-sel').value;
      if (id) loadVidPromptsFromProject(id);
      debouncedFlowSave();
    });
  });

  document.getElementById('btn-vid-filter-apply').addEventListener('click', () => {
    const id = document.getElementById('vid-project-sel').value;
    if (id) loadVidPromptsFromProject(id);
    else alert('আগে একটি Project সিলেক্ট করুন।');
  });

  document.getElementById('img-delay').addEventListener('change', debouncedFlowSave);
  document.getElementById('vid-delay').addEventListener('change', debouncedFlowSave);

  // FIX: arrow functions to avoid passing Event object as 'text' parameter
  document.getElementById('btn-add-img').addEventListener('click', () => { imgAddItem(); debouncedFlowSave(); });
  document.getElementById('btn-add-vid').addEventListener('click', () => { vidAddItem(true); debouncedFlowSave(); });

  // Save Settings buttons
  document.getElementById('btn-flow-save-img').addEventListener('click', () => flowSaveSettings('img'));
  document.getElementById('btn-flow-save-vid').addEventListener('click', () => flowSaveSettings('vid'));

  // Clear All buttons
  document.getElementById('btn-clear-all-img').addEventListener('click', async () => {
    if (confirm('সব image prompts মুছে দেবেন?')) {
      document.getElementById('img-prompt-list').innerHTML = '';
      imgAddItem();
      await flowSaveState();
    }
  });
  document.getElementById('btn-clear-all-vid').addEventListener('click', async () => {
    if (confirm('সব video prompts মুছে দেবেন?')) {
      document.getElementById('vid-prompt-list').innerHTML = '';
      Object.keys(flowVidImgData).forEach(k => delete flowVidImgData[k]);
      vidAddItem(true);
      await flowSaveState();
    }
  });

  // Start/Stop — single button that converts
  document.getElementById('btn-start-flow-img').addEventListener('click', () => {
    const btn = document.getElementById('btn-start-flow-img');
    if (btn.dataset.running === 'true') stopFlowAutomation();
    else startFlowAutomation('image');
  });
  document.getElementById('btn-start-flow-vid').addEventListener('click', () => {
    const btn = document.getElementById('btn-start-flow-vid');
    if (btn.dataset.running === 'true') stopFlowAutomation();
    else startFlowAutomation('video');
  });

  // Global paste: Ctrl+V image into active video prompt
  document.addEventListener('paste', flowHandlePaste);
}

// ── Ctrl+V image paste ───────────────────────────────────────────────────────

function flowHandlePaste(e) {
  if (!document.getElementById('page-flow').classList.contains('active')) return;
  if (!document.getElementById('flow-content-video').classList.contains('active')) return;

  const items = e.clipboardData?.items || [];
  let imgFile = null;
  for (const item of items) {
    if (item.type.startsWith('image/')) { imgFile = item.getAsFile(); break; }
  }
  if (!imgFile) return;

  const targetId = activeVidItemId || getFirstVidItemId();
  if (!targetId) return;

  const domItem = document.querySelector(`.flow-prompt-item[data-item-id="${targetId}"]`);
  if (!domItem) return;
  const attachRow = domItem.querySelector('.img-attach-row');
  if (!attachRow || attachRow.style.display === 'none') return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    flowVidImgData[targetId] = { data: ev.target.result, name: imgFile.name || 'pasted.png' };
    const nameSpan = domItem.querySelector('.img-attach-name');
    const clearBtn = domItem.querySelector('.btn-clear-img');
    if (nameSpan) { nameSpan.textContent = imgFile.name || 'pasted.png'; nameSpan.classList.add('has-img'); }
    if (clearBtn) clearBtn.style.display = 'inline';
    domItem.style.outline = '1px solid #44ddcc';
    setTimeout(() => { domItem.style.outline = ''; }, 700);
    debouncedFlowSave();
  };
  reader.readAsDataURL(imgFile);
  e.preventDefault();
}

function getFirstVidItemId() {
  const first = document.querySelector('#vid-prompt-list .flow-prompt-item');
  return first ? first.dataset.itemId : null;
}

// ── Show / Restore Flow page ─────────────────────────────────────────────────

async function showFlowPage() {
  showPage('page-flow');
  await populateFlowProjectDropdowns();
  await flowRestoreState();
  await checkFlowRunningState();
}

async function populateFlowProjectDropdowns() {
  const data = await chrome.storage.local.get('savedProjects');
  const projects = data.savedProjects || [];
  ['img-project-sel', 'vid-project-sel'].forEach(id => {
    const sel = document.getElementById(id);
    const cur = sel.value;
    sel.innerHTML = '<option value="">-- Project সিলেক্ট করুন --</option>';
    projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.title} (${p.sceneCount} সিন)`;
      sel.appendChild(opt);
    });
    if (cur) sel.value = cur;
  });
}

// ── State persistence ────────────────────────────────────────────────────────

function debouncedFlowSave() {
  clearTimeout(flowSaveTimer);
  flowSaveTimer = setTimeout(flowSaveState, 700);
}

async function flowSaveState() {
  const imgSrc = document.querySelector('input[name="img-src"]:checked')?.value || 'manual';
  const vidSrc = document.querySelector('input[name="vid-src"]:checked')?.value || 'manual';

  const imgPrompts = [];
  document.querySelectorAll('#img-prompt-list .flow-prompt-item').forEach(item => {
    imgPrompts.push(item.querySelector('.prompt-text-inp')?.value || '');
  });

  const vidPrompts = [];
  document.querySelectorAll('#vid-prompt-list .flow-prompt-item').forEach(item => {
    const id = item.dataset.itemId;
    const savedImg = flowVidImgData[id] || null;
    if (item.dataset.isBoth === 'true') {
      const imgText = item.querySelector('.img-text-inp')?.value || '';
      const vidText = item.querySelector('.vid-text-inp')?.value || '';
      vidPrompts.push({ isBoth: true, imgText, vidText, imgData: savedImg });
    } else {
      const label = item.querySelector('.prompt-item-label')?.textContent || '';
      vidPrompts.push({ text: item.querySelector('.prompt-text-inp')?.value || '', label, imgData: savedImg });
    }
  });

  await chrome.storage.local.set({
    flowImgState: {
      source: imgSrc,
      projectId: document.getElementById('img-project-sel').value,
      delay: parseInt(document.getElementById('img-delay').value) || 45,
      prompts: imgPrompts,
    },
    flowVidState: {
      source: vidSrc,
      projectId: document.getElementById('vid-project-sel').value,
      promptType: document.querySelector('input[name="vid-type"]:checked')?.value || 'video',
      delay: parseInt(document.getElementById('vid-delay').value) || 60,
      prompts: vidPrompts,
    },
    flowActiveTab: document.querySelector('.flow-mode-tab.active')?.dataset?.flow || 'image',
  });
}

async function flowRestoreState() {
  const data = await chrome.storage.local.get(['flowImgState', 'flowVidState', 'flowActiveTab']);
  const imgState = data.flowImgState;
  const vidState = data.flowVidState;
  const activeTab = data.flowActiveTab || 'image';

  document.querySelectorAll('.flow-mode-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.flow === activeTab));
  document.querySelectorAll('.flow-content').forEach(c =>
    c.classList.toggle('active', c.id === `flow-content-${activeTab}`));

  // ── Image ──
  if (imgState) {
    const r = document.querySelector(`input[name="img-src"][value="${imgState.source}"]`);
    if (r) r.checked = true;
    const isPrj = imgState.source === 'project';
    document.getElementById('img-project-row').style.display = isPrj ? 'flex' : 'none';
    document.getElementById('img-manual-add').style.display  = isPrj ? 'none'  : 'block';
    document.getElementById('img-delay').value = imgState.delay || 45;
    document.getElementById('img-prompt-list').innerHTML = '';
    if (isPrj && imgState.projectId) {
      document.getElementById('img-project-sel').value = imgState.projectId;
      await loadImgPromptsFromProject(imgState.projectId);
    } else if (imgState.prompts?.length > 0) {
      imgState.prompts.forEach(t => imgAddItem(t));
    } else { imgAddItem(); }
  } else { imgAddItem(); }

  // ── Video ──
  if (vidState) {
    const r = document.querySelector(`input[name="vid-src"][value="${vidState.source}"]`);
    if (r) r.checked = true;
    const isPrj = vidState.source === 'project';
    document.getElementById('vid-project-row').style.display = isPrj ? 'flex' : 'none';
    document.getElementById('vid-manual-add').style.display  = isPrj ? 'none'  : 'block';
    const tr = document.querySelector(`input[name="vid-type"][value="${vidState.promptType}"]`);
    if (tr) tr.checked = true;
    document.getElementById('vid-delay').value = vidState.delay || 60;
    document.getElementById('vid-prompt-list').innerHTML = '';
    if (isPrj && vidState.projectId) {
      document.getElementById('vid-project-sel').value = vidState.projectId;
      await loadVidPromptsFromProject(vidState.projectId);
    } else if (vidState.prompts?.length > 0) {
      vidState.prompts.forEach(p => {
        if (p.isBoth) {
          const newId = vidAddBothItem(p.imgText || '', p.vidText || '');
          if (p.imgData && newId) {
            flowVidImgData[newId] = p.imgData;
            _restoreImgUI(newId, p.imgData.name || 'image');
          }
        } else {
          const txt = typeof p === 'string' ? p : (p.text || '');
          const lbl = typeof p === 'object' ? (p.label || '') : '';
          const newId = vidAddItem(!lbl || lbl === 'VID', txt, lbl);
          if (p.imgData && newId) {
            flowVidImgData[newId] = p.imgData;
            _restoreImgUI(newId, p.imgData.name || 'image');
          }
        }
      });
    } else { vidAddItem(true); }
  } else { vidAddItem(true); }
}

// ── Image prompt items ──────────────────────────────────────────────────────

function imgAddItem(text = '') {
  const list = document.getElementById('img-prompt-list');
  const id   = `img-${++flowImgItemCounter}`;
  const item = document.createElement('div');
  item.className = 'flow-prompt-item';
  item.dataset.itemId = id;
  item.innerHTML = `
    <div class="prompt-item-top">
      <span class="prompt-idx"></span>
      <input type="text" class="prompt-text-inp" placeholder="Image prompt এখানে লিখুন...">
      <button class="btn-remove-item" title="Remove">✕</button>
    </div>`;
  const inp = item.querySelector('input.prompt-text-inp');
  inp.value = text;
  inp.addEventListener('input', debouncedFlowSave);
  item.querySelector('.btn-remove-item').addEventListener('click', () => {
    item.remove(); renumberList('img-prompt-list'); debouncedFlowSave();
  });
  list.appendChild(item);
  renumberList('img-prompt-list');
  if (!text) inp.focus();
}

// ── Video prompt items ──────────────────────────────────────────────────────

function vidAddItem(showImgAttach, text = '', label = '') {
  const list = document.getElementById('vid-prompt-list');
  const id   = `vid-${++flowVidItemCounter}`;
  const item = document.createElement('div');
  item.className = 'flow-prompt-item';
  item.dataset.itemId = id;

  const labelHtml = label
    ? `<span class="prompt-item-label ${label === 'IMG' ? 'label-img' : 'label-vid'}">${label}</span>`
    : '';
  const placeholder = label === 'IMG' ? 'Image prompt...' : 'Video prompt...';
  const attachStyle = (showImgAttach && label !== 'IMG') ? '' : 'display:none';

  item.innerHTML = `
    <div class="prompt-item-top">
      <span class="prompt-idx"></span>
      ${labelHtml}
      <input type="text" class="prompt-text-inp" placeholder="${placeholder}">
      <button class="btn-remove-item" title="Remove">✕</button>
    </div>
    <div class="img-attach-row" style="${attachStyle}">
      <input type="file" accept="image/*" class="img-file-hidden" style="display:none">
      <button class="btn-attach-img" title="ছবি সিলেক্ট করুন">📎 ছবি</button>
      <span class="img-attach-name">optional · Ctrl+V বা Right-click paste</span>
      <button class="btn-clear-img" style="display:none">✕</button>
    </div>`;

  const inp      = item.querySelector('input.prompt-text-inp');
  const fileInp  = item.querySelector('.img-file-hidden');
  const attachBtn = item.querySelector('.btn-attach-img');
  const nameSpan = item.querySelector('.img-attach-name');
  const clearBtn = item.querySelector('.btn-clear-img');

  inp.value = text;
  inp.addEventListener('input', debouncedFlowSave);
  inp.addEventListener('focus', () => { activeVidItemId = id; });
  item.addEventListener('mouseenter', () => { activeVidItemId = id; });

  item.querySelector('.btn-remove-item').addEventListener('click', () => {
    delete flowVidImgData[id];
    if (activeVidItemId === id) activeVidItemId = null;
    item.remove(); renumberList('vid-prompt-list'); debouncedFlowSave();
  });

  attachBtn.addEventListener('click', () => { activeVidItemId = id; fileInp.click(); });

  fileInp.addEventListener('change', () => {
    const file = fileInp.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      flowVidImgData[id] = { data: e.target.result, name: file.name };
      nameSpan.textContent = file.name;
      nameSpan.classList.add('has-img');
      clearBtn.style.display = 'inline';
      debouncedFlowSave();
    };
    reader.readAsDataURL(file);
  });

  clearBtn.addEventListener('click', () => {
    delete flowVidImgData[id];
    fileInp.value = '';
    nameSpan.textContent = 'optional · Ctrl+V বা Right-click paste';
    nameSpan.classList.remove('has-img');
    clearBtn.style.display = 'none';
    debouncedFlowSave();
  });

  item.querySelector('.img-attach-row').addEventListener('contextmenu', async (e) => {
    e.preventDefault(); e.stopPropagation();
    activeVidItemId = id;
    try {
      const clipItems = await navigator.clipboard.read();
      for (const clipItem of clipItems) {
        for (const type of clipItem.types) {
          if (type.startsWith('image/')) {
            const blob = await clipItem.getType(type);
            const reader = new FileReader();
            reader.onload = (ev) => {
              flowVidImgData[id] = { data: ev.target.result, name: 'pasted.png' };
              nameSpan.textContent = 'pasted.png'; nameSpan.classList.add('has-img');
              clearBtn.style.display = 'inline';
              item.style.outline = '1px solid #44ddcc';
              setTimeout(() => { item.style.outline = ''; }, 700);
              debouncedFlowSave();
            };
            reader.readAsDataURL(blob); return;
          }
        }
      }
    } catch (_) {}
  });

  list.appendChild(item);
  renumberList('vid-prompt-list');
  if (!text) inp.focus();
  return id;
}

function renumberList(listId) {
  document.querySelectorAll(`#${listId} .flow-prompt-item`).forEach((item, i) => {
    const idx = item.querySelector('.prompt-idx');
    if (idx) idx.textContent = `${i + 1}.`;
  });
}

// ── BOTH mode combined item ─────────────────────────────────────────────────

function vidAddBothItem(imgText = '', vidText = '') {
  const list = document.getElementById('vid-prompt-list');
  const id   = `vid-${++flowVidItemCounter}`;
  const item = document.createElement('div');
  item.className = 'flow-prompt-item flow-both-item';
  item.dataset.itemId = id;
  item.dataset.isBoth = 'true';

  item.innerHTML = `
    <div class="prompt-item-top">
      <span class="prompt-idx"></span>
      <span class="both-scene-label">📸+🎬 Scene</span>
      <button class="btn-remove-item" title="Remove">✕</button>
    </div>
    <div class="both-sub-row">
      <span class="prompt-item-label label-img">IMG</span>
      <input type="text" class="prompt-text-inp img-text-inp" placeholder="Image prompt...">
    </div>
    <div class="both-sub-row">
      <span class="prompt-item-label label-vid">VID</span>
      <input type="text" class="prompt-text-inp vid-text-inp" placeholder="Video prompt...">
    </div>
    <div class="img-attach-row">
      <input type="file" accept="image/*" class="img-file-hidden" style="display:none">
      <button class="btn-attach-img" title="ছবি সিলেক্ট করুন">📎 ছবি</button>
      <span class="img-attach-name">optional · Ctrl+V বা Right-click paste</span>
      <button class="btn-clear-img" style="display:none">✕</button>
    </div>`;

  const imgInp  = item.querySelector('.img-text-inp');
  const vidInp  = item.querySelector('.vid-text-inp');
  const fileInp = item.querySelector('.img-file-hidden');
  const attachBtn = item.querySelector('.btn-attach-img');
  const nameSpan  = item.querySelector('.img-attach-name');
  const clearImgBtn = item.querySelector('.btn-clear-img');

  imgInp.value = imgText;
  vidInp.value = vidText;
  imgInp.addEventListener('input', debouncedFlowSave);
  vidInp.addEventListener('input', debouncedFlowSave);
  imgInp.addEventListener('focus', () => { activeVidItemId = id; });
  vidInp.addEventListener('focus', () => { activeVidItemId = id; });
  item.addEventListener('mouseenter', () => { activeVidItemId = id; });

  item.querySelector('.btn-remove-item').addEventListener('click', () => {
    delete flowVidImgData[id];
    if (activeVidItemId === id) activeVidItemId = null;
    item.remove(); renumberList('vid-prompt-list'); debouncedFlowSave();
  });

  attachBtn.addEventListener('click', () => { activeVidItemId = id; fileInp.click(); });

  fileInp.addEventListener('change', () => {
    const file = fileInp.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      flowVidImgData[id] = { data: e.target.result, name: file.name };
      nameSpan.textContent = file.name; nameSpan.classList.add('has-img');
      clearImgBtn.style.display = 'inline'; debouncedFlowSave();
    };
    reader.readAsDataURL(file);
  });

  clearImgBtn.addEventListener('click', () => {
    delete flowVidImgData[id]; fileInp.value = '';
    nameSpan.textContent = 'optional · Ctrl+V বা Right-click paste';
    nameSpan.classList.remove('has-img'); clearImgBtn.style.display = 'none';
    debouncedFlowSave();
  });

  item.querySelector('.img-attach-row').addEventListener('contextmenu', async (e) => {
    e.preventDefault(); e.stopPropagation();
    activeVidItemId = id;
    try {
      const clipItems = await navigator.clipboard.read();
      for (const clipItem of clipItems) {
        for (const type of clipItem.types) {
          if (type.startsWith('image/')) {
            const blob = await clipItem.getType(type);
            const reader = new FileReader();
            reader.onload = (ev) => {
              flowVidImgData[id] = { data: ev.target.result, name: 'pasted.png' };
              nameSpan.textContent = 'pasted.png'; nameSpan.classList.add('has-img');
              clearImgBtn.style.display = 'inline';
              item.style.outline = '1px solid #44ddcc';
              setTimeout(() => { item.style.outline = ''; }, 700);
              debouncedFlowSave();
            };
            reader.readAsDataURL(blob); return;
          }
        }
      }
    } catch (_) {}
  });

  list.appendChild(item);
  renumberList('vid-prompt-list');
  return id;
}

function _restoreImgUI(itemId, fileName) {
  const domItem = document.querySelector(`.flow-prompt-item[data-item-id="${itemId}"]`);
  if (!domItem) return;
  const nameSpan = domItem.querySelector('.img-attach-name');
  const clearBtn = domItem.querySelector('.btn-clear-img');
  if (nameSpan) { nameSpan.textContent = fileName || 'image'; nameSpan.classList.add('has-img'); }
  if (clearBtn) clearBtn.style.display = 'inline';
}

// ── Flow Save Settings ───────────────────────────────────────────────────────

async function flowSaveSettings(p) {
  await flowSaveState();
  const el = document.getElementById(`flow-${p}-save-status`);
  if (el) {
    el.textContent = '✔ সেভ হয়েছে!';
    setTimeout(() => { el.textContent = ''; }, 2000);
  }
}

// ── Load from saved project ─────────────────────────────────────────────────

async function loadImgPromptsFromProject(projectId) {
  const data = await chrome.storage.local.get('savedProjects');
  const project = (data.savedProjects || []).find(p => p.id === projectId);
  if (!project) return;
  document.getElementById('img-prompt-list').innerHTML = '';
  project.scenes.forEach(s => imgAddItem(s.imagePrompt || ''));
  debouncedFlowSave();
}

function parseSceneFilter(filterStr, totalScenes) {
  const s = (filterStr || '').trim().toLowerCase();
  if (!s || s === 'all' || s === 'সব' || s === 'সব') return null;
  const indices = new Set();
  const parts = s.split(',');
  for (const part of parts) {
    const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = parseInt(range[1]), to = parseInt(range[2]);
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
        if (i >= 1 && i <= totalScenes) indices.add(i - 1);
      }
    } else {
      const n = parseInt(part.trim());
      if (!isNaN(n) && n >= 1 && n <= totalScenes) indices.add(n - 1);
    }
  }
  return indices.size > 0 ? [...indices].sort((a, b) => a - b) : null;
}

async function loadVidPromptsFromProject(projectId) {
  const data = await chrome.storage.local.get('savedProjects');
  const project = (data.savedProjects || []).find(p => p.id === projectId);
  if (!project) return;
  Object.keys(flowVidImgData).forEach(k => delete flowVidImgData[k]);
  document.getElementById('vid-prompt-list').innerHTML = '';
  const type = document.querySelector('input[name="vid-type"]:checked')?.value || 'video';
  const filterStr = document.getElementById('vid-scene-filter')?.value || '';
  const indices = parseSceneFilter(filterStr, project.scenes.length);
  const scenes = indices ? indices.map(i => project.scenes[i]) : project.scenes;
  if (type === 'both') {
    scenes.forEach(s => {
      const combined = [s.imagePrompt || '', s.videoPrompt || ''].filter(Boolean).join('\n\n');
      vidAddItem(true, combined);
    });
  } else {
    scenes.forEach(s => vidAddItem(true, s.videoPrompt || ''));
  }
  debouncedFlowSave();
}

// ── Build prompts ───────────────────────────────────────────────────────────

function buildFlowPrompts(mode) {
  const listId = mode === 'image' ? 'img-prompt-list' : 'vid-prompt-list';
  const prompts = [];
  document.querySelectorAll(`#${listId} .flow-prompt-item`).forEach(item => {
    if (item.dataset.isBoth === 'true') {
      // Combined BOTH item: merge IMG + VID into ONE prompt for ONE video per scene
      const imgText = item.querySelector('.img-text-inp')?.value?.trim() || '';
      const vidText = item.querySelector('.vid-text-inp')?.value?.trim() || '';
      if (!imgText && !vidText) return;
      const parts = [];
      if (imgText) parts.push(imgText);
      if (vidText) parts.push(vidText);
      const combinedText = parts.join('\n\n');
      const imgData = flowVidImgData[item.dataset.itemId];
      prompts.push({ text: combinedText, imageData: imgData?.data || null, label: 'BOTH' });
    } else {
      const text = item.querySelector('.prompt-text-inp')?.value?.trim() || '';
      if (!text) return;
      const imgData = flowVidImgData[item.dataset.itemId];
      const label   = item.querySelector('.prompt-item-label')?.textContent || '';
      prompts.push({ text, imageData: imgData?.data || null, label });
    }
  });
  return prompts;
}

// ── Start / Stop Flow Automation ────────────────────────────────────────────

async function startFlowAutomation(mode) {
  const prompts = buildFlowPrompts(mode);
  if (prompts.length === 0) return alert('কোনো prompt নেই! অন্তত একটি prompt যোগ করুন।');

  const delay = parseInt(
    document.getElementById(mode === 'image' ? 'img-delay' : 'vid-delay').value
  ) || 45;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes('labs.google')) {
    alert('⚠️ Google Flow tab খুলুন (labs.google) এবং সেই tab-এ সক্রিয় থাকুন!');
    return;
  }

  flowActiveMode = mode;
  await chrome.storage.local.set({
    flowRunning: true, flowMode: mode,
    flowStatus: { status: 'starting' }, flowTabId: tab.id,
  });

  setFlowRunningUI(mode, true, null);
  updateFlowStatusUI(mode, { status: 'starting' }, prompts.length);
  startFlowPolling(mode, prompts.length);
  playStartSound();

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'START_FLOW', prompts, delaySeconds: delay });
  } catch (e) {
    await chrome.storage.local.set({
      flowRunning: false,
      flowStatus: { status: 'error', message: '⚠️ Google Flow page refresh করুন তারপর Start করুন।' },
    });
    stopFlowPolling();
    setFlowRunningUI(mode, false, null);
    alert('⚠️ Google Flow page refresh করুন, তারপর Start করুন।');
  }
}

async function stopFlowAutomation() {
  const data = await chrome.storage.local.get('flowTabId');
  await chrome.storage.local.set({ flowRunning: false, flowStatus: { status: 'stopped' } });
  stopFlowPolling();
  if (data.flowTabId) chrome.tabs.sendMessage(data.flowTabId, { type: 'STOP_FLOW' }).catch(() => {});
  const mode = flowActiveMode || 'image';
  setFlowRunningUI(mode, false, null);
  updateFlowStatusUI(mode, { status: 'stopped' }, 0);
  flowActiveMode = null;
}

// ── Flow Polling ─────────────────────────────────────────────────────────────

function startFlowPolling(mode, total) {
  stopFlowPolling();
  flowPollInterval = setInterval(async () => {
    const data = await chrome.storage.local.get(['flowRunning', 'flowStatus']);
    const s = data.flowStatus || {};
    updateFlowStatusUI(mode, s, total);
    if (!data.flowRunning) {
      stopFlowPolling();
      if (s.status === 'all_done') playDoneSound();
      const msg = s.status === 'all_done'
        ? `✅ সব সম্পন্ন! ${s.total || total}টি prompt পাঠানো হয়েছে।`
        : s.status === 'stopped' ? '⏹ Automation বন্ধ করা হয়েছে।' : null;
      setFlowRunningUI(mode, false, msg);
      flowActiveMode = null;
    }
  }, 600);
}

function stopFlowPolling() {
  if (flowPollInterval) { clearInterval(flowPollInterval); flowPollInterval = null; }
}

// ── Restore running state when popup reopens ─────────────────────────────────

async function checkFlowRunningState() {
  const data = await chrome.storage.local.get(['flowRunning', 'flowStatus', 'flowMode']);
  if (!data.flowRunning) return;

  const mode = data.flowMode || 'image';
  flowActiveMode = mode;

  // Navigate to flow page and correct tab
  showPage('page-flow');
  document.querySelectorAll('.flow-mode-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.flow === mode));
  document.querySelectorAll('.flow-content').forEach(c =>
    c.classList.toggle('active', c.id === `flow-content-${mode}`));

  setFlowRunningUI(mode, true, null);
  updateFlowStatusUI(mode, data.flowStatus || {}, 0);
  startFlowPolling(mode, 0);
}

// ── Flow UI helpers ───────────────────────────────────────────────────────────

function setFlowRunningUI(mode, running, completionMsg) {
  const p       = mode === 'image' ? 'img' : 'vid';
  const mainBtn = document.getElementById(`btn-start-flow-${p}`);
  const statusBox = document.getElementById(`flow-${p}-status-box`);
  const msgEl     = document.getElementById(`flow-${p}-complete-msg`);

  if (mainBtn) {
    if (running) {
      mainBtn.textContent = '⏹ Stop Automation';
      mainBtn.classList.remove('btn-flow-start');
      mainBtn.classList.add('btn-danger');
      mainBtn.dataset.running = 'true';
    } else {
      mainBtn.textContent = '▶ Start Automation';
      mainBtn.classList.remove('btn-danger');
      mainBtn.classList.add('btn-flow-start');
      mainBtn.dataset.running = 'false';
    }
  }

  if (statusBox) statusBox.style.display = running ? 'block' : (completionMsg ? 'block' : 'none');

  if (msgEl) {
    if (completionMsg && !running) {
      msgEl.textContent = completionMsg;
      msgEl.style.display = 'block';
    } else {
      msgEl.style.display = 'none';
    }
  }
}

function updateFlowStatusUI(mode, s, total) {
  const p       = mode === 'image' ? 'img' : 'vid';
  const textEl  = document.getElementById(`flow-${p}-status-text`);
  const barEl   = document.getElementById(`flow-${p}-prog-bar`);
  const labelEl = document.getElementById(`flow-${p}-prog-label`);
  if (!textEl) return;

  const idx = (s.index !== undefined) ? s.index + 1 : 0;
  const ttl = s.total || total || 0;
  const pct = ttl > 0 ? Math.round((idx / ttl) * 100) : 0;
  const rem = s.remaining || 0;

  switch (s.status) {
    case 'starting':      textEl.textContent = '⏳ শুরু হচ্ছে...'; break;
    case 'pasting_image':  textEl.textContent = `🖼️ Prompt ${idx}/${ttl} — ছবি paste হচ্ছে...`; break;
    case 'waiting_image': textEl.textContent = `⏳ Prompt ${idx}/${ttl} — ছবি load-এর অপেক্ষায়...`; break;
    case 'sending':       textEl.textContent = `📤 Prompt ${idx}/${ttl} পাঠানো হচ্ছে...`; break;
    case 'prompt_sent':   textEl.textContent = `✅ Prompt ${idx}/${ttl} পাঠানো হয়েছে!`; break;
    case 'waiting':       textEl.textContent = `⏱️ ${rem}s পরে Prompt ${idx + 1}/${ttl}...`; break;
    case 'image_warn':    textEl.textContent = `⚠️ ছবি paste হয়নি, text prompt চলছে...`; break;
    case 'all_done':      textEl.textContent = `🎉 সব সম্পন্ন! ${ttl}টি prompt পাঠানো হয়েছে।`; break;
    case 'stopped':       textEl.textContent = `⏹ বন্ধ করা হয়েছে`; break;
    case 'error':         textEl.textContent = `❌ ${s.message || 'আবার চেষ্টা করুন'}`; break;
    default:              textEl.textContent = s.status || ''; break;
  }

  if (barEl)   barEl.style.width = pct + '%';
  if (labelEl) labelEl.textContent = ttl > 0 ? `${idx} / ${ttl} prompt সম্পন্ন` : '';
}
