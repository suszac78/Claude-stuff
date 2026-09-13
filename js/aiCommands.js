import { parseTimeToken } from './utils.js';
import { detectSilence, detectSceneChanges } from './autoCut.js';

// ---------------------------------------------------------------------------
// Structured action schema shared by both the offline rule-based parser and
// the optional live Claude API bridge, so the executor only has to be
// written once no matter which "brain" produced the actions.
//
//   { type: 'split', at }
//   { type: 'delete', clipIndex }
//   { type: 'trim', clipIndex, inPoint?, outPoint? }
//   { type: 'setSpeed', clipIndex, speed }
//   { type: 'addText', text, start, end, x?, y?, align?, animation?, fontSize?, color? }
//   { type: 'deleteText', index }
//   { type: 'addZoom', clipIndex, start, end, fromScale?, toScale?, fromX?, fromY?, toX?, toY? }
//   { type: 'removeSilence', clipIndex }   // clipIndex omitted = all clips
//   { type: 'detectScenes', clipIndex }    // clipIndex omitted = all clips
// ---------------------------------------------------------------------------

const TIME = '([0-9:.]+)';

const RULES = [
  {
    re: new RegExp(`\\b(?:split|cut)\\b.*?\\bat\\b\\s*${TIME}`, 'i'),
    build: (m) => [{ type: 'split', at: parseTimeToken(m[1]) }],
  },
  {
    re: /\b(?:delete|remove)\s+clip\s*#?(\d+)/i,
    build: (m) => [{ type: 'delete', clipIndex: parseInt(m[1], 10) - 1 }],
  },
  {
    re: new RegExp(`\\btrim\\s+clip\\s*#?(\\d+)\\b.*?\\bfrom\\b\\s*${TIME}\\s*\\bto\\b\\s*${TIME}`, 'i'),
    build: (m) => [{ type: 'trim', clipIndex: parseInt(m[1], 10) - 1, inPoint: parseTimeToken(m[2]), outPoint: parseTimeToken(m[3]) }],
  },
  {
    re: /\bspeed\s*up\s+clip\s*#?(\d+)\b.*?(\d+(?:\.\d+)?)\s*x/i,
    build: (m) => [{ type: 'setSpeed', clipIndex: parseInt(m[1], 10) - 1, speed: parseFloat(m[2]) }],
  },
  {
    re: /\bslow\s*down\s+clip\s*#?(\d+)\b.*?(\d+(?:\.\d+)?)\s*x/i,
    build: (m) => [{ type: 'setSpeed', clipIndex: parseInt(m[1], 10) - 1, speed: 1 / parseFloat(m[2]) }],
  },
  {
    re: new RegExp(`\\badd\\s+text\\s+['"“](.+?)['"”]\\s*(?:from\\s*${TIME}\\s*to\\s*${TIME})?`, 'i'),
    build: (m, raw) => {
      const start = parseTimeToken(m[2]) ?? 0;
      const end = parseTimeToken(m[3]) ?? start + 3;
      const action = { type: 'addText', text: m[1], start, end };
      if (/\btop\b/i.test(raw)) action.y = 12;
      if (/\bbottom\b/i.test(raw)) action.y = 88;
      if (/\bleft\b/i.test(raw)) { action.x = 15; action.align = 'left'; }
      if (/\bright\b/i.test(raw)) { action.x = 85; action.align = 'right'; }
      return [action];
    },
  },
  {
    re: new RegExp(`\\bzoom\\s+(in|out)\\b.*?\\bclip\\s*#?(\\d+)\\b.*?\\bfrom\\s*${TIME}\\s*to\\s*${TIME}`, 'i'),
    build: (m) => {
      const zoomIn = m[1].toLowerCase() === 'in';
      return [{
        type: 'addZoom',
        clipIndex: parseInt(m[2], 10) - 1,
        start: parseTimeToken(m[3]),
        end: parseTimeToken(m[4]),
        fromScale: zoomIn ? 1 : 1.4,
        toScale: zoomIn ? 1.4 : 1,
      }];
    },
  },
  {
    re: /\bremove\s+silence\b(?:.*?\bclip\s*#?(\d+))?/i,
    build: (m) => [{ type: 'removeSilence', clipIndex: m[1] ? parseInt(m[1], 10) - 1 : undefined }],
  },
  {
    re: /\b(?:detect|find)\s+scenes?\b(?:.*?\bclip\s*#?(\d+))?/i,
    build: (m) => [{ type: 'detectScenes', clipIndex: m[1] ? parseInt(m[1], 10) - 1 : undefined }],
  },
];

// Splits "do X and then do Y; also do Z" into separate fragments.
function splitFragments(text) {
  return text
    .split(/;|\bthen\b|\.\s+|\band\s+also\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseCommandOffline(text) {
  const actions = [];
  const unrecognized = [];
  for (const fragment of splitFragments(text)) {
    let matched = false;
    for (const rule of RULES) {
      const m = fragment.match(rule.re);
      if (m) {
        actions.push(...rule.build(m, fragment));
        matched = true;
        break;
      }
    }
    if (!matched) unrecognized.push(fragment);
  }
  return { actions, unrecognized };
}

// ---------------------------------------------------------------------------
// Optional "smart" mode: send the prompt + a compact project summary to the
// Claude API and ask for the same JSON action schema back. Requires the user
// to paste their own API key (kept only in localStorage, sent only to
// api.anthropic.com). Falls back gracefully if no key is set.
// ---------------------------------------------------------------------------

export const AI_ACTION_SYSTEM_PROMPT = `You control a video editor by emitting a JSON array of actions.
Valid action objects (omit fields you don't need):
{"type":"split","at":seconds}
{"type":"delete","clipIndex":0-based}
{"type":"trim","clipIndex":n,"inPoint":sec,"outPoint":sec}
{"type":"setSpeed","clipIndex":n,"speed":number}
{"type":"addText","text":"...","start":sec,"end":sec,"x":0-100,"y":0-100,"align":"left|center|right","animation":"none|fade|slide","fontSize":px,"color":"#hex"}
{"type":"deleteText","index":n}
{"type":"addZoom","clipIndex":n,"start":sec,"end":sec,"fromScale":n,"toScale":n,"fromX":0-100,"fromY":0-100,"toX":0-100,"toY":0-100}
{"type":"removeSilence","clipIndex":n}
{"type":"detectScenes","clipIndex":n}
Some clips include a "contentTimeline": an array of {start,end,description}
produced by watching the actual video frames, describing what is visibly
happening across that clip in seconds relative to its own (trimmed) start.
Use it to resolve vague, content-based instructions — "when the pack is
opened", "the last 3 cards", "cut the boring part", "right before he speaks"
— into concrete numeric start/end/at seconds before emitting actions. If an
instruction depends on visual content and no contentTimeline is present for
the relevant clip, do your best from the clip name/duration alone. Never
guess a placeholder number (like 0, or the exact clip duration) just to
produce *some* action — an action with a made-up timestamp is worse than no
action, since it silently does the wrong thing. Omit any part of the
instruction you can't confidently turn into a real number, and return an
empty array if none of it can be resolved.

Examples:
Instruction: "cut the first 3 seconds"
[{"type":"split","at":3},{"type":"delete","clipIndex":0}]
Instruction: "add the caption 'Hi there' for the first 2 seconds"
[{"type":"addText","text":"Hi there","start":0,"end":2}]
Instruction: "make clip 1 twice as fast"
[{"type":"setSpeed","clipIndex":0,"speed":2}]

Respond with ONLY the JSON array, no prose, no markdown fences.`;

export async function parseCommandWithClaude(text, apiKey, projectSummary) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      system: AI_ACTION_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `Project state:\n${projectSummary}\n\nInstruction: ${text}` },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Claude API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text response from Claude');
  const jsonMatch = textBlock.text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Could not find a JSON action list in the response');
  return JSON.parse(jsonMatch[0]);
}

export function summarizeProject(state) {
  return JSON.stringify({
    clips: state.clips.map((c, i) => ({
      index: i,
      name: c.name,
      durationSec: +state.clipDuration(c).toFixed(2),
      speed: c.speed,
      contentTimeline: state.getContentAnalysis(c.id) || undefined,
    })),
    textOverlays: state.textOverlays.map((o, i) => ({ index: i, text: o.text, start: o.start, end: o.end })),
    totalDurationSec: +state.totalDuration().toFixed(2),
  });
}

// ---------------------------------------------------------------------------
// Executor: applies a validated action list to the shared EditorState.
// ---------------------------------------------------------------------------

// Returns a results array [{type, applied, note}] so callers can tell a
// genuine no-op (e.g. a guessed "split at 0" that the timeline correctly
// refused, since it's at the very edge of a clip) apart from a real edit —
// both look identical from just "did executeActions throw or not".
export async function executeActions(state, actions, { onLog } = {}) {
  const log = (msg) => onLog && onLog(msg);
  const results = [];
  for (const action of actions) {
    try {
      const note = await executeOne(state, action, log);
      // executeOne returns undefined on a real edit, or a string explaining
      // why it was a no-op — a returned string always means "not applied".
      results.push({ type: action.type, applied: note == null, note: note || undefined });
    } catch (err) {
      log(`⚠️ Failed to apply ${action.type}: ${err.message}`);
      results.push({ type: action.type, applied: false, note: err.message });
    }
  }
  return results;
}

// Returns `false` (or a string note) when the action was a legitimate no-op,
// so executeActions can report it as such instead of a silent success.
async function executeOne(state, action, log) {
  const clipAt = (idx) => {
    if (idx == null) return undefined;
    const clip = state.clips[idx];
    if (!clip) throw new Error(`no clip at index ${idx}`);
    return clip;
  };

  switch (action.type) {
    case 'split': {
      const result = state.splitClipAt(action.at);
      if (!result) {
        return `split at ${action.at}s had no effect (too close to a clip's start/end, or out of range)`;
      }
      log(`Split at ${action.at}s`);
      return;
    }
    case 'delete': {
      const clip = clipAt(action.clipIndex);
      state.removeClip(clip.id);
      log(`Deleted clip ${action.clipIndex + 1}`);
      return;
    }
    case 'trim': {
      const clip = clipAt(action.clipIndex);
      state.trimClip(clip.id, { inPoint: action.inPoint, outPoint: action.outPoint });
      log(`Trimmed clip ${action.clipIndex + 1}`);
      return;
    }
    case 'setSpeed': {
      const clip = clipAt(action.clipIndex);
      state.setClipSpeed(clip.id, action.speed);
      log(`Set clip ${action.clipIndex + 1} speed to ${action.speed}x`);
      return;
    }
    case 'addText': {
      state.addTextOverlay(action);
      log(`Added text "${action.text}"`);
      return;
    }
    case 'deleteText': {
      const overlay = state.textOverlays[action.index];
      if (!overlay) return `no text overlay at index ${action.index}`;
      state.removeTextOverlay(overlay.id);
      return;
    }
    case 'addZoom': {
      const clip = clipAt(action.clipIndex);
      state.addZoomKeyframe({ ...action, clipId: clip.id });
      log(`Added zoom on clip ${action.clipIndex + 1}`);
      return;
    }
    case 'removeSilence': {
      const targets = action.clipIndex != null ? [state.clips[action.clipIndex]] : state.clips;
      let totalGaps = 0;
      for (const clip of targets) {
        if (!clip) continue;
        const gaps = await detectSilence(clip);
        totalGaps += gaps.length;
        // Remove from the end backwards so earlier offsets stay valid.
        for (const gap of gaps.slice().reverse()) {
          const globalStart = state.clipGlobalStart(clip.id) + gap.start;
          const globalEnd = state.clipGlobalStart(clip.id) + gap.end;
          state.splitClipAt(globalEnd);
          state.splitClipAt(globalStart);
          const middle = state.locateTime((globalStart + globalEnd) / 2)?.clip;
          if (middle) state.removeClip(middle.id);
        }
        log(`Removed ${gaps.length} silent gap(s) from clip`);
      }
      if (totalGaps === 0) return 'no silence detected';
      return;
    }
    case 'detectScenes': {
      const targets = action.clipIndex != null ? [state.clips[action.clipIndex]] : state.clips;
      let totalCuts = 0;
      for (const clip of targets) {
        if (!clip) continue;
        const cuts = await detectSceneChanges(clip);
        totalCuts += cuts.length;
        for (const t of cuts) {
          state.splitClipAt(state.clipGlobalStart(clip.id) + t);
        }
        log(`Found ${cuts.length} scene change(s)`);
      }
      if (totalCuts === 0) return 'no scene changes detected';
      return;
    }
    default:
      throw new Error(`unknown action type "${action.type}"`);
  }
}
