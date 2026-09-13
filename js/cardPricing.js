import { seekTo } from './autoCut.js';
import { callGemini } from './geminiClient.js';

// "Identify the trading card on screen, look up what it's worth, show the
// price" — a small pipeline chaining three independent services:
//   1. Gemini vision: what card is this?
//   2. JustTCG (https://justtcg.com): what does that card sell for (USD)?
//   3. Frankfurter (ECB rates, no key needed): USD -> AUD.
// Each step can fail independently (no confident ID, no market match, rate
// service down) — lookupCardPriceAtTime() reports exactly which step got
// how far rather than an opaque single failure, and still returns a USD
// price if only the currency conversion step fails.

const JUSTTCG_BASE = 'https://api.justtcg.com/v1';
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
    maxOutputTokens: 512,
  });
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (!objectMatch) throw new Error(`Gemini gave an unusable response: "${raw.slice(0, 150)}"`);
  const result = JSON.parse(objectMatch[0]);
  if (!result.identified || !result.name) {
    throw new Error(result.notes || 'Gemini could not confidently identify a card in this frame.');
  }
  return result;
}

// Picks a representative price from a JustTCG card's variants: prefers
// Near Mint / unlisted condition (the typical "market price" a casual user
// means), falling back to whichever variant actually has a price.
function pickVariant(card) {
  const priced = (card.variants || []).filter((v) => typeof v.price === 'number');
  if (priced.length === 0) return null;
  const nearMint = priced.find((v) => /near mint|^nm$/i.test(v.condition || ''));
  return nearMint || priced.sort((a, b) => b.price - a.price)[0];
}

export async function searchJustTCG(apiKey, { name, game = 'Pokemon', number } = {}) {
  const params = new URLSearchParams({ q: name, game, limit: '10' });
  if (number) params.set('number', number);
  const res = await fetch(`${JUSTTCG_BASE}/cards?${params.toString()}`, {
    headers: { 'x-api-key': apiKey },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`JustTCG API error ${res.status}: ${body?.error || res.statusText}`);
  }
  if (body?.error) throw new Error(`JustTCG: ${body.error}`);
  const cards = body?.data || [];
  if (cards.length === 0) return null;

  // If a set/number was identified, prefer an exact-ish match; otherwise
  // just take the best-priced first result (JustTCG's default ordering).
  const card = cards[0];
  const variant = pickVariant(card);
  if (!variant) return null;
  return {
    name: card.name,
    set: card.set_name || card.set,
    number: card.number,
    condition: variant.condition,
    printing: variant.printing,
    priceUsd: variant.price,
  };
}

let cachedRate = null; // { rate, fetchedAt } — USD->AUD barely moves minute to minute
const RATE_CACHE_MS = 5 * 60 * 1000;

export async function convertUsdToAud(usd) {
  if (cachedRate && Date.now() - cachedRate.fetchedAt < RATE_CACHE_MS) {
    return { aud: usd * cachedRate.rate, rate: cachedRate.rate };
  }
  const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=AUD');
  if (!res.ok) throw new Error(`Currency conversion API error ${res.status}`);
  const data = await res.json();
  const rate = data?.rates?.AUD;
  if (typeof rate !== 'number') throw new Error('Currency conversion API returned no AUD rate');
  cachedRate = { rate, fetchedAt: Date.now() };
  return { aud: usd * rate, rate };
}

// The full pipeline. Never throws for a partial success — e.g. if
// identification and the JustTCG lookup both succeed but the currency
// conversion fails, it still returns the USD price with `audError` set,
// rather than discarding a result the first two (harder) steps produced.
export async function lookupCardPriceAtTime(state, { geminiApiKey, justtcgApiKey, at }, { onProgress } = {}) {
  onProgress && onProgress('Looking at the frame...');
  const card = await identifyCardWithGemini(state, geminiApiKey, at);

  onProgress && onProgress(`Identified "${card.name}" — checking JustTCG...`);
  const listing = await searchJustTCG(justtcgApiKey, { name: card.name, number: card.number || undefined });
  if (!listing) {
    throw new Error(`Identified "${card.name}"${card.set ? ` (${card.set})` : ''}, but JustTCG has no priced listing for it.`);
  }

  const result = { card, listing, priceUsd: listing.priceUsd };
  onProgress && onProgress('Converting to AUD...');
  try {
    const { aud, rate } = await convertUsdToAud(listing.priceUsd);
    result.priceAud = aud;
    result.rate = rate;
  } catch (err) {
    result.audError = err.message;
  }
  return result;
}
