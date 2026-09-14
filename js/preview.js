import { PROJECT } from './state.js';
import { clamp } from './utils.js';

export class Preview {
  constructor(state, canvas) {
    this.state = state;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.canvas.width = PROJECT.width;
    this.canvas.height = PROJECT.height;

    this.video = document.createElement('video');
    this.video.muted = false;
    this.video.playsInline = true;
    this.activeClipId = null;
    this.activeUrl = null;
    this._loading = false;

    this.rafId = null;
    this.onTimeUpdate = null; // callback(globalTime)

    this._tick = this._tick.bind(this);
  }

  start() {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(this._tick);
  }

  stop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  async play() {
    this.state.playing = true;
    await this._ensureClipLoaded();
    if (this.video.src) {
      try { await this.video.play(); } catch {}
    }
    this.start();
  }

  pause() {
    this.state.playing = false;
    this.video.pause();
  }

  async seek(globalTime) {
    const total = this.state.totalDuration();
    this.state.playhead = clamp(globalTime, 0, total);
    await this._ensureClipLoaded(true);
    this.renderFrame();
  }

  async _ensureClipLoaded(forceSeek = false) {
    const loc = this.state.locateTime(this.state.playhead);
    if (!loc) return;
    const { clip, localTime } = loc;
    const sourceTime = clip.inPoint + localTime * clip.speed;

    if (this.activeUrl !== clip.url) {
      // A genuinely different source file — full reload, with a brief
      // window where video.currentTime is meaningless (src just changed,
      // metadata not loaded yet). _tick() checks `_loading` to avoid
      // computing a bogus/backwards playhead from the video during this.
      this.activeClipId = clip.id;
      this.activeUrl = clip.url;
      this._loading = true;
      this.video.src = clip.url;
      this.video.playbackRate = clip.speed || 1;
      await new Promise((resolve) => {
        const onReady = () => {
          this.video.removeEventListener('loadedmetadata', onReady);
          resolve();
        };
        this.video.addEventListener('loadedmetadata', onReady);
      });
      this.video.currentTime = sourceTime;
      this._loading = false;
      if (this.state.playing) {
        try { await this.video.play(); } catch {}
      }
    } else if (this.activeClipId !== clip.id) {
      // Same underlying source as before (e.g. two clips produced by a
      // split share one file) — just retarget which region we're playing,
      // no src reassignment/reload/metadata wait needed.
      this.activeClipId = clip.id;
      this.video.currentTime = sourceTime;
      this.video.playbackRate = clip.speed || 1;
    } else if (forceSeek || Math.abs(this.video.currentTime - sourceTime) > 0.15) {
      this.video.currentTime = sourceTime;
      this.video.playbackRate = clip.speed || 1;
    }
  }

  _tick() {
    if (this.state.playing) {
      if (!this._loading) {
        const loc = this.state.locateTime(this.state.playhead);
        if (loc) {
          const globalNow = loc.clipStart + (this.video.currentTime - loc.clip.inPoint) / (loc.clip.speed || 1);
          this.state.playhead = globalNow;
          // Roll over to next clip once the current one is exhausted.
          if (this.video.currentTime >= loc.clip.outPoint - 0.02) {
            const total = this.state.totalDuration();
            if (loc.clipStart + loc.clipDuration >= total - 0.02) {
              this.pause();
              this.state.playhead = total;
            } else {
              this._ensureClipLoaded();
            }
          }
        }
      }
      this.onTimeUpdate && this.onTimeUpdate(this.state.playhead);
    }
    this.renderFrame();
    this.rafId = requestAnimationFrame(this._tick);
  }

  renderFrame() {
    const { ctx, canvas } = this;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const loc = this.state.locateTime(this.state.playhead);
    if (loc && this.video.readyState >= 2 && this.activeClipId === loc.clip.id) {
      this._drawZoomedFrame(loc.clip, loc.localTime);
    }
    this._drawOverlays(this.state.playhead);
  }

  _drawZoomedFrame(clip, localTime) {
    const { ctx, canvas, video } = this;
    const zoom = this.state.activeZoomFor(clip.id, localTime);
    const vw = video.videoWidth || canvas.width;
    const vh = video.videoHeight || canvas.height;

    let scale = 1, fx = 50, fy = 50;
    if (zoom) {
      const t = clamp((localTime - zoom.start) / Math.max(0.001, zoom.end - zoom.start), 0, 1);
      scale = zoom.fromScale + (zoom.toScale - zoom.fromScale) * t;
      fx = zoom.fromX + (zoom.toX - zoom.fromX) * t;
      fy = zoom.fromY + (zoom.toY - zoom.fromY) * t;
    }

    const cropW = vw / scale;
    const cropH = vh / scale;
    let sx = (fx / 100) * vw - cropW / 2;
    let sy = (fy / 100) * vh - cropH / 2;
    sx = clamp(sx, 0, Math.max(0, vw - cropW));
    sy = clamp(sy, 0, Math.max(0, vh - cropH));

    // Letterbox to fit the project aspect ratio inside the canvas.
    const targetAspect = canvas.width / canvas.height;
    const cropAspect = cropW / cropH;
    let dw = canvas.width, dh = canvas.height, dx = 0, dy = 0;
    if (cropAspect > targetAspect) {
      dh = canvas.width / cropAspect;
      dy = (canvas.height - dh) / 2;
    } else {
      dw = canvas.height * cropAspect;
      dx = (canvas.width - dw) / 2;
    }
    ctx.drawImage(video, sx, sy, cropW, cropH, dx, dy, dw, dh);
  }

  _drawOverlays(globalTime) {
    const { ctx, canvas } = this;
    for (const o of this.state.activeTextOverlays(globalTime)) {
      const localT = globalTime - o.start;
      const dur = o.end - o.start;
      let alpha = 1, offsetX = 0;
      const fadeWindow = Math.min(0.3, dur / 2);
      if (o.animation === 'fade') {
        if (localT < fadeWindow) alpha = localT / fadeWindow;
        else if (dur - localT < fadeWindow) alpha = (dur - localT) / fadeWindow;
      } else if (o.animation === 'slide') {
        const slideWindow = Math.min(0.4, dur / 2);
        if (localT < slideWindow) offsetX = (1 - localT / slideWindow) * 60;
      }

      ctx.save();
      ctx.globalAlpha = clamp(alpha, 0, 1);
      ctx.font = `${o.bold ? 'bold' : ''} ${o.fontSize}px ${o.fontFamily}`.trim();
      ctx.textAlign = o.align;
      ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(2, o.fontSize / 12);
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.fillStyle = o.color;
      const x = (o.x / 100) * canvas.width + offsetX;
      const y = (o.y / 100) * canvas.height;
      ctx.strokeText(o.text, x, y);
      ctx.fillText(o.text, x, y);
      ctx.restore();
    }
  }
}
