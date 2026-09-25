// エクスポート・バックアップ・インポート（JSON / Markdown）
import { store } from '../store.js';
import { migrate, mergeData } from '../merge.js';
import { exportText, exportRoundtrip, parseMarkdown, buildHierarchy } from '../markdown.js';
import { downloadText, pickFile, stamp, uuid, orderBetween } from '../util.js';
import { h, modal, confirmDialog, toast, radioGroup, radioValue, checkbox } from './dom.js';
import { ctx } from './ctx.js';

const safeName = (s) => (s || '無題').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 40);

// ---------- バックアップ ----------
export function downloadBackup() {
  const data = store.exportData();
  downloadText(`netaterry-backup-${stamp()}.json`, JSON.stringify(data, null, 1), 'application/json');
  toast('バックアップを保存しました');
}

export async function restoreBackup() {
  const f = await pickFile('.json,application/json');
  if (!f) return;
  let data;
  let hasGlobal = false; // 共通メモを含む（v2以降の）バックアップか
  try {
    const raw = JSON.parse(f.text);
    hasGlobal = !!(raw && raw.globalNote);
    if (raw && /^(netaterry|novelmemo)-settings$/.test(raw.kind || '')) { toast('これは設定ファイルです。設定画面から読み込んでください。'); return; }
    data = migrate(raw);
  } catch (e) { await modal({ title: '読み込めません', body: h('p', {}, e.message) }); return; }
  const live = data.nodes.filter((n) => !n.deleted);
  const ids = new Set(data.nodes.map((n) => n.id));
  const orphans = live.filter((n) => n.parentId != null && !ids.has(n.parentId)).length;
  const warns = [];
  if (orphans) warns.push(`存在しない親を指すノードが ${orphans} 件あります（最上位に表示されます）。`);
  const wrap = h('div', {},
    h('p', {}, `${f.name}`),
    h('p', { class: 'muted' }, `ノード ${live.length}件（ゴミ箱 ${data.nodes.length - live.length}件）・テンプレート ${data.templates.filter((t) => !t.deleted).length}件${hasGlobal ? '・共通メモあり' : ''}`),
    warns.length ? h('div', { class: 'warn' }, h('ul', {}, warns.map((w) => h('li', {}, w)))) : null,
    h('h3', {}, '読み込み方法'),
    radioGroup('mode', [
      ['merge', 'マージする', '（ノードごとに新しい方を残す）'],
      ['replace', '現在のデータを置き換える', '（今あるノードはゴミ箱へ）'],
    ], 'merge'),
    h('div', { class: 'warn' }, '読み込む前に、現在のデータのバックアップ取得をおすすめします。 ',
      h('button', { type: 'button', class: 'btn small', onclick: downloadBackup }, 'バックアップを保存')));
  const mode = await modal({ title: 'バックアップから読み込み', body: wrap, buttons: [{ label: 'キャンセル', value: null }, { label: '読み込む', primary: true, value: () => radioValue(wrap, 'mode') }] });
  if (!mode) return;
  if (mode === 'merge') {
    const merged = mergeData(store.exportData(), data);
    store.batch('バックアップをマージ', (tx) => {
      for (const n of merged.nodes) {
        const cur = store.get(n.id);
        if (!cur || cur.updatedAt !== n.updatedAt) { tx.touch('node', n.id); store.nodes.set(n.id, n); }
      }
      for (const t of merged.templates) {
        const cur = store.templates.get(t.id);
        if (!cur || cur.updatedAt !== t.updatedAt) { tx.touch('tpl', t.id); store.templates.set(t.id, t); }
      }
      if (merged.globalNote.updatedAt !== store.globalNote.updatedAt) { tx.touch('global', 'global'); store.globalNote = merged.globalNote; }
    });
    store._childCache = null;
  } else {
    const keep = new Set(data.nodes.map((n) => n.id));
    store.batch('バックアップで置き換え', (tx) => {
      const toDelete = [...store.nodes.values()].filter((n) => !n.deleted && !keep.has(n.id));
      const delSet = new Set(toDelete.map((n) => n.id));
      toDelete.forEach((n) => tx.update(n.id, { deleted: true, deletedRoot: !delSet.has(n.parentId) }));
      data.nodes.forEach((n) => tx.put({ ...n, collapsed: store.get(n.id)?.collapsed ?? n.collapsed }));
      const keepT = new Set(data.templates.map((t) => t.id));
      [...store.templates.values()].filter((t) => !t.deleted && !keepT.has(t.id)).forEach((t) => tx.updateTemplate(t.id, { deleted: true }));
      data.templates.forEach((t) => { tx.touch('tpl', t.id); store.templates.set(t.id, { ...t, updatedAt: tx.t }); });
      // 共通メモを含まない古い形式のバックアップでは、今の共通メモを残す
      if (hasGlobal) tx.updateGlobalNote(data.globalNote.text);
    });
  }
  ctx.refreshAll();
  toast('読み込みました', { action: () => store.undo(), actionLabel: '元に戻す', ms: 6000 });
}

// ---------- エクスポート ----------
export async function openExport() {
  const sel = store.ui.selectedId && store.get(store.ui.selectedId);
  const hasSel = sel && !sel.deleted;
  const s = store.settings;
  const wrap = h('div', {});
  const preview = h('div', { class: 'preview-box' });
  let includeNote = s.sideNoteExport === 'include';
  const scopeOpts = [
    ['node', '選択ノードのみ', hasSel ? `（${sel.title || '無題'}）` : '（未選択）'],
    ['tree', '選択ノード＋子孫'],
    ['all', '全体'],
  ];
  const fmtOpts = [
    ['plain', 'プレーンテキスト', '（記号なし）'],
    ['md', 'Markdown'],
    ['sheet', 'キャラクターシート'],
    ['roundtrip', '往復用Markdown', '（外部エディタで編集してアプリに戻せる形式）'],
  ];
  const noteCtl = s.sideNoteExport === 'ask'
    ? checkbox('サイドメモを含める', includeNote, (v) => { includeNote = v; update(); })
    : h('p', { class: 'muted' }, `サイドメモ：${s.sideNoteExport === 'include' ? '含める' : '含めない'}（設定で固定）`);
  wrap.append(
    h('h3', {}, '対象範囲'), radioGroup('scope', scopeOpts, hasSel ? 'tree' : 'all', () => update()),
    h('h3', {}, '形式'), radioGroup('fmt', fmtOpts, 'plain', () => update()),
    h('div', { class: 'note-ctl' }, noteCtl),
    h('h3', {}, 'プレビュー'), preview);
  if (!hasSel) wrap.querySelectorAll('input[name="scope"]').forEach((i) => { if (i.value !== 'all') i.disabled = true; });

  let out = '';
  let fname = '';
  const update = () => {
    const scope = radioValue(wrap, 'scope');
    const fmt = radioValue(wrap, 'fmt');
    const roots = scope === 'all' ? store.children(null) : [sel];
    const withDesc = scope !== 'node';
    wrap.querySelector('.note-ctl').hidden = fmt === 'roundtrip';
    if (fmt === 'roundtrip') {
      const tree = withDesc ? store : { children: () => [] };
      out = exportRoundtrip(roots, tree);
    } else {
      out = exportText(roots, store, { format: fmt, includeNote, withDesc });
    }
    const base = scope === 'all' ? 'netaterry' : safeName(sel.title);
    fname = `${base}-${stamp()}.${fmt === 'plain' || fmt === 'sheet' ? 'txt' : 'md'}`;
    preview.textContent = out.length > 3000 ? out.slice(0, 3000) + '\n…（以下省略）' : out;
  };
  update();
  const act = await modal({
    title: 'エクスポート', wide: true, body: wrap,
    buttons: [{ label: 'コピー', value: 'copy' }, { label: 'ダウンロード', value: 'dl', primary: true }],
  });
  if (act === 'dl') { downloadText(fname, out, fname.endsWith('.md') ? 'text/markdown' : 'text/plain'); }
  else if (act === 'copy') {
    try { await navigator.clipboard.writeText(out); toast('クリップボードにコピーしました'); }
    catch { toast('コピーできませんでした'); }
  }
}

// ---------- Markdown 読み込み ----------
export async function importMarkdown() {
  const f = await pickFile('.md,.markdown,.txt,text/markdown,text/plain');
  if (!f) return;
  const parsed = parseMarkdown(f.text);
  const items = buildHierarchy(parsed.items);
  if (!items.length) { toast('見出しも本文も見つかりませんでした'); return; }
  const warnings = [...parsed.warnings];
  // ゴミ箱内のノードとの一致
  for (const it of items) {
    const ex = it.id && store.get(it.id);
    if (ex && ex.deleted) warnings.push(`${it.line}行目「${it.title || '無題'}」: ゴミ箱内（または完全削除済み）のノードと同じidです。新しいidで作成します。`);
  }
  if (!parsed.roundtrip) warnings.unshift('往復用の書式ではない普通のMarkdownです。見出しの深さから階層を推定し、すべて新規ノードとして作成します。');
  const maxDepth = Math.max(...items.map((i) => i.depth));
  const outline = items.slice(0, 40).map((i) => '  '.repeat(i.depth - 1) + '・' + (i.title || '無題')).join('\n') + (items.length > 40 ? `\n…ほか${items.length - 40}件` : '');
  const matchCount = items.filter((i) => i.id && store.get(i.id) && !store.get(i.id).deleted).length;

  const wrap = h('div', {});
  const replaceWarn = h('div', { class: 'warn danger', hidden: true }, '全体を置き換えると、ファイルに含まれない既存のノードはすべてゴミ箱へ移動します（ゴミ箱から復元できます）。');
  const modeOpts = [['add', '新しい子ツリーとして追加', '（既存データを変えない）']];
  if (parsed.roundtrip) {
    modeOpts.push(['update', 'idが一致するノードを更新', `（一致 ${matchCount}件）`]);
    modeOpts.push(['replace', '全体を置き換え']);
  }
  wrap.append(
    h('p', {}, f.name),
    h('p', { class: 'muted' }, `ノード ${items.length}件・最大 ${maxDepth}階層${parsed.roundtrip ? '・往復用Markdown' : ''}`),
    h('div', { class: 'warn' }, h('strong', {}, '読み込み前にバックアップを取得してください　'),
      h('button', { type: 'button', class: 'btn small primary', onclick: downloadBackup }, 'バックアップを保存')),
    warnings.length ? h('div', { class: 'warn' }, h('strong', {}, `注意（${warnings.length}件）`), h('ul', {}, warnings.slice(0, 50).map((w) => h('li', {}, w)))) : null,
    h('h3', {}, '変換結果'), h('div', { class: 'preview-box' }, outline),
    h('h3', {}, '反映方法'),
    radioGroup('mode', modeOpts, 'add', (v) => { replaceWarn.hidden = v !== 'replace'; }),
    replaceWarn);
  const mode = await modal({ title: 'Markdownの読み込み', wide: true, body: wrap, buttons: [{ label: 'キャンセル', value: null }, { label: '読み込む', primary: true, value: () => radioValue(wrap, 'mode') }] });
  if (!mode) return;
  if (mode === 'replace' && !(await confirmDialog('既存のノードのうち、ファイルに含まれないものはゴミ箱へ移動します。よろしいですか？', { ok: '置き換える', danger: true }))) return;
  const firstId = applyMarkdownItems(items, mode, f.name);
  ctx.refreshAll();
  if (firstId) ctx.select(firstId);
  toast('読み込みました', { action: () => store.undo(), actionLabel: '元に戻す', ms: 6000 });
}

/** 読み込み結果をストアへ反映。戻り値: 先頭（またはラッパー）ノードのid */
export function applyMarkdownItems(items, mode, fileName = '') {
  let first = null;
  store.batch('Markdownの読み込み', (tx) => {
    const idMap = [];
    const usedIds = new Set();
    const seq = new Map(); // parentId -> count
    const nextOrder = (pid) => { const c = (seq.get(pid) || 0) + 1; seq.set(pid, c); return c; };
    const idFor = (it, allowExisting) => {
      if (!it.id || usedIds.has(it.id)) return null;
      const ex = store.get(it.id);
      if (ex && ex.deleted) return null;
      if (ex && !allowExisting) return null;
      return it.id;
    };
    if (mode === 'add') {
      const roots = store.children(null);
      const wrapper = tx.create({ parentId: null, order: orderBetween(roots[roots.length - 1]?.order, null), title: `読み込み：${fileName || 'Markdown'}` });
      first = wrapper.id;
      items.forEach((it, i) => {
        const pid = it.parentIdx >= 0 ? idMap[it.parentIdx] : wrapper.id;
        const id = idFor(it, false) || uuid();
        usedIds.add(id);
        tx.create({ id, parentId: pid, order: nextOrder(pid), title: it.title, body: it.body, sideNote: it.sideNote, tags: it.tags });
        idMap[i] = id;
      });
      return;
    }
    if (mode === 'replace') {
      const inFile = new Set(items.map((i) => i.id).filter(Boolean));
      const toDelete = [...store.nodes.values()].filter((n) => !n.deleted && !inFile.has(n.id));
      const delSet = new Set(toDelete.map((n) => n.id));
      toDelete.forEach((n) => tx.update(n.id, { deleted: true, deletedRoot: !delSet.has(n.parentId) }));
    }
    const roots = store.children(null);
    let rootOrder = mode === 'replace' ? 0 : (roots[roots.length - 1]?.order ?? 0);
    items.forEach((it, i) => {
      const id = idFor(it, true);
      const existing = id && store.get(id);
      const fields = { title: it.title, body: it.body, sideNote: it.sideNote, tags: it.tags };
      let pid, order;
      if (it.parentIdx >= 0) { pid = idMap[it.parentIdx]; order = nextOrder(pid); }
      else if (existing && mode === 'update') { pid = existing.parentId; order = existing.order; }
      else { pid = null; order = ++rootOrder; }
      if (existing) {
        tx.update(id, { ...fields, parentId: pid, order });
        idMap[i] = id;
      } else {
        const nid = id || uuid();
        tx.create({ id: nid, parentId: pid, order, ...fields });
        idMap[i] = nid;
      }
      usedIds.add(idMap[i]);
      if (i === 0) first = idMap[i];
    });
  });
  return first;
}
