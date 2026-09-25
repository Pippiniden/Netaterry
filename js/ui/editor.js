// 編集モード: タイトル・タグ・本文・サイドメモ・特殊文字点検・検索ナビ
import { store } from '../store.js';
import { suggestTags, canonicalTag, tagKey, cleanTag, addTagsTo } from '../tags.js';
import { search } from '../search.js';
import { h, $, icon, iconBtn, modal, isMobile, toast } from './dom.js';
import { ctx } from './ctx.js';
import { nodeOpButtons, removeSelected } from './tree.js';
import { applyTemplateTo } from './templates.js';
import { sanitizeTitle, escapeHtml } from '../util.js';

let els = null;       // 現在のエディタ要素
let curId = null;

const pane = () => $('#pane-editor');

export function currentEditorId() { return curId; }

export function renderEditor() {
  const id = store.ui.selectedId;
  const n = id && store.get(id);
  const p = pane();
  if (!n || n.deleted) {
    curId = null;
    els = null;
    p.innerHTML = '';
    p.append(h('div', { class: 'ed-empty' },
      h('p', {}, 'ノードを選択してください'),
      h('p', { class: 'muted' }, store.children(null).length ? '左のツリーから選ぶと、ここで編集できます。' : '「＋」でノードを追加できます。')));
    renderSideNote();
    return;
  }
  if (curId === id && els) { refreshEditor(); return; }
  curId = id;
  p.innerHTML = '';

  const title = h('input', { class: 'ed-title', type: 'text', placeholder: '無題', value: n.title, 'aria-label': 'タイトル', enterkeyhint: 'next' });
  title.addEventListener('input', () => {
    const v = sanitizeTitle(title.value);
    store.batch('タイトル編集', (tx) => tx.update(id, { title: v }), { coalesce: 'title:' + id });
  });
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); els.body.focus(); els.body.setSelectionRange(0, 0); }
  });

  const body = h('textarea', { class: 'ed-body', placeholder: '本文', 'aria-label': '本文', spellcheck: 'false' });
  body.value = n.body;
  body.addEventListener('input', () => {
    store.batch('本文編集', (tx) => tx.update(id, { body: body.value }), { coalesce: 'body:' + id });
  });
  body.addEventListener('keydown', (e) => autoIndent(e, body));

  const tagbox = createTagBox(id);
  const tagToggle = h('button', { type: 'button', class: 'tagbox-toggle mobile-only', onclick: () => { store.ui.tagsOpen = !store.ui.tagsOpen; store.saveUI(); updateTagToggle(); } });
  const tagWrap = h('div', { class: 'tagbox-wrap' }, tagToggle, tagbox.el);

  const noteBtn = iconBtn('note', 'サイドメモ', () => toggleSideNote());
  const toolbar = h('div', { class: 'toolbar ed-toolbar' },
    iconBtn('template', 'テンプレート呼び出し', () => applyTemplateTo(id)),
    noteBtn,
    iconBtn('eye', '特殊文字の点検', () => inspect(id)),
    h('span', { class: 'sep' }),
    ...nodeOpButtons().map((b) => { b.classList.add('mobile-only'); return b; }),
  );
  const path = h('div', { class: 'ed-path' });
  const nav = h('div', { class: 'searchnav', hidden: true });
  const head = h('div', { class: 'ed-head' }, path, title, tagWrap);
  p.append(head, toolbar, nav, body);
  els = { title, body, tagbox, tagToggle, noteBtn, path, nav };
  refreshEditor();
  renderSideNote();
  renderSearchNav();
}

function updateTagToggle() {
  if (!els) return;
  const n = store.get(curId);
  const open = store.ui.tagsOpen || !isMobile();
  els.tagToggle.textContent = `タグ${n && n.tags.length ? `(${n.tags.length})` : ''} ${store.ui.tagsOpen ? '▾' : '▸'}`;
  els.tagbox.el.hidden = !open;
}

/** ストアの内容をエディタへ反映（値が異なるときだけ） */
export function refreshEditor() {
  if (!els) return;
  const n = store.get(curId);
  if (!n || n.deleted) { renderEditor(); return; }
  if (els.title.value !== n.title) els.title.value = n.title;
  if (els.body.value !== n.body) {
    const { selectionStart: s, selectionEnd: e, scrollTop } = els.body;
    els.body.value = n.body;
    try { els.body.setSelectionRange(Math.min(s, n.body.length), Math.min(e, n.body.length)); } catch { /* noop */ }
    els.body.scrollTop = scrollTop;
  }
  els.path.textContent = store.pathText(curId) || '（最上位）';
  els.tagbox.render();
  els.noteBtn.classList.toggle('has', !!n.sideNote.trim());
  updateTagToggle();
  const snTa = $('#sidenote-panel textarea');
  if (snTa && snTa.dataset.id === curId && snTa.value !== n.sideNote) snTa.value = n.sideNote;
}

export function focusTitle() {
  if (!els) return;
  els.title.focus();
  if (!els.title.value) return;
  els.title.select();
}

// ---------- オートインデント ----------
function autoIndent(e, ta) {
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!store.settings.autoIndent) return;
  const s = ta.selectionStart;
  const lineStart = ta.value.lastIndexOf('\n', s - 1) + 1;
  const indent = /^[ \t　]*/.exec(ta.value.slice(lineStart, s))[0];
  if (!indent) return;
  e.preventDefault();
  insertText(ta, '\n' + indent);
}

export function insertText(ta, text) {
  ta.focus();
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
  if (!ok) {
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// ---------- タグ入力 ----------
function createTagBox(id) {
  const el = h('div', { class: 'tagbox' });
  const chips = h('span', { style: { display: 'contents' } });
  const input = h('input', { type: 'text', placeholder: 'タグを追加', 'aria-label': 'タグを追加', enterkeyhint: 'done', autocomplete: 'off' });
  const sug = h('div', { class: 'suggest', role: 'listbox', hidden: true });
  el.append(chips, input, sug);
  let items = [];
  let active = -1;

  const node = () => store.get(id);
  const setTags = (tags, label) => store.batch(label, (tx) => tx.update(id, { tags }));

  const commit = (raw) => {
    const n = node();
    let t = cleanTag(raw);
    if (!t || !n) return;
    t = canonicalTag(t); // 全角半角・大小文字の表記ゆれは既存の表記に合わせる
    if (n.tags.some((x) => tagKey(x) === tagKey(t))) { toast(`「${t}」は既に付いています`); return; }
    setTags(addTagsTo(n.tags, [t]), 'タグ追加');
  };
  const remove = (t) => { const n = node(); if (n) setTags(n.tags.filter((x) => x !== t), 'タグ削除'); };

  const showSug = () => {
    const n = node();
    if (!n) return;
    items = suggestTags(input.value, n.tags, 8);
    active = input.value && items.length && items[0].rank === 0 ? 0 : -1;
    drawSug();
  };
  const drawSug = () => {
    sug.innerHTML = '';
    if (!items.length || document.activeElement !== input) { sug.hidden = true; return; }
    items.forEach((it, i) => sug.append(h('button', {
      type: 'button', role: 'option', class: i === active ? 'active' : '', tabindex: '-1',
      onmousedown: (e) => e.preventDefault(),
      onclick: () => { commit(it.tag); input.value = ''; showSug(); input.focus(); },
    }, h('span', {}, it.tag), h('span', { class: 'hint' }, it.similar ? '既存のタグ（表記ゆれ）' : `${it.count}件`))));
    sug.hidden = false;
  };

  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME 変換中の Enter では確定しない
    if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && items[active]) commit(items[active].tag); else commit(input.value);
      input.value = ''; showSug();
    } else if (e.key === 'Backspace' && input.value === '') {
      const n = node(); if (n && n.tags.length) remove(n.tags[n.tags.length - 1]);
    } else if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); active = (active + 1) % items.length; drawSug(); }
    else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); active = active <= 0 ? items.length - 1 : active - 1; drawSug(); }
    else if (e.key === 'Escape') { sug.hidden = true; }
  });
  const splitCheck = () => {
    if (/[,、，]/.test(input.value)) {
      const parts = input.value.split(/[,、，]/);
      const rest = parts.pop();
      parts.forEach((p) => commit(p));
      input.value = rest;
    }
    showSug();
  };
  input.addEventListener('input', (e) => { if (!e.isComposing) splitCheck(); else showSug(); });
  input.addEventListener('compositionend', () => setTimeout(splitCheck, 0));
  input.addEventListener('focus', showSug);
  input.addEventListener('blur', () => { setTimeout(() => { sug.hidden = true; }, 120); });

  const render = () => {
    const n = node();
    chips.innerHTML = '';
    if (!n) return;
    n.tags.forEach((t) => chips.append(h('span', { class: 'chip' }, t,
      h('button', { type: 'button', 'aria-label': `タグ「${t}」を削除`, onclick: () => remove(t) }, '×'))));
  };
  render();
  return { el, render, input };
}

// ---------- サイドメモ ----------
let sideNoteOpen = false;
export function toggleSideNote(force) {
  sideNoteOpen = force ?? !sideNoteOpen;
  renderSideNote();
  if (sideNoteOpen) $('#sidenote-panel textarea')?.focus();
}
export function renderSideNote() {
  const panel = $('#sidenote-panel');
  const n = curId && store.get(curId);
  if (!sideNoteOpen || !n) { panel.hidden = true; panel.innerHTML = ''; return; }
  const existing = panel.querySelector('textarea');
  if (existing && existing.dataset.id === curId) { panel.hidden = false; panel.querySelector('strong').textContent = `メモ：${n.title || '無題'}`; return; }
  panel.innerHTML = '';
  const ta = h('textarea', { placeholder: '本文とは別の作業用メモ（閲覧モードには表示されません）', 'aria-label': 'サイドメモ', dataset: { id: curId } });
  ta.value = n.sideNote;
  const id = curId;
  ta.addEventListener('input', () => store.batch('サイドメモ編集', (tx) => tx.update(id, { sideNote: ta.value }), { coalesce: 'note:' + id }));
  ta.addEventListener('keydown', (e) => autoIndent(e, ta));
  panel.append(h('div', { class: 'sn-head' }, h('span', { html: icon('note', 18) }), h('strong', {}, `メモ：${n.title || '無題'}`), iconBtn('close', 'サイドメモを閉じる', () => toggleSideNote(false))), ta);
  panel.hidden = false;
}

// ---------- 特殊文字の点検ビュー（読み取り専用） ----------
function inspect(id) {
  const n = store.get(id);
  if (!n) return;
  const lines = n.body.split('\n');
  const html = lines.map((line, i) => {
    const m = /[ \t　]+$/.exec(line);
    const main = m ? line.slice(0, m.index) : line;
    const trail = m ? m[0] : '';
    const vis = (s, trailing) => [...s].map((c) => {
      if (c === '\t') return `<span class="sp${trailing ? ' tr' : ''}">→\t</span>`.replace('\t', '   ');
      if (c === '　') return `<span class="zs${trailing ? ' tr' : ''}">□</span>`;
      if (c === ' ' && trailing) return '<span class="sp tr">·</span>';
      return escapeHtml(c);
    }).join('');
    const last = i === lines.length - 1;
    return vis(main, false) + vis(trail, true) + (last ? '<span class="eof">[EOF]</span>' : '<span class="nl">↵</span>\n');
  }).join('');
  const stats = `${n.body.length}文字 / ${lines.length}行 / 全角スペース ${(n.body.match(/　/g) || []).length} / タブ ${(n.body.match(/\t/g) || []).length} / 行末の空白 ${lines.filter((l) => /[ \t　]$/.test(l)).length}行`;
  modal({
    title: `特殊文字の点検：${n.title || '無題'}`, wide: true,
    body: [
      h('p', { class: 'muted' }, '↵ 改行　→ タブ　□ 全角スペース　赤 行末の余分な空白　[EOF] 終端'),
      h('p', { class: 'muted' }, stats),
      h('pre', { class: 'inspect', html }),
    ],
  });
}

// ---------- 検索ナビ（前へ・次へ） ----------
function navMatches() {
  const sn = ctx.searchNav;
  const n = curId && store.get(curId);
  if (!sn || !n || sn.nodeId !== curId) return [];
  const r = search([n], sn.query, sn.opts);
  return r.results[0] ? r.results[0].matches : [];
}

export function renderSearchNav() {
  if (!els) return;
  const sn = ctx.searchNav;
  const nav = els.nav;
  if (!sn || sn.nodeId !== curId) { nav.hidden = true; nav.innerHTML = ''; return; }
  const ms = navMatches();
  nav.innerHTML = '';
  nav.append(
    h('span', { html: icon('search', 16) }),
    h('span', { class: 'q' }, sn.query),
    h('span', {}, ms.length ? `${Math.min(sn.idx, ms.length - 1) + 1} / ${ms.length}` : '0件'),
    h('span', { class: 'spacer' }),
    iconBtn('prev', '前の一致', () => gotoMatch(-1)),
    iconBtn('next', '次の一致', () => gotoMatch(1)),
    iconBtn('close', '検索ナビを閉じる', () => { ctx.searchNav = null; renderSearchNav(); }),
  );
  nav.hidden = false;
}

export function gotoMatch(delta = 0) {
  const sn = ctx.searchNav;
  if (!sn || !els) return;
  const ms = navMatches();
  if (!ms.length) { renderSearchNav(); return; }
  sn.idx = ((sn.idx + delta) % ms.length + ms.length) % ms.length;
  const m = ms[sn.idx];
  renderSearchNav();
  let target;
  if (m.field === 'title') target = els.title;
  else if (m.field === 'body') target = els.body;
  else { toggleSideNote(true); target = $('#sidenote-panel textarea'); }
  if (!target) return;
  target.focus({ preventScroll: true });
  try { target.setSelectionRange(m.start, m.end); } catch { /* noop */ }
  if (target.tagName === 'TEXTAREA') scrollToPos(target, m.start);
}

/** textarea 内の位置が見えるようにスクロール */
function scrollToPos(ta, pos) {
  const mirror = document.createElement('textarea');
  const cs = getComputedStyle(ta);
  Object.assign(mirror.style, {
    position: 'absolute', visibility: 'hidden', left: '-9999px', top: '0', height: '0',
    width: ta.clientWidth + 'px', font: cs.font, lineHeight: cs.lineHeight, padding: cs.padding,
    border: '0', boxSizing: 'border-box', whiteSpace: 'pre-wrap', wordWrap: 'break-word', tabSize: cs.tabSize, letterSpacing: cs.letterSpacing,
  });
  mirror.value = ta.value.slice(0, pos);
  document.body.append(mirror);
  const y = mirror.scrollHeight;
  mirror.remove();
  ta.scrollTop = Math.max(0, y - ta.clientHeight / 2);
}

export { removeSelected };
