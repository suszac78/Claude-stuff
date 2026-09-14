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
import { parseCommandWithLocalLLM, MODEL_TIERS } from './localLLM.js';
import { parseCommandWithGemini, analyzeClipContentWithGemini } from './geminiClient.js';
import { lookupCardPriceAtTime } from './cardPricing.js';
import { BUILTIN_EFFECTS, SoundEffectPlayer } from './soundEffects.js';
import { searchFreesound, isCC0 } from './freesound.js';
import { exportProject, downloadBlob } from './exportPipeline.js';
import { formatTime } from './utils.js';

const state = new EditorState();
const canvas = document.getElementById('previewCanvas');
const preview = new Preview(state, canvas);
preview.start();

const sfxPlayer = new SoundEffectPlayer(state);

const timelineContainer = document.getElementById('timelineContainer');
const timeline = new Timeline(state, timelineContainer, {
  onSeek: async (t) => {
    sfxPlayer.resetScheduling();
    // preview.seek() only redraws the canvas — nothing else moves the
    // playhead marker's DOM position after a manual seek, so without this
    // it silently freezes wherever it last was (usually t=0, from the
    // initial render right after import) even though the video/time label
    // correctly jump to the new position.
    await preview.seek(t);
    document.getElementById('timeLabel').textContent =
      `${formatTime(state.playhead)} / ${formatTime(state.totalDuration())}`;
    timeline.render();
  },
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
  renderSfxPanel();
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
    sfxPlayer.resetScheduling();
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
  sfxPlayer.tick(state.playhead);
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

  const mode = getAiMode();
  const useClaude = mode === 'claude' && !!claudeApiKey.value;
  const useGemini = mode === 'gemini' && !!geminiApiKey.value;
  const label = useClaude ? 'Claude Vision' : useGemini ? 'Gemini Vision' : null;

  try {
    setProgress(0.05, label ? `Recognizing video content with ${label}...` : 'Recognizing video content (free, local, no API key)...');
    const onProgress = (msg) => setProgress(0.4, msg);
    const segments = useClaude
      ? await analyzeClipContent(clip, claudeApiKey.value, { onProgress })
      : useGemini
        ? await analyzeClipContentWithGemini(clip, geminiApiKey.value, { onProgress })
        : await analyzeClipContentLocal(clip, { onProgress });
    state.setContentAnalysis(clip.id, segments);
    renderContentAnalysisPanel();
    setProgress(null);
    setStatus(
      label
        ? `Recognized ${segments.length} segment(s) with ${label}.`
        : `Recognized ${segments.length} segment(s) locally (free) — for richer descriptions, switch AI mode to Claude or Gemini API.`
    );
  } catch (err) {
    setProgress(null);
    setStatus(`Content recognition failed: ${err.message}`);
    console.error(err);
  }
});

document.getElementById('cardPriceBtn').addEventListener('click', async (e) => {
  if (state.clips.length === 0) return setStatus('Import a clip first.');
  if (!geminiApiKey.value) {
    e.stopPropagation();
    setStatus('Card price lookup needs a Gemini API key (⚙ settings) — it identifies the card via Gemini vision regardless of your AI command bar mode.');
    document.getElementById('aiSettings').hidden = false;
    return;
  }

  const resultBox = document.getElementById('cardPriceResult');
  try {
    setProgress(0.1, 'Identifying card at playhead...');
    const result = await lookupCardPriceAtTime(state, {
      geminiApiKey: geminiApiKey.value,
      at: state.playhead,
    }, { onProgress: (msg) => setProgress(0.5, msg) });
    setProgress(null);

    const { card, listing, priceAud, audError } = result;
    const nativeLabel = `${listing.amount.toFixed(2)} ${listing.currency}`;
    const priceLabel = priceAud != null
      ? `$${priceAud.toFixed(2)} AUD`
      : `${nativeLabel} (AUD conversion failed: ${audError})`;
    const overlayText = `${listing.name}${listing.number ? ` #${listing.number}` : ''} — ${priceAud != null ? `$${priceAud.toFixed(2)} AUD` : nativeLabel}`;
    state.addTextOverlay({ text: overlayText, start: state.playhead, end: state.playhead + 4, y: 92, fontSize: 36 });

    resultBox.innerHTML = '';
    const item = document.createElement('div');
    item.className = 'content-analysis-item';
    item.textContent = `${listing.name}${listing.set ? ` (${listing.set})` : ''} — ${priceLabel} [${listing.source}]`;
    resultBox.appendChild(item);
    if (card.confidence !== 'high') {
      const note = document.createElement('div');
      note.className = 'panel-hint';
      note.textContent = `Identification confidence: ${card.confidence}. ${card.notes || ''}`;
      resultBox.appendChild(note);
    }

    setStatus(`Added price overlay: ${overlayText}`);
  } catch (err) {
    setProgress(null);
    setStatus(`Card price lookup failed: ${err.message}`);
    console.error(err);
  }
});

// --- Sound effects -------------------------------------------------------
const sfxBuiltinList = document.getElementById('sfxBuiltinList');
for (const effect of BUILTIN_EFFECTS) {
  const btn = document.createElement('button');
  btn.className = 'btn btn-secondary btn-block';
  btn.textContent = effect.label;
  btn.addEventListener('click', () => {
    const sfx = state.addSoundEffect({
      kind: 'builtin',
      effect: effect.id,
      duration: effect.duration,
      start: state.playhead,
    });
    state.selection = { type: 'sfx', id: sfx.id };
    rerenderAll();
    setStatus(`Added "${effect.label}" at ${formatTime(state.playhead, false)}.`);
  });
  sfxBuiltinList.appendChild(btn);
}

document.getElementById('sfxUploadInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  let duration = 1;
  try {
    duration = await new Promise((resolve, reject) => {
      const probe = document.createElement('audio');
      probe.preload = 'metadata';
      probe.src = url;
      probe.addEventListener('loadedmetadata', () => resolve(probe.duration || 1));
      probe.addEventListener('error', () => reject(new Error('could not read audio file')));
    });
  } catch (err) {
    setStatus(`Failed to load "${file.name}": ${err.message}`);
    e.target.value = '';
    return;
  }
  const sfx = state.addSoundEffect({
    kind: 'custom',
    url,
    name: file.name,
    duration,
    start: state.playhead,
  });
  state.selection = { type: 'sfx', id: sfx.id };
  rerenderAll();
  setStatus(`Added custom sound "${file.name}" at ${formatTime(state.playhead, false)}.`);
  e.target.value = '';
});

async function runFreesoundSearch(e) {
  const query = document.getElementById('freesoundQuery').value;
  const resultsBox = document.getElementById('freesoundResults');
  if (!freesoundApiKey.value) {
    if (e) e.stopPropagation();
    setStatus('Sound search needs your own Freesound API key (⚙ settings).');
    document.getElementById('aiSettings').hidden = false;
    return;
  }
  resultsBox.innerHTML = '';
  setStatus(`Searching Freesound for "${query}"...`);
  try {
    const results = await searchFreesound(freesoundApiKey.value, query);
    renderFreesoundResults(results);
    setStatus(
      results.length
        ? `Found ${results.length} sound(s) for "${query}".`
        : `No Freesound results for "${query}".`
    );
  } catch (err) {
    setStatus(`Freesound search failed: ${err.message}`);
    console.error(err);
  }
}

function renderFreesoundResults(results) {
  const container = document.getElementById('freesoundResults');
  container.innerHTML = '';
  for (const r of results) {
    const item = document.createElement('div');
    item.className = 'sfx-item';

    const label = document.createElement('span');
    label.className = 'sfx-item-label';
    label.textContent = `${r.name} (${r.duration.toFixed(1)}s)${isCC0(r.license) ? '' : ` — by ${r.username}`}`;
    label.title = `${r.name} — ${r.license || 'unknown license'} — uploaded by ${r.username}`;
    item.appendChild(label);

    const playBtn = document.createElement('button');
    playBtn.className = 'btn btn-icon';
    playBtn.textContent = '▶';
    playBtn.title = 'Preview';
    playBtn.addEventListener('click', () => {
      new Audio(r.previewUrl).play().catch((err) => setStatus(`Preview playback failed: ${err.message}`));
    });
    item.appendChild(playBtn);

    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-secondary';
    addBtn.textContent = '+ Add';
    addBtn.addEventListener('click', () => {
      const sfx = state.addSoundEffect({
        kind: 'freesound',
        url: r.previewUrl,
        name: r.name,
        duration: r.duration,
        start: state.playhead,
        license: r.license,
        attribution: r.username,
      });
      state.selection = { type: 'sfx', id: sfx.id };
      rerenderAll();
      setStatus(`Added "${r.name}" at ${formatTime(state.playhead, false)}.`);
    });
    item.appendChild(addBtn);

    container.appendChild(item);
  }
}

document.getElementById('freesoundSearchBtn').addEventListener('click', runFreesoundSearch);
document.getElementById('freesoundQuery').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runFreesoundSearch();
});

function renderSfxPanel() {
  const container = document.getElementById('sfxPanel');
  if (!container) return;
  container.innerHTML = '';
  const sorted = [...state.soundEffects].sort((a, b) => a.start - b.start);
  for (const sfx of sorted) {
    const isSelected = state.selection.type === 'sfx' && state.selection.id === sfx.id;
    const item = document.createElement('div');
    item.className = 'sfx-item';
    if (isSelected) item.style.borderColor = 'var(--accent-2)';

    const label = document.createElement('span');
    label.className = 'sfx-item-label';
    const name = sfx.kind === 'builtin' ? (BUILTIN_EFFECTS.find((e) => e.id === sfx.effect)?.label || sfx.effect) : sfx.name;
    label.textContent = `${name} @ ${formatTime(sfx.start, false)}`;
    if (sfx.kind === 'freesound') {
      label.title = `${sfx.name} — ${sfx.license || 'unknown license'} — by ${sfx.attribution}`;
    }
    item.appendChild(label);

    const startInput = document.createElement('input');
    startInput.type = 'number';
    startInput.step = '0.1';
    startInput.min = '0';
    startInput.value = sfx.start.toFixed(1);
    startInput.style.width = '64px';
    startInput.addEventListener('change', () => {
      state.updateSoundEffect(sfx.id, { start: Math.max(0, parseFloat(startInput.value) || 0) });
    });
    item.appendChild(startInput);

    const volInput = document.createElement('input');
    volInput.type = 'range';
    volInput.min = '0';
    volInput.max = '2';
    volInput.step = '0.05';
    volInput.value = sfx.volume ?? 1;
    volInput.title = 'Volume';
    volInput.addEventListener('input', () => {
      state.updateSoundEffect(sfx.id, { volume: parseFloat(volInput.value) });
    });
    item.appendChild(volInput);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-icon';
    delBtn.textContent = '✕';
    delBtn.title = 'Remove sound effect';
    delBtn.addEventListener('click', () => {
      state.removeSoundEffect(sfx.id);
      if (state.selection.type === 'sfx' && state.selection.id === sfx.id) {
        state.selection = { type: null, id: null };
      }
      rerenderAll();
    });
    item.appendChild(delBtn);

    item.addEventListener('click', (e) => {
      if (e.target === startInput || e.target === volInput || e.target === delBtn) return;
      state.selection = { type: 'sfx', id: sfx.id };
      refreshSidePanel();
      timeline.render();
    });

    container.appendChild(item);
  }
  if (sorted.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'panel-hint';
    hint.textContent = 'No sound effects placed yet.';
    container.appendChild(hint);
  }
}

// --- AI command bar --------------------------------------------------------
const aiInput = document.getElementById('aiInput');
const claudeApiKey = document.getElementById('claudeApiKey');
const geminiApiKey = document.getElementById('geminiApiKey');
const freesoundApiKey = document.getElementById('freesoundApiKey');
freesoundApiKey.value = localStorage.getItem('novacut_freesound_key') || '';
freesoundApiKey.addEventListener('change', () => localStorage.setItem('novacut_freesound_key', freesoundApiKey.value));
const aiModeRadios = Array.from(document.querySelectorAll('input[name="aiMode"]'));
const localLlmTierGroup = document.getElementById('localLlmTierGroup');

function getAiMode() {
  return (aiModeRadios.find((r) => r.checked) || {}).value || 'pattern';
}

// Build the fast/smart model-quality picker for the local-LLM mode from
// MODEL_TIERS so the UI and the actual model list never drift apart.
for (const [key, tier] of Object.entries(MODEL_TIERS)) {
  const label = document.createElement('label');
  label.className = 'ai-tier-option';
  label.innerHTML = `<input type="radio" name="aiLlmTier" value="${key}" />
    <span><strong>${tier.label}</strong><br/><span class="tier-note">${tier.note}</span></span>`;
  localLlmTierGroup.appendChild(label);
}
const aiTierRadios = Array.from(document.querySelectorAll('input[name="aiLlmTier"]'));

function getAiLlmTier() {
  return (aiTierRadios.find((r) => r.checked) || {}).value || 'smart';
}

const savedMode = localStorage.getItem('novacut_ai_mode');
if (savedMode) {
  const radio = aiModeRadios.find((r) => r.value === savedMode);
  if (radio) radio.checked = true;
}
const savedTier = localStorage.getItem('novacut_ai_llm_tier') || 'smart';
const tierRadio = aiTierRadios.find((r) => r.value === savedTier);
if (tierRadio) tierRadio.checked = true;
claudeApiKey.value = localStorage.getItem('novacut_claude_key') || '';
geminiApiKey.value = localStorage.getItem('novacut_gemini_key') || '';

function updateAiModeUI() {
  const mode = getAiMode();
  claudeApiKey.hidden = mode !== 'claude';
  geminiApiKey.hidden = mode !== 'gemini';
  localLlmTierGroup.hidden = mode !== 'local-llm';
  const btn = document.getElementById('recognizeContentBtn');
  btn.textContent = mode === 'claude' && claudeApiKey.value
    ? '🔍 Recognize Video Content (Claude Vision)'
    : mode === 'gemini' && geminiApiKey.value
      ? '🔍 Recognize Video Content (Gemini Vision)'
      : '🔍 Recognize Video Content (Free)';
}
updateAiModeUI();

for (const radio of aiModeRadios) {
  radio.addEventListener('change', () => {
    localStorage.setItem('novacut_ai_mode', getAiMode());
    updateAiModeUI();
  });
}
for (const radio of aiTierRadios) {
  radio.addEventListener('change', () => localStorage.setItem('novacut_ai_llm_tier', getAiLlmTier()));
}
claudeApiKey.addEventListener('change', () => {
  localStorage.setItem('novacut_claude_key', claudeApiKey.value);
  updateAiModeUI();
});
claudeApiKey.addEventListener('input', updateAiModeUI);
geminiApiKey.addEventListener('change', () => {
  localStorage.setItem('novacut_gemini_key', geminiApiKey.value);
  updateAiModeUI();
});
geminiApiKey.addEventListener('input', updateAiModeUI);

const aiSettingsPanel = document.getElementById('aiSettings');
const aiCommandArea = document.querySelector('.ai-command-area');
document.getElementById('aiSettingsToggle').addEventListener('click', (e) => {
  e.stopPropagation();
  aiSettingsPanel.hidden = !aiSettingsPanel.hidden;
});
// The panel floats above the rest of the page (so it can never squeeze the
// video preview, however tall it gets), which means it also has to close
// itself on an outside click like any other dropdown/popover — otherwise
// it just sits there covering whatever's underneath until you find the
// gear icon again. Scoped to the whole command-bar area rather than just
// the panel itself, so typing a command or hitting Run right after
// tweaking a setting doesn't slam it shut first.
document.addEventListener('click', (e) => {
  if (!aiSettingsPanel.hidden && !aiCommandArea.contains(e.target)) {
    aiSettingsPanel.hidden = true;
  }
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

  if (mode === 'gemini' && geminiApiKey.value) {
    setStatus(`Asking Gemini: "${text}"`);
    try {
      const actions = await parseCommandWithGemini(text, geminiApiKey.value, summarizeProject(state));
      await reportAndExecute(actions, 'Gemini');
    } catch (err) {
      setStatus(`Gemini request failed: ${err.message}`);
    }
    return;
  }

  if (mode === 'local-llm') {
    try {
      const actions = await parseCommandWithLocalLLM(text, summarizeProject(state), {
        tier: getAiLlmTier(),
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
