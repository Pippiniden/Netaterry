// タグの正規化・集計・一括操作
import { normalize, normalizeWithMap } from './util.js';
import { store } from './store.js';

/** 重複判定用キー（全角半角・大小文字を統一、設定に応じてかなを同一視） */
export function tagKey(tag, kanaFold = store.settings.kanaFold) {
  return normalize(String(tag).trim(), kanaFold);
}

export function cleanTag(s) {
  return String(s ?? '').replace(/[\r\n]/g, ' ').trim();
}

/** 全タグの使用数（生きているノードのみ）: Map<表示名, 件数> */
export function tagCounts() {
  const m = new Map();
  for (const n of store.nodes.values()) {
    if (n.deleted) continue;
    for (const t of n.tags) m.set(t, (m.get(t) || 0) + 1);
  }
  return m;
}

/** 絞り込み: 選択タグ sel がノードのタグ tags にマッチするか（階層タグは前方一致） */
export function tagMatches(nodeTag, sel, kanaFold = store.settings.kanaFold) {
  const a = tagKey(nodeTag, kanaFold);
  const b = tagKey(sel, kanaFold);
  return a === b || a.startsWith(b + '/');
}

export function nodeHasTag(node, sel) {
  return node.tags.some((t) => tagMatches(t, sel));
}

/**
 * 補完候補。入力 q に部分一致する既存タグを使用数順に。
 * 正規化キーが一致する（表記ゆれ）既存タグは先頭に出す。
 */
export function suggestTags(q, exclude = [], limit = 8) {
  const counts = tagCounts();
  const ex = new Set(exclude.map((t) => tagKey(t)));
  const qk = tagKey(q);
  const qkFold = tagKey(q, true);
  const items = [];
  for (const [tag, count] of counts) {
    if (ex.has(tagKey(tag))) continue;
    const k = tagKey(tag);
    const kFold = tagKey(tag, true);
    let rank;
    if (qk && k === qk) rank = 0;
    else if (qk && store.settings.kanaFold && kFold === qkFold) rank = 0;
    else if (!qk || k.includes(qk)) rank = 2;
    else if (store.settings.kanaFold && kFold.includes(qkFold)) rank = 2;
    else continue;
    items.push({ tag, count, rank, similar: rank === 0 && tag !== q.trim() });
  }
  items.sort((a, b) => a.rank - b.rank || b.count - a.count || a.tag.localeCompare(b.tag, 'ja'));
  return items.slice(0, limit);
}

/** 既存タグに表記ゆれ（全角半角・大小文字）で一致するものがあればその表記を返す */
export function canonicalTag(tag) {
  const k = tagKey(tag, false);
  let best = null, bestCount = 0;
  for (const [t, c] of tagCounts()) {
    if (tagKey(t, false) === k && c > bestCount) { best = t; bestCount = c; }
  }
  return best || tag;
}

/** 名前変更・統合（from の全表記 → to）。階層タグの子（from/xxx）も書き換える */
export function renameTag(from, to, { includeChildren = true } = {}) {
  to = cleanTag(to);
  if (!to) return 0;
  const fk = tagKey(from, false);
  let count = 0;
  store.batch(`タグ「${from}」を「${to}」に変更`, (tx) => {
    for (const n of store.nodes.values()) {
      if (n.deleted) continue;
      let changed = false;
      const next = [];
      for (const t of n.tags) {
        const k = tagKey(t, false);
        let nt = t;
        if (k === fk) nt = to;
        else if (includeChildren && k.startsWith(fk + '/')) {
          const { map } = normalizeWithMap(t.trim());
          nt = to + '/' + t.trim().slice(map[fk.length] + 1);
        }
        if (nt !== t) changed = true;
        if (!next.some((x) => tagKey(x) === tagKey(nt))) next.push(nt); else changed = true;
      }
      if (changed) { tx.update(n.id, { tags: next }); count++; }
    }
  });
  return count;
}

export function deleteTag(tag) {
  const k = tagKey(tag, false);
  let count = 0;
  store.batch(`タグ「${tag}」を削除`, (tx) => {
    for (const n of store.nodes.values()) {
      if (n.deleted) continue;
      const next = n.tags.filter((t) => tagKey(t, false) !== k);
      if (next.length !== n.tags.length) { tx.update(n.id, { tags: next }); count++; }
    }
  });
  return count;
}

/** ノードにタグを追加（重複しない） */
export function addTagsTo(tags, add) {
  const out = [...tags];
  for (const t of add) {
    const c = cleanTag(t);
    if (c && !out.some((x) => tagKey(x) === tagKey(c))) out.push(c);
  }
  return out;
}
