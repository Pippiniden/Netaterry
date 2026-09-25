// メニュー・設定・ゴミ箱・タグ管理・テーマ
import { store, ops, DEFAULT_SETTINGS, deepMerge } from '../store.js';
import { tagCounts, renameTag, deleteTag, tagKey } from '../tags.js';
import { clone, formatDate, downloadText, pickFile, stamp } from '../util.js';
import { h, $, icon, modal, confirmDialog, promptDialog, toast, checkbox, radioGroup, radioValue } from './dom.js';
import { ctx } from './ctx.js';
import { openTemplateManager } from './templates.js';
import { openExport, downloadBackup, restoreBackup, importMarkdown } from './io.js';
import { sync } from '../sync.js';
import { auth } from '../drive.js';

// ---------- テーマ ----------
export function applyTheme() {
  const s = store.settings;
  const r = document.documentElement.style;
  const e = s.editTheme;
  r.setProperty('--bg', e.bg);
  r.setProperty('--fg', e.fg);
  r.setProperty('--sel', e.sel);
  r.setProperty('--m-top', e.margin.top + 'px');
  r.setProperty('--m-right', e.margin.right + 'px');
  r.setProperty('--m-bottom', e.margin.bottom + 'px');
  r.setProperty('--m-left', e.margin.left + 'px');
  r.setProperty('--edit-font', s.editFontSize + 'px');
  const dark = luminance(e.bg) < 0.35;
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', e.bg);
  const v = $('#viewer');
  const vt = s.viewTheme;
  v.style.setProperty('--v-bg', vt.bg);
  v.style.setProperty('--v-fg', vt.fg);
  v.style.setProperty('--v-sel', vt.sel);
  v.style.setProperty('--vm-top', vt.margin.top + 'px');
  v.style.setProperty('--vm-right', vt.margin.right + 'px');
  v.style.setProperty('--vm-bottom', vt.margin.bottom + 'px');
  v.style.setProperty('--vm-left', vt.margin.left + 'px');
  v.style.setProperty('--v-font', s.viewFontSize + 'px');
  v.style.colorScheme = luminance(vt.bg) < 0.35 ? 'dark' : 'light';
}
function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

const PRESETS = {
  'ライト': { bg: '#f7f6f2', fg: '#26262a', sel: '#b9d4f5' },
  'ダーク': { bg: '#1e1f22', fg: '#d8d6d0', sel: '#3c5a86' },
  'セピア': { bg: '#f4ecd8', fg: '#2e2a24', sel: '#e6cf8f' },
  '夜間（目に優しい）': { bg: '#232520', fg: '#b9b8a8', sel: '#4a5a3c' },
  '白': { bg: '#ffffff', fg: '#111111', sel: '#bcd7ff' },
};

// ---------- メニュー ----------
export function toggleMenu(force) {
  const menu = $('#menu');
  const show = force ?? menu.hidden;
  if (!show) { menu.hidden = true; return; }
  menu.innerHTML = '';
  const item = (ic, label, fn) => h('button', { type: 'button', role: 'menuitem', onclick: () => { menu.hidden = true; fn(); } }, h('span', { html: icon(ic, 18) }), label);
  const loggedIn = auth.hasToken;
  menu.append(
    item('template', 'テンプレート管理', openTemplateManager),
    item('tag', 'タグ管理', openTagManager),
    item('trash', 'ゴミ箱', openTrash),
    h('hr'),
    item('download', 'エクスポート', openExport),
    item('list', 'Markdownを読み込む', importMarkdown),
    item('download', 'バックアップを保存（JSON）', downloadBackup),
    item('list', 'バックアップから読み込む', restoreBackup),
    h('hr'),
    item('cloud', loggedIn ? 'Googleドライブ同期（ログイン中）' : 'Googleでログイン', openSyncDialog),
    item('settings', '設定', openSettings),
    item('note', '使い方', openHelp),
  );
  menu.hidden = false;
  setTimeout(() => menu.querySelector('button')?.focus(), 10);
}

// ---------- 同期ダイアログ ----------
export async function openSyncDialog() {
  const body = h('div', {});
  if (!auth.configured) {
    body.append(
      h('p', {}, 'Googleドライブ同期はまだ設定されていません。'),
      h('p', { class: 'muted' }, 'config.js に Google Cloud の OAuth クライアントIDを設定すると、複数端末でデータを同期できます（手順は README を参照）。未設定でも、この端末内ですべての機能を使えます。'));
    await modal({ title: 'Googleドライブ同期', body });
    return;
  }
  const status = { local: 'この端末のみ（未ログイン）', synced: '同期済み', syncing: '同期中…', pending: '未同期の変更あり', needLogin: '再ログインが必要', error: 'エラー', offline: 'オフライン' }[sync.status];
  body.append(
    h('p', {}, `状態：${status}${sync.message ? '（' + sync.message + '）' : ''}`),
    sync.lastSyncAt ? h('p', { class: 'muted' }, `最終同期：${formatDate(sync.lastSyncAt)}`) : null,
    h('p', { class: 'muted' }, 'データはGoogleドライブのアプリ専用領域（ドライブの画面には表示されない場所）に保存されます。ログインの有効期限は約1時間で、切れた場合は「再ログイン」を押すと未同期の変更がそのまま同期されます。'),
  );
  const buttons = auth.hasToken
    ? [{ label: 'ログアウト', value: 'logout' }, { label: '今すぐ同期', value: 'sync', primary: true }]
    : [{ label: '閉じる', value: null }, { label: store.meta.driveFileId ? '再ログイン' : 'Googleでログイン', value: 'login', primary: true }];
  const act = await modal({ title: 'Googleドライブ同期', body, buttons });
  if (act === 'login') await doLogin();
  else if (act === 'sync') sync.run();
  else if (act === 'logout') { await sync.logout(); toast('ログアウトしました（データはこの端末に残ります）'); }
}

export async function doLogin() {
  try { await sync.login(); toast('ログインしました'); }
  catch (e) { toast('ログインできませんでした：' + e.message, { ms: 6000 }); }
}

// ---------- ゴミ箱 ----------
export async function openTrash() {
  const box = h('div', {});
  const draw = () => {
    box.innerHTML = '';
    const all = [...store.nodes.values()].filter((n) => n.deleted && !n.purged);
    const ids = new Set(all.map((n) => n.id));
    const roots = all.filter((n) => n.deletedRoot || !ids.has(n.parentId)).sort((a, b) => b.updatedAt - a.updatedAt);
    const days = store.settings.retentionDays;
    box.append(h('p', { class: 'muted' }, `削除から${days}日を過ぎたノードは、同期時に完全に削除されます（設定で変更可）。`));
    if (!roots.length) { box.append(h('p', {}, 'ゴミ箱は空です。')); return; }
    const countDesc = (id) => { let c = 0; const walk = (pid) => all.forEach((n) => { if (n.parentId === pid && !n.deletedRoot) { c++; walk(n.id); } }); walk(id); return c; };
    const list = h('div', { class: 'list' });
    roots.forEach((n) => {
      const left = Math.max(0, Math.ceil(days - (Date.now() - n.updatedAt) / 86400000));
      const dc = countDesc(n.id);
      list.append(h('div', { class: 'list-item' },
        h('div', { class: 'main' }, h('div', { class: 't' }, n.title || '無題'),
          h('div', { class: 'sub' }, `${formatDate(n.updatedAt)} 削除${dc ? `・子孫${dc}件` : ''}・あと${left}日`)),
        h('button', { type: 'button', class: 'btn small', onclick: () => { ops.restore(n.id); toast(`「${n.title || '無題'}」を復元しました`); draw(); } }, '復元'),
        h('button', { type: 'button', class: 'btn small', onclick: async () => {
          if (!(await confirmDialog(`「${n.title || '無題'}」${dc ? `と子孫${dc}件` : ''}を完全に削除します。元に戻せません（このセッション中は「元に戻す」で戻せます）。`, { ok: '完全に削除', danger: true }))) return;
          ops.purge([n.id]); draw();
        } }, '完全削除')));
    });
    box.append(list);
  };
  draw();
  const act = await modal({ title: 'ゴミ箱', wide: true, body: box, buttons: [{ label: 'ゴミ箱を空にする', value: 'empty', danger: true }, { label: '閉じる', value: null }] });
  if (act === 'empty') {
    const targets = [...store.nodes.values()].filter((n) => n.deleted && !n.purged);
    if (!targets.length) { toast('ゴミ箱は空です'); return; }
    if (await confirmDialog(`ゴミ箱内の ${targets.length} 件をすべて完全に削除します。よろしいですか？`, { ok: '空にする', danger: true })) {
      ops.purge(targets.map((n) => n.id));
      toast('ゴミ箱を空にしました');
    }
  }
}

// ---------- タグ管理 ----------
export async function openTagManager() {
  const box = h('div', {});
  const draw = () => {
    box.innerHTML = '';
    const counts = [...tagCounts()].sort((a, b) => a[0].localeCompare(b[0], 'ja'));
    if (!counts.length) { box.append(h('p', {}, 'タグはまだありません。')); return; }
    // 表記ゆれ候補（全角半角・大小文字・かな）
    const groups = new Map();
    counts.forEach(([t]) => { const k = tagKey(t, true); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
    const dup = [...groups.values()].filter((g) => g.length > 1);
    if (dup.length) {
      box.append(h('div', { class: 'warn' }, h('strong', {}, '表記ゆれの候補'), h('ul', {}, dup.map((g) => h('li', {}, g.join(' ／ '), ' ',
        h('button', { type: 'button', class: 'link', onclick: () => mergeInto(g) }, '統合する'))))));
    }
    const list = h('div', { class: 'list' });
    counts.forEach(([t, c]) => list.append(h('div', { class: 'list-item' },
      h('div', { class: 'main' }, h('div', { class: 't' }, h('span', { class: 'chip' }, t)), h('div', { class: 'sub' }, `${c}件のノード`)),
      h('button', { type: 'button', class: 'btn small', onclick: async () => {
        const to = await promptDialog(`「${t}」の新しい名前（${t}/… の階層タグもまとめて変更）`, t, { title: 'タグの名前変更', ok: '変更' });
        if (to == null || to.trim() === '' || to.trim() === t) return;
        const n = renameTag(t, to.trim());
        toast(`${n}件のノードを更新しました`, { action: () => store.undo(), actionLabel: '元に戻す' });
        draw();
      } }, '名前変更'),
      h('button', { type: 'button', class: 'btn small', onclick: () => mergeInto([t]) }, '統合'),
      h('button', { type: 'button', class: 'btn small', onclick: async () => {
        if (!(await confirmDialog(`タグ「${t}」を ${c} 件のノードから外します。`, { ok: '削除', danger: true }))) return;
        deleteTag(t);
        draw();
      } }, '削除'))));
    box.append(list);
  };
  const mergeInto = async (fromList) => {
    const others = [...tagCounts().keys()].sort((a, b) => a.localeCompare(b, 'ja'));
    const wrap = h('div', {},
      h('p', {}, `統合するタグ：${fromList.join('、')}`),
      h('label', { class: 'field' }, h('span', {}, '統合先のタグ（既存タグを選ぶか新しい名前を入力）'),
        h('input', { class: 'input', type: 'text', list: 'tag-datalist', value: fromList[0] })),
      h('datalist', { id: 'tag-datalist' }, others.map((o) => h('option', { value: o }))));
    const to = await modal({ title: 'タグの統合', body: wrap, buttons: [{ label: 'キャンセル', value: null }, { label: '統合', primary: true, value: () => wrap.querySelector('input').value.trim() }] });
    if (!to) return;
    let total = 0;
    fromList.forEach((f) => { if (f !== to) total += renameTag(f, to); });
    toast(`${total}件のノードを更新しました`, { action: () => store.undo(), actionLabel: '元に戻す' });
    draw();
  };
  draw();
  await modal({ title: 'タグ管理', wide: true, body: box });
  ctx.refreshAll();
}

// ---------- 設定 ----------
export async function openSettings() {
  const s = store.settings;
  const save = () => { store.saveSettings(); applyTheme(); ctx.refreshAll(); };
  const num = (val, min, max, on) => h('input', { type: 'number', class: 'num', value: String(val), min: String(min), max: String(max), onchange: (e) => { const v = Math.max(min, Math.min(max, Number(e.target.value) || min)); e.target.value = v; on(v); save(); } });

  const themeBox = h('div', {});
  let which = 'editTheme';
  const drawTheme = () => {
    themeBox.innerHTML = '';
    const t = s[which];
    const color = (key, label) => h('label', {}, label, h('input', { type: 'color', value: t[key], oninput: (e) => { t[key] = e.target.value; save(); } }));
    const margin = (key, label) => h('label', {}, label, num(t.margin[key], 0, 200, (v) => { t.margin[key] = v; }));
    themeBox.append(
      h('div', { class: 'seg', style: { marginBottom: '10px' } },
        h('button', { type: 'button', 'aria-pressed': String(which === 'editTheme'), onclick: () => { which = 'editTheme'; drawTheme(); } }, '編集用テーマ'),
        h('button', { type: 'button', 'aria-pressed': String(which === 'viewTheme'), onclick: () => { which = 'viewTheme'; drawTheme(); } }, '閲覧用テーマ')),
      h('div', { class: 'row-inline', style: { marginBottom: '8px' } }, h('span', { class: 'muted' }, 'プリセット:'),
        Object.entries(PRESETS).map(([name, p]) => h('button', { type: 'button', class: 'btn small', style: { background: p.bg, color: p.fg }, onclick: () => { Object.assign(t, p); save(); drawTheme(); } }, name))),
      h('div', { class: 'theme-grid' },
        color('bg', '背景色'), color('fg', '文字色'), color('sel', '選択色'),
        margin('top', '余白 上'), margin('right', '余白 右'), margin('bottom', '余白 下'), margin('left', '余白 左'),
        which === 'editTheme'
          ? h('label', {}, '文字サイズ', num(s.editFontSize, 10, 40, (v) => { s.editFontSize = v; }))
          : h('label', {}, '文字サイズ', num(s.viewFontSize, 10, 48, (v) => { s.viewFontSize = v; }))),
      h('p', { class: 'muted' }, which === 'editTheme' ? '編集用テーマはアプリ全体と編集画面に適用されます。' : '閲覧用テーマはビューモード（閲覧）に適用されます。'));
  };
  drawTheme();

  const body = h('div', {},
    h('h3', {}, '表示（この端末のみ）'), themeBox,
    h('h3', {}, '編集'),
    checkbox('オートインデント（改行時に前の行の字下げを引き継ぐ）', s.autoIndent, (v) => { s.autoIndent = v; save(); }),
    h('h3', {}, 'ビューモード'),
    h('div', { class: 'radios' },
      checkbox('縦書き', s.viewVertical, (v) => { s.viewVertical = v; save(); }),
      checkbox('ページめくり表示', s.viewPaged, (v) => { s.viewPaged = v; save(); }),
      checkbox('最上位ノードごとに改ページ', s.viewPageBreakTop, (v) => { s.viewPageBreakTop = v; save(); }),
      checkbox('タグを表示', s.viewShowTags, (v) => { s.viewShowTags = v; save(); })),
    h('h3', {}, 'タグ・検索'),
    checkbox('ひらがなとカタカナを同一視する（「きゃら」と「キャラ」を同じタグとして扱う）', s.kanaFold, (v) => { s.kanaFold = v; store.ui.searchOpts.kanaFold = null; store.saveUI(); save(); }),
    h('p', { class: 'muted' }, '切り替えても保存済みのタグの文字列は変わりません（比較方法だけが変わります）。'),
    h('h3', {}, 'エクスポート時のサイドメモ'),
    radioGroup('snexp', [['ask', '毎回確認する'], ['include', '常に含める'], ['exclude', '常に含めない']], s.sideNoteExport, (v) => { s.sideNoteExport = v; save(); }),
    h('h3', {}, 'ゴミ箱・同期'),
    h('div', { class: 'row-inline' }, h('span', {}, 'ゴミ箱の保持期間'), num(s.retentionDays, 1, 3650, (v) => { s.retentionDays = v; }), h('span', {}, '日')),
    h('div', { class: 'row-inline', style: { marginTop: '6px' } }, h('span', {}, '編集後の自動同期まで'), num(s.autoSyncDelay, 1, 600, (v) => { s.autoSyncDelay = v; }), h('span', {}, '秒')),
    h('h3', {}, '設定ファイル'),
    h('p', { class: 'muted' }, '表示設定はこの端末にだけ保存されます。別の端末で同じ見た目にしたいときは、設定ファイルを書き出して読み込んでください。'),
    h('div', { class: 'row-inline' },
      h('button', { type: 'button', class: 'btn small', onclick: exportSettings }, '設定を書き出す'),
      h('button', { type: 'button', class: 'btn small', onclick: async () => { await importSettings(); drawTheme(); } }, '設定を読み込む'),
      h('button', { type: 'button', class: 'btn small', onclick: async () => {
        if (!(await confirmDialog('設定を初期状態に戻しますか？（データは消えません）'))) return;
        store.settings = clone(DEFAULT_SETTINGS); save(); toast('設定を初期化しました');
      } }, '初期設定に戻す')),
    h('h3', {}, 'ストレージ'),
    h('p', { class: 'muted', id: 'storage-info' }, '確認中…'),
  );
  (async () => {
    const el = body.querySelector('#storage-info');
    try {
      const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
      const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
      el.textContent = `ブラウザによる自動削除の防止：${persisted ? '有効' : '未許可（ホーム画面に追加すると保護されやすくなります）'}` + (est ? `／使用量 約${Math.round((est.usage || 0) / 1024)}KB` : '');
    } catch { el.textContent = ''; }
  })();
  await modal({ title: '設定', wide: true, body });
}

function exportSettings() {
  const data = { kind: 'netaterry-settings', version: 1, settings: store.settings };
  downloadText(`netaterry-settings-${stamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
}

async function importSettings() {
  const f = await pickFile('.json,application/json');
  if (!f) return;
  let data;
  try {
    data = JSON.parse(f.text);
    if (data.kind !== 'netaterry-settings' || !data.settings) throw new Error('設定ファイルではありません');
  } catch (e) { toast('読み込めません：' + e.message); return; }
  const wrap = h('div', {},
    h('p', {}, '画面の幅に依存する項目（余白）を適用しますか？'),
    radioGroup('margins', [['no', '適用しない（この端末の余白を維持）'], ['yes', '適用する']], 'no'));
  const res = await modal({ title: '設定の読み込み', body: wrap, buttons: [{ label: 'キャンセル', value: null }, { label: '読み込む', primary: true, value: () => radioValue(wrap, 'margins') }] });
  if (!res) return;
  const incoming = clone(data.settings);
  if (res === 'no') {
    if (incoming.editTheme) incoming.editTheme.margin = clone(store.settings.editTheme.margin);
    if (incoming.viewTheme) incoming.viewTheme.margin = clone(store.settings.viewTheme.margin);
  }
  store.settings = deepMerge(clone(DEFAULT_SETTINGS), deepMerge(clone(store.settings), incoming));
  await store.saveSettings();
  applyTheme();
  ctx.refreshAll();
  toast('設定を読み込みました');
}

// ---------- 使い方 ----------
export function openHelp() {
  modal({
    title: '使い方', wide: true,
    body: h('div', { html: `
<h3>基本</h3>
<p>左のツリーでノードを選び、右側でタイトル・タグ・本文を書きます。スマホではノードをタップすると編集画面が開きます。変更は自動で保存されます。</p>
<h3>ノード操作</h3>
<p>＋ 下に兄弟ノード／↳ 子ノード／↑↓ 並べ替え／⇤⇥ 階層の上げ下げ／複製／削除（ゴミ箱へ）。PCではドラッグ＆ドロップでも移動できます。</p>
<p>PCのツリー操作キー：↑↓ 選択、←→ 開閉、Tab / Shift+Tab 階層、Alt+↑↓ 移動、Ctrl+Enter 兄弟追加、Enter 編集、Delete 削除。</p>
<h3>タグ</h3>
<p>Enter または「,」「、」で確定。<code>キャラ/主人公</code> のように「/」で区切ると、<code>キャラ</code> で絞り込んだときにまとめて表示されます。</p>
<h3>検索</h3>
<p><code>語1 語2</code>（すべて含む）、<code>-語</code>（含まない）、<code>"語 句"</code>、<code>tag:タグ</code>、<code>in:title</code> / <code>in:body</code> / <code>in:note</code>。検索結果から一括置換もできます。</p>
<h3>テンプレート</h3>
<p>本文に <code>{{名前}}</code> のような変数を書いておくと、呼び出し時に入力欄が出ます。</p>
<h3>閲覧モード</h3>
<p>本の形で読み返せます。縦書き・ページめくりに対応。ページめくりでは画面の左右タップ・スワイプ・矢印キーでめくり、中央タップでメニューを表示します。</p>
<h3>データの保護</h3>
<p>データはこの端末（ブラウザ）内に保存されます。iPhone/iPad では「ホーム画面に追加」して使うと、データが自動削除されにくくなります。定期的にメニューの「バックアップを保存」もおすすめします。</p>` }),
  });
}
