// IndexedDB ラッパー（ローカルファースト保存）
// stores: nodes(keyPath id), templates(keyPath id), meta(key-value)

const DB_NAME = 'netaterry';
const DB_VERSION = 1;

let dbPromise = null;
let memoryFallback = null; // IndexedDB が使えない環境用

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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { console.warn('IndexedDB open error', req.error); resolve(null); };
    req.onblocked = () => console.warn('IndexedDB blocked');
  }).then((db) => {
    if (!db) memoryFallback = { nodes: new Map(), templates: new Map(), meta: new Map() };
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
  get isPersistentStore() { return !memoryFallback; },

  async loadAll() {
    const d = await open();
    if (!d) return { nodes: [...memoryFallback.nodes.values()], templates: [...memoryFallback.templates.values()] };
    const tx = d.transaction(['nodes', 'templates'], 'readonly');
    const [nodes, templates] = await Promise.all([
      reqP(tx.objectStore('nodes').getAll()),
      reqP(tx.objectStore('templates').getAll()),
    ]);
    return { nodes, templates };
  },

  /** 変更分を書き込み。puts: {nodes:[], templates:[]}, dels: {nodes:[id], templates:[id]} */
  async write({ nodes = [], templates = [] }, dels = { nodes: [], templates: [] }) {
    const d = await open();
    if (!d) {
      nodes.forEach((n) => memoryFallback.nodes.set(n.id, n));
      templates.forEach((t) => memoryFallback.templates.set(t.id, t));
      (dels.nodes || []).forEach((id) => memoryFallback.nodes.delete(id));
      (dels.templates || []).forEach((id) => memoryFallback.templates.delete(id));
      return;
    }
    const tx = d.transaction(['nodes', 'templates'], 'readwrite');
    const ns = tx.objectStore('nodes');
    const ts = tx.objectStore('templates');
    nodes.forEach((n) => ns.put(n));
    templates.forEach((t) => ts.put(t));
    (dels.nodes || []).forEach((id) => ns.delete(id));
    (dels.templates || []).forEach((id) => ts.delete(id));
    await txDone(tx);
  },

  /** 全置き換え */
  async replaceAll({ nodes, templates }) {
    const d = await open();
    if (!d) {
      memoryFallback.nodes = new Map(nodes.map((n) => [n.id, n]));
      memoryFallback.templates = new Map(templates.map((t) => [t.id, t]));
      return;
    }
    const tx = d.transaction(['nodes', 'templates'], 'readwrite');
    const ns = tx.objectStore('nodes');
    const ts = tx.objectStore('templates');
    ns.clear();
    ts.clear();
    nodes.forEach((n) => ns.put(n));
    templates.forEach((t) => ts.put(t));
    await txDone(tx);
  },

  /**
   * 旧アプリ名のデータベースにデータがあれば、今のデータベースへ写す（旧データベースは消さずに残す）。
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
        await this.replaceAll({ nodes, templates });
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

  async getMeta(key, def = undefined) {
    const d = await open();
    if (!d) return memoryFallback.meta.has(key) ? memoryFallback.meta.get(key) : def;
    const v = await reqP(d.transaction('meta', 'readonly').objectStore('meta').get(key));
    return v === undefined ? def : v;
  },

  async setMeta(key, value) {
    const d = await open();
    if (!d) { memoryFallback.meta.set(key, value); return; }
    const tx = d.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(value, key);
    await txDone(tx);
  },
};
