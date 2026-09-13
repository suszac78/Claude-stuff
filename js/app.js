import { EditorState } from './state.js';
import { Preview } from './preview.js';
import { Timeline } from './timeline.js';
import { TextOverlayPanel } from './textOverlay.js';
import { ZoomEffectPanel } from './zoomEffect.js';
import { importVideoFile, SUPPORTED_EXTENSIONS } from './media.js';
import { detectSilence, detectSceneChanges } from './autoCut.js';
import { parseCommandOffline, parseCommandWithClaude, summarizeProject, executeActions } from './aiCommands.js';
import { analyzeClipContent } from './visionAnalysis.js';
import { analyzeClipContentLocal } from './localVision.js';
import { parseCommandWithLocalLLM } from './localLLM.js';
import { exportProject, downloadBlob } from './exportPipeline.js';
import { formatTime } from './utils.js';

const state = new EditorState();
const canvas = document.getElementById('previewCanvas');
const preview = new Preview(state, canvas);
preview.start();

const timelineContainer = document.getElementById('timelineContainer');
const timeline = new Timeline(state, timelineContainer, {
  onSeek: (t) => preview.seek(t),
  onSelect: (type, id) => {
    state.selection = { type, id };
    refreshSidePanel();
    timeline.render();
  },
});

const textPanel = new TextOverlayPanel(state, document.getElementById('textPanel'), { onChange: rerenderAll });
const zoomPanel = new ZoomEffectPanel(state, document.getElementById('zoomPanel'), { onChange: rerenderAll });

const statusLog = document.getElementById('statusLog');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');

function setStatus(msg) {
  statusLog.textContent = msg;
}

function setProgress(p, label) {
  if (p == null) {
    progressBar.hidden = true;
    return;
  }
  progressBar.hidden = false;
  progressFill.style.width = `${Math.round(p * 100)}%`;
  if (label) setStatus(label);
}

function rerenderAll() {
  timeline.render();
  refreshSidePanel();
  document.getElementById('dropHint').classList.toggle('hidden', state.clips.length > 0);
}

function refreshSidePanel() {
  if (state.selection.type === 'text') textPanel.renderFor(state.selection.id);
  else textPanel.renderEmpty();
  if (state.selection.type === 'zoom') zoomPanel.renderFor(state.selection.id);
  else zoomPanel.renderEmpty();
  renderContentAnalysisPanel();
}

state.on(() => rerenderAll());
rerenderAll();

// --- Playback controls -----------------------------------------------------
const playBtn = document.getElementById('playBtn');
playBtn.addEventListener('click', () => {
  if (state.playing) {
    preview.pause();
    playBtn.textContent = '▶';
  } else {
    preview.play();
    playBtn.textContent = '⏸';
  }
});

document.getElementById('splitBtn').addEventListener('click', () => {
  state.splitClipAt(state.playhead);
});

preview.onTimeUpdate = () => {
  document.getElementById('timeLabel').textContent =
    `${formatTime(state.playhead)} / ${formatTime(state.totalDuration())}`;
  timeline.render();
};
setInterval(() => {
  if (!state.playing) {
    document.getElementById('timeLabel').textContent =
      `${formatTime(state.playhead)} / ${formatTime(state.totalDuration())}`;
  }
}, 200);

// --- Import ------------------------------------------------------------
const fileInput = document.getElementById('fileInput');
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

const previewPane = document.querySelector('.preview-pane');
previewPane.addEventListener('dragover', (e) => e.preventDefault());
previewPane.addEventListener('drop', (e) => {
  e.preventDefault();
  handleFiles(e.dataTransfer.files);
});

async function handleFiles(fileList) {
  for (const file of Array.from(fileList)) {
    try {
      setProgress(0.02, `Importing ${file.name}...`);
      const { url, duration } = await importVideoFile(file, {
        onStatus: (msg) => setProgress(0.5, msg),
      });
      state.addClip({ name: file.name, url, sourceDuration: duration });
      setProgress(null);
      setStatus(`Imported ${file.name} (${formatTime(duration, false)})`);
    } catch (err) {
      setProgress(null);
      setStatus(`Failed to import ${file.name}: ${err.message}`);
      console.error(err);
    }
  }
  fileInput.value = '';
}

// --- Side tabs ---------------------------------------------------------
document.querySelectorAll('.side-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.side-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tab;
    document.querySelectorAll('.side-tab-content').forEach((c) => {
      c.hidden = c.dataset.tabContent !== target;
    });
  });
});

// --- Add text / zoom -----------------------------------------------------
document.getElementById('addTextBtn').addEventListener('click', () => {
  const overlay = state.addTextOverlay({ start: state.playhead, end: state.playhead + 3 });
  state.selection = { type: 'text', id: overlay.id };
  document.querySelector('.side-tab[data-tab="text"]').click();
  rerenderAll();
});

document.getElementById('addZoomBtn').addEventListener('click', () => {
  if (state.selection.type !== 'clip') {
    setStatus('Select a clip on the timeline first, then click "+ Add Zoom".');
    return;
  }
  const clip = state.clips.find((c) => c.id === state.selection.id);
  const zoom = state.addZoomKeyframe({ clipId: clip.id, start: 0, end: Math.min(2, state.clipDuration(clip)) });
  state.selection = { type: 'zoom', id: zoom.id };
  rerenderAll();
});

// --- Auto-cut ------------------------------------------------------------
function selectedClip() {
  if (state.selection.type !== 'clip') return null;
  return state.clips.find((c) => c.id === state.selection.id) || null;
}

document.getElementById('detectSilenceBtn').addEventListener('click', async () => {
  const clip = selectedClip();
  if (!clip) return setStatus('Select a clip first.');
  const idx = state.clips.indexOf(clip);
  setStatus('Analyzing audio for silence...');
  await executeActions(state, [{ type: 'removeSilence', clipIndex: idx }], { onLog: setStatus });
});

document.getElementById('detectScenesBtn').addEventListener('click', async () => {
  const clip = selectedClip();
  if (!clip) return setStatus('Select a clip first.');
  const idx = state.clips.indexOf(clip);
  setStatus('Scanning for scene changes...');
  await executeActions(state, [{ type: 'detectScenes', clipIndex: idx }], { onLog: setStatus });
});

function renderContentAnalysisPanel() {
  const container = document.getElementById('contentAnalysisResult');
  const clip = selectedClip();
  container.innerHTML = '';
  if (!clip) return;
  const segments = state.getContentAnalysis(clip.id);
  if (!segments) return;
  for (const seg of segments) {
    const item = document.createElement('div');
    item.className = 'content-analysis-item';
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = `${formatTime(seg.start, false)}–${formatTime(seg.end, false)}`;
    item.appendChild(ts);
    item.appendChild(document.createTextNode(seg.description));
    container.appendChild(item);
  }
}

document.getElementById('recognizeContentBtn').addEventListener('click', async () => {
  const clip = selectedClip();
  if (!clip) return setStatus('Select a clip first.');

  const useClaude = getAiMode() === 'claude' && !!claudeApiKey.value;
  try {
    setProgress(0.05, useClaude ? 'Recognizing video content with Claude Vision...' : 'Recognizing video content (free, local, no API key)...');
    const segments = useClaude
      ? await analyzeClipContent(clip, claudeApiKey.value, { onProgress: (msg) => setProgress(0.4, msg) })
      : await analyzeClipContentLocal(clip, { onProgress: (msg) => setProgress(0.4, msg) });
    state.setContentAnalysis(clip.id, segments);
    renderContentAnalysisPanel();
    setProgress(null);
    setStatus(
      useClaude
        ? `Recognized ${segments.length} segment(s) with Claude Vision.`
        : `Recognized ${segments.length} segment(s) locally (free) — for richer descriptions, switch AI mode to Claude API.`
    );
  } catch (err) {
    setProgress(null);
    setStatus(`Content recognition failed: ${err.message}`);
    console.error(err);
  }
});

// --- AI command bar --------------------------------------------------------
const aiInput = document.getElementById('aiInput');
const claudeApiKey = document.getElementById('claudeApiKey');
const aiModeRadios = Array.from(document.querySelectorAll('input[name="aiMode"]'));

function getAiMode() {
  return (aiModeRadios.find((r) => r.checked) || {}).value || 'pattern';
}

const savedMode = localStorage.getItem('novacut_ai_mode');
if (savedMode) {
  const radio = aiModeRadios.find((r) => r.value === savedMode);
  if (radio) radio.checked = true;
}
claudeApiKey.value = localStorage.getItem('novacut_claude_key') || '';

function updateAiModeUI() {
  const mode = getAiMode();
  claudeApiKey.hidden = mode !== 'claude';
  const btn = document.getElementById('recognizeContentBtn');
  btn.textContent = mode === 'claude' && claudeApiKey.value
    ? '🔍 Recognize Video Content (Claude Vision)'
    : '🔍 Recognize Video Content (Free)';
}
updateAiModeUI();

for (const radio of aiModeRadios) {
  radio.addEventListener('change', () => {
    localStorage.setItem('novacut_ai_mode', getAiMode());
    updateAiModeUI();
  });
}
claudeApiKey.addEventListener('change', () => {
  localStorage.setItem('novacut_claude_key', claudeApiKey.value);
  updateAiModeUI();
});
claudeApiKey.addEventListener('input', updateAiModeUI);

document.getElementById('aiSettingsToggle').addEventListener('click', () => {
  const panel = document.getElementById('aiSettings');
  panel.hidden = !panel.hidden;
});

async function runAiCommand() {
  const text = aiInput.value.trim();
  if (!text) return;
  aiInput.value = '';
  const mode = getAiMode();

  async function reportAndExecute(actions, sourceLabel) {
    console.log(`${sourceLabel} returned actions for "${text}":`, actions);
    if (!actions || actions.length === 0) {
      setStatus(`${sourceLabel} understood the request but produced no edits — it likely couldn't work out concrete timestamps from "${text}". Try being more specific (exact seconds), or splitting it into separate, simpler commands.`);
      return;
    }
    const results = await executeActions(state, actions, { onLog: setStatus });
    console.log(`${sourceLabel} execution results:`, results);
    const applied = results.filter((r) => r.applied);
    const skipped = results.filter((r) => !r.applied);
    if (applied.length === 0) {
      setStatus(`${sourceLabel} tried ${results.length} action(s) but none had any effect: ${skipped.map((r) => r.note || r.type).join('; ')}. Try being more specific, or use exact seconds.`);
    } else if (skipped.length > 0) {
      setStatus(`Applied ${applied.length}/${results.length} action(s) from ${sourceLabel} (${applied.map((r) => r.type).join(', ')}); skipped: ${skipped.map((r) => r.note || r.type).join('; ')}`);
    } else {
      setStatus(`Applied ${applied.length} action(s) from ${sourceLabel}: ${applied.map((r) => r.type).join(', ')}`);
    }
  }

  if (mode === 'claude' && claudeApiKey.value) {
    setStatus(`Asking Claude: "${text}"`);
    try {
      const actions = await parseCommandWithClaude(text, claudeApiKey.value, summarizeProject(state));
      await reportAndExecute(actions, 'Claude');
    } catch (err) {
      setStatus(`Claude request failed: ${err.message}`);
    }
    return;
  }

  if (mode === 'local-llm') {
    try {
      const actions = await parseCommandWithLocalLLM(text, summarizeProject(state), {
        onProgress: (msg, progress) => setProgress(Math.min(0.95, progress || 0.1), msg),
      });
      setProgress(null);
      await reportAndExecute(actions, 'the free local AI');
    } catch (err) {
      setProgress(null);
      setStatus(`Free local AI failed: ${err.message}`);
      console.error(err);
    }
    return;
  }

  setStatus(`Running: "${text}"`);
  const { actions, unrecognized } = parseCommandOffline(text);
  const results = actions.length ? await executeActions(state, actions, { onLog: setStatus }) : [];
  const applied = results.filter((r) => r.applied);
  const skipped = results.filter((r) => !r.applied);
  if (unrecognized.length) {
    setStatus(`Applied ${applied.length} action(s). Didn't understand: "${unrecognized.join('; ')}" — try "Free Local AI" mode (⚙) for free-form phrasing.`);
  } else if (skipped.length > 0 && applied.length === 0) {
    setStatus(`No effect: ${skipped.map((r) => r.note || r.type).join('; ')}`);
  } else if (actions.length) {
    setStatus(`Applied: ${text}`);
  } else {
    setStatus(`Didn't recognize that command. Try "split at 0:10", or switch to "Free Local AI" mode (⚙) for free-form phrasing.`);
  }
}

document.getElementById('aiRunBtn').addEventListener('click', runAiCommand);
aiInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runAiCommand();
});

// --- Export ------------------------------------------------------------
document.getElementById('exportBtn').addEventListener('click', async () => {
  if (state.clips.length === 0) return setStatus('Import a clip first.');
  try {
    preview.pause();
    playBtn.textContent = '▶';
    setProgress(0.01, 'Starting export...');
    const blob = await exportProject(state, {
      onProgress: (p, label) => setProgress(p, label),
      onLog: setStatus,
    });
    downloadBlob(blob, 'novacut-export.mp4');
    setProgress(null);
    setStatus('Export complete — download started.');
  } catch (err) {
    console.error(err);
    setProgress(null);
    setStatus(`Export failed: ${err.message}`);
  }
});

console.log('Nova Cut ready. Supported upload extensions:', SUPPORTED_EXTENSIONS.join(', '));
