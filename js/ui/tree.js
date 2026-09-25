// ツリー表示・タグ絞り込みバー・ノード操作ツールバー
import { store, ops } from '../store.js';
import { nodeHasTag, tagCounts, tagKey } from '../tags.js';
import { h, $, icon, iconBtn, toast, modal, isMobile, checkbox } from './dom.js';
import { ctx } from './ctx.js';

const treeEl = () => $('#tree');

// ---------- 絞り込み ----------
export function filterActive() { return store.ui.filter.tags.length > 0; }

/** 絞り込み条件に一致するノード id の集合（子孫を含めるオプション込み） */
export function filteredSet() {
  const f = store.ui.filter;
  if (!f.tags.length) return null;
  const match = (n) => (f.mode === 'or' ? f.tags.some((t) => nodeHasTag(n, t)) : f.tags.every((t) => nodeHasTag(n, t)));
  const m = new Set();
  for (const n of store.treeOrder()) if (match(n)) m.add(n.id);
  if (f.includeDesc) for (const id of [...m]) store.descendants(id).forEach((d) => m.add(d.id));
  return m;
}

// ---------- 描画 ----------
export function renderTree() {
  const el = treeEl();
  const scroll = el.scrollTop;
  el.innerHTML = '';
  const frag = document.createDocumentFragment();
  const sel = store.ui.selectedId;
  const matched = filteredSet();
  const f = store.ui.filter;
  const draggable = !isMobile() && !(matched && f.display === 'flat');

  const row = (n, depth, { dim = false, flat = false, hasKids = false, forceOpen = false } = {}) => {
    const r = h('div', {
      class: 'row' + (n.id === sel ? ' selected' : '') + (dim ? ' dim' : ''),
      role: 'treeitem', 'aria-selected': String(n.id === sel), 'aria-level': String(depth),
      dataset: { id: n.id }, style: { '--depth': flat ? 1 : depth }, draggable: draggable ? 'true' : null,
    });
    if (!flat) {
      const open = forceOpen || !n.collapsed;
      if (hasKids) r.setAttribute('aria-expanded', String(open));
      r.append(h('button', { type: 'button', class: 'tw' + (hasKids ? '' : ' leaf'), tabindex: '-1', 'aria-label': open ? '閉じる' : '開く', dataset: { tw: '1' } }, hasKids ? (open ? '▾' : '▸') : ''));
      r.append(h('span', { class: 'title' + (n.title ? '' : ' empty') }, n.title || '無題'));
    } else {
      r.append(h('div', { class: 'flat-main' },
        h('span', { class: 'title' + (n.title ? '' : ' empty') }, n.title || '無題'),
        h('span', { class: 'path' }, store.pathText(n.id) || '（最上位）')));
    }
    if (n.sideNote.trim()) r.append(h('span', { class: 'has-note', title: 'サイドメモあり' }));
    if (n.tags.length) {
      const tg = h('span', { class: 'rtags' });
      n.tags.slice(0, 3).forEach((t) => tg.append(h('span', { class: 'chip small' }, t)));
      if (n.tags.length > 3) tg.append(h('span', { class: 'chip small more' }, `+${n.tags.length - 3}`));
      r.append(tg);
    }
    return r;
  };

  if (!matched) {
    const walk = (pid, depth) => {
      for (const n of store.children(pid)) {
        const kids = store.children(n.id);
        frag.append(row(n, depth, { hasKids: kids.length > 0 }));
        if (kids.length && !n.collapsed) walk(n.id, depth + 1);
      }
    };
    walk(null, 1);
    if (!store.children(null).length) frag.append(h('div', { class: 'tree-empty' }, 'ノードがありません。下の「＋」から追加してください。'));
  } else if (f.display === 'flat') {
    for (const n of store.treeOrder()) if (matched.has(n.id)) frag.append(row(n, 1, { flat: true }));
    if (!matched.size) frag.append(h('div', { class: 'tree-empty' }, '該当するノードがありません。'));
  } else {
    // 該当ノードとその祖先だけを残す
    const show = new Set(matched);
    for (const id of matched) store.ancestors(id).forEach((a) => show.add(a.id));
    const walk = (pid, depth) => {
      for (const n of store.children(pid)) {
        if (!show.has(n.id)) continue;
        const kids = store.children(n.id).filter((k) => show.has(k.id));
        frag.append(row(n, depth, { dim: !matched.has(n.id), hasKids: kids.length > 0, forceOpen: true }));
        walk(n.id, depth + 1);
      }
    };
    walk(null, 1);
    if (!matched.size) frag.append(h('div', { class: 'tree-empty' }, '該当するノードがありません。'));
  }
  el.append(frag);
  el.scrollTop = scroll;
}

export function scrollSelectedIntoView() {
  const r = treeEl().querySelector('.row.selected');
  if (r) r.scrollIntoView({ block: 'nearest' });
}

// ---------- 絞り込みバー ----------
export function renderFilterBar() {
  const bar = $('#filterbar');
  const f = store.ui.filter;
  bar.innerHTML = '';
  const save = () => { store.saveUI(); renderFilterBar(); renderTree(); };
  const row1 = h('div', { class: 'filter-row' },
    h('span', { class: 'label', html: icon('filter', 14) }),
    f.tags.map((t) => h('span', { class: 'chip on' }, t, h('button', { type: 'button', 'aria-label': `${t} を外す`, onclick: () => { f.tags = f.tags.filter((x) => x !== t); save(); } }, '×'))),
    h('button', { type: 'button', class: 'link', onclick: () => pickFilterTag(save) }, f.tags.length ? '+ 追加' : 'タグで絞り込む'),
  );
  bar.append(row1);
  if (f.tags.length) {
    const seg = (key, opts) => h('span', { class: 'seg' }, opts.map(([v, label]) =>
      h('button', { type: 'button', 'aria-pressed': String(f[key] === v), onclick: () => { f[key] = v; save(); } }, label)));
    bar.append(h('div', { class: 'filter-opts' },
      seg('mode', [['and', 'すべて'], ['or', 'いずれか']]),
      seg('display', [['tree', 'ツリー'], ['flat', '一覧']]),
      checkbox('子孫も含める', f.includeDesc, (v) => { f.includeDesc = v; save(); }),
      h('button', { type: 'button', class: 'link', onclick: () => { f.tags = []; save(); } }, 'クリア')));
  }
}

async function pickFilterTag(save) {
  const counts = [...tagCounts()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'));
  // 階層タグの親も候補に（キャラ/主人公 → キャラ）
  const parents = new Map();
  for (const [t, c] of counts) {
    const parts = t.split('/');
    for (let i = 1; i < parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      if (!counts.some(([x]) => tagKey(x) === tagKey(p))) parents.set(p, (parents.get(p) || 0) + c);
    }
  }
  const all = [...counts, ...[...parents].map(([t, c]) => [t, c, true])].sort((a, b) => a[0].localeCompare(b[0], 'ja'));
  const f = store.ui.filter;
  const input = h('input', { class: 'input', placeholder: 'タグを検索', type: 'search' });
  const list = h('div', { class: 'list' });
  let closeFn;
  const draw = () => {
    const q = tagKey(input.value);
    list.innerHTML = '';
    all.filter(([t]) => !q || tagKey(t).includes(q)).forEach(([t, c, isParent]) => {
      const on = f.tags.some((x) => tagKey(x) === tagKey(t));
      list.append(h('div', { class: 'list-item clickable', onclick: () => {
        if (on) f.tags = f.tags.filter((x) => tagKey(x) !== tagKey(t)); else f.tags.push(t);
        save(); draw();
      } },
        h('input', { type: 'checkbox', checked: on, tabindex: '-1' }),
        h('div', { class: 'main' }, h('div', { class: 't' }, t), isParent ? h('div', { class: 'sub' }, '階層タグの親（配下をまとめて絞り込み）') : null),
        h('span', { class: 'muted' }, String(c))));
    });
    if (!list.children.length) list.append(h('div', { class: 'muted', style: { padding: '12px 4px' } }, 'タグがありません'));
  };
  input.addEventListener('input', draw);
  draw();
  await modal({ title: 'タグで絞り込む', body: [input, list], onOpen: (d, c) => { closeFn = c; setTimeout(() => input.focus(), 30); } });
  void closeFn;
}

// ---------- ツールバー ----------
export function renderTreeToolbar() {
  const tb = $('#tree-toolbar');
  tb.innerHTML = '';
  tb.append(...nodeOpButtons());
}

export function nodeOpButtons() {
  const sel = () => store.ui.selectedId && store.get(store.ui.selectedId) && !store.get(store.ui.selectedId).deleted ? store.ui.selectedId : null;
  return [
    iconBtn('plus', '下に兄弟ノード追加', () => { const n = ops.addSibling(sel()); ctx.select(n.id, { open: true, focusTitle: true }); }),
    iconBtn('child', '子ノード追加', () => { const id = sel(); const n = id ? ops.addChild(id) : ops.addSibling(null); ctx.select(n.id, { open: true, focusTitle: true }); }),
    h('span', { class: 'sep' }),
    iconBtn('up', '上へ', () => sel() && ops.moveUp(sel())),
    iconBtn('down', '下へ', () => sel() && ops.moveDown(sel())),
    iconBtn('outdent', '階層を上げる', () => sel() && ops.outdent(sel())),
    iconBtn('indent', '階層を下げる', () => sel() && ops.indent(sel())),
    h('span', { class: 'sep' }),
    iconBtn('copy', '複製（子孫も）', () => { if (!sel()) return; const n = ops.duplicate(sel()); if (n) ctx.select(n.id); toast('複製しました'); }),
    iconBtn('trash', '削除（ゴミ箱へ）', () => removeSelected()),
  ];
}

export function removeSelected() {
  const id = store.ui.selectedId;
  const n = id && store.get(id);
  if (!n || n.deleted) return;
  // 削除後の選択先
  const visible = visibleRowIds();
  const i = visible.indexOf(id);
  const desc = new Set(store.descendants(id).map((d) => d.id));
  const next = visible.slice(i + 1).find((x) => !desc.has(x)) || visible.slice(0, i).reverse()[0] || null;
  ops.remove(id);
  ctx.select(next, { open: false });
  if (isMobile()) ctx.showScreen('tree');
  toast(`「${n.title || '無題'}」をゴミ箱へ移動しました`, { action: () => store.undo(), actionLabel: '元に戻す' });
}

export function visibleRowIds() {
  return [...treeEl().querySelectorAll('.row')].map((r) => r.dataset.id);
}

// ---------- イベント ----------
export function initTree() {
  const el = treeEl();
  el.addEventListener('click', (e) => {
    const r = e.target.closest('.row');
    if (!r) return;
    const id = r.dataset.id;
    if (e.target.closest('[data-tw]')) {
      const n = store.get(id);
      if (n && !filterActive()) store.setCollapsed(id, !n.collapsed);
      return;
    }
    ctx.select(id, { open: isMobile() });
  });
  el.addEventListener('dblclick', (e) => {
    const r = e.target.closest('.row');
    if (r && !e.target.closest('[data-tw]')) ctx.focusEditorTitle();
  });

  el.addEventListener('keydown', (e) => {
    if (e.target !== el) return;
    const ids = visibleRowIds();
    const cur = store.ui.selectedId;
    const i = ids.indexOf(cur);
    const n = cur && store.get(cur);
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); n && ops.moveDown(cur); }
    else if (e.key === 'ArrowUp' && e.altKey) { e.preventDefault(); n && ops.moveUp(cur); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); const nx = ids[Math.min(ids.length - 1, i + 1)]; if (nx) ctx.select(nx); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); const nx = ids[Math.max(0, i - 1)]; if (nx) ctx.select(nx); }
    else if (e.key === 'ArrowRight' && n) {
      e.preventDefault();
      if (n.collapsed && store.children(cur).length) store.setCollapsed(cur, false);
      else { const k = store.children(cur)[0]; if (k && !filterActive()) ctx.select(k.id); }
    } else if (e.key === 'ArrowLeft' && n) {
      e.preventDefault();
      if (!n.collapsed && store.children(cur).length && !filterActive()) store.setCollapsed(cur, true);
      else { const p = store.effectiveParent(n); if (p) ctx.select(p); }
    } else if (e.key === 'Tab' && n) { e.preventDefault(); e.shiftKey ? ops.outdent(cur) : ops.indent(cur); }
    else if (e.key === 'Enter' && !mod && n) { e.preventDefault(); ctx.focusEditorTitle(); }
    else if (e.key === 'Enter' && mod) { e.preventDefault(); const nn = ops.addSibling(cur); ctx.select(nn.id, { open: true, focusTitle: true }); }
    else if (e.key === 'Delete' && n) { e.preventDefault(); removeSelected(); }
  });

  // ---- ドラッグ＆ドロップ（PC） ----
  let dragId = null;
  const clearMarks = () => el.querySelectorAll('.drop-before,.drop-after,.drop-child').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-child'));
  const zone = (r, e) => {
    const b = r.getBoundingClientRect();
    const y = (e.clientY - b.top) / b.height;
    return y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'child';
  };
  el.addEventListener('dragstart', (e) => {
    const r = e.target.closest('.row');
    if (!r) return;
    dragId = r.dataset.id;
    r.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', store.get(dragId)?.title || '');
  });
  el.addEventListener('dragend', () => { dragId = null; clearMarks(); el.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging')); });
  el.addEventListener('dragover', (e) => {
    const r = e.target.closest('.row');
    if (!dragId || !r) return;
    const tid = r.dataset.id;
    if (tid === dragId || store.isDescendant(tid, dragId)) { clearMarks(); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearMarks();
    r.classList.add('drop-' + zone(r, e));
  });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) clearMarks(); });
  el.addEventListener('drop', (e) => {
    const r = e.target.closest('.row');
    if (!dragId || !r) return;
    e.preventDefault();
    const where = zone(r, e);
    clearMarks();
    if (ops.moveTo(dragId, r.dataset.id, where)) ctx.select(dragId);
    dragId = null;
  });
}
