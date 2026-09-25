// DOM ヘルパー・ダイアログ・トースト・アイコン

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, String(sv)); else el.style[sk] = sv;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- アイコン（線画SVG） ----------
const P = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5"/><path d="M8 7h7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  child: '<path d="M6 4v8a4 4 0 0 0 4 4h9"/><path d="m15 12 4 4-4 4"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  outdent: '<path d="M21 6H11M21 12H11M21 18H11"/><path d="m7 8-4 4 4 4"/>',
  indent: '<path d="M21 6H11M21 12H11M21 18H11"/><path d="m3 8 4 4-4 4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  note: '<path d="M5 3h10l4 4v14H5z"/><path d="M14 3v5h5M8 13h8M8 17h5"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>',
  template: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  cloud: '<path d="M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19.5 10 4 4 0 0 1 18 18z"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  prev: '<path d="m15 18-6-6 6-6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
};
export function icon(name, size = 20) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}
export function iconBtn(name, title, onclick, extra = {}) {
  return h('button', { type: 'button', class: 'icon-btn ' + (extra.class || ''), title, 'aria-label': title, html: icon(name), onclick, ...extra.attrs });
}

// ---------- トースト ----------
let toastTimer = null;
export function toast(msg, { action = null, actionLabel = '', ms = 3500 } = {}) {
  const el = $('#toast');
  el.innerHTML = '';
  el.append(h('span', {}, msg));
  if (action) el.append(h('button', { type: 'button', class: 'link', onclick: () => { el.classList.remove('show'); action(); } }, actionLabel));
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ---------- モーダル ----------
const stack = [];
/**
 * modal({title, body: Node|Node[], buttons:[{label, value, primary, danger}], wide, onOpen})
 * → Promise<value>（閉じたら null）
 */
export function modal({ title, body, buttons = [{ label: '閉じる', value: null }], wide = false, full = false, onOpen = null, className = '' }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const close = (v) => {
      back.remove();
      stack.splice(stack.indexOf(close), 1);
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.focus) try { prevFocus.focus({ preventScroll: true }); } catch { /* noop */ }
      resolve(v);
    };
    const onKey = (e) => {
      if (stack[stack.length - 1] !== close) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
    };
    const foot = h('div', { class: 'modal-foot' },
      buttons.map((b) => h('button', {
        type: 'button',
        class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''),
        onclick: async () => {
          if (b.validate && !(await b.validate())) return;
          close(typeof b.value === 'function' ? b.value() : b.value);
        },
      }, b.label)));
    const dlg = h('div', { class: `modal ${wide ? 'wide' : ''} ${full ? 'full' : ''} ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', {}, title), iconBtn('close', '閉じる', () => close(null))),
      h('div', { class: 'modal-body' }, body),
      buttons.length ? foot : null);
    const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) back.dataset.down = '1'; }, onclick: (e) => { if (e.target === back && back.dataset.down) close(null); } }, dlg);
    $('#modal-root').append(back);
    stack.push(close);
    document.addEventListener('keydown', onKey, true);
    dlg._close = close;
    if (onOpen) onOpen(dlg, close);
    else {
      const f = dlg.querySelector('input, textarea, select, .btn.primary');
      if (f) setTimeout(() => f.focus(), 30);
    }
  });
}

export function confirmDialog(message, { ok = 'OK', cancel = 'キャンセル', danger = false, title = '確認', extra = null } = {}) {
  return modal({
    title,
    body: [h('p', { class: 'pre' }, message), extra].filter(Boolean),
    buttons: [{ label: cancel, value: false }, { label: ok, value: true, primary: !danger, danger }],
  }).then((v) => !!v);
}

export function promptDialog(message, def = '', { title = '入力', ok = 'OK', placeholder = '' } = {}) {
  const input = h('input', { type: 'text', value: def, placeholder, class: 'input' });
  return modal({
    title,
    body: [h('label', { class: 'field' }, h('span', {}, message), input)],
    buttons: [{ label: 'キャンセル', value: null }, { label: ok, value: () => input.value, primary: true }],
    onOpen: (dlg, close) => {
      setTimeout(() => { input.focus(); input.select(); }, 30);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); close(input.value); } });
    },
  });
}

export function radioGroup(name, options, value, onchange) {
  return h('div', { class: 'radios' }, options.map(([v, label, hint]) =>
    h('label', { class: 'radio' },
      h('input', { type: 'radio', name, value: v, checked: v === value, onchange: () => onchange && onchange(v) }),
      h('span', {}, label, hint ? h('small', { class: 'muted' }, ' ' + hint) : null))));
}
export function radioValue(root, name) {
  const el = root.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : null;
}
export function checkbox(label, checked, onchange, attrs = {}) {
  const input = h('input', { type: 'checkbox', checked, onchange: (e) => onchange && onchange(e.target.checked), ...attrs });
  return h('label', { class: 'check' }, input, h('span', {}, label));
}

export function isMobile() { return window.matchMedia('(max-width: 799px)').matches; }
export function isMac() { return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent); }
