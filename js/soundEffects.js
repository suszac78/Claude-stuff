// Sound effects: a handful of common SFX synthesized procedurally via the
// Web Audio API (no licensing/sourcing concerns, zero asset weight), plus
// support for a user-uploaded custom sound. Shared by the live preview
// player and the export pipeline so "what you hear" and "what gets
// exported" are guaranteed to use the identical rendered audio.

export const BUILTIN_EFFECTS = [
  { id: 'beep', label: '🔔 Beep', duration: 0.16 },
  { id: 'pop', label: '🫧 Pop', duration: 0.11 },
  { id: 'whoosh', label: '💨 Whoosh', duration: 0.4 },
  { id: 'ding', label: '✨ Ding', duration: 0.9 },
  { id: 'drumroll', label: '🥁 Drumroll', duration: 1.2 },
  { id: 'shutter', label: '📸 Camera Shutter', duration: 0.18 },
];

function whiteNoiseBuffer(ctx, duration) {
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * duration)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function noiseBurst(ctx, dest, when, durationSec, gainValue, highpassHz = 1200) {
  const src = ctx.createBufferSource();
  src.buffer = whiteNoiseBuffer(ctx, durationSec);
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = highpassHz;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(gainValue, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + durationSec);
  src.connect(filter).connect(gain).connect(dest);
  src.start(when);
}

// Each synth function renders directly into an OfflineAudioContext ending
// at ctx.destination; SYNTH[id](ctx) is called, then the caller renders it.
const SYNTH = {
  beep(ctx) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 880;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, 0);
    gain.gain.exponentialRampToValueAtTime(0.8, 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start(0);
    osc.stop(0.16);
  },
  pop(ctx) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1300, 0);
    osc.frequency.exponentialRampToValueAtTime(90, 0.09);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.9, 0);
    gain.gain.exponentialRampToValueAtTime(0.001, 0.1);
    osc.connect(gain).connect(ctx.destination);
    osc.start(0);
    osc.stop(0.11);
  },
  whoosh(ctx) {
    const duration = 0.4;
    const src = ctx.createBufferSource();
    src.buffer = whiteNoiseBuffer(ctx, duration);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1;
    filter.frequency.setValueAtTime(300, 0);
    filter.frequency.linearRampToValueAtTime(3000, duration * 0.5);
    filter.frequency.linearRampToValueAtTime(300, duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, 0);
    gain.gain.linearRampToValueAtTime(0.7, duration * 0.25);
    gain.gain.linearRampToValueAtTime(0.0001, duration);
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(0);
  },
  ding(ctx) {
    const duration = 0.9;
    const master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(ctx.destination);
    const partials = [1318.5, 2637, 3956];
    partials.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.6 / (i + 1), 0);
      gain.gain.exponentialRampToValueAtTime(0.001, duration);
      osc.connect(gain).connect(master);
      osc.start(0);
      osc.stop(duration);
    });
  },
  drumroll(ctx) {
    const duration = 1.2;
    const master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    let t = 0;
    let interval = 0.09;
    while (t < duration - 0.1) {
      noiseBurst(ctx, master, t, 0.06, 0.4, 1500);
      t += interval;
      interval *= 0.93; // accelerating roll
    }
    noiseBurst(ctx, master, duration - 0.08, 0.08, 0.9, 1000); // final accent hit
  },
  shutter(ctx) {
    noiseBurst(ctx, ctx.destination, 0, 0.02, 0.9, 2500);
    noiseBurst(ctx, ctx.destination, 0.07, 0.03, 0.6, 1800);
  },
};

function durationFor(effectId) {
  return BUILTIN_EFFECTS.find((e) => e.id === effectId)?.duration ?? 0.3;
}

const SAMPLE_RATE = 44100;
const renderCache = new Map();

export async function synthesizeEffect(effectId) {
  if (renderCache.has(effectId)) return renderCache.get(effectId);
  const duration = durationFor(effectId);
  const ctx = new OfflineAudioContext(1, Math.ceil(SAMPLE_RATE * duration), SAMPLE_RATE);
  const synth = SYNTH[effectId];
  if (!synth) throw new Error(`unknown built-in effect "${effectId}"`);
  synth(ctx);
  const buffer = await ctx.startRendering();
  renderCache.set(effectId, buffer);
  return buffer;
}

// Resolves any sound-effect state object (built-in or custom upload) to a
// decoded AudioBuffer, used identically by the live preview player and the
// export pipeline so both hear/render the exact same audio.
export async function resolveEffectBuffer(sfx, audioContext) {
  if (sfx.kind === 'builtin') return synthesizeEffect(sfx.effect);
  const res = await fetch(sfx.url);
  const arrayBuffer = await res.arrayBuffer();
  return audioContext.decodeAudioData(arrayBuffer);
}

// Schedules sound effects against the live preview during playback. Kept
// deliberately simple: each effect fires once per play session, scheduled
// a fraction of a second ahead of when it's due so the browser's audio
// clock (not just the rAF-driven video clock) determines exact timing.
export class SoundEffectPlayer {
  constructor(state) {
    this.state = state;
    this.ctx = null;
    this.scheduledIds = new Set();
  }

  ensureContext() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    return this.ctx;
  }

  resetScheduling() {
    this.scheduledIds.clear();
  }

  // Call every animation frame while playing, with the current global
  // playhead time in seconds.
  tick(playhead) {
    const ctx = this.ensureContext();
    for (const sfx of this.state.soundEffects) {
      if (this.scheduledIds.has(sfx.id)) continue;
      const delta = sfx.start - playhead;
      if (delta < -0.5) {
        this.scheduledIds.add(sfx.id); // already passed this session; don't fire late
        continue;
      }
      if (delta <= 0.25) {
        this.scheduledIds.add(sfx.id);
        resolveEffectBuffer(sfx, ctx)
          .then((buffer) => {
            const src = ctx.createBufferSource();
            src.buffer = buffer;
            const gain = ctx.createGain();
            gain.gain.value = sfx.volume ?? 1;
            src.connect(gain).connect(ctx.destination);
            src.start(ctx.currentTime + Math.max(0, delta));
          })
          .catch((err) => console.error('Sound effect playback failed:', err));
      }
    }
  }
}

// Encodes an AudioBuffer as a 16-bit PCM stereo WAV Blob — always stereo
// (mono sources are duplicated to both channels) so every effect mixes
// cleanly against the video's stereo audio track during export.
export function audioBufferToWav(buffer) {
  const numChannels = 2;
  const sampleRate = buffer.sampleRate;
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const length = left.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = length * blockAlign;
  const bufferOut = new ArrayBuffer(44 + dataSize);
  const view = new DataView(bufferOut);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < length; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    offset += 2;
    view.setInt16(offset, r < 0 ? r * 0x8000 : r * 0x7fff, true);
    offset += 2;
  }
  return new Blob([bufferOut], { type: 'audio/wav' });
}
