import { clamp } from './utils.js';
import { seekTo } from './autoCut.js';

// Free, local, no-API-key object recognition using TensorFlow.js + COCO-SSD.
// Runs entirely in the browser (WebGL/WASM) — no server, no cost, no key.
// Trade-off vs. js/visionAnalysis.js's Claude Vision path: COCO-SSD only
// recognizes 80 everyday object classes, so descriptions are coarser
// ("visible: person, cup") rather than rich scene descriptions.

const TF_SCRIPT = new URL('../vendor/tfjs/tf.min.js', import.meta.url).href;
const COCO_SCRIPT = new URL('../vendor/tfjs/coco-ssd.min.js', import.meta.url).href;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

let libsPromise = null;
async function ensureLibs() {
  if (!libsPromise) {
    libsPromise = (async () => {
      if (!window.tf) await loadScript(TF_SCRIPT);
      if (!window.cocoSsd) await loadScript(COCO_SCRIPT);
    })();
  }
  return libsPromise;
}

let modelPromise = null;
async function getModel() {
  await ensureLibs();
  if (!modelPromise) {
    // lite_mobilenet_v2 is the smallest/fastest COCO-SSD base — good fit for
    // running inference on-device in a regular browser tab.
    modelPromise = window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
  }
  return modelPromise;
}

export async function analyzeClipContentLocal(clip, { onProgress, maxFrames = 20, minConfidence = 0.5 } = {}) {
  onProgress && onProgress('Loading local recognition model (first run only, ~20MB)...');
  const model = await getModel();

  const video = document.createElement('video');
  video.src = clip.url;
  video.muted = true;
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = reject;
  });

  const localDur = (clip.outPoint - clip.inPoint) / (clip.speed || 1);
  const frameCount = clamp(Math.round(localDur * 2), 6, maxFrames);
  const interval = localDur / frameCount;

  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d');

  const perFrame = [];
  for (let i = 0; i < frameCount; i++) {
    const t = clamp(i * interval, 0, localDur - 0.01);
    const sourceTime = clip.inPoint + t * clip.speed;
    await seekTo(video, sourceTime);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    onProgress && onProgress(`Scanning frame ${i + 1}/${frameCount}...`);
    const predictions = await model.detect(canvas, 10, minConfidence);
    const labels = [...new Set(predictions.map((p) => p.class))].sort();
    perFrame.push({ t, labels });
  }

  return groupIntoSegments(perFrame, localDur);
}

// Merges consecutive samples that detected the same set of objects into one
// segment, producing the same {start,end,description} shape used by the
// Claude Vision path (js/visionAnalysis.js) so both plug into aiCommands.js
// identically.
function groupIntoSegments(perFrame, localDur) {
  const runs = [];
  for (const frame of perFrame) {
    const key = frame.labels.join(',');
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.end = frame.t;
    else runs.push({ start: frame.t, end: frame.t, key, labels: frame.labels });
  }
  for (let i = 0; i < runs.length - 1; i++) runs[i].end = runs[i + 1].start;
  if (runs.length) runs[runs.length - 1].end = localDur;

  return runs.map((r) => ({
    start: +r.start.toFixed(2),
    end: +r.end.toFixed(2),
    description: r.labels.length ? `visible: ${r.labels.join(', ')}` : 'no recognized objects in frame',
  }));
}
