import { el, formatTime, clamp } from './utils.js';

const PIXELS_PER_SECOND = 60;

export class Timeline {
  constructor(state, container, { onSeek, onSelect } = {}) {
    this.state = state;
    this.container = container;
    this.onSeek = onSeek || (() => {});
    this.onSelect = onSelect || (() => {});
    this.zoom = 1;
    this.render();
  }

  pxPerSecond() {
    return PIXELS_PER_SECOND * this.zoom;
  }

  render() {
    const { state, container } = this;
    container.innerHTML = '';
    const total = Math.max(state.totalDuration(), 1);
    const pps = this.pxPerSecond();
    const width = total * pps + 40;

    const ruler = el('div', { class: 'timeline-ruler', style: `width:${width}px` });
    for (let s = 0; s <= total; s += 1) {
      const tick = el('div', {
        class: s % 5 === 0 ? 'tick tick-major' : 'tick',
        style: `left:${s * pps}px`,
      });
      if (s % 5 === 0) tick.appendChild(el('span', { class: 'tick-label', text: formatTime(s, false) }));
      ruler.appendChild(tick);
    }

    const track = el('div', { class: 'clip-track', style: `width:${width}px` });
    let acc = 0;
    state.clips.forEach((clip, idx) => {
      const dur = state.clipDuration(clip);
      const clipEl = this._renderClip(clip, idx, acc, dur, pps);
      track.appendChild(clipEl);
      acc += dur;
    });

    const overlayTrack = el('div', { class: 'overlay-track', style: `width:${width}px` });
    for (const o of state.textOverlays) {
      overlayTrack.appendChild(this._renderOverlayChip(o, pps));
    }

    const zoomTrack = el('div', { class: 'zoom-track', style: `width:${width}px` });
    for (const z of state.zoomKeyframes) {
      const start = state.clipGlobalStart(z.clipId) + z.start;
      zoomTrack.appendChild(
        el('div', {
          class: 'zoom-chip',
          style: `left:${start * pps}px;width:${(z.end - z.start) * pps}px`,
          text: `🔍 ${z.fromScale.toFixed(1)}→${z.toScale.toFixed(1)}x`,
          title: 'Zoom keyframe',
          onclick: () => this.onSelect('zoom', z.id),
        })
      );
    }

    const playhead = el('div', {
      class: 'playhead',
      style: `left:${state.playhead * pps}px;height:${40 + 28 + 24 + 12}px`,
    });

    const wrapper = el('div', { class: 'timeline-scroll-inner', style: `width:${width}px` }, [
      ruler,
      track,
      overlayTrack,
      zoomTrack,
      playhead,
    ]);
    wrapper.addEventListener('click', (e) => {
      if (e.target === wrapper || e.target === ruler || e.target === track) {
        const rect = wrapper.getBoundingClientRect();
        const t = (e.clientX - rect.left) / pps;
        this.onSeek(clamp(t, 0, total));
      }
    });
    container.appendChild(wrapper);
  }

  _renderClip(clip, idx, start, dur, pps) {
    const isSelected = this.state.selection.type === 'clip' && this.state.selection.id === clip.id;
    const clipEl = el(
      'div',
      {
        class: `clip-block${isSelected ? ' selected' : ''}`,
        style: `left:${start * pps}px;width:${dur * pps}px`,
        draggable: 'true',
        'data-clip-id': clip.id,
      },
      [
        el('div', { class: 'clip-label', text: `${idx + 1}. ${clip.name}` }),
        el('div', { class: 'trim-handle trim-left' }),
        el('div', { class: 'trim-handle trim-right' }),
      ]
    );

    clipEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onSelect('clip', clip.id);
    });

    this._wireDrag(clipEl, clip);
    this._wireTrim(clipEl, clip, pps);
    return clipEl;
  }

  _wireDrag(clipEl, clip) {
    clipEl.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/clip-id', clip.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    clipEl.addEventListener('dragover', (e) => e.preventDefault());
    clipEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const draggedId = e.dataTransfer.getData('text/clip-id');
      if (!draggedId || draggedId === clip.id) return;
      const targetIndex = this.state.clips.findIndex((c) => c.id === clip.id);
      this.state.reorderClip(draggedId, targetIndex);
    });
  }

  _wireTrim(clipEl, clip, pps) {
    const startDrag = (handle, isLeft) => {
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const startX = e.clientX;
        const startIn = clip.inPoint;
        const startOut = clip.outPoint;
        const onMove = (ev) => {
          const deltaSeconds = (ev.clientX - startX) / pps;
          if (isLeft) {
            this.state.trimClip(clip.id, { inPoint: startIn + deltaSeconds * clip.speed });
          } else {
            this.state.trimClip(clip.id, { outPoint: startOut + deltaSeconds * clip.speed });
          }
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    };
    startDrag(clipEl.querySelector('.trim-left'), true);
    startDrag(clipEl.querySelector('.trim-right'), false);
  }

  _renderOverlayChip(overlay, pps) {
    const isSelected = this.state.selection.type === 'text' && this.state.selection.id === overlay.id;
    const chip = el('div', {
      class: `overlay-chip${isSelected ? ' selected' : ''}`,
      style: `left:${overlay.start * pps}px;width:${Math.max(20, (overlay.end - overlay.start) * pps)}px`,
      text: `🅣 ${overlay.text.slice(0, 16)}`,
      title: overlay.text,
      onclick: (e) => {
        e.stopPropagation();
        this.onSelect('text', overlay.id);
      },
    });
    return chip;
  }
}
