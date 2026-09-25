// Google Drive との同期（差分チェック・ノード単位マージ・上書き防止）
import { store } from './store.js';
import { auth, drive, AuthError, NotFoundError } from './drive.js';
import { mergeData, cleanupTombstones, migrate } from './merge.js';

let running = null;
let again = false;
const listeners = [];

export const sync = {
  status: 'local',   // local | synced | syncing | pending | needLogin | error | offline
  message: '',
  lastSyncAt: null,

  onStatus(fn) { listeners.push(fn); },
  _set(status, message = '') {
    this.status = status;
    this.message = message;
    listeners.forEach((fn) => fn(status, message));
  },

  init() {
    auth.restore();
    this.refreshStatus();
    store.on('dirty', () => this.refreshStatus());
    store.on('change', (info) => {
      if (info.source === 'sync-replace' || info.source === 'sync-merge') return;
      if (auth.hasToken) this.scheduleAuto();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && auth.hasToken) this.run();
      if (document.visibilityState === 'hidden') { store.flush(); if (auth.hasToken && store.meta.dirty) this.scheduleAuto.flush(); }
    });
    window.addEventListener('online', () => { if (auth.hasToken) this.run(); });
    if (auth.hasToken) this.run();
  },

  refreshStatus() {
    if (this.status === 'syncing') return;
    if (!auth.hasToken) {
      if (store.meta.driveFileId) this._set('needLogin', store.meta.dirty ? '未同期の変更があります' : '');
      else this._set('local');
      return;
    }
    this._set(store.meta.dirty ? 'pending' : 'synced');
  },

  scheduleAuto: Object.assign(function () {
    clearTimeout(sync._autoTimer);
    sync._autoTimer = setTimeout(() => sync.run(), Math.max(1, Number(store.settings.autoSyncDelay) || 5) * 1000);
  }, { flush() { if (sync._autoTimer) { clearTimeout(sync._autoTimer); sync._autoTimer = null; sync.run(); } } }),
  _autoTimer: null,

  async login() {
    await auth.login();
    await this.run();
  },

  async logout() {
    await auth.logout();
    this.refreshStatus();
  },

  /** 同期を実行（多重実行は1回にまとめる） */
  async run() {
    if (!auth.hasToken) { this.refreshStatus(); return; }
    if (running) { again = true; return running; }
    running = (async () => {
      do {
        again = false;
        try {
          this._set('syncing');
          await this._syncOnce();
          this.lastSyncAt = Date.now();
          this._set(store.meta.dirty ? 'pending' : 'synced');
        } catch (e) {
          console.warn('sync error', e);
          if (e instanceof AuthError) this._set('needLogin', '未同期（再ログインが必要）');
          else if (!navigator.onLine) this._set('offline', 'オフライン（未同期）');
          else this._set('error', e.message);
          again = false;
        }
      } while (again);
    })();
    try { await running; } finally { running = null; }
  },

  async _syncOnce(retried = false) {
    await store.flush();
    const retention = store.settings.retentionDays;
    let fileId = store.meta.driveFileId;
    if (!fileId) {
      const f = await drive.findFile();
      if (f) {
        fileId = f.id;
        await store.setMeta('driveFileId', fileId);
        await store.setMeta('lastSyncedRemoteModifiedTime', null); // 初回は必ず取り込む
      } else {
        // リモートなし → ローカルを新規作成
        const counter = store.editCounter;
        const { data } = cleanupTombstones(store.exportData(), retention);
        const res = await drive.create(data);
        await store.setMeta('driveFileId', res.id);
        await store.setMeta('lastSyncedRemoteModifiedTime', res.modifiedTime);
        if (store.editCounter === counter) store.setDirty(false);
        return;
      }
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      let remoteMT;
      try { remoteMT = await drive.getModifiedTime(fileId); }
      catch (e) {
        if (!(e instanceof NotFoundError) || retried) throw e;
        // 保存先ファイルが消えていた → 探し直す
        await store.setMeta('driveFileId', null);
        await store.setMeta('lastSyncedRemoteModifiedTime', null);
        return this._syncOnce(true);
      }
      const remoteChanged = remoteMT !== store.meta.lastSyncedRemoteModifiedTime;
      const dirty = store.meta.dirty;
      if (!remoteChanged && !dirty) return;

      const counter = store.editCounter;
      let base;
      if (remoteChanged) {
        const remote = migrate(await drive.download(fileId));
        if (!dirty && store.editCounter === counter) {
          // リモートで置き換え
          const { data } = cleanupTombstones(remote, retention);
          await store.replaceData(data, { source: 'sync-replace', keepHistory: false });
          await store.setMeta('lastSyncedRemoteModifiedTime', remoteMT);
          return;
        }
        base = mergeData(store.exportData(), remote);
      } else {
        base = store.exportData();
      }
      const { data } = cleanupTombstones(base, retention);

      // アップロード直前に再確認（他端末が更新していたらやり直し）
      const checkMT = await drive.getModifiedTime(fileId);
      if (checkMT !== remoteMT) continue;
      const res = await drive.update(fileId, data);

      // ローカルへ反映（同期中の編集はマージで保持）
      if (store.editCounter === counter) {
        if (remoteChanged || data.nodes.length !== store.nodes.size || data.templates.length !== store.templates.size) {
          await store.replaceData(data, { source: 'sync-replace', keepHistory: true });
        }
        store.setDirty(false);
      } else {
        const merged = mergeData(store.exportData(), data);
        await store.replaceData(merged, { source: 'sync-merge', keepHistory: true });
        // dirty はそのまま（次回アップロード）
        again = true;
      }
      await store.setMeta('lastSyncedRemoteModifiedTime', res.modifiedTime);
      return;
    }
    throw new Error('他の端末と同時に更新が続いたため同期を中断しました。しばらくしてから再度お試しください。');
  },
};
