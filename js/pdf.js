// 縦書きPDF（同人誌入稿用）: 判型・字詰め・行数から、印刷用の縦書きHTMLを作る（DOM 非依存）
//
// ブラウザの印刷機能で「PDFに保存」して使う。用紙サイズと余白は @page で指定し、
// 縦書き（writing-mode: vertical-rl）の文書をブラウザにそのままページ分割させる。
// 文字の領域は「字詰め × 行数」から決め、天地左右の余白は中央に割り振る。
import { escapeHtml } from './util.js';
import { renderBody, renderTitle } from './richtext.js';

export const PAPERS = {
  b6: { label: 'B6（128×182mm）', w: 128, h: 182 },
  a5: { label: 'A5（148×210mm）', w: 148, h: 210 },
  a6: { label: 'A6・文庫（105×148mm）', w: 105, h: 148 },
  shinsho: { label: '新書（103×182mm）', w: 103, h: 182 },
  b5: { label: 'B5（182×257mm）', w: 182, h: 257 },
  a4: { label: 'A4（210×297mm）', w: 210, h: 297 },
};

export const DEFAULT_PDF = {
  paper: 'b6',
  fontPt: 9,
  chars: 40,        // 1行の字数
  lines: 17,        // 1ページの行数
  gapPct: 60,       // 行間（文字サイズに対する割合）。行送り = 文字サイズ × (1 + 行間)
  gutterMm: 0,      // のど（綴じ側）を広げる量
  nombre: true,     // ノンブル（ページ番号）を下中央に入れる
  chapterBreak: true, // 章ごとに改ページ
  cover: false,     // 最初に扉（作品名）のページを付ける
  font: 'mincho',   // 'mincho' | 'gothic'
  fontName: '',     // 指定すると標準のフォントより優先
};

const MM_PER_PT = 25.4 / 72;
export const MIN_MARGIN_MM = 10; // 印刷所の規定は様々なので、目安として警告するだけ

/** 設定から版面（文字の領域）と余白を計算。単位は mm */
export function pdfGeometry(o) {
  const p = PAPERS[o.paper] || PAPERS.b6;
  const fontMm = o.fontPt * MM_PER_PT;
  const pitchMm = fontMm * (1 + o.gapPct / 100);
  const areaW = o.lines * pitchMm;
  const areaH = o.chars * fontMm;
  const vert = (p.h - areaH) / 2;
  const side = (p.w - areaW) / 2;
  const g = o.gutterMm || 0;
  const warnings = [];
  let fatal = false;
  if (areaH > p.h || areaW > p.w) { fatal = true; warnings.push('文字の領域が用紙より大きくなっています。字数・行数・文字サイズを減らしてください。'); }
  else if (Math.min(vert, side - Math.abs(g)) < MIN_MARGIN_MM) warnings.push(`余白が ${MIN_MARGIN_MM}mm を下回る箇所があります。印刷所の規定を確認してください。`);
  return { paper: p, fontMm, pitchMm, areaW, areaH, vert, side, gutter: g, warnings, fatal };
}

const FONTS = {
  mincho: '"Hiragino Mincho ProN","游明朝","Yu Mincho","BIZ UDMincho","Noto Serif JP","MS Mincho",serif',
  gothic: '"Hiragino Sans","游ゴシック","Yu Gothic","BIZ UDGothic","Noto Sans JP","Meiryo",sans-serif',
};
const cssFont = (o) => {
  const name = String(o.fontName || '').replace(/["'\\<>;{}]/g, '').trim();
  return (name ? `"${name}",` : '') + (FONTS[o.font] || FONTS.mincho);
};
const n3 = (x) => (Math.round(x * 1000) / 1000) + 'mm';

/**
 * @param roots 出力するノードの配列
 * @param children (id) => 子ノードの配列
 * @param breakDepth この深さのノードの手前で改ページする（0 なら改ページしない）。roots の深さを 1 とする
 */
export function buildPdfHtml({ docTitle, roots, children, breakDepth = 1 }, o) {
  const g = pdfGeometry(o);
  const { paper: p } = g;
  // 綴じ側は奇数ページ（右綴じの本では右側のページ）の左端、偶数ページの右端
  const sideOdd = { l: g.side + g.gutter, r: g.side - g.gutter };
  const sideEven = { l: g.side - g.gutter, r: g.side + g.gutter };
  const margin = (s) => `${n3(g.vert)} ${n3(s.r)} ${n3(g.vert)} ${n3(s.l)}`;

  let first = true;
  const section = (n, depth) => {
    const brk = breakDepth > 0 && depth === breakDepth && !first;
    first = false;
    let s = `<section class="node${brk ? ' pb' : ''}"><div class="h" data-d="${Math.min(depth, 4)}">${renderTitle(n.title || '無題', { vertical: true })}</div>`;
    if (n.body) s += renderBody(n.body, { vertical: true });
    s += '</section>';
    for (const c of children(n.id)) s += section(c, depth + 1);
    return s;
  };
  let body = o.cover && docTitle ? `<section class="cover"><h1>${renderTitle(docTitle, { vertical: true })}</h1></section>` : '';
  if (o.cover && docTitle) first = false;
  for (const r of roots) body += section(r, 1);

  const css = `
@page { size: ${p.w}mm ${p.h}mm; margin: ${margin(sideOdd)};${o.nombre ? `
  @bottom-center { content: counter(page); writing-mode: horizontal-tb; font: ${Math.max(6, o.fontPt - 1)}pt ${cssFont(o)}; color: #000; vertical-align: middle; } ` : ''} }
@page :left { margin: ${margin(sideEven)}; }
html { writing-mode: vertical-rl; }
body {
  margin: 0; color: #000; background: #fff;
  font-family: ${cssFont(o)}; font-size: ${o.fontPt}pt; line-height: ${n3(g.pitchMm)};
  line-break: strict; text-align: justify; word-break: normal; overflow-wrap: break-word;
  font-kerning: none; font-variant-east-asian: normal;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
p, .md-h, .md-hr, .md-scene, .md-quote, .md-li, .md-code { margin: 0; white-space: pre-wrap; orphans: 1; widows: 1; }
p { min-block-size: ${n3(g.pitchMm)}; }
.node { margin: 0; }
.pb { break-before: page; }
.h { font-weight: 700; break-after: avoid; break-inside: avoid; }
.h[data-d="1"] { font-size: 1.5em; line-height: ${n3(g.pitchMm * 2)}; padding-block-end: ${n3(g.pitchMm)}; padding-inline-start: 3em; }
.h[data-d="2"] { font-size: 1.2em; line-height: ${n3(g.pitchMm * 2)}; padding-block-end: ${n3(g.pitchMm)}; padding-inline-start: 2em; }
.h[data-d="3"], .h[data-d="4"] { font-size: 1em; line-height: ${n3(g.pitchMm)}; padding-inline-start: 1em; }
.cover { break-after: page; text-align: center; }
.cover h1 { margin: 0 ${n3(g.pitchMm * 3)} 0 0; font-size: 2.2em; line-height: ${n3(g.pitchMm * 2)}; font-weight: 700; padding-inline: 0; }
.tcy { text-combine-upright: all; -webkit-text-combine: horizontal; }
.md-h { font-weight: 700; break-after: avoid; }
.md-hr { position: relative; block-size: ${n3(g.pitchMm)}; }
.md-hr::before { content: ""; position: absolute; inset-inline: 8%; inset-block-start: 50%; border-block-start: .5pt solid #000; }
.md-scene { text-align: center; letter-spacing: .1em; }
.md-quote { padding-inline-start: calc(var(--q, 1) * 2em); }
.md-li { padding-inline-start: calc(var(--li, 0) * 1.5em + 1.5em); text-indent: -1.5em; }
.md-li .mk { display: inline-block; inline-size: 1.5em; text-indent: 0; }
code, .md-code { font-family: monospace; font-size: .88em; }
b { font-weight: 700; }
em { font-style: normal; text-decoration: underline; text-underline-position: right; text-decoration-thickness: .5pt; }
a { color: inherit; text-decoration: none; }
ruby { ruby-align: center; ruby-position: over; }
rt { font-size: .5em; line-height: 1; font-weight: normal; }
.bt .bc { position: relative; }
.bt .bc::after { content: "﹅"; position: absolute; inset-inline: 0; inset-block-start: -1em; font-size: .5em; line-height: 1; text-align: center; font-weight: normal; }
.bt ruby .bc::after { inset-block-start: auto; inset-block-end: -1em; }
`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(docTitle || '縦書き')}</title><style>${css}</style></head><body>${body}</body></html>`;
}
