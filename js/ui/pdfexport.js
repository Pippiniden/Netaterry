// 縦書きPDF出力（同人誌入稿用）: 組版の設定ダイアログと、印刷（PDFに保存）の起動
import { store } from '../store.js';
import { buildPdfHtml, pdfGeometry, PAPERS } from '../pdf.js';
import { genkou } from '../count.js';
import { h, modal, checkbox, radioGroup, radioValue, toast } from './dom.js';

const IFRAME_ID = 'pdf-print-frame';

/** 隠しiframeに組版済みHTMLを読み込み、印刷ダイアログを開く（「PDFに保存」を選ぶ） */
async function printHtml(html) {
  document.getElementById(IFRAME_ID)?.remove();
  const f = document.createElement('iframe');
  f.id = IFRAME_ID;
  f.setAttribute('aria-hidden', 'true');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  await new Promise((resolve) => { f.onload = resolve; f.srcdoc = html; document.body.append(f); });
  try { await f.contentDocument.fonts.ready; } catch { /* noop */ }
  const w = f.contentWindow;
  w.addEventListener('afterprint', () => setTimeout(() => f.remove(), 500));
  w.focus();
  w.print();
}

/** 別タブで組版結果を開く（そこから Ctrl+P でも印刷できる） */
function previewHtml(html) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  if (!window.open(url, '_blank')) toast('別タブを開けませんでした（ポップアップを許可してください）');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function openPdfExport() {
  const s = store.settings;
  const o = s.pdf;
  const sel = store.ui.selectedId && store.get(store.ui.selectedId);
  const hasSel = sel && !sel.deleted;
  const save = () => store.saveSettings();

  const info = h('div', { class: 'pdf-info' });
  const warn = h('div', { class: 'warn', hidden: true });
  const wrap = h('div', {});

  const roots = () => (radioValue(wrap, 'pdfscope') === 'all' ? store.children(null) : [sel]);
  const children = (id) => (radioValue(wrap, 'pdfscope') === 'node' ? [] : store.children(id));

  const update = () => {
    const g = pdfGeometry(o);
    const mm = (x) => (Math.round(x * 10) / 10);
    // ページ数の目安: 段落ごとに行を改めて、1ページの行数で割る（見出しは2行分）
    let lines = 0;
    const walk = (n) => {
      lines += 2 + (n.body ? genkou(n.body, { cols: o.chars, rows: o.lines }).lines : 0);
      children(n.id).forEach(walk);
    };
    roots().forEach(walk);
    const pages = Math.max(1, Math.ceil(lines / o.lines));
    info.innerHTML = '';
    info.append(
      h('div', {}, `1ページ ${o.chars}字 × ${o.lines}行（${mm(g.fontMm)}mm角・行送り ${mm(g.pitchMm)}mm）`),
      h('div', {}, `版面 縦${mm(g.areaH)}mm × 横${mm(g.areaW)}mm　余白 天地${mm(g.vert)}mm・左右${mm(g.side)}mm${g.gutter ? `（のど側 ${mm(g.side + g.gutter)}mm）` : ''}`),
      h('div', {}, `ページ数の目安：約 ${pages} ページ${o.cover ? '（＋扉）' : ''}（禁則処理や見出しの改ページで増減します）`));
    warn.hidden = !g.warnings.length;
    warn.textContent = g.warnings.join(' ');
    warn.classList.toggle('danger', g.fatal);
  };

  const num = (key, min, max, step = 1) => h('input', {
    type: 'number', class: 'num', value: String(o[key]), min: String(min), max: String(max), step: String(step),
    oninput: (e) => { const v = Number(e.target.value); if (Number.isFinite(v)) { o[key] = Math.max(min, Math.min(max, v)); update(); } },
    onchange: (e) => { e.target.value = o[key]; save(); },
  });
  const row = (label, input, unit = '') => h('label', { class: 'pdf-row' }, h('span', {}, label), input, unit ? h('span', { class: 'muted' }, unit) : null);

  const paperSel = h('select', { onchange: (e) => { o.paper = e.target.value; save(); update(); } },
    Object.entries(PAPERS).map(([k, p]) => h('option', { value: k, selected: o.paper === k }, p.label)));
  const fontSel = h('select', { onchange: (e) => { o.font = e.target.value; save(); } },
    [['mincho', '明朝体'], ['gothic', 'ゴシック体']].map(([k, l]) => h('option', { value: k, selected: o.font === k }, l)));
  const fontName = h('input', { type: 'text', class: 'input', value: o.fontName, placeholder: '空欄なら標準（例：游明朝）', onchange: (e) => { o.fontName = e.target.value.trim(); save(); } });

  wrap.append(
    h('h3', {}, '対象範囲'),
    radioGroup('pdfscope', [
      ['node', '選択ノードのみ', hasSel ? `（${sel.title || '無題'}）` : '（未選択）'],
      ['tree', '選択ノード＋子孫'],
      ['all', '作品全体', `（${store.work.name}）`],
    ], hasSel ? 'tree' : 'all', update),
    h('h3', {}, '判型・組版'),
    row('判型', paperSel),
    h('div', { class: 'pdf-grid' },
      row('文字サイズ', num('fontPt', 5, 20, 0.5), 'pt'),
      row('1行の字数', num('chars', 10, 80), '字'),
      row('1ページの行数', num('lines', 5, 60), '行'),
      row('行間', num('gapPct', 0, 200, 5), '%'),
      row('のどを広げる', num('gutterMm', -10, 20, 0.5), 'mm')),
    row('書体', fontSel),
    row('フォント名', fontName),
    h('div', { class: 'radios' },
      checkbox('ノンブル（ページ番号）を下中央に入れる', o.nombre, (v) => { o.nombre = v; save(); }),
      checkbox('最上位の章ごとに改ページ', o.chapterBreak, (v) => { o.chapterBreak = v; save(); }),
      checkbox('最初に扉（作品名）のページを付ける', o.cover, (v) => { o.cover = v; save(); update(); })),
    h('h3', {}, '版面'), info, warn,
    h('div', { class: 'muted pdf-help' },
      '「PDF出力」を押すと印刷ダイアログが開きます。送信先を「PDFに保存」にし、余白は「デフォルト」（用紙サイズ・余白はこの設定が使われます）、「背景のグラフィック」はお好みで選んでください。',
      ' ノンブルの表示には Chrome / Edge の最新版が必要です。'));
  if (!hasSel) wrap.querySelectorAll('input[name="pdfscope"]').forEach((i) => { if (i.value !== 'all') i.disabled = true; });
  update();

  const act = await modal({
    title: '縦書きPDF出力（同人誌入稿用）', wide: true, body: wrap,
    buttons: [
      { label: 'キャンセル', value: null },
      { label: '別タブでプレビュー', value: 'preview' },
      { label: 'PDF出力', value: 'print', primary: true, validate: () => !pdfGeometry(o).fatal },
    ],
  });
  if (!act) return;
  const scope = radioValue(wrap, 'pdfscope');
  const r = scope === 'all' ? store.children(null) : [sel];
  if (!r.length || !r[0]) { toast('出力するノードがありません'); return; }
  const html = buildPdfHtml({
    docTitle: store.work.name,
    roots: r,
    children: (id) => (scope === 'node' ? [] : store.children(id)),
    breakDepth: o.chapterBreak ? (scope === 'all' ? 1 : 2) : 0,
  }, o);
  if (act === 'preview') previewHtml(html); else await printHtml(html);
}
