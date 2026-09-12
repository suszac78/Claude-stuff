import { AI_ACTION_SYSTEM_PROMPT } from './aiCommands.js';

// Free, local, real natural-language command parsing — no API key, no
// server, no cost. Runs a small instruction-tuned LLM entirely in the
// browser via WebGPU (WebLLM/MLC). Trade-off vs. Claude: needs a
// WebGPU-capable browser (Chrome/Edge; not Safari/Firefox by default), a
// large one-time model download (~880MB, cached by the browser after
// that), and — being a 1B-parameter model — is noticeably weaker at
// following complex, multi-clause instructions than a frontier model.

const WEBLLM_MODULE = new URL('../vendor/webllm/index.js', import.meta.url).href;
const MODEL_ID = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';

export function isSupported() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

const MAX_LOAD_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Downloading ~880MB across many shard requests means *some* single request
// hiccupping (a dropped connection, a flaky wifi packet) is common, not
// exceptional. WebLLM's cache layer treats any such hiccup as a hard
// failure, so we retry the whole load a few times before giving up — and,
// importantly, never cache a *rejected* promise, otherwise every future
// attempt would just replay the same stale failure without ever touching
// the network again.
let enginePromise = null;

export async function ensureEngine({ onProgress } = {}) {
  if (!isSupported()) {
    throw new Error('This browser has no WebGPU support (try Chrome or Edge) — the free local AI needs it.');
  }
  if (enginePromise) return enginePromise;

  const attempt = (async () => {
    const webllm = await import(/* webpackIgnore: true */ /* @vite-ignore */ WEBLLM_MODULE);
    let lastError;
    for (let i = 1; i <= MAX_LOAD_ATTEMPTS; i++) {
      try {
        return await webllm.CreateMLCEngine(MODEL_ID, {
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

  enginePromise = attempt;
  try {
    return await attempt;
  } catch (err) {
    enginePromise = null; // don't poison future attempts with this rejection
    throw err;
  }
}

export async function parseCommandWithLocalLLM(text, projectSummary, { onProgress } = {}) {
  const engine = await ensureEngine({ onProgress });
  onProgress && onProgress('Thinking...', 1);
  const reply = await engine.chat.completions.create({
    messages: [
      { role: 'system', content: AI_ACTION_SYSTEM_PROMPT },
      { role: 'user', content: `Project state:\n${projectSummary}\n\nInstruction: ${text}` },
    ],
    temperature: 0,
  });
  const raw = reply.choices?.[0]?.message?.content || '';
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`The local model didn't return a usable action list (got: "${raw.slice(0, 120)}")`);
  return JSON.parse(jsonMatch[0]);
}
