import { clamp } from './utils.js';
import { seekTo } from './autoCut.js';
import { extractTopLevelObjects } from './aiCommands.js';

const CLAUDE_MODEL = 'claude-sonnet-5';
const FRAME_W = 384;
const FRAME_H = 216;

// Samples evenly-spaced frames across a clip's *trimmed* local timeline and
// returns them as small base64 JPEGs (cheap enough to send several to a
// vision model in one request). Shared by every vision backend (Claude,
// Gemini) so the sampling strategy only has to be tuned once.
export async function sampleFrames(clip, { maxFrames = 16, minFrames = 4 } = {}) {
  const video = document.createElement('video');
  video.src = clip.url;
  video.muted = true;
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = reject;
  });

  const localDur = (clip.outPoint - clip.inPoint) / (clip.speed || 1);
  const frameCount = clamp(Math.round(localDur), minFrames, maxFrames);
  const interval = localDur / frameCount;

  const canvas = document.createElement('canvas');
  canvas.width = FRAME_W;
  canvas.height = FRAME_H;
  const ctx = canvas.getContext('2d');

  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    const t = clamp(i * interval, 0, localDur - 0.01);
    const sourceTime = clip.inPoint + t * clip.speed;
    await seekTo(video, sourceTime);
    ctx.drawImage(video, 0, 0, FRAME_W, FRAME_H);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
    frames.push({ t, base64: dataUrl.split(',')[1] });
  }
  return { frames, localDur };
}

// The instructions text is identical no matter which vision model reads it —
// only how each provider's API wants images packaged differs. Shared so
// Claude's and Gemini's vision bridges can't drift in wording/output shape.
export function visionIntroText(frameCount, localDur) {
  return `Here are ${frameCount} frames sampled evenly across a ${localDur.toFixed(1)}s video clip, in chronological order. Each frame is preceded by a text label giving its timestamp in seconds.`;
}
export function visionAskText(localDur) {
  return `Based on these frames, describe what happens across the full ${localDur.toFixed(1)}s clip as a timeline of short segments. Respond with ONLY a JSON array (no prose, no markdown fences) of objects shaped like {"start":number,"end":number,"description":string}, covering the entire 0-${localDur.toFixed(1)} range with no gaps and no overlaps, ordered chronologically. Each description should be under 15 words and name concrete visible objects/actions (e.g. "hand holds a sealed pack of cards", "cards fanned out face-down on table", "pack torn open, cards revealed").`;
}

export function filterSegments(segments) {
  return segments.filter((s) => typeof s.start === 'number' && typeof s.end === 'number' && s.description);
}

// Sends sampled frames to Claude's vision endpoint and asks for a JSON
// timeline of what's visually happening, in the same {start,end,...} shape
// used everywhere else in the app. Requires a user-supplied API key (same
// bring-your-own-key model as the text command bridge in aiCommands.js).
export async function analyzeClipContent(clip, apiKey, { onProgress } = {}) {
  onProgress && onProgress('Sampling frames from clip...');
  const { frames, localDur } = await sampleFrames(clip);

  onProgress && onProgress(`Asking Claude to watch ${frames.length} frames...`);
  const content = [{ type: 'text', text: visionIntroText(frames.length, localDur) }];
  for (const f of frames) {
    content.push({ type: 'text', text: `Frame at t=${f.t.toFixed(2)}s:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.base64 } });
  }
  content.push({ type: 'text', text: visionAskText(localDur) });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 3072,
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Claude API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text response from Claude');
  const arrayStart = textBlock.text.indexOf('[');
  if (arrayStart === -1) throw new Error('Could not find a JSON timeline in the response');
  const segments = extractTopLevelObjects(textBlock.text.slice(arrayStart))
    .map((objText) => {
      try { return JSON.parse(objText); } catch { return null; }
    })
    .filter(Boolean);
  if (segments.length === 0) throw new Error('Could not find a JSON timeline in the response');
  return filterSegments(segments);
}
