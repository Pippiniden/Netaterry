// ビューモード（閲覧）: 見出し自動生成・縦書き・ページめくり
import { store } from '../store.js';
import { escapeHtml, debounce } from '../util.js';
import { h, $, icon, iconBtn } from './dom.js';

const V = {
  open: false,
  range: 'node',      // node | all
  chapterIdx: 0,
  page: 0,
  total: 1,
  expanded: new Set(), // スクロール表示で開いたノード（ビュー内だけの開閉）
  collapsedLocal: new Set(),
  els: null,
  layout: null,
};

const vertical = () => store.settings.viewVertical;
const paged = () => store.settings.viewPaged;

export function isViewerOpen() { return V.open; }

export function openViewer() {
  const sel = store.ui.selectedId && store.get(store.ui.selectedId);
  V.range = sel && !sel.deleted ? 'node' : 'all';
  V.chapterIdx = 0;
  if (V.range === 'all' && sel) {
    // 選択ノードを含む章から
    const top = store.ancestors(sel.id)[0] || sel;
    V.chapterIdx = Math.max(0, store.children(null).findIndex((n) => n.id === top.id));
  }
  V.page = 0;
  V.open = true;
  V.expanded = new Set();
  V.collapsedLocal = new Set();
  $('#viewer').hidden = false;
  build();
  render({ keepPos: false });
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
}

export function closeViewer() {
  V.open = false;
  const v = $('#viewer');
  v.hidden = true;
  v.innerHTML = '';
  V.els = null;
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', onResize);
}

export function refreshViewer() { if (V.open) { build(); render({ keepPos: true }); } }

function chapters() {
  if (V.range === 'node') {
    const n = store.get(store.ui.selectedId);
    return n && !n.deleted ? [n] : [];
  }
  return store.children(null);
}

// ---------- 骨組み ----------
function build() {
  const v = $('#viewer');
  v.innerHTML = '';
  v.className = (paged() ? 'paged' : 'scrolling') + (vertical() ? ' is-vertical' : '');
  const s = store.settings;
  const seg = (opts, cur, on) => h('span', { class: 'seg' }, opts.map(([val, label]) => h('button', { type: 'button', 'aria-pressed': String(cur === val), onclick: () => on(val) }, label)));
  const setS = (k, val) => {
    const anchor = paged() ? currentAnchor() : null; // 文字単位の位置なので書字方向を変えても保てる
    s[k] = val; store.saveSettings(); build(); render({ keepPos: !!anchor, anchor });
  };
  const sel = store.ui.selectedId && store.get(store.ui.selectedId);
  const rangeSel = h('select', { 'aria-label': '表示範囲', onchange: (e) => { V.range = e.target.value; V.chapterIdx = 0; V.page = 0; build(); render({ keepPos: false }); } },
    h('option', { value: 'node', selected: V.range === 'node', disabled: !(sel && !sel.deleted) }, '選択ノード以下'),
    h('option', { value: 'all', selected: V.range === 'all' }, '全体'));
  const title = h('span', { class: 'ttl' });
  const bar = h('div', { class: 'v-bar' },
    iconBtn('close', '閲覧モードを閉じる', closeViewer),
    title,
    rangeSel,
    V.range === 'all' && paged() ? [iconBtn('prev', '前の章', () => gotoChapter(-1)), iconBtn('next', '次の章', () => gotoChapter(1))] : null,
    seg([[false, '横'], [true, '縦']], s.viewVertical, (val) => setS('viewVertical', val)),
    seg([[false, 'スクロール'], [true, 'ページ']], s.viewPaged, (val) => setS('viewPaged', val)),
    h('button', { type: 'button', class: 'icon-btn', title: '文字を小さく', onclick: () => setFont(-1) }, 'A-'),
    h('button', { type: 'button', class: 'icon-btn', title: '文字を大きく', onclick: () => setFont(1) }, 'A+'));
  const stage = h('div', { class: 'v-stage' });
  const foot = h('div', { class: 'v-foot' });
  v.append(bar, stage, foot);
  V.els = { v, bar, stage, foot, title };
  setupGestures(stage);
}

function setFont(d) {
  const s = store.settings;
  const anchor = paged() ? currentAnchor() : null; // 文字サイズを変える前に先頭文字を記録
  s.viewFontSize = Math.max(12, Math.min(40, s.viewFontSize + d));
  store.saveSettings();
  $('#viewer').style.setProperty('--v-font', s.viewFontSize + 'px');
  render({ keepPos: true, anchor });
}

function gotoChapter(d) {
  const cs = chapters();
  const ni = V.chapterIdx + d;
  if (ni < 0 || ni >= cs.length) return false;
  V.chapterIdx = ni;
  V.page = d > 0 ? 0 : Infinity; // 前の章へは最終ページから
  render({ keepPos: false });
  return true;
}

// ---------- 本文の生成 ----------
function inline(text, vert) {
  // **太字** のみ対応
  const out = [];
  let last = 0;
  const re = /\*\*(.+?)\*\*/g;
  let m;
  const plain = (s) => (vert ? tcy(s) : escapeHtml(s));
  while ((m = re.exec(text))) {
    out.push(plain(text.slice(last, m.index)), '<b>', plain(m[1]), '</b>');
    last = m.index + m[0].length;
  }
  out.push(plain(text.slice(last)));
  return out.join('');
}
/** 縦中横: 2桁までの半角数字 */
function tcy(s) {
  return s.split(/((?<![0-9])[0-9]{1,2}(?![0-9]))/).map((p, i) => (i % 2 ? `<span class="tcy">${p}</span>` : escapeHtml(p))).join('');
}

let keyCounter = 0;
function nodeHtml(n, depth, { lazy, pb }) {
  const vert = vertical();
  const kids = store.children(n.id);
  const closed = lazy && kids.length && (V.collapsedLocal.has(n.id) || (n.collapsed && !V.expanded.has(n.id)));
  let s = `<section class="node${pb ? ' pb' : ''}" style="--d:${Math.min(depth, 8)}" data-id="${n.id}">`;
  s += `<div class="h" data-d="${Math.min(depth, 6)}" data-k="${keyCounter++}">${inline(n.title || '無題', vert)}`;
  if (lazy && kids.length) s += `<button type="button" class="fold" data-fold="${n.id}">${closed ? `▸ 開く（${kids.length}）` : '▾ 閉じる'}</button>`;
  s += '</div>';
  if (store.settings.viewShowTags && n.tags.length) s += `<div class="vtags">${n.tags.map((t) => '#' + escapeHtml(t)).join('　')}</div>`;
  if (n.body) for (const line of n.body.replace(/\s+$/, '').split('\n')) s += `<p data-k="${keyCounter++}">${inline(line, vert)}</p>`;
  s += '</section>';
  if (!closed) kids.forEach((k) => { s += nodeHtml(k, depth + 1, { lazy, pb: false }); });
  return s;
}

function docHtml() {
  keyCounter = 0;
  const cs = chapters();
  if (!cs.length) return '';
  if (paged()) {
    V.chapterIdx = Math.max(0, Math.min(V.chapterIdx, cs.length - 1));
    const root = cs[V.chapterIdx];
    // 章 = 選択ノードとその子孫。最上位（章直下）ごとに改ページ
    const kids = store.children(root.id);
    let s = sectionOnly(root, 1);
    kids.forEach((k) => { s += subtree(k, 2, store.settings.viewPageBreakTop); });
    return s;
  }
  return cs.map((n) => nodeHtml(n, 1, { lazy: true, pb: false })).join('');
}
function sectionOnly(n, depth) {
  const vert = vertical();
  let s = `<section class="node" style="--d:${depth}" data-id="${n.id}"><div class="h" data-d="${Math.min(depth, 6)}" data-k="${keyCounter++}">${inline(n.title || '無題', vert)}</div>`;
  if (store.settings.viewShowTags && n.tags.length) s += `<div class="vtags">${n.tags.map((t) => '#' + escapeHtml(t)).join('　')}</div>`;
  if (n.body) for (const line of n.body.replace(/\s+$/, '').split('\n')) s += `<p data-k="${keyCounter++}">${inline(line, vert)}</p>`;
  return s + '</section>';
}
function subtree(n, depth, pb) {
  let s = sectionOnly(n, depth);
  if (pb) s = s.replace('<section class="node"', '<section class="node pb"');
  store.children(n.id).forEach((k) => { s += subtree(k, depth + 1, false); });
  return s;
}

// ---------- 描画・レイアウト ----------
function render({ keepPos, anchor: given = null }) {
  if (!V.els) return;
  const { stage, foot, title } = V.els;
  const anchor = given || (keepPos ? currentAnchor() : null);
  stage.innerHTML = '';
  const cs = chapters();
  const s = store.settings;
  const lh = Math.round(s.viewFontSize * 1.9);
  V.els.v.style.setProperty('--v-lh', lh + 'px');
  const html = docHtml();
  if (!html) {
    stage.append(h('div', { class: 'v-empty' }, '表示するノードがありません'));
    title.textContent = '';
    foot.textContent = '';
    return;
  }
  const doc = h('div', { class: 'v-doc ' + (vertical() ? 'vertical' : 'horizontal'), html });
  doc.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fold]');
    if (!b) return;
    const id = b.dataset.fold;
    const n = store.get(id);
    const isClosed = V.collapsedLocal.has(id) || (n.collapsed && !V.expanded.has(id));
    if (isClosed) { V.collapsedLocal.delete(id); V.expanded.add(id); } else { V.collapsedLocal.add(id); V.expanded.delete(id); }
    const sc = V.els.stage.querySelector('.v-scroll');
    const pos = sc ? [sc.scrollTop, sc.scrollLeft] : null;
    render({ keepPos: false });
    const sc2 = V.els.stage.querySelector('.v-scroll');
    if (sc2 && pos) { sc2.scrollTop = pos[0]; sc2.scrollLeft = pos[1]; }
  });

  if (!paged()) {
    const sc = h('div', { class: 'v-scroll' + (vertical() ? ' vertical' : '') }, doc);
    if (vertical()) sc.style.writingMode = 'vertical-rl';
    sc.addEventListener('wheel', (e) => {
      if (!vertical() || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      sc.scrollLeft -= e.deltaY;
    }, { passive: false });
    stage.append(sc);
    title.textContent = V.range === 'node' ? (cs[0].title || '無題') : '全体';
    foot.textContent = '';
    V.layout = null;
    return;
  }

  // ページめくり
  const W = stage.clientWidth, H = stage.clientHeight;
  const m = store.settings.viewTheme.margin;
  let fw = Math.max(120, W - m.left - m.right);
  const fh = Math.max(120, H - m.top - m.bottom);
  let left = m.left;
  if (vertical()) {
    // ページ幅を行送りの整数倍に揃えて、ページ境界で行が切れないようにする
    const cols = Math.max(1, Math.floor(fw / lh));
    const nfw = cols * lh;
    left += Math.floor((fw - nfw) / 2);
    fw = nfw;
  }
  const frame = h('div', { class: 'v-page-frame', style: { left: left + 'px', top: m.top + 'px', width: fw + 'px', height: fh + 'px' } }, doc);
  stage.append(frame);
  const gap = 48;
  if (vertical()) {
    doc.style.height = fh + 'px';
    insertVerticalBreaks(doc, fw);
  } else {
    doc.style.columnWidth = fw + 'px';
    doc.style.columnGap = gap + 'px';
    doc.style.width = fw + 'px';
    doc.append(h('span', { class: 'v-end' }));
  }
  const stride = vertical() ? fw : fw + gap;
  let total;
  if (vertical()) total = Math.max(1, Math.ceil((doc.scrollWidth - 1) / fw));
  else {
    const end = doc.querySelector('.v-end').getBoundingClientRect();
    const dr = doc.getBoundingClientRect();
    total = Math.max(1, Math.floor((end.left - dr.left + 1) / stride) + 1);
  }
  V.layout = { doc, fw, fh, stride, total, vertical: vertical() };
  V.total = total;
  if (anchor != null) V.page = pageOfKey(anchor);
  V.page = Math.max(0, Math.min(V.page === Infinity ? total - 1 : V.page, total - 1));
  title.textContent = cs[V.chapterIdx] ? (cs[V.chapterIdx].title || '無題') : '';
  applyPage();
}

/** 縦書き: 改ページ指定の節をページ境界まで送る */
function insertVerticalBreaks(doc, fw) {
  const pbs = doc.querySelectorAll('.pb');
  for (const el of pbs) {
    const dr = doc.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const off = Math.round(dr.right - er.right);
    const rem = ((off % fw) + fw) % fw;
    if (rem > 1) {
      const sp = document.createElement('div');
      sp.style.blockSize = (fw - rem) + 'px';
      sp.style.inlineSize = '1px';
      el.before(sp);
    }
  }
}

function applyPage() {
  const L = V.layout;
  if (!L) return;
  const x = L.vertical ? V.page * L.stride : -V.page * L.stride;
  L.doc.style.transform = `translateX(${x}px)`;
  const cs = chapters();
  V.els.foot.textContent = `${V.page + 1} / ${L.total}` + (V.range === 'all' && cs.length > 1 ? `　（章 ${V.chapterIdx + 1} / ${cs.length}）` : '');
}

function pageOfEl(el) {
  const L = V.layout;
  const dr = L.doc.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  if (L.vertical) return Math.floor((dr.right - er.right + 1) / L.stride);
  return Math.floor((er.left - dr.left + 1) / L.stride);
}
// ---- 位置の保持: 表示中の先頭文字（要素キー＋文字オフセット）を記録 ----
function textNodes(el) {
  const out = [];
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) if (!n.parentElement.closest('.fold')) out.push(n);
  return out;
}
function charRect(nodes, off) {
  let acc = 0;
  for (const n of nodes) {
    const len = n.length;
    if (off < acc + len) {
      const r = document.createRange();
      r.setStart(n, off - acc);
      r.setEnd(n, off - acc + 1);
      const rects = r.getClientRects();
      return rects.length ? rects[0] : r.getBoundingClientRect();
    }
    acc += len;
  }
  return null;
}
function pageOfRect(rect) {
  const L = V.layout;
  const dr = L.doc.getBoundingClientRect();
  if (L.vertical) return Math.floor((dr.right - rect.right + 1) / L.stride);
  return Math.floor((rect.left - dr.left + 1) / L.stride);
}
function currentAnchor() {
  const L = V.layout;
  if (!L || !L.doc.isConnected) return null;
  const els = [...L.doc.querySelectorAll('[data-k]')];
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const next = els[i + 1];
    // 次の要素がまだ現在ページより前なら飛ばす
    if (next && pageOfEl(next) < V.page) continue;
    const nodes = textNodes(el);
    const total = nodes.reduce((s, n) => s + n.length, 0);
    if (!total) { if (pageOfEl(el) >= V.page) return { k: el.dataset.k, off: 0 }; continue; }
    // 二分探索で現在ページに入る最初の文字を探す
    let lo = 0, hi = total - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = charRect(nodes, mid);
      if (r && pageOfRect(r) >= V.page) { found = mid; hi = mid - 1; } else lo = mid + 1;
    }
    if (found >= 0) return { k: el.dataset.k, off: found };
  }
  return null;
}
function pageOfKey(a) {
  const el = V.layout.doc.querySelector(`[data-k="${a.k}"]`);
  if (!el) return 0;
  const r = a.off ? charRect(textNodes(el), a.off) : null;
  return r ? pageOfRect(r) : pageOfEl(el);
}

export function turn(d) {
  if (!V.layout) return;
  const np = V.page + d;
  if (np < 0) { if (V.range === 'all') gotoChapter(-1); return; }
  if (np >= V.total) { if (V.range === 'all') gotoChapter(1); return; }
  V.page = np;
  applyPage();
}

// ---------- 操作 ----------
function onKey(e) {
  if (!V.open || document.querySelector('.modal-back')) return;
  if (e.key === 'Escape') { e.preventDefault(); closeViewer(); return; }
  if (!paged()) return;
  const vert = vertical();
  const map = { ArrowRight: vert ? -1 : 1, ArrowLeft: vert ? 1 : -1, PageDown: 1, PageUp: -1, ' ': e.shiftKey ? -1 : 1, ArrowDown: 1, ArrowUp: -1 };
  if (e.key in map && !e.target.closest('select')) { e.preventDefault(); turn(map[e.key]); }
}

const onResize = debounce(() => { if (V.open && paged()) render({ keepPos: true }); }, 200);

function setupGestures(stage) {
  let sx = 0, sy = 0, st = 0, active = false;
  stage.addEventListener('pointerdown', (e) => { if (!paged()) return; active = true; sx = e.clientX; sy = e.clientY; st = Date.now(); });
  stage.addEventListener('pointerup', (e) => {
    if (!active || !paged()) return;
    active = false;
    if (window.getSelection && String(window.getSelection()).length) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    const vert = vertical();
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) && Date.now() - st < 800) {
      // スワイプ: 横書きは左へ払うと次、縦書きは右へ払うと次
      turn(vert ? (dx > 0 ? 1 : -1) : (dx < 0 ? 1 : -1));
      return;
    }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const r = stage.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      if (x < 0.3) turn(vert ? 1 : -1);
      else if (x > 0.7) turn(vert ? -1 : 1);
      else V.els.v.classList.toggle('hide-ui');
    }
  });
  stage.addEventListener('pointercancel', () => { active = false; });
}

export { icon };

/** テスト用: 現在の先頭文字位置と、その位置があるページ */
export function _debugAnchor(prev) {
  if (prev) return { prevAnchorPageNow: pageOfKey(prev), page: V.page };
  const a = currentAnchor();
  return a && { ...a, page: V.page, anchorPage: pageOfKey(a), total: V.total };
}
