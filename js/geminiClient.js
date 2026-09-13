import { AI_ACTION_SYSTEM_PROMPT, extractActionsFromText, extractTopLevelObjects } from './aiCommands.js';
import { sampleFrames, visionIntroText, visionAskText, filterSegments } from './visionAnalysis.js';

// Bring-your-own-key bridge to Google's Gemini API — an alternative to
// Claude for anyone who already has a Gemini key. Mirrors aiCommands.js's
// Claude bridge and visionAnalysis.js's Claude Vision bridge exactly (same
// system prompt, same action schema, same {start,end,description} vision
// output), just against Gemini's REST API shape instead of Anthropic's.
//
// The key is used only in this browser session (sent only to
// generativelanguage.googleapis.com) and stored only in localStorage by the
// caller, same as the Claude key.

// Google retires/renames model ids over time; if this ever 404s with a
// message naming a replacement model, that message is authoritative — just
// update this constant to whatever it says.
const GEMINI_MODEL = 'gemini-3.6-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function callGemini(apiKey, { systemInstruction, parts, maxOutputTokens = 1536 }) {
  const res = await fetch(`${API_BASE}/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0, maxOutputTokens },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason === 'SAFETY') {
    throw new Error('Gemini declined to respond (safety filter).');
  }
  const text = (candidate?.content?.parts || []).map((p) => p.text).filter(Boolean).join('\n');
  if (!text) throw new Error('No text response from Gemini');
  return text;
}

export async function parseCommandWithGemini(text, apiKey, projectSummary) {
  const raw = await callGemini(apiKey, {
    systemInstruction: AI_ACTION_SYSTEM_PROMPT,
    parts: [{ text: `Project state:\n${projectSummary}\n\nInstruction: ${text}` }],
    // Generous headroom: a content-aware, multi-action response can run
    // long, and on models with built-in reasoning, internal "thinking"
    // tokens are drawn from this same budget before the visible JSON even
    // starts — too tight a cap here truncates the answer mid-object.
    maxOutputTokens: 4096,
  });
  return extractActionsFromText(raw);
}

// Gemini has no meaningful per-request image limit (unlike Claude's ~20),
// so it gets much denser sampling — close to 1 frame/sec for clips up to
// 60s — rather than the 16-frame default tuned for Claude's cap. Coarser
// sampling was the confirmed root cause of short (~1-2s) events getting
// missed entirely even after running recognition.
const GEMINI_MAX_FRAMES = 60;

export async function analyzeClipContentWithGemini(clip, apiKey, { onProgress } = {}) {
  onProgress && onProgress('Sampling frames from clip...');
  const { frames, localDur } = await sampleFrames(clip, { maxFrames: GEMINI_MAX_FRAMES });

  onProgress && onProgress(`Asking Gemini to watch ${frames.length} frames...`);
  const parts = [{ text: visionIntroText(frames.length, localDur) }];
  for (const f of frames) {
    parts.push({ text: `Frame at t=${f.t.toFixed(2)}s:` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: f.base64 } });
  }
  parts.push({ text: visionAskText(localDur) });

  const raw = await callGemini(apiKey, { parts, maxOutputTokens: 4096 });
  const arrayStart = raw.indexOf('[');
  if (arrayStart === -1) throw new Error('Could not find a JSON timeline in the response');
  // Same salvage approach as extractActionsFromText: keep whatever complete
  // {start,end,description} segments came through even if the response got
  // cut off before the array closed.
  const segments = extractTopLevelObjects(raw.slice(arrayStart))
    .map((objText) => {
      try { return JSON.parse(objText); } catch { return null; }
    })
    .filter(Boolean);
  if (segments.length === 0) throw new Error('Could not find a JSON timeline in the response');
  return filterSegments(segments);
}
