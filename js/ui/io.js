// エクスポート・バックアップ・インポート（JSON / Markdown）
import { store } from '../store.js';
import { parseDataFile, mergeData, mergeTemplateData } from '../merge.js';
import { exportText, exportRoundtrip, parseMarkdown, buildHierarchy } from '../markdown.js';
import { downloadText, pickFile, stamp, uuid, orderBetween } from '../util.js';
import { h, modal, confirmDialog, toast, radioGroup, radioValue, checkbox } from './dom.js';
import { ctx } from './ctx.js';

const safeName = (s) => (s || '無題').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 40);

// ---------- バックアップ ----------
/** すべての作品とテンプレートを1つのファイルに保存 */
export async function downloadBackup() {
  const data = await store.exportBackup();
  downloadText(`netaterry-backup-${stamp()}.json`, JSON.stringify(data, null, 1), 'application/json');
  toast('バックアップを保存しました（すべての作品）');
}

const countLive = (list) => list.filter((x) => !x.deleted).length;

/**
 * JSON ファイルを読み込む。中身に応じて処理を変える
 *   バックアップ（すべての作品）: 同じ作品はマージ、ない作品は追加
 *   作品ファイル・旧形式: 新しい作品として追加／今の作品にマージ／今の作品を置き換え
 *   テンプレートファイル: テンプレートに追加
 */
export async function importDataFile() {
  const f = await pickFile('.json,application/json');
  if (!f) return;
  let parsed;
  try { parsed = parseDataFile(JSON.parse(f.text)); }
  catch (e) { await modal({ title: '読み込めません', body: h('p', {}, e.message) }); return; }
  if (parsed.type === 'templates') { await importTemplatesParsed(parsed.templates, f.name); return; }
  if (parsed.type === 'backup') { await importBackupParsed(parsed, f.name); return; }
  await importWorkParsed(parsed.works[0], parsed.templates, f.name, parsed.type);
}
export const restoreBackup = importDataFile;

const backupWarn = () => h('div', { class: 'warn' }, '読み込む前に、現在のデータのバックアップ取得をおすすめします。 ',
  h('button', { type: 'button', class: 'btn small', onclick: downloadBackup }, 'バックアップを保存'));

/** バックアップ（すべての作品）の読み込み */
async function importBackupParsed(parsed, fileName) {
  const rows = parsed.works.map((w) => {
    const ex = w.work && store.works.get(w.work.id);
    return h('li', {}, `${w.work?.name || '無題の作品'}（ノード ${countLive(w.nodes)}件）`, h('small', { class: 'muted' }, ex && !ex.deleted ? '　→ この端末にある同じ作品へ' : '　→ 作品として追加'));
  });
  const wrap = h('div', {},
    h('p', {}, fileName),
    h('p', { class: 'muted' }, `作品 ${parsed.works.length}件・テンプレート ${countLive(parsed.templates)}件`),
    h('ul', {}, rows),
    h('h3', {}, '読み込み方法'),
    radioGroup('mode', [
      ['merge', 'マージする', '（ノードごとに新しい方を残す）'],
      ['replace', 'バックアップの状態に戻す', '（同じ作品の中身をバックアップで置き換え、ない分はゴミ箱へ）'],
    ], 'merge'),
    h('p', { class: 'muted' }, 'この端末にない作品は、どちらの方法でも追加します。バックアップに含まれない作品はそのまま残します。テンプレートはマージします。'),
    backupWarn());
  const mode = await modal({
    title: 'バックアップから読み込み', wide: true, body: wrap,
    buttons: [{ label: 'キャンセル', value: null }, { label: '読み込む', primary: true, value: () => radioValue(wrap, 'mode') }],
  });
  if (!mode) return;
  for (const w of parsed.works) {
    const id = w.work?.id;
    const ex = id && store.works.get(id);
    if (ex && !ex.deleted) {
      if (id === store.workId) {
        if (mode === 'replace') replaceCurrent(w, 'バックアップの状態に戻す'); else mergeIntoCurrent(w, 'バックアップをマージ');
        continue;
      }
      const local = await store.loadWorkData(id);
      await store.saveWorkData(id, mode === 'replace' ? replacedData(local, w) : mergeData(local, w));
      store.works.get(id).sync.dirty = true;
      await store.saveWork(id);
    } else {
      await store.createWork(w.work?.name || '読み込んだ作品', { id: ex ? undefined : id, nodes: w.nodes, globalNote: w.globalNote, open: false });
    }
  }
  if (parsed.templates.length) mergeTemplates(parsed.templates);
  store.setDirtyFlag();
  store.emit('works', {});
  ctx.refreshAll();
  toast(`${parsed.works.length}件の作品を読み込みました`, { ms: 5000 });
}

/**
 * 作品の中身を file の状態にしたデータを作る（開いていない作品用）。
 * 同期で新しい方が勝つので、置き換えたノードは今の時刻にする。file にないノードはゴミ箱へ
 */
function replacedData(local, file) {
  const t = Date.now();
  const keep = new Set(file.nodes.map((n) => n.id));
  const gone = local.nodes.filter((n) => !n.deleted && !keep.has(n.id));
  const goneSet = new Set(gone.map((n) => n.id));
  const nodes = [
    ...local.nodes.filter((n) => !keep.has(n.id) && !goneSet.has(n.id)),
    ...gone.map((n) => ({ ...n, deleted: true, deletedRoot: !goneSet.has(n.parentId), updatedAt: t })),
    ...file.nodes.map((n) => ({ ...n, updatedAt: t })),
  ];
  const hasNote = file.globalNote.updatedAt || file.globalNote.text;
  return { ...local, nodes, globalNote: hasNote ? { text: file.globalNote.text, updatedAt: t } : local.globalNote };
}

/** 今開いている作品を file の状態にする（元に戻せる） */
function replaceCurrent(w, label) {
  const keep = new Set(w.nodes.map((n) => n.id));
  store.batch(label, (tx) => {
    const toDelete = [...store.nodes.values()].filter((n) => !n.deleted && !keep.has(n.id));
    const delSet = new Set(toDelete.map((n) => n.id));
    toDelete.forEach((n) => tx.update(n.id, { deleted: true, deletedRoot: !delSet.has(n.parentId) }));
    w.nodes.forEach((n) => tx.put({ ...n, collapsed: store.get(n.id)?.collapsed ?? n.collapsed }));
    // 共通メモを含まない古い形式のファイルでは、今の共通メモを残す
    if (w.globalNote.updatedAt || w.globalNote.text) tx.updateGlobalNote(w.globalNote.text);
  });
}

/** 作品ファイル（または v1.3 までのバックアップ）の読み込み */
async function importWorkParsed(w, templates, fileName, type) {
  const live = countLive(w.nodes);
  const ids = new Set(w.nodes.map((n) => n.id));
  const orphans = w.nodes.filter((n) => !n.deleted && n.parentId != null && !ids.has(n.parentId)).length;
  const name = w.work?.name || fileName.replace(/(-\d{8}-\d{4})?\.json$/i, '').replace(/^netaterry-backup$/, '読み込んだ作品');
  const cur = store.work;
  const warns = [];
  if (orphans) warns.push(`存在しない親を指すノードが ${orphans} 件あります（最上位に表示されます）。`);
  const replaceWarn = h('div', { class: 'warn danger', hidden: true }, `作品「${cur.name}」のノードのうち、ファイルに含まれないものはゴミ箱へ移ります。`);
  const wrap = h('div', {},
    h('p', {}, fileName),
    h('p', { class: 'muted' }, `${type === 'legacy' ? '以前の形式のバックアップ' : '作品ファイル'}：ノード ${live}件（ゴミ箱 ${w.nodes.length - live}件）${w.globalNote.text ? '・共通メモあり' : ''}${templates.length ? `・テンプレート ${countLive(templates)}件` : ''}`),
    warns.length ? h('div', { class: 'warn' }, h('ul', {}, warns.map((x) => h('li', {}, x)))) : null,
    h('h3', {}, '読み込み方法'),
    radioGroup('mode', [
      ['new', '新しい作品として追加', `（作品名「${name}」）`],
      ['merge', `今開いている作品「${cur.name}」にマージ`, '（ノードごとに新しい方を残す）'],
      ['replace', `今開いている作品「${cur.name}」を置き換える`, '（今あるノードはゴミ箱へ）'],
    ], 'new', (v) => { replaceWarn.hidden = v !== 'replace'; }),
    replaceWarn,
    templates.length ? h('p', { class: 'muted' }, 'ファイルに含まれるテンプレートは、テンプレート（全作品共通）にマージします。') : null,
    backupWarn());
  const mode = await modal({ title: 'ファイルから読み込み', wide: true, body: wrap, buttons: [{ label: 'キャンセル', value: null }, { label: '読み込む', primary: true, value: () => radioValue(wrap, 'mode') }] });
  if (!mode) return;
  if (mode === 'new') {
    // 同じ作品がこの端末にあっても別の作品として追加する（id は新しくする）
    await store.createWork(name, { nodes: w.nodes, globalNote: w.globalNote.text ? { ...w.globalNote, updatedAt: Date.now() } : null });
  } else if (mode === 'merge') {
    mergeIntoCurrent(w, 'ファイルをマージ');
  } else {
    replaceCurrent(w, 'ファイルで置き換え');
  }
  if (templates.length) mergeTemplates(templates);
  ctx.refreshAll();
  toast('読み込みました', mode === 'new' ? {} : { action: () => store.undo(), actionLabel: '元に戻す', ms: 6000 });
}

/** 今開いている作品へノード単位でマージ（元に戻せる） */
function mergeIntoCurrent(w, label) {
  const merged = mergeData(store.exportWork(), w);
  store.batch(label, (tx) => {
    for (const n of merged.nodes) {
      const cur = store.get(n.id);
      if (!cur || cur.updatedAt !== n.updatedAt) { tx.touch('node', n.id); store.nodes.set(n.id, n); }
    }
    if (merged.globalNote.updatedAt !== store.globalNote.updatedAt) { tx.touch('global', 'global'); store.globalNote = merged.globalNote; }
  });
  store._childCache = null;
}

/** テンプレートを id 単位でマージ（元に戻せる） */
function mergeTemplates(list) {
  const merged = mergeTemplateData(store.exportTemplates(), { templates: list });
  store.batch('テンプレートをマージ', (tx) => {
    for (const t of merged.templates) {
      const cur = store.templates.get(t.id);
      if (!cur || cur.updatedAt !== t.updatedAt) { tx.touch('tpl', t.id); store.templates.set(t.id, t); }
    }
  });
}

/**
 * テンプレートファイルの読み込み。新しいテンプレートとして追加する
 * （同じ名前・本文・タグのテンプレートが既にあるものは飛ばす）
 */
export async function importTemplatesParsed(list, fileName) {
  const items = list.filter((t) => !t.deleted);
  if (!items.length) { toast('テンプレートが見つかりませんでした'); return 0; }
  const same = (a, b) => a.name === b.name && a.body === b.body && a.tags.join('\n') === b.tags.join('\n');
  const existing = store.liveTemplates();
  const add = items.filter((t) => !existing.some((e) => same(e, t)));
  const skip = items.length - add.length;
  const ok = await modal({
    title: 'テンプレートの読み込み',
    body: h('div', {},
      h('p', {}, fileName),
      h('ul', {}, items.slice(0, 30).map((t) => h('li', {}, t.name || '無題', add.includes(t) ? '' : h('small', { class: 'muted' }, '　（同じものがあるので飛ばします）')))),
      h('p', { class: 'muted' }, `${add.length}件を追加します。`)),
    buttons: [{ label: 'キャンセル', value: false }, { label: '追加', primary: true, value: true }],
  });
  if (!ok || !add.length) return 0;
  const names = new Set(existing.map((t) => t.name));
  store.batch('テンプレートの読み込み', (tx) => {
    for (const t of add) {
      let name = t.name || '無題';
      if (names.has(name)) name += '（読み込み）';
      names.add(name);
      tx.createTemplate({ name, body: t.body, tags: [...t.tags] });
    }
  });
  toast(`テンプレートを${add.length}件追加しました${skip ? `（${skip}件は同じものがあるため飛ばしました）` : ''}`, { action: () => store.undo(), actionLabel: '元に戻す' });
  return add.length;
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
    ['all', '作品全体', `（${store.work.name}）`],
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
    const base = safeName(scope === 'all' ? store.work.name : sel.title);
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
