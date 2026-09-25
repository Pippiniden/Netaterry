// 検索エンジン（端末内で全件走査）
import { normalize, normalizeWithMap } from './util.js';

const FIELD_ALIASES = { title: 'title', body: 'body', note: 'sideNote', memo: 'sideNote', sidenote: 'sideNote', t: 'title', b: 'body' };

/** 検索語の解析 */
export function parseQuery(q) {
  const res = { terms: [], tags: [], fields: null, raw: q, errors: [] };
  const re = /(-?)(?:(tag|in):)?(?:"([^"]*)"?|(\S+))/g;
  let m;
  while ((m = re.exec(q))) {
    const neg = m[1] === '-';
    const kind = m[2];
    const val = m[3] !== undefined ? m[3] : m[4];
    if (val === undefined || val === '') { if (m[0] === '') re.lastIndex++; continue; }
    if (kind === 'tag') res.tags.push({ tag: val, neg });
    else if (kind === 'in') {
      const f = FIELD_ALIASES[val.toLowerCase()];
      if (f) { res.fields = res.fields || new Set(); res.fields.add(f); }
      else res.errors.push(`in:${val} は使えません（title / body / note）`);
    } else res.terms.push({ text: val, neg, quoted: m[3] !== undefined });
  }
  return res;
}

function tagMatch(nodeTag, sel, kanaFold) {
  const a = normalize(nodeTag.trim(), kanaFold);
  const b = normalize(sel.trim(), kanaFold);
  return a === b || a.startsWith(b + '/');
}

function findAll(hay, needle) {
  const out = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i >= 0) { out.push(i); i = hay.indexOf(needle, i + needle.length); }
  return out;
}

/**
 * @param nodes 検索対象ノード（配列）
 * @param query 文字列
 * @param opts { note, kanaFold, regex }
 * @returns { results: [{node, matches:[{field,start,end,term}], count, titleHit}], parsed, error }
 */
export function search(nodes, query, opts = {}) {
  const parsed = parseQuery(query);
  const kanaFold = !!opts.kanaFold;
  let fields = parsed.fields ? [...parsed.fields] : ['title', 'body', ...(opts.note ? ['sideNote'] : [])];
  if (parsed.fields && !opts.note && parsed.fields.has('sideNote')) fields = [...parsed.fields];
  const pos = parsed.terms.filter((t) => !t.neg);
  const neg = parsed.terms.filter((t) => t.neg);
  if (!pos.length && !neg.length && !parsed.tags.length) return { results: [], parsed, error: null };

  let regex = null;
  if (opts.regex && pos.length) {
    try { regex = new RegExp(pos.map((t) => t.text).join(' '), 'giu'); }
    catch (e) { return { results: [], parsed, error: '正規表現が正しくありません: ' + e.message }; }
  }

  const results = [];
  for (const node of nodes) {
    // タグ条件
    let ok = true;
    for (const tc of parsed.tags) {
      const has = node.tags.some((t) => tagMatch(t, tc.tag, kanaFold));
      if (has === tc.neg) { ok = false; break; }
    }
    if (!ok) continue;
    const normCache = {};
    const norm = (f) => (normCache[f] ||= normalizeWithMap(node[f] || '', kanaFold));
    // 除外語
    for (const t of neg) {
      const nt = normalize(t.text, kanaFold);
      if (fields.some((f) => norm(f).text.includes(nt))) { ok = false; break; }
    }
    if (!ok) continue;
    const matches = [];
    if (regex) {
      for (const f of fields) {
        const s = node[f] || '';
        regex.lastIndex = 0;
        let m;
        while ((m = regex.exec(s))) {
          if (m[0] === '') { regex.lastIndex++; continue; }
          matches.push({ field: f, start: m.index, end: m.index + m[0].length, term: 0 });
        }
      }
      if (!matches.length) continue;
    } else {
      for (let ti = 0; ti < pos.length; ti++) {
        const nt = normalize(pos[ti].text, kanaFold);
        let found = false;
        for (const f of fields) {
          const { text, map } = norm(f);
          for (const i of findAll(text, nt)) {
            matches.push({ field: f, start: map[i], end: map[i + nt.length], term: ti });
            found = true;
          }
        }
        if (!found) { ok = false; break; }
      }
      if (!ok) continue;
    }
    const order = { title: 0, body: 1, sideNote: 2 };
    matches.sort((a, b) => order[a.field] - order[b.field] || a.start - b.start);
    results.push({ node, matches, count: matches.length, titleHit: matches.some((m) => m.field === 'title') });
  }
  return { results, parsed, error: null, regex };
}

/** 抜粋（一致箇所の前後）を HTML 片の配列で返す: [{text, hit}] */
export function excerpt(text, matches, radius = 28) {
  if (!matches.length) {
    const s = text.slice(0, radius * 2).replace(/\n/g, ' ');
    return [{ text: s + (text.length > radius * 2 ? '…' : ''), hit: false }];
  }
  const first = matches[0];
  const from = Math.max(0, first.start - radius);
  const to = Math.min(text.length, first.end + radius * 2);
  const parts = [];
  if (from > 0) parts.push({ text: '…', hit: false });
  let cur = from;
  for (const m of matches) {
    if (m.start < cur || m.start >= to) continue;
    parts.push({ text: text.slice(cur, m.start), hit: false });
    parts.push({ text: text.slice(m.start, Math.min(m.end, to)), hit: true });
    cur = Math.min(m.end, to);
  }
  parts.push({ text: text.slice(cur, to), hit: false });
  if (to < text.length) parts.push({ text: '…', hit: false });
  return parts.map((p) => ({ ...p, text: p.text.replace(/\n/g, ' ↵ ') }));
}

/**
 * 置換対象の一覧を作る。検索語（肯定語）が1つ、または正規表現のときのみ。
 * @returns { items: [{key, nodeId, field, start, end, before, after}], error }
 */
export function planReplace(searchResult, replacement) {
  const { results, parsed, regex } = searchResult;
  const pos = parsed.terms.filter((t) => !t.neg);
  if (!regex && pos.length !== 1) return { items: [], error: '置換は検索語（除外語・tag:・in: 以外）が1つのときに使えます。' };
  const items = [];
  for (const r of results) {
    for (const m of r.matches) {
      if (!regex && m.term !== 0) continue;
      const src = r.node[m.field];
      const matched = src.slice(m.start, m.end);
      const after = regex ? matched.replace(new RegExp(regex.source, regex.flags.replace('g', '')), replacement) : replacement;
      items.push({
        key: `${r.node.id}:${m.field}:${m.start}`,
        nodeId: r.node.id, field: m.field, start: m.start, end: m.end,
        matched, after,
        ctxBefore: src.slice(Math.max(0, m.start - 16), m.start).replace(/\n/g, ' ↵ '),
        ctxAfter: src.slice(m.end, m.end + 16).replace(/\n/g, ' ↵ '),
      });
    }
  }
  return { items, error: null };
}

/** 置換を文字列に適用（後ろから） */
export function applyReplacements(text, items) {
  const sorted = [...items].sort((a, b) => b.start - a.start);
  let s = text;
  let lastStart = Infinity;
  for (const it of sorted) {
    if (it.end > lastStart) continue; // 重なりは無視
    s = s.slice(0, it.start) + it.after + s.slice(it.end);
    lastStart = it.start;
  }
  return s;
}
