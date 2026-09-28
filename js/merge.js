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
