// 検索パネル・一括置換
import { store } from '../store.js';
import { search, excerpt, planReplace, applyReplacements } from '../search.js';
import { h, $, icon, iconBtn, modal, confirmDialog, toast, checkbox, isMobile, isMac } from './dom.js';
import { ctx } from './ctx.js';
import { filteredSet } from './tree.js';
import { gotoMatch } from './editor.js';
import { downloadBackup } from './io.js';

let built = false;
let els = {};
let lastResult = null;
let timer = null;
let open = false;

export function isSearchOpen() { return open; }

export function openSearch() {
  build();
  open = true;
  $('#pane-search').hidden = false;
  $('#btn-search').classList.add('active');
  if (isMobile()) ctx.showScreen('search');
  setTimeout(() => { els.input.focus(); els.input.select(); }, 30);
  run();
}

export function closeSearch() {
  open = false;
  $('#pane-search').hidden = true;
  $('#btn-search').classList.remove('active');
  if (isMobile()) ctx.showScreen('tree');
}

function kanaDefault() {
  const o = store.ui.searchOpts;
  return o.kanaFold == null ? store.settings.kanaFold : o.kanaFold;
}

function build() {
  if (built) return;
  built = true;
  const o = store.ui.searchOpts;
  const pane = $('#pane-search');
  const input = h('input', { class: 'sp-input', type: 'search', placeholder: '検索（例: 王都 騎士 -団長 tag:キャラ）', 'aria-label': '検索語', enterkeyhint: 'search', autocomplete: 'off' });
  const hist = h('div', { class: 'suggest sp-history', hidden: true });
  const save = () => { store.saveUI(); run(); };
  const sortSel = h('select', { 'aria-label': '並び順', onchange: (e) => { o.sort = e.target.value; save(); } },
    h('option', { value: 'relevance', selected: o.sort === 'relevance' }, 'タイトル一致→新しい順'),
    h('option', { value: 'tree', selected: o.sort === 'tree' }, 'ツリー順'));
  const kana = checkbox('かな同一視', kanaDefault(), (v) => { o.kanaFold = v; save(); });
  const opts = h('div', { class: 'sp-opts' },
    checkbox('サイドメモ', o.note, (v) => { o.note = v; save(); }),
    checkbox('ゴミ箱', o.trash, (v) => { o.trash = v; save(); }),
    checkbox('このノード以下', o.scope, (v) => { o.scope = v; save(); }),
    checkbox('タグ絞り込みと併用', o.withFilter, (v) => { o.withFilter = v; save(); }),
    kana,
    h('span', { class: 'desktop-only' }, checkbox('正規表現', o.regex, (v) => { o.regex = v; save(); })),
    sortSel);
  const meta = h('div', { class: 'sp-meta' });
  const results = h('div', { class: 'sp-results' });
  const help = h('details', { class: 'muted', style: { fontSize: '12px' } }, h('summary', {}, '検索語の書き方'),
    h('div', { html: '<code>語1 語2</code> すべて含む ／ <code>-語</code> 含まない ／ <code>"語 句"</code> 空白を含む語句<br><code>tag:タグ</code> タグで絞る（階層は前方一致）／ <code>in:title</code> <code>in:body</code> <code>in:note</code> 場所を限定' }));
  const head = h('div', { class: 'sp-head' },
    h('div', { class: 'sp-input-row' },
      input, hist,
      iconBtn('close', '検索を閉じる', closeSearch, { class: 'desktop-only' })),
    opts, help, meta);
  pane.append(head, results);
  els = { input, hist, meta, results, kana };

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 200); drawHistory(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); clearTimeout(timer); run(); pushHistory(); els.hist.hidden = true; }
    if (e.key === 'Escape') { if (!els.hist.hidden) els.hist.hidden = true; else closeSearch(); }
  });
  input.addEventListener('focus', drawHistory);
  input.addEventListener('blur', () => setTimeout(() => { hist.hidden = true; }, 150));
}

function drawHistory() {
  const hist = els.hist;
  hist.innerHTML = '';
  const list = store.ui.searchHistory;
  if (els.input.value || !list.length || document.activeElement !== els.input) { hist.hidden = true; return; }
  list.forEach((q) => hist.append(h('button', { type: 'button', onmousedown: (e) => e.preventDefault(), onclick: () => { els.input.value = q; hist.hidden = true; run(); } }, h('span', {}, q), h('span', { class: 'hint' }, '履歴'))));
  hist.append(h('button', { type: 'button', onmousedown: (e) => e.preventDefault(), onclick: () => { store.ui.searchHistory = []; store.saveUI(); hist.hidden = true; } }, h('span', { class: 'hint' }, '履歴を消去')));
  hist.hidden = false;
}

function pushHistory() {
  const q = els.input.value.trim();
  if (!q) return;
  const hl = store.ui.searchHistory.filter((x) => x !== q);
  hl.unshift(q);
  store.ui.searchHistory = hl.slice(0, 10);
  store.saveUI();
}

function candidates() {
  const o = store.ui.searchOpts;
  let nodes;
  if (o.scope && store.ui.selectedId && store.get(store.ui.selectedId) && !store.get(store.ui.selectedId).deleted) {
    const root = store.get(store.ui.selectedId);
    nodes = [root, ...store.descendants(root.id)];
  } else nodes = store.treeOrder();
  if (o.withFilter) {
    const fs = filteredSet();
    if (fs) nodes = nodes.filter((n) => fs.has(n.id));
  }
  if (o.trash) nodes = nodes.concat([...store.nodes.values()].filter((n) => n.deleted && !n.purged));
  return nodes;
}

export function rerunSearch() { if (open) run(); }

function run() {
  if (!built) return;
  const o = store.ui.searchOpts;
  const q = els.input.value;
  const opts = { note: o.note, kanaFold: kanaDefault(), regex: o.regex && !isMobile() };
  const res = search(candidates(), q, opts);
  lastResult = { ...res, query: q, opts };
  const results = els.results;
  results.innerHTML = '';
  els.meta.innerHTML = '';
  if (res.error) { els.meta.append(h('span', { style: { color: 'var(--danger)' } }, res.error)); return; }
  if (res.parsed.errors.length) els.meta.append(h('span', { style: { color: 'var(--danger)' } }, res.parsed.errors.join(' ')));
  if (!q.trim()) {
    const scopeInfo = store.ui.searchOpts.scope ? '（選択ノード以下）' : '';
    els.meta.append(h('span', {}, `キーワードを入力してください${scopeInfo}　${isMac() ? '⌘' : 'Ctrl'}+F でいつでも検索`));
    return;
  }
  let list = res.results;
  if (o.sort === 'relevance') list = [...list].sort((a, b) => (b.titleHit - a.titleHit) || (b.node.updatedAt - a.node.updatedAt));
  const total = list.reduce((s, r) => s + r.count, 0);
  els.meta.append(h('span', {}, `${list.length}件のノード・${total}箇所`),
    h('button', { type: 'button', class: 'btn small', disabled: !list.length, onclick: () => openReplace() }, '置換…'));
  const frag = document.createDocumentFragment();
  for (const r of list.slice(0, 300)) {
    const n = r.node;
    const bodyMs = r.matches.filter((m) => m.field === 'body');
    const noteMs = r.matches.filter((m) => m.field === 'sideNote');
    const exField = bodyMs.length ? 'body' : noteMs.length ? 'sideNote' : 'body';
    const ex = excerpt(n[exField], exField === 'body' ? bodyMs : noteMs);
    const titleMs = r.matches.filter((m) => m.field === 'title');
    frag.append(h('div', { class: 'sp-item', tabindex: '0', role: 'button', onclick: () => openResult(r), onkeydown: (e) => { if (e.key === 'Enter') openResult(r); } },
      h('div', { class: 't' }, h('span', {}, highlight(n.title || '無題', titleMs), n.deleted ? h('small', { class: 'muted' }, '（ゴミ箱）') : null), h('span', { class: 'n' }, `${r.count}件`)),
      h('div', { class: 'p' }, store.pathText(n.id) || '最上位'),
      h('div', { class: 'x' }, exField === 'sideNote' ? h('small', { class: 'muted' }, 'メモ: ') : null, ex.map((p) => (p.hit ? h('mark', {}, p.text) : p.text)))));
  }
  if (list.length > 300) frag.append(h('p', { class: 'muted', style: { padding: '8px 12px' } }, `ほか ${list.length - 300} 件（検索語を絞り込んでください）`));
  if (!list.length) frag.append(h('p', { class: 'muted', style: { padding: '8px 12px' } }, '見つかりませんでした'));
  results.append(frag);
}

function highlight(text, ms) {
  if (!ms.length) return text;
  const out = [];
  let cur = 0;
  for (const m of ms) {
    if (m.start < cur) continue;
    out.push(text.slice(cur, m.start), h('mark', {}, text.slice(m.start, m.end)));
    cur = m.end;
  }
  out.push(text.slice(cur));
  return out;
}

function openResult(r) {
  pushHistory();
  if (r.node.deleted) { toast('ゴミ箱内のノードです。メニューの「ゴミ箱」から復元できます。'); return; }
  ctx.searchNav = { nodeId: r.node.id, query: lastResult.query, opts: lastResult.opts, idx: 0 };
  ctx.select(r.node.id, { open: true });
  setTimeout(() => gotoMatch(0), 50);
}

// ---------- 一括置換 ----------
async function openReplace() {
  if (!lastResult) return;
  const res = { ...lastResult, results: lastResult.results.filter((r) => !r.node.deleted) };
  const repInput = h('input', { class: 'input', type: 'text', placeholder: '置換後の文字列' });
  const list = h('div', { class: 'rep-list' });
  const info = h('div', { class: 'muted', style: { margin: '6px 0' } });
  let plan = { items: [] };
  const checked = new Set();
  const draw = () => {
    plan = planReplace(res, repInput.value);
    list.innerHTML = '';
    if (plan.error) { info.textContent = plan.error; return; }
    const keys = new Set(plan.items.map((i) => i.key));
    [...checked].forEach((k) => { if (!keys.has(k)) checked.delete(k); });
    if (!list.dataset.init) { plan.items.forEach((i) => checked.add(i.key)); list.dataset.init = '1'; }
    info.textContent = `${plan.items.length}箇所中 ${checked.size}箇所を置換します（チェックを外すと除外）`;
    const fieldName = { title: 'タイトル', body: '本文', sideNote: 'サイドメモ' };
    plan.items.slice(0, 1000).forEach((it) => {
      const n = store.get(it.nodeId);
      list.append(h('label', { class: 'rep-item' },
        h('input', { type: 'checkbox', checked: checked.has(it.key), onchange: (e) => { e.target.checked ? checked.add(it.key) : checked.delete(it.key); info.textContent = `${plan.items.length}箇所中 ${checked.size}箇所を置換します（チェックを外すと除外）`; } }),
        h('div', {},
          h('div', { class: 'where' }, `${n.title || '無題'}・${fieldName[it.field]}`),
          h('div', {}, it.ctxBefore, h('del', {}, it.matched), h('ins', {}, it.after), it.ctxAfter))));
    });
  };
  repInput.addEventListener('input', draw);
  draw();
  const go = await modal({
    title: `置換：「${lastResult.query}」`, wide: true,
    body: [h('label', { class: 'field' }, h('span', {}, '置換後'), repInput), info, list],
    buttons: [{ label: 'キャンセル', value: false }, { label: '置換を実行', primary: true, value: true }],
  });
  if (!go || plan.error) return;
  const items = plan.items.filter((i) => checked.has(i.key));
  if (!items.length) { toast('置換する箇所がありません'); return; }
  const nodeCount = new Set(items.map((i) => i.nodeId)).size;
  const many = items.length >= 30;
  const ok = await confirmDialog(`${nodeCount}件のノード・${items.length}箇所を置換します。\n実行後は「元に戻す」で一括して戻せます。`, {
    ok: '置換する', title: '置換の確認',
    extra: many ? h('div', { class: 'warn' }, '置換件数が多いため、実行前にバックアップの取得をおすすめします。 ',
      h('button', { type: 'button', class: 'btn small', onclick: () => downloadBackup() }, 'バックアップを保存')) : null,
  });
  if (!ok) return;
  store.batch(`置換「${lastResult.query}」→「${repInput.value}」`, (tx) => {
    const byNode = new Map();
    items.forEach((i) => { const k = i.nodeId + '\u0000' + i.field; if (!byNode.has(k)) byNode.set(k, []); byNode.get(k).push(i); });
    for (const [k, its] of byNode) {
      const [nodeId, field] = k.split('\u0000');
      const n = store.get(nodeId);
      tx.update(nodeId, { [field]: field === 'title' ? applyReplacements(n[field], its).replace(/[\r\n]+/g, ' ') : applyReplacements(n[field], its) });
    }
  });
  toast(`${items.length}箇所を置換しました`, { action: () => store.undo(), actionLabel: '元に戻す', ms: 6000 });
  run();
}

export { icon };
