import { el } from './utils.js';

const FONTS = ['Inter, Arial, sans-serif', 'Georgia, serif', '"Courier New", monospace', '"Comic Sans MS", cursive'];

export class TextOverlayPanel {
  constructor(state, container, { onChange } = {}) {
    this.state = state;
    this.container = container;
    this.onChange = onChange || (() => {});
  }

  renderEmpty() {
    this.container.innerHTML = '';
    this.container.appendChild(
      el('div', { class: 'panel-hint', text: 'Select a text clip on the timeline, or click "Add Text" to create one.' })
    );
  }

  renderFor(overlayId) {
    const o = this.state.textOverlays.find((x) => x.id === overlayId);
    if (!o) return this.renderEmpty();
    this.container.innerHTML = '';

    const update = (patch) => {
      this.state.updateTextOverlay(o.id, patch);
      this.onChange();
    };

    const textArea = el('textarea', {
      class: 'field-textarea',
      rows: '2',
      oninput: (e) => update({ text: e.target.value }),
    });
    textArea.value = o.text;

    this.container.append(
      el('label', { text: 'Text' }),
      textArea,
      this._row('Start', this._numberInput(o.start, 0.01, (v) => update({ start: v }))),
      this._row('End', this._numberInput(o.end, 0.01, (v) => update({ end: v }))),
      this._row('Font size', this._numberInput(o.fontSize, 1, (v) => update({ fontSize: v }))),
      this._row('Color', this._colorInput(o.color, (v) => update({ color: v }))),
      this._row('Font', this._select(FONTS, o.fontFamily, (v) => update({ fontFamily: v }))),
      this._row('X %', this._numberInput(o.x, 1, (v) => update({ x: v }))),
      this._row('Y %', this._numberInput(o.y, 1, (v) => update({ y: v }))),
      this._row('Align', this._select(['left', 'center', 'right'], o.align, (v) => update({ align: v }))),
      this._row('Animation', this._select(['none', 'fade', 'slide'], o.animation, (v) => update({ animation: v }))),
      this._row('Bold', this._checkbox(o.bold, (v) => update({ bold: v }))),
      el('button', {
        class: 'btn btn-danger',
        text: 'Delete overlay',
        onclick: () => {
          this.state.removeTextOverlay(o.id);
          this.state.selection = { type: null, id: null };
          this.onChange();
        },
      })
    );
  }

  _row(label, inputEl) {
    return el('div', { class: 'field-row' }, [el('label', { text: label }), inputEl]);
  }

  _numberInput(value, step, onChange) {
    const input = el('input', { type: 'number', step: String(step), oninput: (e) => onChange(parseFloat(e.target.value) || 0) });
    input.value = value;
    return input;
  }

  _colorInput(value, onChange) {
    const input = el('input', { type: 'color', oninput: (e) => onChange(e.target.value) });
    input.value = value;
    return input;
  }

  _checkbox(checked, onChange) {
    const input = el('input', { type: 'checkbox', onchange: (e) => onChange(e.target.checked) });
    input.checked = checked;
    return input;
  }

  _select(options, value, onChange) {
    const select = el(
      'select',
      { onchange: (e) => onChange(e.target.value) },
      options.map((opt) => el('option', { value: opt, text: opt }))
    );
    select.value = value;
    return select;
  }
}
