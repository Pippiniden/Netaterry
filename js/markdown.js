// エクスポート整形と JSON↔Markdown 相互変換（DOM 非依存）
import { normalizeNewlines } from './util.js';

// ---------- 読み物としてのエクスポート ----------

/**
 * @param roots 出力するノード（深さ1として扱う）
 * @param tree  { children(id) } 生存ノードの子を返す
 * @param opts  { format: 'plain'|'md'|'sheet', includeNote, withDesc }
 */
export function exportText(roots, tree, { format = 'plain', includeNote = false, withDesc = true } = {}) {
  const blocks = [];
  const walk = (n, depth) => {
    blocks.push(formatNode(n, depth, format, includeNote));
    if (withDesc) tree.children(n.id).forEach((c) => walk(c, depth + 1));
  };
  roots.forEach((r) => walk(r, 1));
  const sep = format === 'sheet' ? '\n\n' : '\n\n';
  return blocks.join(sep).replace(/\n{4,}/g, '\n\n\n') + '\n';
}

function formatNode(n, depth, format, includeNote) {
  const title = n.title || '無題';
  const body = n.body.replace(/\s+$/, '');
  const note = includeNote && n.sideNote.trim() ? n.sideNote.replace(/\s+$/, '') : '';
  if (format === 'md') {
    const head = depth <= 6 ? '#'.repeat(depth) + ' ' + title : `**${title}**`;
    let s = head + (body ? '\n\n' + body : '');
    if (note) {
      const lv = Math.min(depth + 1, 6);
      s += '\n\n---\n\n' + (depth + 1 <= 6 ? '#'.repeat(lv) + ' メモ' : '**メモ**') + '\n\n' + note;
    }
    return s;
  }
  if (format === 'sheet') {
    const line = '━'.repeat(20);
    let s = `${line}\n【${title}】\n`;
    if (n.tags.length) s += `タグ：${n.tags.join('、')}\n`;
    s += line + '\n';
    s += body || '（未記入）';
    if (note) s += `\n\n―― メモ ――\n${note}`;
    return s;
  }
  // plain
  let s = title + (body ? '\n\n' + body : '');
  if (note) s += '\n\n――――――――\nメモ\n' + note;
  return s;
}

// ---------- 往復用 Markdown 書き出し ----------

const HEAD_RE = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/** 行頭の # / \# … にバックスラッシュを1つ足す（本文・サイドメモ共通） */
function escapeLine(line, { isBody }) {
  if (/^\\*#/.test(line)) return '\\' + line;
  if (isBody && /^\\*<!-- (node|sidenote)/.test(line)) return '\\' + line;
  return line;
}
function unescapeLine(line, { isBody }) {
  if (/^\\+#/.test(line)) return line.slice(1);
  if (isBody && /^\\+<!-- (node|sidenote)/.test(line)) return line.slice(1);
  return line;
}
function escapeNoteArrow(s) { return s.replace(/--(\\*)>/g, '--\\$1>'); }
function unescapeNoteArrow(s) { return s.replace(/--\\(\\*)>/g, '--$1>'); }

export function exportRoundtrip(roots, tree, { exportedAt = new Date() } = {}) {
  const out = [`<!-- netaterry v1 exported="${exportedAt.toISOString().replace(/\.\d{3}Z$/, 'Z')}" -->`, ''];
  const walk = (n, depth) => {
    const title = String(n.title).replace(/[\r\n]+/g, ' ');
    out.push('#'.repeat(Math.min(depth, 6)) + ' ' + title);
    const meta = { id: n.id };
    if (n.tags.length) meta.tags = n.tags;
    if (depth > 6) meta.depth = depth;
    out.push(`<!-- node ${JSON.stringify(meta).replace(/>/g, '\\u003e')} -->`);
    out.push('');
    if (n.body !== '') {
      normalizeNewlines(n.body).split('\n').forEach((l) => out.push(escapeLine(l, { isBody: true })));
      out.push('');
    }
    if (n.sideNote !== '') {
      out.push('<!-- sidenote');
      normalizeNewlines(n.sideNote).split('\n').forEach((l) => out.push(escapeNoteArrow(escapeLine(l, { isBody: false }))));
      out.push('-->');
      out.push('');
    }
    tree.children(n.id).forEach((c) => walk(c, depth + 1));
  };
  roots.forEach((r) => walk(r, 1));
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

// ---------- Markdown 読み込み ----------

/**
 * @returns { roundtrip, items: [{id|null, title, body, sideNote, tags, depth, line}], warnings: [string] }
 * items はファイル内の出現順。depth は 1 始まり（最初の見出しの深さを基準に補正済み）
 */
export function parseMarkdown(src) {
  const text = normalizeNewlines(src);
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const roundtrip = /^<!-- netaterry v\d+/.test(lines[0] || '');
  return roundtrip ? parseRoundtrip(lines) : parsePlain(lines);
}

function isFence(line) { return /^\s{0,3}(```|~~~)/.test(line); }

function parsePlain(lines) {
  const warnings = [];
  const items = [];
  let cur = null;
  let pre = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (isFence(line)) inFence = !inFence;
    const m = !inFence && HEAD_RE.exec(line);
    if (m) {
      cur = { id: null, title: m[2] || '', bodyLines: [], sideNote: '', tags: [], level: m[1].length, line: i + 1 };
      items.push(cur);
    } else if (cur) cur.bodyLines.push(line);
    else pre.push(line);
  });
  const trimBlank = (arr) => {
    let s = 0, e = arr.length;
    while (s < e && arr[s].trim() === '') s++;
    while (e > s && arr[e - 1].trim() === '') e--;
    return arr.slice(s, e).join('\n');
  };
  const out = [];
  const preText = trimBlank(pre);
  if (preText) out.push({ id: null, title: '無題', body: preText, sideNote: '', tags: [], depth: 1, line: 1 });
  // 見出しレベルから階層を推定
  const stack = []; // levels
  let prevDepth = out.length ? 1 : 0;
  const baseOffset = out.length ? 1 : 0; // 前付けノードがあっても兄弟として並べる
  for (const it of items) {
    while (stack.length && stack[stack.length - 1] >= it.level) stack.pop();
    let depth = stack.length + 1;
    if (depth > prevDepth + 1) depth = prevDepth + 1;
    stack.push(it.level);
    out.push({ id: null, title: it.title, body: trimBlank(it.bodyLines), sideNote: '', tags: [], depth, line: it.line });
    prevDepth = depth;
  }
  void baseOffset;
  checkJumps(items.map((it) => ({ level: it.level, line: it.line, title: it.title })), warnings);
  return { roundtrip: false, items: out, warnings };
}

function checkJumps(heads, warnings) {
  let prev = 0;
  for (const h of heads) {
    if (prev && h.level > prev + 1) warnings.push(`${h.line}行目「${h.title || '無題'}」: 見出しレベルが飛んでいます（${'#'.repeat(prev)} の次が ${'#'.repeat(h.level)}）。1つ上の階層の子として読み込みます。`);
    prev = h.level;
  }
}

function parseRoundtrip(lines) {
  const warnings = [];
  const items = [];
  let i = 1;
  const n = lines.length;
  let inFence = false;
  // 最初の見出しまでの文章
  const pre = [];
  const isHeadingAt = (k) => HEAD_RE.test(lines[k]);
  const isNodeHeadingAt = (k) => isHeadingAt(k) && /^<!-- node /.test(lines[k + 1] || '');
  while (i < n) {
    if (isNodeHeadingAt(i) || (!inFence && isHeadingAt(i))) break;
    if (isFence(lines[i])) inFence = !inFence;
    pre.push(lines[i]);
    i++;
  }
  const preText = pre.join('\n').trim();
  if (preText) items.push({ id: null, title: '無題', body: preText, sideNote: '', tags: [], depth: 1, level: 1, line: 2, metaOk: false });

  while (i < n) {
    const hm = HEAD_RE.exec(lines[i]);
    // 往復用: 「# 」の後ろをそのままタイトルにする（前後の空白も保持）
    const title = hm ? (lines[i].length > hm[1].length + 1 ? lines[i].slice(hm[1].length + 1) : '') : '';
    const it = { id: null, title, body: '', sideNote: '', tags: [], level: hm ? hm[1].length : 1, depth: null, line: i + 1, metaOk: false };
    i++;
    // ノード情報
    const mm = /^<!-- node (.*) -->\s*$/.exec(lines[i] || '');
    if (mm) {
      try {
        const meta = JSON.parse(mm[1]);
        if (meta && typeof meta.id === 'string' && meta.id) it.id = meta.id; else throw new Error('id');
        if (Array.isArray(meta.tags)) it.tags = meta.tags.map(String);
        if (typeof meta.depth === 'number' && meta.depth > 6) it.depth = meta.depth;
        it.metaOk = true;
      } catch {
        warnings.push(`${i + 1}行目「${it.title || '無題'}」: ノード情報のコメントが壊れています。新しいノードとして読み込みます。`);
      }
      i++;
      if (lines[i] === '') i++; // ノード情報の後の空行1行
    } else {
      warnings.push(`${it.line}行目「${it.title || '無題'}」: ノード情報のコメントがありません（外部エディタで削除された可能性）。新しいノードとして読み込みます。`);
      if (lines[i] === '') i++;
    }
    // 本文
    const body = [];
    inFence = false;
    while (i < n) {
      const l = lines[i];
      if (isNodeHeadingAt(i)) break;
      if (!inFence && isHeadingAt(i)) break;
      if (l === '<!-- sidenote') break;
      if (isFence(l)) inFence = !inFence;
      body.push(unescapeLine(l, { isBody: true }));
      i++;
    }
    if (body.length && body[body.length - 1] === '') body.pop();
    it.body = body.join('\n');
    // サイドメモ
    if (lines[i] === '<!-- sidenote') {
      i++;
      const note = [];
      let closed = false;
      while (i < n) {
        if (lines[i] === '-->') { closed = true; i++; break; }
        note.push(unescapeLine(unescapeNoteArrow(lines[i]), { isBody: false }));
        i++;
      }
      if (!closed) warnings.push(`${it.line}行目「${it.title || '無題'}」: サイドメモのコメントが閉じられていません。`);
      it.sideNote = note.join('\n');
      if (lines[i] === '') i++;
      // サイドメモの後に本文が続いていた場合（外部編集）は本文に追記
      const extra = [];
      while (i < n && !isHeadingAt(i)) { extra.push(unescapeLine(lines[i], { isBody: true })); i++; }
      while (extra.length && extra[extra.length - 1] === '') extra.pop();
      if (extra.length) {
        it.body += (it.body ? '\n' : '') + extra.join('\n');
        warnings.push(`${it.line}行目「${it.title || '無題'}」: サイドメモの後にある文章を本文の末尾に追加しました。`);
      }
    }
    items.push(it);
  }
  // 深さの決定と見出しレベル飛びの検出
  let prevDepth = 0;
  let prevLevel = 0;
  for (const it of items) {
    let d = it.level === 6 && it.depth ? it.depth : it.level;
    if (d > prevDepth + 1) {
      if (!(it.level === 6 && it.depth)) warnings.push(`${it.line}行目「${it.title || '無題'}」: 見出しレベルが飛んでいます（${'#'.repeat(Math.min(prevLevel, 6)) || 'なし'} の次が ${'#'.repeat(it.level)}）。1つ上の階層の子として読み込みます。`);
      else warnings.push(`${it.line}行目「${it.title || '無題'}」: 記録された深さ(${it.depth})が前のノードと合わないため補正しました。`);
      d = prevDepth + 1;
    }
    it.depth = d;
    prevDepth = d;
    prevLevel = it.level;
  }
  // id の重複
  const seen = new Set();
  for (const it of items) {
    if (!it.id) continue;
    if (seen.has(it.id)) {
      warnings.push(`${it.line}行目「${it.title || '無題'}」: idが重複しているため新しいidで作成します。`);
      it.id = null;
    } else seen.add(it.id);
  }
  return {
    roundtrip: true,
    items: items.map(({ id, title, body, sideNote, tags, depth, line }) => ({ id, title, body, sideNote, tags, depth, line })),
    warnings,
  };
}

/** 読み込み結果の items から親子関係を組み立てる。戻り値: items に parentIdx を付けたもの */
export function buildHierarchy(items) {
  const stack = [];
  return items.map((it, idx) => {
    while (stack.length && items[stack[stack.length - 1]].depth >= it.depth) stack.pop();
    const parentIdx = stack.length ? stack[stack.length - 1] : -1;
    stack.push(idx);
    return { ...it, parentIdx };
  });
}
