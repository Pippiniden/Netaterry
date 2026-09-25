// 閲覧モード用の本文記法 → HTML 変換（DOM 非依存）
//
// 本文は「1行＝1段落」として扱う（小説の改行をそのまま生かす。Markdown のような行の連結はしない）。
// どの要素も行送り（line-height）を変えないように作り、縦書き・ページめくりでも崩れないようにする。
//
// ブロック（行単位）
//   # 見出し 〜 ###### 見出し / - * + 箇条書き / 1. 番号付き / > 引用 / ``` コード
//   --- ___ 区切り線 / *** ＊＊＊ ◇◇◇ など 場面転換
// インライン
//   ｜漢字《かんじ》 |漢字《かんじ》 漢字《かんじ》 ルビ（｜《 で《をそのまま表示）
//   《《傍点》》 / **太字** __太字__ / *斜体* _斜体_ / ~~取り消し~~ / `コード` / [文字](https://…)
//   \* のようにバックスラッシュで記号をそのまま表示

import { escapeHtml } from './util.js';

const esc = escapeHtml;

// ---------- インライン ----------

/** 縦中横: 2桁までの半角数字と !! !? ?! ?? */
function tcy(s) {
  return s.split(/((?<![0-9])[0-9]{1,2}(?![0-9])|(?<![!?])[!?]{2}(?![!?]))/)
    .map((p, i) => (i % 2 ? `<span class="tcy">${esc(p)}</span>` : esc(p)))
    .join('');
}

const HAN = '\\p{Script=Han}々〆ヶ〇';
const RULES = [
  // バックスラッシュエスケープ
  { re: /\\([\\`*_~#>|｜《》[\]()!+.\-])/y, out: (m) => ({ text: m[1] }) },
  // インラインコード（中は解釈しない）
  { re: /`([^`\n]+)`/y, out: (m) => ({ html: `<code>${esc(m[1])}</code>` }) },
  // 傍点《《…》》（ルビより先に判定）
  { re: /《《((?:[^《》\n]|《[^《》\n]*》)+?)》》/y, out: (m, ctx) => ({ html: bouten(m[1], ctx) }) },
  // ｜《 → 《 をそのまま表示
  { re: /[｜|]《/y, out: () => ({ text: '《' }) },
  // ルビ（親文字を ｜ で指定）
  { re: /[｜|]([^｜|《》\n]{1,30}?)《([^《》\n]{1,30})》/y, out: (m, ctx) => ({ html: ruby(m[1], m[2], ctx) }), ruby: true },
  // ルビ（直前の漢字の連続を親文字にする）
  { re: new RegExp(`([${HAN}]{1,30})《([^《》\\n]{1,30})》`, 'uy'), out: (m, ctx) => ({ html: ruby(m[1], m[2], ctx) }), ruby: true },
  // 太字
  { re: /\*\*(?=\S)(.+?)(?<=\S)\*\*/y, out: (m, ctx) => ({ html: `<b>${inline(m[1], ctx)}</b>` }) },
  { re: /__(?=\S)(.+?)(?<=\S)__/y, out: (m, ctx) => ({ html: `<b>${inline(m[1], ctx)}</b>` }) },
  // 取り消し線
  { re: /~~(?=\S)(.+?)(?<=\S)~~/y, out: (m, ctx) => ({ html: `<s>${inline(m[1], ctx)}</s>` }) },
  // 斜体（縦書きでは傍線で表現）
  { re: /\*(?=[^\s*])(.+?)(?<=[^\s*])\*/y, out: (m, ctx) => ({ html: `<em>${inline(m[1], ctx)}</em>` }) },
  { re: /_(?=[^\s_])(.+?)(?<=[^\s_])_(?![A-Za-z0-9])/uy, out: (m, ctx) => ({ html: `<em>${inline(m[1], ctx)}</em>` }), wordStart: true },
  // リンク（http / https のみ）
  { re: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/y, out: (m, ctx) => ({ html: `<a href="${esc(m[2])}" target="_blank" rel="noopener noreferrer">${inline(m[1], ctx)}</a>` }) },
];

function ruby(base, rt, ctx) {
  return `<ruby>${inline(base, { ...ctx, noRuby: true })}<rt>${esc(rt)}</rt></ruby>`;
}

/** 傍点: 1文字ずつ印を付ける（行間に重ねて描くので行送りは変わらない） */
function bouten(text, ctx) {
  // 中のルビ・太字なども生かしたいので、まずインライン変換してから文字単位に包む
  const inner = inline(text, ctx);
  return `<span class="bt">${wrapChars(inner)}</span>`;
}
/** HTML 文字列中のテキスト部分を1文字ずつ <span class="bc"> で包む（タグ・rt 内は除く） */
function wrapChars(html) {
  let out = '';
  let inRt = 0;
  const re = /(<[^>]+>)|(&[a-z#0-9]+;)|([\s\S])/giu;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) {
      if (/^<rt\b/i.test(m[1])) inRt++;
      else if (/^<\/rt>/i.test(m[1])) inRt--;
      out += m[1];
    } else {
      const ch = m[2] || m[3];
      out += inRt || /^\s$/.test(ch) ? ch : `<span class="bc">${ch}</span>`;
    }
  }
  return out;
}

/**
 * インライン記法の変換
 * @param ctx { vertical: boolean, noRuby?: boolean }
 */
export function inline(text, ctx = {}) {
  let out = '';
  let buf = '';
  const flush = () => { if (buf) { out += ctx.vertical ? tcy(buf) : esc(buf); buf = ''; } };
  let i = 0;
  const s = String(text ?? '');
  outer: while (i < s.length) {
    for (const rule of RULES) {
      if (ctx.noRuby && rule.ruby) continue;
      if (rule.wordStart && i > 0 && /[A-Za-z0-9]/.test(s[i - 1])) continue; // snake_case は斜体にしない
      rule.re.lastIndex = i;
      const m = rule.re.exec(s);
      if (!m) continue;
      const end = i + m[0].length; // 入れ子の変換で正規表現の lastIndex が書き換わるので先に控える
      const r = rule.out(m, ctx);
      if (r.text != null) buf += r.text;
      else { flush(); out += r.html; }
      i = end;
      continue outer;
    }
    buf += s[i];
    i++;
  }
  flush();
  return out;
}

// ---------- ブロック ----------

const FENCE = /^\s{0,3}(```|~~~)/;
const HR = /^\s{0,3}([-_])(?:[ \t]*\1){2,}[ \t]*$/;
const SCENE_STAR = /^[ \t　]*(?:\*[ \t　]*){3,}$/;
const SCENE_SYM = /^[ \t　]*([＊☆★◇◆◈○●◎♢])(?:[ \t　]*[＊☆★◇◆◈○●◎♢]){0,8}[ \t　]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const QUOTE = /^((?:[ \t]*>)+)[ \t]?(.*)$/;
const BULLET = /^([ \t　]*)([-*+])[ \t]+(.*)$/;
const ORDERED = /^([ \t　]*)(\d{1,4})([.)．）])[ \t]+(.*)$/;

function indentLevel(ws) {
  let n = 0;
  for (const c of ws) n += c === '\t' ? 4 : c === '　' ? 2 : 1;
  return Math.min(6, Math.floor(n / 2));
}

/**
 * 本文をブロック HTML に変換
 * @param text 本文
 * @param opts { vertical: boolean, key: () => string } key は位置保持用の data-k を払い出す
 * @returns HTML 文字列
 */
export function renderBody(text, { vertical = false, key = () => '' } = {}) {
  const ctx = { vertical };
  const lines = String(text ?? '').replace(/\s+$/, '').split('\n');
  let out = '';
  let fence = false;
  const k = () => { const v = key(); return v === '' ? '' : ` data-k="${v}"`; };
  for (const line of lines) {
    if (FENCE.test(line)) { fence = !fence; continue; }
    if (fence) { out += `<div class="md-code"${k()}>${esc(line) || '&#8203;'}</div>`; continue; }
    if (line.trim() === '') { out += `<p class="blank"${k()}></p>`; continue; }
    let m;
    if (HR.test(line)) { out += `<div class="md-hr" role="separator"${k()}></div>`; continue; }
    if (SCENE_STAR.test(line)) { out += `<div class="md-scene" role="separator"${k()}>＊　＊　＊</div>`; continue; }
    if (SCENE_SYM.test(line)) { out += `<div class="md-scene" role="separator"${k()}>${esc(line.trim())}</div>`; continue; }
    if ((m = HEADING.exec(line))) { out += `<div class="md-h" data-l="${m[1].length}"${k()}>${inline(m[2], ctx)}</div>`; continue; }
    if ((m = QUOTE.exec(line))) {
      const lv = Math.min(4, (m[1].match(/>/g) || []).length);
      out += `<div class="md-quote" style="--q:${lv}"${k()}>${inline(m[2], ctx) || '&#8203;'}</div>`;
      continue;
    }
    if ((m = BULLET.exec(line))) {
      out += `<div class="md-li" style="--li:${indentLevel(m[1])}"${k()}><span class="mk" aria-hidden="true">・</span>${inline(m[3], ctx)}</div>`;
      continue;
    }
    if ((m = ORDERED.exec(line))) {
      const num = vertical ? tcy(m[2]) + '．' : esc(m[2]) + '.';
      out += `<div class="md-li ol" style="--li:${indentLevel(m[1])}"${k()}><span class="mk">${num}</span>${inline(m[4], ctx)}</div>`;
      continue;
    }
    out += `<p${k()}>${inline(line, ctx)}</p>`;
  }
  return out;
}

/** タイトル（見出し）用: インライン記法のみ */
export function renderTitle(text, { vertical = false } = {}) {
  return inline(text, { vertical });
}
