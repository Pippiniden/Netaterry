// データ移行・ノード単位マージ・トゥームストーン掃除（純粋関数）
import { SCHEMA_VERSION, clampTime } from './util.js';

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

/** 保存ファイルを現在のスキーマへ移行 */
export function migrate(data) {
  if (!data || typeof data !== 'object') throw new Error('データ形式が正しくありません');
  const v = data.schemaVersion ?? 0;
  if (v > SCHEMA_VERSION) throw new Error(`新しい形式のデータです（schemaVersion ${v}）。アプリを更新してください。`);
  // v0（schemaVersion なし）→ v1: フィールド補完のみ
  // v1 → v2: 共通メモ（globalNote）を追加。v1 には無いので空で補う
  const nodes = (Array.isArray(data.nodes) ? data.nodes : []).filter((n) => n && n.id != null).map(normalizeNode);
  const templates = (Array.isArray(data.templates) ? data.templates : []).filter((t) => t && t.id != null).map(normalizeTemplate);
  return { schemaVersion: SCHEMA_VERSION, nodes, templates, globalNote: normalizeGlobalNote(data.globalNote) };
}

/** 共通メモ（どのノードからでも見られるメモ）。空で未編集なら updatedAt は 0 */
export function normalizeGlobalNote(g) {
  if (!g || typeof g !== 'object') return { text: '', updatedAt: 0 };
  return { text: String(g.text ?? ''), updatedAt: g.updatedAt ? clampTime(g.updatedAt) : 0 };
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

/** ノード・テンプレート単位の Last Write Wins マージ */
export function mergeData(local, remote) {
  return {
    schemaVersion: SCHEMA_VERSION,
    nodes: mergeList(local.nodes, remote.nodes),
    templates: mergeList(local.templates, remote.templates),
    globalNote: mergeGlobalNote(local.globalNote, remote.globalNote),
  };
}

/** 共通メモも新しい方を採用（Last Write Wins） */
function mergeGlobalNote(a, b) {
  const x = normalizeGlobalNote(a), y = normalizeGlobalNote(b);
  return y.updatedAt > x.updatedAt ? y : x;
}

/** 保持期間を過ぎたトゥームストーンを物理削除 */
export function cleanupTombstones(data, retentionDays, t = Date.now()) {
  const limit = t - retentionDays * 24 * 60 * 60 * 1000;
  const keep = (x) => !(x.deleted && x.updatedAt < limit);
  const nodes = data.nodes.filter(keep);
  const templates = data.templates.filter(keep);
  return {
    data: { schemaVersion: SCHEMA_VERSION, nodes, templates, globalNote: normalizeGlobalNote(data.globalNote) },
    removed: data.nodes.length - nodes.length + data.templates.length - templates.length,
  };
}

/** 2つのデータが同一内容か（同期の要否判定用） */
export function sameData(a, b) {
  const key = (d) => JSON.stringify([
    [...d.nodes].sort((x, y) => (x.id < y.id ? -1 : 1)).map((n) => [n.id, n.updatedAt, n.deleted]),
    [...d.templates].sort((x, y) => (x.id < y.id ? -1 : 1)).map((n) => [n.id, n.updatedAt, n.deleted]),
    normalizeGlobalNote(d.globalNote).updatedAt,
  ]);
  return key(a) === key(b);
}
