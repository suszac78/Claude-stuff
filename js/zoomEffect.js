import { el } from './utils.js';

export class ZoomEffectPanel {
  constructor(state, container, { onChange } = {}) {
    this.state = state;
    this.container = container;
    this.onChange = onChange || (() => {});
  }

  renderEmpty() {
    this.container.innerHTML = '';
    this.container.appendChild(
      el('div', { class: 'panel-hint', text: 'Select a clip and click "Add Zoom" to create a Ken Burns keyframe on it.' })
    );
  }

  renderFor(zoomId) {
    const z = this.state.zoomKeyframes.find((x) => x.id === zoomId);
    if (!z) return this.renderEmpty();
    this.container.innerHTML = '';

    const update = (patch) => {
      this.state.updateZoomKeyframe(z.id, patch);
      this.onChange();
    };
    const num = (value, step, onChange) => {
      const input = el('input', { type: 'number', step: String(step), oninput: (e) => onChange(parseFloat(e.target.value) || 0) });
      input.value = value;
      return input;
    };
    const row = (label, inputEl) => el('div', { class: 'field-row' }, [el('label', { text: label }), inputEl]);

    this.container.append(
      el('div', { class: 'panel-hint', text: 'Times are relative to the start of this clip.' }),
      row('Start (s)', num(z.start, 0.1, (v) => update({ start: v }))),
      row('End (s)', num(z.end, 0.1, (v) => update({ end: v }))),
      row('From scale', num(z.fromScale, 0.05, (v) => update({ fromScale: v }))),
      row('To scale', num(z.toScale, 0.05, (v) => update({ toScale: v }))),
      row('From focal X %', num(z.fromX, 1, (v) => update({ fromX: v }))),
      row('From focal Y %', num(z.fromY, 1, (v) => update({ fromY: v }))),
      row('To focal X %', num(z.toX, 1, (v) => update({ toX: v }))),
      row('To focal Y %', num(z.toY, 1, (v) => update({ toY: v }))),
      el('button', {
        class: 'btn btn-danger',
        text: 'Delete zoom',
        onclick: () => {
          this.state.removeZoomKeyframe(z.id);
          this.state.selection = { type: null, id: null };
          this.onChange();
        },
      })
    );
  }
}
