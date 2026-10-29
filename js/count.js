// 文字数・原稿用紙換算（DOM 非依存）
//
// 数える対象は「読者に見える文字」。ルビの読み（《かな》）と、ルビ・傍点の記号（｜ 《《 》》）は数えない。

export const GENKOU = { cols: 20, rows: 20 }; // 400字詰め原稿用紙

/** ルビの読み・傍点の記号を外した、見える文字だけの文字列 */
export function visibleText(s) {
  return String(s ?? '')
    .replace(/[｜|]([^｜|《》\n]{1,30}?)《[^《》\n]{1,30}》/g, '$1')
    .replace(/([\p{Script=Han}々〆ヶ〇]{1,30})《[^《》\n]{1,30}》/gu, '$1')
    .replace(/《《((?:[^《》\n])+?)》》/g, '$1')
    .replace(/[｜|]《/g, '《');
}

const len = (s) => [...s].length;

/** 文字数: all=改行を除く / nospace=空白・改行も除く */
export function countChars(text) {
  const t = visibleText(text).replace(/\n/g, '');
  return { all: len(t), nospace: len(t.replace(/[\s　]/g, '')) };
}

/**
 * 原稿用紙への換算。1行＝1段落として、段落ごとに行を改める（空行も1行使う）。
 * 戻り値: { lines, pages(小数), sheets(使う枚数) }
 */
export function genkou(text, { cols = GENKOU.cols, rows = GENKOU.rows } = {}) {
  const paras = visibleText(text).replace(/\n+$/, '').split('\n');
  if (paras.length === 1 && paras[0] === '') return { lines: 0, pages: 0, sheets: 0 };
  const lines = paras.reduce((n, p) => n + Math.max(1, Math.ceil(len(p) / cols)), 0);
  return { lines, pages: lines / rows, sheets: Math.ceil(lines / rows) };
}
