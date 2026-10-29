// データ移行・ノード単位マージ・トゥームストーン掃除（純粋関数）
//
// ファイルの種類（kind）
//   netaterry-work      作品1つ分: { work, nodes, globalNote }          ← ドライブの作品ファイル・「作品をファイルに保存」
//   netaterry-templates テンプレート: { templates }                      ← ドライブのテンプレートファイル・テンプレートの書き出し
//   netaterry-backup    すべての作品とテンプレート: { works: [作品…], templates }
//   （kind なし）       v2 までの形式: { nodes, templates, globalNote } を作品1つとして扱う
import { SCHEMA_VERSION, clampTime } from './util.js';

export const KIND = { work: 'netaterry-work', templates: 'netaterry-templates', backup: 'netaterry-backup' };

export function normalizeNode(n) {
  const node = {
    id: String(n.id),
    parentId: n.parentId == null ? null : String(n.parentId),
    order: typeof n.order === 'number' && isFinite(n.order) ? n.order : 0,
    title: String(n.title ?? ''),
    body: String(n.body ?? ''),
    sideNote: String(n.sideNote ?? ''),
    tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
    collapsed: !!n.collapsed,
    deleted: !!n.deleted,
    updatedAt: clampTime(n.updatedAt),
  };
  if (n.purged) node.purged = true; // 完全削除の記録（id と削除日時のみ保持）
  if (n.deletedRoot) node.deletedRoot = true; // ゴミ箱で親として表示するか
  return node;
}

export function normalizeTemplate(t) {
  const tpl = {
    id: String(t.id),
    name: String(t.name ?? ''),
    body: String(t.body ?? ''),
    tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
    deleted: !!t.deleted,
    updatedAt: clampTime(t.updatedAt),
  };
  if (t.purged) tpl.purged = true;
  return tpl;
}

/** 作品の情報（id・名前）。名前の変更日時で新しい方を採る */
export function normalizeWork(w) {
  if (!w || typeof w !== 'object') return null;
  if (w.id == null) return null;
  return { id: String(w.id), name: String(w.name ?? '').trim() || '無題の作品', nameUpdatedAt: w.nameUpdatedAt ? clampTime(w.nameUpdatedAt) : 0 };
}

/** 共通メモ（作品ごと・どのノードからでも見られるメモ）。空で未編集なら updatedAt は 0 */
export function normalizeGlobalNote(g) {
  if (!g || typeof g !== 'object') return { text: '', updatedAt: 0 };
  return { text: String(g.text ?? ''), updatedAt: g.updatedAt ? clampTime(g.updatedAt) : 0 };
}

function checkVersion(data) {
  if (!data || typeof data !== 'object') throw new Error('データ形式が正しくありません');
  const v = data.schemaVersion ?? 0;
  if (v > SCHEMA_VERSION) throw new Error(`新しい形式のデータです（schemaVersion ${v}）。アプリを更新してください。`);
}
const nodesOf = (d) => (Array.isArray(d.nodes) ? d.nodes : []).filter((n) => n && n.id != null).map(normalizeNode);
const templatesOf = (d) => (Array.isArray(d.templates) ? d.templates : []).filter((t) => t && t.id != null).map(normalizeTemplate);

/**
 * 作品ファイル（または v2 までの形式）を現在のスキーマへ移行。
 * v0（schemaVersion なし）→ v1: フィールド補完のみ
 * v1 → v2: 共通メモ（globalNote）を追加。v1 には無いので空で補う
 * v2 → v3: 作品情報（work）を追加。v2 には無いので null（読み込む側で決める）。テンプレートは別ファイルへ
 * @returns { schemaVersion, kind, work|null, nodes, templates, globalNote }  templates は v2 以前のファイルにだけ入っている
 */
export function migrate(data) {
  checkVersion(data);
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: KIND.work,
    work: normalizeWork(data.work),
    nodes: nodesOf(data),
    templates: templatesOf(data),
    globalNote: normalizeGlobalNote(data.globalNote),
  };
}

/** テンプレートファイルの移行 */
export function migrateTemplates(data) {
  checkVersion(data);
  return { schemaVersion: SCHEMA_VERSION, kind: KIND.templates, templates: templatesOf(data) };
}

/**
 * 読み込んだ JSON の中身を判別する（バックアップ・作品・テンプレート・旧形式）
 * @returns { type: 'backup'|'work'|'templates'|'legacy', works: [作品データ], templates: [テンプレート] }
 */
export function parseDataFile(raw) {
  checkVersion(raw);
  if (raw.kind === KIND.backup) {
    const works = (Array.isArray(raw.works) ? raw.works : []).map(migrate);
    return { type: 'backup', works, templates: templatesOf(raw) };
  }
  if (raw.kind === KIND.templates) return { type: 'templates', works: [], templates: templatesOf(raw) };
  if (/^(netaterry|novelmemo)-settings$/.test(raw.kind || '')) throw new Error('これは設定ファイルです。設定画面から読み込んでください。');
  const w = migrate(raw);
  return { type: raw.kind === KIND.work ? 'work' : 'legacy', works: [w], templates: w.templates };
}

function mergeList(a, b) {
  const map = new Map();
  for (const x of a) map.set(x.id, x);
  for (const y of b) {
    const x = map.get(y.id);
    if (!x) map.set(y.id, y);
    else if (y.updatedAt > x.updatedAt) map.set(y.id, y);
    else if (y.updatedAt === x.updatedAt && x.deleted !== y.deleted) {
      // 同時刻なら削除側を優先（復活を防ぐ）
      map.set(y.id, y.deleted ? y : x);
    }
  }
  return [...map.values()];
}
export { mergeList };

/** 共通メモも新しい方を採用（Last Write Wins） */
function mergeGlobalNote(a, b) {
  const x = normalizeGlobalNote(a), y = normalizeGlobalNote(b);
  return y.updatedAt > x.updatedAt ? y : x;
}
/** 作品名も新しく変更した方を採用 */
function mergeWork(a, b) {
  const x = normalizeWork(a), y = normalizeWork(b);
  if (!x) return y;
  if (!y) return x;
  return y.nameUpdatedAt > x.nameUpdatedAt ? { ...y, id: x.id } : x;
}

/** ノード・テンプレート単位の Last Write Wins マージ（作品ファイル・旧形式の両方に使う） */
export function mergeData(local, remote) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: KIND.work,
    work: mergeWork(local.work, remote.work),
    nodes: mergeList(local.nodes || [], remote.nodes || []),
    templates: mergeList(local.templates || [], remote.templates || []),
    globalNote: mergeGlobalNote(local.globalNote, remote.globalNote),
  };
}

/** テンプレートファイル同士のマージ */
export function mergeTemplateData(local, remote) {
  return { schemaVersion: SCHEMA_VERSION, kind: KIND.templates, templates: mergeList(local.templates || [], remote.templates || []) };
}

/** 保持期間を過ぎたトゥームストーンを物理削除（nodes・templates のあるものだけ。他の項目はそのまま） */
export function cleanupTombstones(data, retentionDays, t = Date.now()) {
  const limit = t - retentionDays * 24 * 60 * 60 * 1000;
  const keep = (x) => !(x.deleted && x.updatedAt < limit);
  const out = { ...data, schemaVersion: SCHEMA_VERSION };
  let removed = 0;
  for (const k of ['nodes', 'templates']) {
    if (!Array.isArray(data[k])) continue;
    out[k] = data[k].filter(keep);
    removed += data[k].length - out[k].length;
  }
  if (out.kind !== KIND.templates) out.globalNote = normalizeGlobalNote(data.globalNote);
  return { data: out, removed };
}

// ---------- 同期の競合 ----------
// 「前回の同期以降、両方の端末が同じノード（テンプレート・共通メモ）を変更した」ものを競合として扱う。
// 前回の同期時点の状態は base（各項目の updatedAt の一覧）として端末に覚えておく。

/** 同期が済んだ時点のデータから base を作る */
export function makeBase(data) {
  const items = {};
  for (const k of ['nodes', 'templates']) for (const x of data[k] || []) items[x.id] = x.updatedAt;
  return { items, global: data.globalNote ? normalizeGlobalNote(data.globalNote).updatedAt : 0 };
}

const CONTENT_FIELDS = ['title', 'body', 'sideNote', 'name', 'tags', 'parentId', 'order', 'deleted', 'purged'];
const sameContent = (x, y) => CONTENT_FIELDS.every((f) => JSON.stringify(x[f] ?? null) === JSON.stringify(y[f] ?? null));

/**
 * ローカルとドライブの両方が base 以降に変更した項目を探す（内容が同じものは除く）
 * @returns [{ key, kind: 'node'|'template'|'global', id, local, remote }]
 */
export function findConflicts(local, remote, base) {
  if (!base || !base.items) return [];
  const out = [];
  for (const [k, kind] of [['nodes', 'node'], ['templates', 'template']]) {
    const rmap = new Map((remote[k] || []).map((x) => [x.id, x]));
    for (const l of local[k] || []) {
      const r = rmap.get(l.id);
      const b = base.items[l.id];
      if (!r || b === undefined) continue;
      if (l.updatedAt === b || r.updatedAt === b || l.updatedAt === r.updatedAt) continue;
      if (sameContent(l, r)) continue;
      out.push({ key: `${kind}:${l.id}:${l.updatedAt}:${r.updatedAt}`, kind, id: l.id, local: l, remote: r });
    }
  }
  if (local.globalNote && remote.globalNote) {
    const l = normalizeGlobalNote(local.globalNote), r = normalizeGlobalNote(remote.globalNote);
    if (l.updatedAt !== base.global && r.updatedAt !== base.global && l.updatedAt !== r.updatedAt && l.text !== r.text) {
      out.push({ key: `global:${l.updatedAt}:${r.updatedAt}`, kind: 'global', id: 'global', local: l, remote: r });
    }
  }
  return out;
}

/** 「両方残す」ができる競合か（どちらも削除されていないもの） */
export const canKeepBoth = (c) => c.kind === 'global' || (!c.local.deleted && !c.remote.deleted);

/**
 * 競合の解決結果をマージ済みデータへ反映する
 * @param resolved [{ conflict, choice: 'local'|'remote'|'both' }]
 */
export function applyResolutions(merged, resolved, newId, t = Date.now()) {
  const out = { ...merged };
  for (const k of ['nodes', 'templates']) if (Array.isArray(out[k])) out[k] = [...out[k]];
  const put = (list, item) => {
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) list[i] = item; else list.push(item);
  };
  for (const { conflict: c, choice } of resolved) {
    const at = Math.max(t, c.local.updatedAt, c.remote.updatedAt) + 1; // 他の端末にもこの選択が勝つように
    const win = choice === 'remote' ? c.remote : c.local;
    if (c.kind === 'global') {
      out.globalNote = {
        text: choice === 'both' ? `${c.local.text}\n\n――（ドライブ側の共通メモ）――\n${c.remote.text}` : win.text,
        updatedAt: at,
      };
      continue;
    }
    const list = c.kind === 'node' ? out.nodes : out.templates;
    put(list, { ...win, updatedAt: at });
    if (choice === 'both') {
      const copy = { ...c.remote, id: newId(), updatedAt: at };
      if (c.kind === 'node') copy.title = `${c.remote.title}（ドライブ側の版）`;
      else copy.name = `${c.remote.name}（ドライブ側の版）`;
      list.push(copy);
    }
  }
  return out;
}

/** 2つのデータが同一内容か（同期の要否判定用） */
export function sameData(a, b) {
  const ids = (list) => [...(list || [])].sort((x, y) => (x.id < y.id ? -1 : 1)).map((n) => [n.id, n.updatedAt, n.deleted]);
  const key = (d) => JSON.stringify([ids(d.nodes), ids(d.templates), normalizeGlobalNote(d.globalNote).updatedAt, normalizeWork(d.work)?.nameUpdatedAt ?? 0]);
  return key(a) === key(b);
}

/** 作品の中身を別の作品として使うため、ノードの id を振り直す（親子関係は保つ） */
export function reassignNodeIds(nodes, newId) {
  const map = new Map(nodes.map((n) => [n.id, newId()]));
  return nodes.map((n) => ({ ...n, id: map.get(n.id), parentId: n.parentId != null && map.has(n.parentId) ? map.get(n.parentId) : (n.parentId == null ? null : n.parentId) }));
}
