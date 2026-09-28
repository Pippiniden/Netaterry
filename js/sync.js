// Google Drive との同期（作品ごとのファイル・テンプレートファイル／差分チェック・ノード単位マージ・上書き防止）
//
// 1回の同期でやること
//   1. ドライブ上のアプリのファイル（作品・テンプレート）を一覧する
//   2. 作品の一覧を合わせる（ドライブにだけある作品を加える／ドライブで消された作品を外す／端末で消した作品をドライブのゴミ箱へ）
//   3. 旧保存先（v1.3 までのアプリ専用領域）のデータがあれば一度だけ取り込む
//   4. テンプレート、今開いている作品、未同期の変更がある作品を、それぞれ同期する
import { store, LEGACY_WORK_ID, makeWork } from './store.js';
import { auth, drive, fileNameFor, AuthError, NotFoundError } from './drive.js';
import { mergeData, mergeTemplateData, cleanupTombstones, migrate, migrateTemplates, KIND } from './merge.js';
import { clone } from './util.js';

let running = null;
let again = false;
const listeners = [];
const noticeListeners = [];

export const sync = {
  status: 'local',   // local | synced | syncing | pending | needLogin | error | offline
  message: '',
  lastSyncAt: null,

  onStatus(fn) { listeners.push(fn); },
  /** 同期中に起きた、利用者に知らせたいこと（作品がドライブで削除された など） */
  onNotice(fn) { noticeListeners.push(fn); },
  _notice(msg) { noticeListeners.forEach((fn) => fn(msg)); },
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
      if (['sync-replace', 'sync-merge', 'work-switch'].includes(info.source)) return;
      if (auth.hasToken) this.scheduleAuto();
    });
    store.on('works', () => { if (auth.hasToken) this.scheduleAuto(); });
    // 作品を開いたら、その作品の最新をすぐ取りに行く
    store.on('work', () => { if (auth.hasToken) this.run(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && auth.hasToken) this.run();
      if (document.visibilityState === 'hidden') { store.flush(); if (auth.hasToken && store.isDirty()) this.scheduleAuto.flush(); }
    });
    window.addEventListener('online', () => { if (auth.hasToken) this.run(); });
    if (auth.hasToken) this.run();
  },

  refreshStatus() {
    if (this.status === 'syncing') return;
    if (!auth.hasToken) {
      if (store.meta.everSynced) this._set('needLogin', store.isDirty() ? '未同期の変更があります' : '');
      else this._set('local');
      return;
    }
    this._set(store.isDirty() ? 'pending' : 'synced');
  },

  scheduleAuto: Object.assign(function () {
    clearTimeout(sync._autoTimer);
    sync._autoTimer = setTimeout(() => sync.run(), Math.max(1, Number(store.settings.autoSyncDelay) || 5) * 1000);
  }, { flush() { if (sync._autoTimer) { clearTimeout(sync._autoTimer); sync._autoTimer = null; sync.run(); } } }),
  _autoTimer: null,

  /** ログイン（必ずクリックから呼ぶ）。旧保存先の取り込みが残っていれば、その権限も一緒に求める */
  async login({ legacy = false } = {}) {
    if (legacy) await store.setMeta('legacyDrive', { pending: true });
    await auth.login({ legacy: legacy || !!store.meta.legacyDrive?.pending });
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
          if (!store.meta.everSynced) await store.setMeta('everSynced', true);
          this._set(store.isDirty() ? 'pending' : 'synced');
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

  async _syncOnce() {
    await store.flush();
    // 1. 一覧
    const [workFiles, tplFiles] = await Promise.all([drive.list('work'), drive.list('templates')]);
    const groups = new Map();
    for (const f of workFiles) {
      const wid = f.appProperties?.workId;
      if (!wid) continue;
      if (!groups.has(wid)) groups.set(wid, []);
      groups.get(wid).push(f);
    }
    // 同じ作品のファイルが2つ以上（2台で同時に初回同期した など）→ 1つにまとめる
    const remoteWorks = new Map();
    for (const [wid, files] of groups) remoteWorks.set(wid, await this._dedupe(files, (a, b) => stripTemplates(mergeData(a, b)), migrate));
    const tplFile = tplFiles.length ? await this._dedupe(tplFiles, mergeTemplateData, migrateTemplates) : null;

    // 2. 作品の一覧を合わせる
    await this._reconcile(remoteWorks);

    // 3. 旧保存先の取り込み（その端末で一度だけ）
    if (store.meta.legacyDrive?.pending && auth.canReadLegacy) await this._importLegacyDrive();

    // 4. テンプレートと作品
    await this._syncDataset(templatesDataset(), tplFile);
    const targets = store.liveWorks().filter((w) => w.id === store.workId || w.sync.dirty);
    for (const w of targets) {
      if (!store.works.get(w.id) || store.works.get(w.id).deleted) continue;
      await this._syncDataset(workDataset(w.id), remoteWorks.get(w.id) || null);
    }
  },

  /** 同じ種類のファイルが複数あれば、中身をマージして一番古いファイルに書き、残りはドライブのゴミ箱へ */
  async _dedupe(files, merge, mig) {
    if (files.length === 1) return files[0];
    const sorted = [...files].sort((a, b) => (a.createdTime < b.createdTime ? -1 : 1));
    let merged = null;
    for (const f of sorted) {
      const d = mig(await drive.download(f.id));
      merged = merged ? merge(merged, d) : d;
    }
    const keep = await drive.update(sorted[0].id, merged);
    for (const f of sorted.slice(1)) await drive.trash(f.id);
    return { ...sorted[0], ...keep };
  },

  async _reconcile(remoteWorks) {
    // ドライブにだけある作品を加える
    for (const [wid, f] of remoteWorks) {
      const w = store.works.get(wid);
      if (!w) {
        await store.addRemoteWork({ id: wid, name: f.name.replace(/\.json$/i, ''), fileId: f.id });
      } else if (!w.deleted && w.sync.fileId !== f.id) {
        // 同じ作品が別のファイルになっている（初回・統合後）→ 次の同期でマージさせる
        w.sync.fileId = f.id;
        w.sync.remoteMT = null;
        w.sync.dirty = true;
        await store.saveWork(wid);
      }
    }
    // 初回起動のサンプル（未編集）は、ドライブに作品があればこの端末から外す
    if (remoteWorks.size) {
      for (const w of store.liveWorks()) if (w.seed && !w.sync.fileId) await store.forgetWork(w.id);
    }
    // 端末で削除した作品 → ドライブのゴミ箱へ
    for (const w of [...store.works.values()]) {
      if (!w.deleted) continue;
      if (w.sync.fileId) await drive.trash(w.sync.fileId);
      await store.forgetWork(w.id);
    }
    // ドライブ上で削除（ゴミ箱へ移動）された作品
    for (const w of store.liveWorks()) {
      if (!w.sync.fileId || remoteWorks.has(w.id)) continue;
      if (w.sync.dirty) {
        // この端末に未同期の変更がある → 消さずに新しいファイルとして作り直す
        w.sync.fileId = null;
        w.sync.remoteMT = null;
        await store.saveWork(w.id);
      } else {
        await store.forgetWork(w.id);
        this._notice(`作品「${w.name}」はGoogleドライブで削除されたため、この端末から外しました（ドライブのゴミ箱から戻せます）`);
      }
    }
    store.setDirtyFlag();
  },

  /** 旧保存先（アプリ専用領域の netaterry.json / novelmemo.json）を「最初の作品」とテンプレートへマージ */
  async _importLegacyDrive() {
    const f = await drive.findLegacyFile();
    if (f) {
      const d = migrate(await drive.download(f.id));
      if (!store.works.get(LEGACY_WORK_ID)) {
        const w = makeWork({ id: LEGACY_WORK_ID, name: '最初の作品', dirty: true });
        store.works.set(w.id, w);
        await store.saveWork(w.id);
      }
      const local = await store.loadWorkData(LEGACY_WORK_ID);
      const merged = stripTemplates(mergeData(local, { ...d, work: null }));
      if (LEGACY_WORK_ID === store.workId) await store.replaceData(merged, { source: 'sync-merge', keepHistory: true });
      else await store.saveWorkData(LEGACY_WORK_ID, merged);
      const w = store.works.get(LEGACY_WORK_ID);
      w.sync.dirty = true;
      delete w.deleted;
      await store.saveWork(LEGACY_WORK_ID);
      if (d.templates.length) {
        const t = mergeTemplateData(store.exportTemplates(), { templates: d.templates });
        await store.replaceTemplates(t.templates, { source: 'sync-merge' });
        store.meta.templatesSync.dirty = true;
        await store.saveTemplatesSync();
      }
      this._notice('以前の保存先（Googleドライブのアプリ専用領域）のデータを「最初の作品」に取り込みました');
    }
    await store.setMeta('legacyDrive', { pending: false, doneAt: Date.now(), found: !!f });
  },

  /**
   * 1つのファイル（作品 or テンプレート）を同期する
   * ds: { state, saveState, exportData, replace, merge, migrate, fileName, appProperties }
   */
  async _syncDataset(ds, remoteFile, retried = false) {
    const retention = store.settings.retentionDays;
    const st = ds.state();
    if (!st) return;
    if (remoteFile && st.fileId !== remoteFile.id) { st.fileId = remoteFile.id; st.remoteMT = null; }
    if (!st.fileId) {
      // ドライブにない → 新しく作る
      const counter = store.editCounter;
      const { data } = cleanupTombstones(await ds.exportData(), retention);
      const folderId = await drive.ensureFolder(store.meta.driveFolderId);
      if (folderId !== store.meta.driveFolderId) await store.setMeta('driveFolderId', folderId);
      const res = await drive.create(data, { name: ds.fileName(), folderId, appProperties: ds.appProperties });
      st.fileId = res.id;
      st.remoteMT = res.modifiedTime;
      if (store.editCounter === counter) st.dirty = false;
      await ds.saveState();
      return;
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      let remoteMT;
      try { remoteMT = await drive.getModifiedTime(st.fileId); }
      catch (e) {
        if (!(e instanceof NotFoundError) || retried) throw e;
        // 保存先ファイルが消えていた → 作り直す
        st.fileId = null;
        st.remoteMT = null;
        st.dirty = true;
        await ds.saveState();
        return this._syncDataset(ds, null, true);
      }
      const remoteChanged = remoteMT !== st.remoteMT;
      const dirty = st.dirty;
      if (!remoteChanged && !dirty) { await this._rename(ds, st, remoteFile?.name); return; }

      const counter = store.editCounter;
      let base;
      if (remoteChanged) {
        const remote = ds.migrate(await drive.download(st.fileId));
        if (!dirty && store.editCounter === counter) {
          // ドライブの内容で置き換え
          const { data } = cleanupTombstones(remote, retention);
          await ds.replace(data, 'sync-replace');
          st.remoteMT = remoteMT;
          await ds.saveState();
          await this._rename(ds, st, remoteFile?.name);
          return;
        }
        base = ds.merge(await ds.exportData(), remote);
      } else {
        base = await ds.exportData();
      }
      const { data, removed } = cleanupTombstones(base, retention);

      // アップロード直前に再確認（他端末が更新していたらやり直し）
      const checkMT = await drive.getModifiedTime(st.fileId);
      if (checkMT !== remoteMT) continue;
      const res = await drive.update(st.fileId, data);

      // ローカルへ反映（同期中の編集はマージで保持）
      if (store.editCounter === counter) {
        if (remoteChanged || removed) await ds.replace(data, 'sync-replace');
        st.dirty = false;
      } else {
        await ds.replace(ds.merge(await ds.exportData(), data), 'sync-merge');
        again = true; // dirty はそのまま（次回アップロード）
      }
      st.remoteMT = res.modifiedTime;
      await ds.saveState();
      await this._rename(ds, st, res.name);
      return;
    }
    throw new Error('他の端末と同時に更新が続いたため同期を中断しました。しばらくしてから再度お試しください。');
  },

  /** ドライブ上のファイル名を作品名に合わせる */
  async _rename(ds, st, remoteName) {
    const want = ds.fileName();
    if (!remoteName || remoteName === want || !ds.renamable) return;
    const res = await drive.rename(st.fileId, want);
    if (res.modifiedTime) { st.remoteMT = res.modifiedTime; await ds.saveState(); }
  },
};

function stripTemplates(d) {
  const { templates, ...rest } = d;
  void templates;
  return rest;
}

/** 作品ファイルの同期用 */
function workDataset(workId) {
  const w = () => store.works.get(workId);
  return {
    state: () => w()?.sync,
    saveState: async () => { if (w()) { await store.saveWork(workId); store.setDirtyFlag(); } },
    exportData: async () => stripTemplates(await store.loadWorkData(workId)),
    replace: async (data, source) => {
      const d = stripTemplates(data);
      if (workId === store.workId) await store.replaceData(d, { source, keepHistory: true });
      else await store.saveWorkData(workId, d);
    },
    merge: (a, b) => stripTemplates(mergeData(a, b)),
    migrate: (raw) => stripTemplates(migrate(raw)),
    fileName: () => fileNameFor(w().name),
    appProperties: { netaterry: 'work', workId },
    renamable: true,
  };
}

/** テンプレートファイルの同期用 */
function templatesDataset() {
  const st = store.meta.templatesSync;
  return {
    state: () => st,
    saveState: () => store.saveTemplatesSync(),
    exportData: async () => store.exportTemplates(),
    replace: async (data) => store.replaceTemplates(data.templates, { source: 'sync-replace' }),
    merge: (a, b) => mergeTemplateData(a, b),
    migrate: (raw) => migrateTemplates(raw),
    fileName: () => 'テンプレート.json',
    appProperties: { netaterry: 'templates' },
    renamable: false,
    kind: KIND.templates,
  };
}

export { clone };
