import { AI_ACTION_SYSTEM_PROMPT, extractActionsFromText } from './aiCommands.js';
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
    maxOutputTokens: 1024,
  });
  return extractActionsFromText(raw);
}

export async function analyzeClipContentWithGemini(clip, apiKey, { onProgress } = {}) {
  onProgress && onProgress('Sampling frames from clip...');
  const { frames, localDur } = await sampleFrames(clip);

  onProgress && onProgress(`Asking Gemini to watch ${frames.length} frames...`);
  const parts = [{ text: visionIntroText(frames.length, localDur) }];
  for (const f of frames) {
    parts.push({ text: `Frame at t=${f.t.toFixed(2)}s:` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: f.base64 } });
  }
  parts.push({ text: visionAskText(localDur) });

  const raw = await callGemini(apiKey, { parts, maxOutputTokens: 1536 });
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Could not find a JSON timeline in the response');
  return filterSegments(JSON.parse(jsonMatch[0]));
}
