// エントリポイント
import { store } from './store.js';
import { sync } from './sync.js';
import { auth } from './drive.js';
import { $, icon, toast, isMobile } from './ui/dom.js';
import { ctx } from './ui/ctx.js';
import { initTree, renderTree, renderFilterBar, renderTreeToolbar, scrollSelectedIntoView } from './ui/tree.js';
import { renderEditor, refreshEditor, focusTitle, renderSearchNav, currentEditorId, renderSideNote } from './ui/editor.js';
import { openSearch, closeSearch, isSearchOpen, rerunSearch } from './ui/searchpanel.js';
import { openViewer, isViewerOpen, refreshViewer } from './ui/viewer.js';
import { applyTheme, toggleMenu, openSyncDialog, doLogin } from './ui/panels.js';

const main = () => $('#main');

// ---------- 画面切り替え（スマホは1画面ずつ） ----------
ctx.showScreen = (name) => {
  main().dataset.screen = name;
  const back = $('#btn-back');
  back.hidden = name === 'tree';
  if (name === 'tree') setTimeout(scrollSelectedIntoView, 0);
};

ctx.select = (id, { open = false, focusTitle: ft = false } = {}) => {
  const prev = store.ui.selectedId;
  store.ui.selectedId = id;
  store.saveUI();
  if (ctx.searchNav && ctx.searchNav.nodeId !== id) ctx.searchNav = null;
  if (prev !== id) {
    const t = $('#tree');
    t.querySelectorAll('.row.selected').forEach((r) => { r.classList.remove('selected'); r.setAttribute('aria-selected', 'false'); });
    const row = t.querySelector(`.row[data-id="${CSS.escape(id || '')}"]`);
    if (row) { row.classList.add('selected'); row.setAttribute('aria-selected', 'true'); row.scrollIntoView({ block: 'nearest' }); }
    else if (id) renderTree();
    renderEditor();
  }
  if (open && isMobile()) ctx.showScreen('editor');
  if (ft) focusTitle(); // iOS でキーボードを出すため同期的にフォーカス
};

ctx.focusEditorTitle = () => { if (isMobile()) ctx.showScreen('editor'); focusTitle(); };

ctx.refreshAll = () => {
  renderFilterBar();
  renderTree();
  renderEditor();
  refreshEditor();
  rerunSearch();
  refreshViewer();
  updateUndo();
};

function updateUndo() {
  $('#btn-undo').disabled = !store.canUndo();
  $('#btn-redo').disabled = !store.canRedo();
  $('#btn-undo').title = store.canUndo() ? `元に戻す：${store.history[store.history.length - 1].label}` : '元に戻す';
  $('#btn-redo').title = store.canRedo() ? `やり直す：${store.future[store.future.length - 1].label}` : 'やり直す';
}

// ---------- 同期表示 ----------
const SYNC_LABEL = { local: 'ローカル', synced: '同期済み', syncing: '同期中', pending: '未同期', needLogin: '再ログイン', error: '同期エラー', offline: 'オフライン' };
function renderSync(status, message) {
  const b = $('#btn-sync');
  b.dataset.status = status;
  b.querySelector('.label').textContent = SYNC_LABEL[status] || status;
  b.title = (SYNC_LABEL[status] || '') + (message ? '：' + message : '') + (status === 'local' ? '（この端末のみに保存）' : '');
}

// ---------- 初期化 ----------
async function init() {
  // アイコン
  $('#btn-back').innerHTML = icon('back');
  $('#btn-undo').innerHTML = icon('undo');
  $('#btn-redo').innerHTML = icon('redo');
  $('#btn-search').innerHTML = icon('search');
  $('#btn-view').innerHTML = icon('book');
  $('#btn-menu').innerHTML = icon('menu');

  await store.init();
  applyTheme();

  // 永続ストレージを要求（ブラウザによる自動削除の防止）
  try { if (navigator.storage?.persist) navigator.storage.persist(); } catch { /* noop */ }

  if (store.ui.selectedId && !store.get(store.ui.selectedId)) store.ui.selectedId = null;
  renderFilterBar();
  renderTreeToolbar();
  initTree();
  renderTree();
  renderEditor();
  updateUndo();
  scrollSelectedIntoView();

  // ストア変更 → 画面更新
  let treeTimer = null;
  store.on('change', (info) => {
    updateUndo();
    const f = info.fields;
    const treeFields = ['structure', 'title', 'tags', 'parentId', 'order', 'deleted', 'collapsed', 'sideNote'];
    if ([...f].some((x) => treeFields.includes(x)) || info.source !== 'local') {
      // タイトル入力中はツリーの該当行だけ更新
      if (info.source === 'local' && f.size === 1 && f.has('title') && info.ids.size === 1) {
        const id = [...info.ids][0];
        const row = $(`#tree .row[data-id="${CSS.escape(id)}"] .title`);
        if (row) { const n = store.get(id); row.textContent = n.title || '無題'; row.classList.toggle('empty', !n.title); }
        else renderTree();
      } else if (info.source === 'local' && f.size === 1 && f.has('sideNote')) {
        clearTimeout(treeTimer); treeTimer = setTimeout(renderTree, 400);
      } else {
        clearTimeout(treeTimer);
        renderTree();
        if (f.has('tags') || info.source !== 'local') renderFilterBar();
      }
    }
    const sel = store.ui.selectedId;
    if (sel && store.get(sel)?.deleted) { renderEditor(); }
    else if (info.source !== 'local' || info.ids.has(currentEditorId()) || f.has('structure')) {
      if (currentEditorId() !== sel) renderEditor(); else refreshEditor();
      renderSearchNav();
    }
    if (info.source !== 'local') { rerunSearch(); refreshViewer(); renderSideNote(); }
  });
  store.on('settings', () => applyTheme());
  store.on('error', (e) => toast(e.message, { ms: 6000 }));

  // ヘッダー
  $('#btn-back').addEventListener('click', () => {
    if (main().dataset.screen === 'search') closeSearch();
    else ctx.showScreen(isSearchOpen() ? 'search' : 'tree');
  });
  $('#btn-undo').addEventListener('click', doUndo);
  $('#btn-redo').addEventListener('click', doRedo);
  $('#btn-search').addEventListener('click', () => (isSearchOpen() && !isMobile() ? closeSearch() : openSearch()));
  $('#btn-view').addEventListener('click', openViewer);
  $('#btn-menu').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('#menu') && !e.target.closest('#btn-menu')) $('#menu').hidden = true; });
  $('#btn-sync').addEventListener('click', () => {
    if (!auth.configured) return openSyncDialog();
    if (sync.status === 'needLogin' || sync.status === 'local') return doLogin();
    if (sync.status === 'error' || sync.status === 'offline' || sync.status === 'pending' || sync.status === 'synced') return sync.run();
  });

  // キーボード
  document.addEventListener('keydown', (e) => {
    if (isViewerOpen() || document.querySelector('.modal-back')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch(); return; }
    const inText = e.target.closest && e.target.closest('input, textarea, [contenteditable]');
    if (mod && e.key.toLowerCase() === 'z' && !inText) { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
    else if (mod && e.key.toLowerCase() === 'y' && !inText) { e.preventDefault(); doRedo(); }
    else if (e.key === 'Escape') { if (!$('#menu').hidden) $('#menu').hidden = true; }
  });

  // 同期
  sync.onStatus(renderSync);
  sync.init();
  renderSync(sync.status, sync.message);

  window.addEventListener('pagehide', () => store.flush());
  registerSW();
  if (store.importedLegacy) toast(`旧版（ノベルメモ）のデータ ${store.importedLegacy} 件を引き継ぎました`, { ms: 6000 });
  if (isMobile() && !store.ui.selectedId) ctx.showScreen('tree');
}

function doUndo() {
  const e = store.undo();
  if (e) toast(`元に戻しました：${e.label}`, { ms: 2000 });
}
function doRedo() {
  const e = store.redo();
  if (e) toast(`やり直しました：${e.label}`, { ms: 2000 });
}

// ---------- Service Worker（更新は確認してから再読み込み） ----------
function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const showUpdate = (worker) => {
      const banner = $('#update-banner');
      banner.hidden = false;
      $('#btn-reload').onclick = async () => {
        await store.flush();
        worker.postMessage({ type: 'SKIP_WAITING' });
      };
    };
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(w);
      });
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((e) => console.warn('SW registration failed', e));
}

init().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<div style="padding:16px;color:#c0392b">起動に失敗しました：${String(e.message || e)}</div>`);
});
