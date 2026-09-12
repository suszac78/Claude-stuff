# Vendored: WebLLM (free, local, real language-model command parsing)

- `index.js` — [@mlc-ai/web-llm](https://www.npmjs.com/package/@mlc-ai/web-llm) 0.2.79 (Apache-2.0), the pre-bundled ESM build (self-contained, only external dependency `loglevel` is inlined).

Loaded lazily, only when the user picks the "Free Local AI" command mode.
It runs a real small instruction-tuned language model (default:
`Llama-3.2-1B-Instruct-q4f16_1-MLC`, ~880MB) entirely in the browser via
WebGPU — no server, no API key, no per-use cost. The model weights and the
compiled WebGPU kernel library are **not** vendored here (they're ~900MB and
a few MB respectively); they're fetched at runtime from:

- `https://huggingface.co/mlc-ai/...` — model weights, standard MLC-LLM
  hosting for every consumer of this library.
- `https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/...` — the
  compiled WebGPU kernels for the chosen model.

Once downloaded, the browser caches both via the Cache API, so subsequent
uses in the same browser don't re-download.

Trade-offs vs. the paid Claude API path (`js/aiCommands.js`'s
`parseCommandWithClaude`): requires a WebGPU-capable browser (Chrome/Edge;
not Safari/Firefox by default), a large first-time download, and — being a
1B-parameter model instead of a frontier model — meaningfully weaker at
following complex, multi-clause instructions. It is a genuine free/local
option for real natural-language command parsing, not just pattern
matching, but it will get some things wrong that Claude would not.
