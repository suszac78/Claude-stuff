import { seekTo } from './autoCut.js';
import { callGemini } from './geminiClient.js';
import { extractTopLevelObjects } from './aiCommands.js';

// "Identify the trading card on screen, look up what it's worth, show the
// price" — a small pipeline chaining three independent services:
//   1. Gemini vision: what card is this?
//   2. TCGdex (https://tcgdex.dev): what does that card sell for? Fully
//      open-source, community-run, no API key/auth required at all.
//   3. Frankfurter (ECB rates, no key needed): source currency -> AUD.
// Each step can fail independently (no confident ID, no market match, rate
// service down) — lookupCardPriceAtTime() reports exactly which step got
// how far rather than an opaque single failure, and still returns the
// original-currency price if only the currency conversion step fails.

const TCGDEX_BASE = 'https://api.tcgdex.net/v2';
const FRAME_W = 512;
const FRAME_H = 512;

async function captureFrameAt(state, globalTime) {
  const loc = state.locateTime(globalTime);
  if (!loc) throw new Error(`nothing on the timeline at ${globalTime}s`);
  const { clip, localTime } = loc;
  const sourceTime = clip.inPoint + localTime * clip.speed;

  const video = document.createElement('video');
  video.src = clip.url;
  video.muted = true;
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = reject;
  });
  await seekTo(video, sourceTime);

  const canvas = document.createElement('canvas');
  canvas.width = FRAME_W;
  canvas.height = FRAME_H;
  const ctx = canvas.getContext('2d');
  // Letterbox into a square-ish frame rather than stretching — cards are
  // usually portrait-oriented and centered in frame, so this keeps them
  // undistorted for identification.
  const scale = Math.min(FRAME_W / video.videoWidth, FRAME_H / video.videoHeight);
  const dw = video.videoWidth * scale;
  const dh = video.videoHeight * scale;
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, FRAME_W, FRAME_H);
  ctx.drawImage(video, (FRAME_W - dw) / 2, (FRAME_H - dh) / 2, dw, dh);
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
}

const IDENTIFY_PROMPT = `You are looking at one video frame that should contain a physical trading card (most likely a Pokemon card). Identify it as precisely as you can.
Respond with ONLY a JSON object (no prose, no markdown fences) shaped like:
{"identified":true,"name":"card name as printed","set":"set name if visible or inferable, else null","number":"collector number like \\"199/197\\" if visible, else null","printing":"e.g. Holo, Reverse Holo, 1st Edition, or null if unclear","confidence":"high|medium|low","notes":"anything relevant, e.g. partially obscured"}
If no identifiable card is visible in the frame, respond with {"identified":false,"notes":"why not"} instead. Never guess a specific name/set you aren't reasonably confident about — an empty identification is better than a wrong one.`;

export async function identifyCardWithGemini(state, apiKey, globalTime) {
  const base64 = await captureFrameAt(state, globalTime);
  const raw = await callGemini(apiKey, {
    parts: [
      { text: IDENTIFY_PROMPT },
      { inline_data: { mime_type: 'image/jpeg', data: base64 } },
    ],
    // Generous headroom, same reasoning as the other Gemini call sites: on
    // a reasoning model, internal "thinking" tokens are drawn from this same
    // budget before any visible JSON even starts — too tight a cap here (a
    // real failure seen in practice at 512) truncates the response mid-object.
    maxOutputTokens: 2048,
  });
  const braceStart = raw.indexOf('{');
  if (braceStart === -1) throw new Error(`Gemini gave an unusable response: "${raw.slice(0, 150)}"`);
  const [objectText] = extractTopLevelObjects(raw.slice(braceStart));
  if (!objectText) {
    throw new Error(`Gemini's response got cut off before finishing (try again): "${raw.slice(0, 150)}"`);
  }
  const result = JSON.parse(objectText);
  if (!result.identified || !result.name) {
    throw new Error(result.notes || 'Gemini could not confidently identify a card in this frame.');
  }
  return result;
}

async function tcgdexFetch(path) {
  let res;
  try {
    res = await fetch(`${TCGDEX_BASE}${path}`);
  } catch (err) {
    throw new Error(`Could not reach TCGdex (network error): ${err.message}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TCGdex API error ${res.status}: ${res.statusText}`);
  return res.json();
}

// Collector numbers come back as things like "199/197" from Gemini and as
// bare (sometimes zero-padded) strings like "007" from TCGdex — compare
// just the leading digits, un-padded, so either shape matches the other.
function normalizeNumber(n) {
  if (!n) return null;
  const m = String(n).match(/\d+/);
  return m ? String(parseInt(m[0], 10)) : null;
}

// Picks a representative market price straight off a TCGdex card's
// `pricing` field: prefers TCGplayer (USD), trying the variant that best
// matches how the card was identified (holo/reverse/normal), then falls
// back to Cardmarket's average (EUR) if TCGplayer has nothing.
function pickPrice(card, printingHint) {
  const pricing = card.pricing;
  if (!pricing) return null;

  const tp = pricing.tcgplayer;
  if (tp) {
    const hint = (printingHint || '').toLowerCase();
    const order = hint.includes('reverse')
      ? ['reverseHolofoil', 'reverse', 'holofoil', 'normal', '1stEditionHolofoil', '1stEdition']
      : hint.includes('1st') || hint.includes('edition')
        ? ['1stEditionHolofoil', '1stEdition', 'holofoil', 'normal', 'reverseHolofoil', 'reverse']
        : hint.includes('holo')
          ? ['holofoil', 'reverseHolofoil', 'normal', 'reverse', '1stEditionHolofoil', '1stEdition']
          : ['normal', 'holofoil', 'reverseHolofoil', 'reverse', '1stEditionHolofoil', '1stEdition'];
    for (const variantKey of order) {
      const v = tp[variantKey];
      const amount = v?.marketPrice ?? v?.midPrice ?? v?.lowPrice;
      if (typeof amount === 'number') {
        return { amount, currency: tp.unit || 'USD', source: 'TCGplayer' };
      }
    }
  }

  const cm = pricing.cardmarket;
  if (cm) {
    const wantsHolo = /holo|reverse|1st|edition/i.test(printingHint || '');
    const amount = wantsHolo
      ? (cm['avg-holo'] ?? cm.avg ?? cm['trend-holo'] ?? cm.trend)
      : (cm.avg ?? cm.trend ?? cm['avg-holo'] ?? cm['trend-holo']);
    if (typeof amount === 'number') {
      return { amount, currency: cm.unit || 'EUR', source: 'Cardmarket' };
    }
  }
  return null;
}

// Searches TCGdex by name, then narrows to the identified collector number
// when we have one, then fetches full card details (pricing only lives on
// the single-card endpoint, not the search results) for a handful of
// candidates until one actually resolves to a price.
export async function searchTCGdex({ name, number, printing } = {}) {
  const candidates = await tcgdexFetch(`/en/cards?name=${encodeURIComponent(name)}`);
  if (!candidates || candidates.length === 0) return null;

  let shortlist = candidates;
  const wantedNumber = normalizeNumber(number);
  if (wantedNumber) {
    const byNumber = candidates.filter((c) => normalizeNumber(c.localId) === wantedNumber);
    if (byNumber.length > 0) shortlist = byNumber;
  }

  for (const candidate of shortlist.slice(0, 5)) {
    const full = await tcgdexFetch(`/en/cards/${candidate.id}`);
    if (!full) continue;
    const price = pickPrice(full, printing);
    if (price) {
      return {
        name: full.name,
        set: full.set?.name || null,
        number: full.localId,
        ...price, // { amount, currency, source }
      };
    }
  }
  return null;
}

const rateCache = new Map(); // currency -> { rate, fetchedAt } — rates barely move minute to minute
const RATE_CACHE_MS = 5 * 60 * 1000;

export async function convertToAud(amount, fromCurrency) {
  if (fromCurrency === 'AUD') return { aud: amount, rate: 1 };
  const cached = rateCache.get(fromCurrency);
  if (cached && Date.now() - cached.fetchedAt < RATE_CACHE_MS) {
    return { aud: amount * cached.rate, rate: cached.rate };
  }
  const res = await fetch(`https://api.frankfurter.app/latest?from=${fromCurrency}&to=AUD`);
  if (!res.ok) throw new Error(`Currency conversion API error ${res.status}`);
  const data = await res.json();
  const rate = data?.rates?.AUD;
  if (typeof rate !== 'number') throw new Error(`Currency conversion API returned no AUD rate for ${fromCurrency}`);
  rateCache.set(fromCurrency, { rate, fetchedAt: Date.now() });
  return { aud: amount * rate, rate };
}

// The full pipeline. Never throws for a partial success — e.g. if
// identification and the TCGdex lookup both succeed but the currency
// conversion fails, it still returns the original-currency price with
// `audError` set, rather than discarding a result the first two (harder)
// steps produced.
export async function lookupCardPriceAtTime(state, { geminiApiKey, at }, { onProgress } = {}) {
  onProgress && onProgress('Looking at the frame...');
  const card = await identifyCardWithGemini(state, geminiApiKey, at);

  onProgress && onProgress(`Identified "${card.name}" — checking TCGdex...`);
  const listing = await searchTCGdex({ name: card.name, number: card.number || undefined, printing: card.printing });
  if (!listing) {
    throw new Error(`Identified "${card.name}"${card.set ? ` (${card.set})` : ''}, but TCGdex has no priced listing for it.`);
  }

  const result = { card, listing };
  onProgress && onProgress(`Converting ${listing.currency} to AUD...`);
  try {
    const { aud, rate } = await convertToAud(listing.amount, listing.currency);
    result.priceAud = aud;
    result.rate = rate;
  } catch (err) {
    result.audError = err.message;
  }
  return result;
}
