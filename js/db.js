// IndexedDB ラッパー（ローカルファースト保存）
// stores:
//   works     作品（keyPath id）: { id, name, nameUpdatedAt, createdAt, openedAt, globalNote, sync, needsDownload? , deleted? }
//   wnodes    作品ごとのノード（keyPath [workId, id]、index workId）
//   templates テンプレート（全作品共通、keyPath id）
//   meta      設定・画面の状態など（key-value）
//   nodes     v1 までのノード置き場（作品に分かれる前）。起動時に「最初の作品」へ移す

const DB_NAME = 'netaterry';
const DB_VERSION = 2;

let dbPromise = null;
let mem = null; // IndexedDB が使えない環境用

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      console.warn('IndexedDB unavailable', e);
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('nodes')) db.createObjectStore('nodes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('templates')) db.createObjectStore('templates', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('works')) db.createObjectStore('works', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('wnodes')) {
        const s = db.createObjectStore('wnodes', { keyPath: ['workId', 'id'] });
        s.createIndex('workId', 'workId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { console.warn('IndexedDB open error', req.error); resolve(null); };
    req.onblocked = () => console.warn('IndexedDB blocked');
  }).then((db) => {
    if (!db) mem = { nodes: new Map(), templates: new Map(), meta: new Map(), works: new Map(), wnodes: new Map() };
    return db;
  });
  return dbPromise;
}

function reqP(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}
function txDone(tx) {
  return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}
const wkey = (workId, id) => workId + '\u0000' + id;
const strip = (n) => { const { workId, ...rest } = n; void workId; return rest; };

const LEGACY_DB_NAMES = ['novelmemo']; // 旧アプリ名「ノベルメモ」時代のデータベース
const LEGACY_META_KEYS = ['settings', 'ui', 'dirty', 'lastSyncedRemoteModifiedTime', 'driveFileId', 'globalNote'];

/** 既存のデータベースだけを開く（存在しなければ作らずに null） */
function openExisting(name) {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(name); } catch { return resolve(null); }
    req.onupgradeneeded = (e) => { if (e.oldVersion === 0) req.transaction.abort(); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

export const db = {
  get isPersistentStore() { return !mem; },

  // ---------- 作品 ----------
  async loadWorks() {
    const d = await open();
    if (!d) return [...mem.works.values()];
    return reqP(d.transaction('works', 'readonly').objectStore('works').getAll());
  },
  async putWork(w) {
    const d = await open();
    if (!d) { mem.works.set(w.id, w); return; }
    const tx = d.transaction('works', 'readwrite');
    tx.objectStore('works').put(w);
    await txDone(tx);
  },
  /** 作品とそのノードを消す */
  async removeWork(workId) {
    const d = await open();
    if (!d) {
      mem.works.delete(workId);
      for (const k of [...mem.wnodes.keys()]) if (k.startsWith(workId + '\u0000')) mem.wnodes.delete(k);
      return;
    }
    const tx = d.transaction(['works', 'wnodes'], 'readwrite');
    tx.objectStore('works').delete(workId);
    tx.objectStore('wnodes').delete(IDBKeyRange.bound([workId], [workId, []]));
    await txDone(tx);
  },

  // ---------- ノード（作品ごと） ----------
  async loadNodes(workId) {
    const d = await open();
    if (!d) return [...mem.wnodes.entries()].filter(([k]) => k.startsWith(workId + '\u0000')).map(([, n]) => strip(n));
    const list = await reqP(d.transaction('wnodes', 'readonly').objectStore('wnodes').index('workId').getAll(workId));
    return list.map(strip);
  },
  /** 変更分を書き込み */
  async writeNodes(workId, nodes = [], delIds = []) {
    const d = await open();
    if (!d) {
      nodes.forEach((n) => mem.wnodes.set(wkey(workId, n.id), { ...n, workId }));
      delIds.forEach((id) => mem.wnodes.delete(wkey(workId, id)));
      return;
    }
    const tx = d.transaction('wnodes', 'readwrite');
    const s = tx.objectStore('wnodes');
    nodes.forEach((n) => s.put({ ...n, workId }));
    delIds.forEach((id) => s.delete([workId, id]));
    await txDone(tx);
  },
  /** 作品のノードを全置き換え */
  async replaceNodes(workId, nodes) {
    const d = await open();
    if (!d) {
      for (const k of [...mem.wnodes.keys()]) if (k.startsWith(workId + '\u0000')) mem.wnodes.delete(k);
      nodes.forEach((n) => mem.wnodes.set(wkey(workId, n.id), { ...n, workId }));
      return;
    }
    const tx = d.transaction('wnodes', 'readwrite');
    const s = tx.objectStore('wnodes');
    s.delete(IDBKeyRange.bound([workId], [workId, []]));
    nodes.forEach((n) => s.put({ ...n, workId }));
    await txDone(tx);
  },

  // ---------- テンプレート（全作品共通） ----------
  async loadTemplates() {
    const d = await open();
    if (!d) return [...mem.templates.values()];
    return reqP(d.transaction('templates', 'readonly').objectStore('templates').getAll());
  },
  async writeTemplates(list = [], delIds = []) {
    const d = await open();
    if (!d) { list.forEach((t) => mem.templates.set(t.id, t)); delIds.forEach((id) => mem.templates.delete(id)); return; }
    const tx = d.transaction('templates', 'readwrite');
    const s = tx.objectStore('templates');
    list.forEach((t) => s.put(t));
    delIds.forEach((id) => s.delete(id));
    await txDone(tx);
  },
  async replaceTemplates(list) {
    const d = await open();
    if (!d) { mem.templates = new Map(list.map((t) => [t.id, t])); return; }
    const tx = d.transaction('templates', 'readwrite');
    const s = tx.objectStore('templates');
    s.clear();
    list.forEach((t) => s.put(t));
    await txDone(tx);
  },

  // ---------- 作品に分かれる前（v1）のデータ ----------
  /**
   * 作品がまだ1つもなく、v1 のノード置き場にデータがあれば、それを1つの作品として移す。
   * @param makeWork (legacyMeta) => 作品レコード
   * @returns 作った作品（移すものがなければ null）
   */
  async migrateToWorks(makeWork) {
    const d = await open();
    if (!d) return null;
    const tx0 = d.transaction(['works', 'nodes', 'meta'], 'readonly');
    const [works, nodes, globalNote, dirty, driveFileId] = await Promise.all([
      reqP(tx0.objectStore('works').count()),
      reqP(tx0.objectStore('nodes').getAll()),
      reqP(tx0.objectStore('meta').get('globalNote')),
      reqP(tx0.objectStore('meta').get('dirty')),
      reqP(tx0.objectStore('meta').get('driveFileId')),
    ]);
    if (works > 0 || !nodes.length) return null;
    const w = makeWork({ globalNote, dirty: !!dirty, driveFileId: driveFileId || null });
    const tx = d.transaction(['works', 'wnodes', 'nodes'], 'readwrite');
    tx.objectStore('works').put(w);
    const s = tx.objectStore('wnodes');
    nodes.forEach((n) => s.put({ ...n, workId: w.id }));
    tx.objectStore('nodes').clear(); // 移し終えたら空にする（二重に移さない）
    await txDone(tx);
    return w;
  },

  /**
   * 旧アプリ名のデータベースにデータがあれば、v1 のノード置き場へ写す（旧データベースは消さずに残す）。
   * このあと migrateToWorks で作品になる。
   * @returns 引き継いだノード数（0 なら何もしていない）
   */
  async importLegacy() {
    const d = await open();
    if (!d) return 0;
    for (const name of LEGACY_DB_NAMES) {
      const old = await openExisting(name);
      if (!old) continue;
      try {
        const stores = ['nodes', 'templates', 'meta'].filter((s) => old.objectStoreNames.contains(s));
        if (!stores.includes('nodes')) continue;
        const tx = old.transaction(stores, 'readonly');
        const nodes = await reqP(tx.objectStore('nodes').getAll());
        if (!nodes.length) continue;
        const templates = stores.includes('templates') ? await reqP(tx.objectStore('templates').getAll()) : [];
        const meta = {};
        if (stores.includes('meta')) for (const k of LEGACY_META_KEYS) meta[k] = await reqP(tx.objectStore('meta').get(k));
        const wtx = d.transaction(['nodes', 'templates'], 'readwrite');
        const ns = wtx.objectStore('nodes');
        ns.clear();
        nodes.forEach((n) => ns.put(n));
        const ts = wtx.objectStore('templates');
        ts.clear();
        templates.forEach((t) => ts.put(t));
        await txDone(wtx);
        for (const [k, v] of Object.entries(meta)) if (v !== undefined) await this.setMeta(k, v);
        return nodes.length;
      } catch (e) {
        console.warn('旧データの引き継ぎに失敗しました', e);
      } finally {
        old.close();
      }
    }
    return 0;
  },

  // ---------- meta ----------
  async getMeta(key, def = undefined) {
    const d = await open();
    if (!d) return mem.meta.has(key) ? mem.meta.get(key) : def;
    const v = await reqP(d.transaction('meta', 'readonly').objectStore('meta').get(key));
    return v === undefined ? def : v;
  },

  async setMeta(key, value) {
    const d = await open();
    if (!d) { mem.meta.set(key, value); return; }
    const tx = d.transaction('meta', 'readwrite');
    if (value === undefined) tx.objectStore('meta').delete(key); else tx.objectStore('meta').put(value, key);
    await txDone(tx);
  },
};
