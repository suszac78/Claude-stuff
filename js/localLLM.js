import { AI_ACTION_SYSTEM_PROMPT, extractActionsFromText } from './aiCommands.js';

// Free, local, real natural-language command parsing — no API key, no
// server, no cost. Runs a small instruction-tuned LLM entirely in the
// browser via WebGPU (WebLLM/MLC). No local model that fits in a browser
// tab matches a frontier model like Claude — this narrows that gap as far
// as is realistic for something that has to download and run on a
// visitor's own GPU, not close it.

const WEBLLM_MODULE = new URL('../vendor/webllm/index.js', import.meta.url).href;

export const MODEL_TIERS = {
  fast: {
    id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    label: 'Fast (1B, ~880MB)',
    note: 'Quick, but frequently misreads or drops parts of multi-clause instructions.',
  },
  smart: {
    id: 'Phi-3.5-mini-instruct-q4f16_1-MLC',
    label: 'Smarter (3.8B, ~3.7GB)',
    note: 'Meaningfully better instruction-following (Microsoft\'s Phi-3.5-mini) — larger download, slower per response, needs a decent GPU. Still well below Claude.',
  },
};
const DEFAULT_TIER = 'smart';

export function isSupported() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

const MAX_LOAD_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Downloading hundreds of MB to several GB across many shard requests means
// *some* single request hiccupping (a dropped connection, a flaky wifi
// packet) is common, not exceptional. WebLLM's cache layer treats any such
// hiccup as a hard failure, so we retry the whole load a few times before
// giving up — and, importantly, never cache a *rejected* promise, otherwise
// every future attempt would just replay the same stale failure without
// ever touching the network again.
//
// Keyed by tier so switching from "fast" to "smart" (or back) mid-session
// loads the other model instead of reusing whichever loaded first — both
// can end up cached in the browser at once.
const enginePromises = new Map();

export async function ensureEngine({ tier = DEFAULT_TIER, onProgress } = {}) {
  if (!isSupported()) {
    throw new Error('This browser has no WebGPU support (try Chrome or Edge) — the free local AI needs it.');
  }
  const modelId = (MODEL_TIERS[tier] || MODEL_TIERS[DEFAULT_TIER]).id;
  if (enginePromises.has(modelId)) return enginePromises.get(modelId);

  const attempt = (async () => {
    const webllm = await import(/* webpackIgnore: true */ /* @vite-ignore */ WEBLLM_MODULE);
    let lastError;
    for (let i = 1; i <= MAX_LOAD_ATTEMPTS; i++) {
      try {
        return await webllm.CreateMLCEngine(modelId, {
          initProgressCallback: (report) => onProgress && onProgress(report.text, report.progress),
        });
      } catch (err) {
        lastError = err;
        const isLastAttempt = i === MAX_LOAD_ATTEMPTS;
        onProgress && onProgress(
          isLastAttempt
            ? `Download failed (${err.message}). Giving up after ${MAX_LOAD_ATTEMPTS} attempts.`
            : `Download hiccupped (${err.message}) — retrying (${i}/${MAX_LOAD_ATTEMPTS})...`,
          0
        );
        if (!isLastAttempt) await delay(RETRY_DELAY_MS * i);
      }
    }
    throw lastError;
  })();

  enginePromises.set(modelId, attempt);
  try {
    return await attempt;
  } catch (err) {
    enginePromises.delete(modelId); // don't poison future attempts with this rejection
    throw err;
  }
}

export async function parseCommandWithLocalLLM(text, projectSummary, { tier = DEFAULT_TIER, onProgress } = {}) {
  const engine = await ensureEngine({ tier, onProgress });
  onProgress && onProgress('Thinking...', 1);
  const reply = await engine.chat.completions.create({
    messages: [
      { role: 'system', content: AI_ACTION_SYSTEM_PROMPT },
      { role: 'user', content: `Project state:\n${projectSummary}\n\nInstruction: ${text}` },
    ],
    temperature: 0,
  });
  const raw = reply.choices?.[0]?.message?.content || '';
  return extractActionsFromText(raw);
}
