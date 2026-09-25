// アプリの状態管理（ノード・テンプレート・Undo/Redo・永続化）
import { db } from './db.js';
import { migrate, normalizeNode, normalizeTemplate } from './merge.js';
import { uuid, now, clone, orderBetween, SCHEMA_VERSION } from './util.js';

export const DEFAULT_SETTINGS = {
  autoIndent: true,
  kanaFold: false,           // タグ・検索のひらがな/カタカナ同一視
  retentionDays: 30,         // ゴミ箱の保持期間
  sideNoteExport: 'ask',     // 'ask' | 'include' | 'exclude'
  viewShowTags: false,
  viewVertical: false,
  viewPaged: false,
  viewPageBreakTop: true,
  viewFontSize: 18,
  editFontSize: 16,
  autoSyncDelay: 5,          // 秒
  editTheme: { bg: '#f7f6f2', fg: '#26262a', sel: '#b9d4f5', margin: { top: 16, right: 16, bottom: 16, left: 16 } },
  viewTheme: { bg: '#f4ecd8', fg: '#2e2a24', sel: '#e6cf8f', margin: { top: 32, right: 28, bottom: 32, left: 28 } },
};

export const DEFAULT_UI = {
  selectedId: null,
  filter: { tags: [], mode: 'and', display: 'tree', includeDesc: false },
  searchHistory: [],
  searchOpts: { note: false, trash: false, scope: false, withFilter: true, sort: 'relevance', regex: false, kanaFold: null },
  tagsOpen: true,
};

const listeners = new Map();
function emit(ev, info) { (listeners.get(ev) || []).forEach((fn) => { try { fn(info); } catch (e) { console.error(e); } }); }

export const store = {
  nodes: new Map(),
  templates: new Map(),
  settings: clone(DEFAULT_SETTINGS),
  ui: clone(DEFAULT_UI),
  meta: { dirty: false, lastSyncedRemoteModifiedTime: null, driveFileId: null },
  editCounter: 0,
  history: [],
  future: [],
  _childCache: null,
  _pending: { nodes: new Set(), templates: new Set(), delNodes: new Set(), delTemplates: new Set() },
  _flushTimer: null,

  on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn); },
  emit,

  async init() {
    const { nodes, templates } = await db.loadAll();
    const data = migrate({ schemaVersion: SCHEMA_VERSION, nodes, templates });
    data.nodes.forEach((n) => this.nodes.set(n.id, n));
    data.templates.forEach((t) => this.templates.set(t.id, t));
    const s = await db.getMeta('settings', null);
    if (s) this.settings = deepMerge(clone(DEFAULT_SETTINGS), s);
    const ui = await db.getMeta('ui', null);
    if (ui) this.ui = deepMerge(clone(DEFAULT_UI), ui);
    this.meta.dirty = await db.getMeta('dirty', false);
    this.meta.lastSyncedRemoteModifiedTime = await db.getMeta('lastSyncedRemoteModifiedTime', null);
    this.meta.driveFileId = await db.getMeta('driveFileId', null);
    this._childCache = null;
    if (this.nodes.size === 0 && !(await db.getMeta('initialized', false))) {
      seedSample(this);
      await this.flush();
    }
    await db.setMeta('initialized', true);
  },

  // ---------- 参照 ----------
  get(id) { return this.nodes.get(id); },
  isLive(n) { return n && !n.deleted; },
  childMap() {
    if (this._childCache) return this._childCache;
    const m = new Map();
    for (const n of this.nodes.values()) {
      if (n.deleted) continue;
      let pid = n.parentId;
      if (pid != null) {
        const p = this.nodes.get(pid);
        if (!p || p.deleted) pid = null; // 親が見つからないノードは最上位に表示
      }
      if (!m.has(pid)) m.set(pid, []);
      m.get(pid).push(n);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
    this._childCache = m;
    return m;
  },
  children(pid) { return this.childMap().get(pid ?? null) || []; },
  effectiveParent(n) {
    if (n.parentId == null) return null;
    const p = this.nodes.get(n.parentId);
    return p && !p.deleted ? p.id : null;
  },
  ancestors(id) {
    const res = [];
    let n = this.nodes.get(id);
    const seen = new Set();
    while (n && n.parentId != null && !seen.has(n.parentId)) {
      seen.add(n.parentId);
      const p = this.nodes.get(n.parentId);
      if (!p || (p.deleted && !n.deleted)) break;
      res.unshift(p);
      n = p;
    }
    return res;
  },
  depth(id) { return this.ancestors(id).length + 1; },
  /** 生きている子孫（ツリー順） */
  descendants(id) {
    const out = [];
    const walk = (pid) => { for (const c of this.children(pid)) { out.push(c); walk(c.id); } };
    walk(id);
    return out;
  },
  /** ツリー順の全生存ノード */
  treeOrder() { return this.descendants(null); },
  isDescendant(id, ofId) {
    return this.ancestors(id).some((a) => a.id === ofId);
  },
  pathText(id) { return this.ancestors(id).map((a) => a.title || '無題').join(' > '); },
  liveTemplates() {
    return [...this.templates.values()].filter((t) => !t.deleted).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  },

  // ---------- 変更（トランザクション） ----------
  /**
   * fn(tx) の中で変更を行う。Undo 履歴に1件として積む。
   * opts.coalesce: 同じキーの連続編集は1件にまとめる（文字入力用）
   */
  batch(label, fn, opts = {}) {
    const changes = new Map(); // key -> {kind, id, before}
    const fields = new Set();
    const t = now();
    const tx = {
      t,
      touch: (kind, id) => {
        const key = kind + ':' + id;
        if (!changes.has(key)) {
          const src = kind === 'node' ? this.nodes.get(id) : this.templates.get(id);
          changes.set(key, { kind, id, before: src ? clone(src) : null });
        }
      },
      create: (data) => {
        const n = normalizeNode({ id: uuid(), parentId: null, order: 0, title: '', body: '', sideNote: '', tags: [], ...data, updatedAt: t });
        tx.touch('node', n.id);
        this.nodes.set(n.id, n);
        fields.add('structure');
        return n;
      },
      update: (id, patch, { bump = true } = {}) => {
        const n = this.nodes.get(id);
        if (!n) return null;
        tx.touch('node', id);
        Object.keys(patch).forEach((k) => fields.add(k));
        Object.assign(n, patch);
        if (bump) n.updatedAt = t;
        return n;
      },
      put: (node) => { // 丸ごと置き換え
        tx.touch('node', node.id);
        this.nodes.set(node.id, normalizeNode({ ...node, updatedAt: t }));
        fields.add('structure');
      },
      createTemplate: (data) => {
        const tpl = normalizeTemplate({ id: uuid(), name: '', body: '', tags: [], ...data, updatedAt: t });
        tx.touch('tpl', tpl.id);
        this.templates.set(tpl.id, tpl);
        fields.add('templates');
        return tpl;
      },
      updateTemplate: (id, patch) => {
        const tpl = this.templates.get(id);
        if (!tpl) return null;
        tx.touch('tpl', id);
        Object.assign(tpl, patch, { updatedAt: t });
        fields.add('templates');
        return tpl;
      },
    };
    fn(tx);
    if (changes.size === 0) return;
    // 変更後のスナップショット
    const entry = { label, t, coalesce: opts.coalesce || null, changes: [] };
    for (const c of changes.values()) {
      const src = c.kind === 'node' ? this.nodes.get(c.id) : this.templates.get(c.id);
      entry.changes.push({ ...c, after: src ? clone(src) : null });
      if (c.kind === 'node') this._pending.nodes.add(c.id); else this._pending.templates.add(c.id);
    }
    const last = this.history[this.history.length - 1];
    if (!opts.noHistory) {
      if (opts.coalesce && last && last.coalesce === opts.coalesce && t - last.t < 2500 && this.future.length === 0) {
        for (const c of entry.changes) {
          const ex = last.changes.find((x) => x.kind === c.kind && x.id === c.id);
          if (ex) ex.after = c.after; else last.changes.push(c);
        }
        last.t = t;
      } else {
        this.history.push(entry);
        if (this.history.length > 300) this.history.shift();
        this.future = [];
      }
    }
    this._afterChange(fields, 'local', entry.changes.map((c) => c.id));
  },

  _afterChange(fields, source, ids = []) {
    if ([...fields].some((f) => ['structure', 'parentId', 'order', 'deleted', 'collapsed'].includes(f))) this._childCache = null;
    if (source !== 'sync-replace') {
      this.editCounter++;
      this.setDirty(true);
    }
    this._scheduleFlush();
    emit('change', { fields, source, ids: new Set(ids) });
  },

  _applySnapshots(list, which) {
    const t = now();
    const fields = new Set(['structure']);
    for (const c of list) {
      const snap = c[which];
      if (c.kind === 'node') {
        if (snap) this.nodes.set(c.id, normalizeNode({ ...snap, updatedAt: t }));
        else {
          const cur = this.nodes.get(c.id);
          if (cur) this.nodes.set(c.id, purgedRecord(cur, t));
        }
        this._pending.nodes.add(c.id);
      } else {
        if (snap) this.templates.set(c.id, normalizeTemplate({ ...snap, updatedAt: t }));
        else {
          const cur = this.templates.get(c.id);
          if (cur) this.templates.set(c.id, { id: cur.id, name: '', body: '', tags: [], deleted: true, purged: true, updatedAt: t });
        }
        this._pending.templates.add(c.id);
        fields.add('templates');
      }
    }
    this._afterChange(fields, 'undo', list.map((c) => c.id));
  },

  canUndo() { return this.history.length > 0; },
  canRedo() { return this.future.length > 0; },
  undo() {
    const e = this.history.pop();
    if (!e) return null;
    this.future.push(e);
    this._applySnapshots(e.changes, 'before');
    return e;
  },
  redo() {
    const e = this.future.pop();
    if (!e) return null;
    this.history.push(e);
    this._applySnapshots(e.changes, 'after');
    return e;
  },

  // 開閉状態は updatedAt を更新しない（他端末の本文編集を上書きしないため）
  setCollapsed(id, v) {
    const n = this.nodes.get(id);
    if (!n || n.collapsed === v) return;
    n.collapsed = v;
    this._pending.nodes.add(id);
    this._childCache = null;
    this._scheduleFlush();
    emit('change', { fields: new Set(['collapsed']), source: 'local', ids: new Set([id]) });
  },

  // ---------- 永続化 ----------
  _scheduleFlush() {
    clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => this.flush(), 150);
  },
  async flush() {
    clearTimeout(this._flushTimer);
    const p = this._pending;
    if (!p.nodes.size && !p.templates.size && !p.delNodes.size && !p.delTemplates.size) return;
    const nodes = [...p.nodes].map((id) => this.nodes.get(id)).filter(Boolean);
    const templates = [...p.templates].map((id) => this.templates.get(id)).filter(Boolean);
    const dels = { nodes: [...p.delNodes], templates: [...p.delTemplates] };
    this._pending = { nodes: new Set(), templates: new Set(), delNodes: new Set(), delTemplates: new Set() };
    try {
      await db.write({ nodes: clone(nodes), templates: clone(templates) }, dels);
    } catch (e) {
      console.error('保存に失敗しました', e);
      emit('error', { message: 'ローカル保存に失敗しました: ' + e.message });
    }
  },
  setDirty(v) {
    if (this.meta.dirty === v) return;
    this.meta.dirty = v;
    db.setMeta('dirty', v);
    emit('dirty', v);
  },
  async setMeta(key, v) { this.meta[key] = v; await db.setMeta(key, v); },

  /** データ一式（保存ファイル形式） */
  exportData() {
    return {
      schemaVersion: SCHEMA_VERSION,
      nodes: [...this.nodes.values()].map(clone),
      templates: [...this.templates.values()].map(clone),
    };
  },

  /** データを丸ごと置き換える（同期・インポート） */
  async replaceData(data, { source = 'sync-replace', keepHistory = false } = {}) {
    const d = migrate(data);
    // 開閉状態はローカルの状態を優先
    const collapsed = new Map([...this.nodes.values()].map((n) => [n.id, n.collapsed]));
    this.nodes = new Map(d.nodes.map((n) => [n.id, collapsed.has(n.id) ? { ...n, collapsed: collapsed.get(n.id) } : n]));
    this.templates = new Map(d.templates.map((t) => [t.id, t]));
    this._childCache = null;
    this._pending = { nodes: new Set(), templates: new Set(), delNodes: new Set(), delTemplates: new Set() };
    if (!keepHistory) { this.history = []; this.future = []; }
    await db.replaceAll({ nodes: clone([...this.nodes.values()]), templates: clone([...this.templates.values()]) });
    if (source !== 'sync-replace') { this.editCounter++; this.setDirty(true); }
    emit('change', { fields: new Set(['structure', 'templates', 'title', 'body', 'tags', 'sideNote']), source, ids: new Set() });
  },

  async saveSettings() { await db.setMeta('settings', clone(this.settings)); emit('settings', this.settings); },
  saveUI() { db.setMeta('ui', clone(this.ui)); },
};

export function purgedRecord(n, t = now()) {
  return { id: n.id, parentId: null, order: 0, title: '', body: '', sideNote: '', tags: [], collapsed: false, deleted: true, purged: true, updatedAt: t };
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object') return base;
  for (const k of Object.keys(over)) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      base[k] = deepMerge(base[k], over[k]);
    } else base[k] = over[k];
  }
  return base;
}
export { deepMerge };

// ---------- ノード操作（高レベル） ----------
export const ops = {
  addSibling(id, data = {}) {
    let created;
    store.batch('ノード追加', (tx) => {
      const n = id ? store.get(id) : null;
      const pid = n ? store.effectiveParent(n) : null;
      const sibs = store.children(pid);
      let order;
      if (n) {
        const i = sibs.findIndex((s) => s.id === n.id);
        order = orderBetween(n.order, sibs[i + 1]?.order);
      } else order = orderBetween(sibs[sibs.length - 1]?.order, null);
      created = tx.create({ parentId: pid, order, ...data });
    });
    ensureOrderSpacing(created.parentId);
    return created;
  },
  addChild(id, data = {}) {
    let created;
    store.batch('子ノード追加', (tx) => {
      const kids = store.children(id);
      created = tx.create({ parentId: id, order: orderBetween(kids[kids.length - 1]?.order, null), ...data });
      if (id) tx.update(id, { collapsed: false }, { bump: false });
    });
    return created;
  },
  remove(id) {
    const n = store.get(id);
    if (!n || n.deleted) return;
    store.batch('削除', (tx) => {
      tx.update(id, { deleted: true, deletedRoot: true });
      for (const d of store.descendants(id)) tx.update(d.id, { deleted: true, deletedRoot: false });
    });
  },
  moveUp(id) {
    const n = store.get(id); if (!n) return;
    const pid = store.effectiveParent(n);
    const sibs = store.children(pid);
    const i = sibs.findIndex((s) => s.id === id);
    if (i <= 0) return;
    store.batch('上へ移動', (tx) => tx.update(id, { parentId: pid, order: orderBetween(sibs[i - 2]?.order, sibs[i - 1].order) }));
    ensureOrderSpacing(pid);
  },
  moveDown(id) {
    const n = store.get(id); if (!n) return;
    const pid = store.effectiveParent(n);
    const sibs = store.children(pid);
    const i = sibs.findIndex((s) => s.id === id);
    if (i < 0 || i >= sibs.length - 1) return;
    store.batch('下へ移動', (tx) => tx.update(id, { parentId: pid, order: orderBetween(sibs[i + 1].order, sibs[i + 2]?.order) }));
    ensureOrderSpacing(pid);
  },
  /** 階層を下げる（直前の兄弟の子にする） */
  indent(id) {
    const n = store.get(id); if (!n) return;
    const pid = store.effectiveParent(n);
    const sibs = store.children(pid);
    const i = sibs.findIndex((s) => s.id === id);
    if (i <= 0) return;
    const prev = sibs[i - 1];
    const kids = store.children(prev.id);
    store.batch('階層を下げる', (tx) => {
      tx.update(id, { parentId: prev.id, order: orderBetween(kids[kids.length - 1]?.order, null) });
      tx.update(prev.id, { collapsed: false }, { bump: false });
    });
  },
  /** 階層を上げる（親の次の兄弟にする） */
  outdent(id) {
    const n = store.get(id); if (!n) return;
    const pid = store.effectiveParent(n);
    if (pid == null) return;
    const parent = store.get(pid);
    const gp = store.effectiveParent(parent);
    const psibs = store.children(gp);
    const i = psibs.findIndex((s) => s.id === pid);
    store.batch('階層を上げる', (tx) => tx.update(id, { parentId: gp, order: orderBetween(parent.order, psibs[i + 1]?.order) }));
    ensureOrderSpacing(gp);
  },
  /** D&D: target の前/後/子へ移動 */
  moveTo(id, targetId, where) {
    if (id === targetId || store.isDescendant(targetId, id)) return false;
    const t = store.get(targetId); if (!t) return false;
    let pid, order;
    if (where === 'child') {
      pid = targetId;
      const kids = store.children(pid).filter((k) => k.id !== id);
      order = orderBetween(kids[kids.length - 1]?.order, null);
    } else {
      pid = store.effectiveParent(t);
      const sibs = store.children(pid).filter((k) => k.id !== id);
      const i = sibs.findIndex((s) => s.id === targetId);
      order = where === 'before' ? orderBetween(sibs[i - 1]?.order, t.order) : orderBetween(t.order, sibs[i + 1]?.order);
    }
    store.batch('移動', (tx) => {
      tx.update(id, { parentId: pid, order });
      if (where === 'child') tx.update(targetId, { collapsed: false }, { bump: false });
    });
    ensureOrderSpacing(pid);
    return true;
  },
  duplicate(id) {
    const n = store.get(id); if (!n) return null;
    let root;
    store.batch('複製', (tx) => {
      const pid = store.effectiveParent(n);
      const sibs = store.children(pid);
      const i = sibs.findIndex((s) => s.id === id);
      const copy = (src, parentId, order, suffix) => {
        const c = tx.create({ parentId, order, title: src.title + suffix, body: src.body, sideNote: src.sideNote, tags: [...src.tags], collapsed: src.collapsed });
        store.children(src.id).forEach((k) => copy(k, c.id, k.order, ''));
        return c;
      };
      root = copy(n, pid, orderBetween(n.order, sibs[i + 1]?.order), '（コピー）');
    });
    return root;
  },
  restore(id) {
    const n = store.get(id); if (!n || !n.deleted || n.purged) return;
    store.batch('復元', (tx) => {
      const p = n.parentId != null ? store.get(n.parentId) : null;
      const patch = { deleted: false, deletedRoot: false };
      if (n.parentId != null && (!p || p.deleted)) {
        const roots = store.children(null);
        patch.parentId = null;
        patch.order = orderBetween(roots[roots.length - 1]?.order, null);
      }
      tx.update(id, patch);
      // 一緒に削除された子孫を復元
      const walk = (pid) => {
        for (const c of store.nodes.values()) {
          if (c.parentId === pid && c.deleted && !c.purged && !c.deletedRoot) { tx.update(c.id, { deleted: false }); walk(c.id); }
        }
      };
      walk(id);
    });
  },
  /** 完全削除（idと削除日時のみ残す） */
  purge(ids) {
    store.batch('完全削除', (tx) => {
      const all = new Set();
      const walk = (pid) => {
        for (const c of store.nodes.values()) if (c.parentId === pid && c.deleted && !c.purged && !all.has(c.id)) { all.add(c.id); walk(c.id); }
      };
      ids.forEach((id) => { all.add(id); walk(id); });
      all.forEach((id) => { const n = store.get(id); if (n) tx.put(purgedRecord(n, tx.t)); });
    });
  },
};

/** 小数の並び順が詰まりすぎたら振り直す */
function ensureOrderSpacing(pid) {
  const sibs = store.children(pid);
  let tight = false;
  for (let i = 1; i < sibs.length; i++) if (Math.abs(sibs[i].order - sibs[i - 1].order) < 1e-6) tight = true;
  if (!tight) return;
  store.batch('並び順の整理', (tx) => sibs.forEach((s, i) => tx.update(s.id, { order: i + 1 })), { noHistory: true });
}

function seedSample(s) {
  const t = now();
  const mk = (id, parentId, order, title, body, tags = [], sideNote = '') =>
    s.nodes.set(id, normalizeNode({ id, parentId, order, title, body, tags, sideNote, updatedAt: t }));
  const a = uuid(), b = uuid(), c = uuid(), d = uuid(), e = uuid(), f = uuid();
  mk(a, null, 1, 'はじめに', 'ノベルメモへようこそ。\nノードを選んで右側で本文を書きます。\n**太字**はビューモードで太字表示されます。\n\n左のツリーで「＋」から兄弟ノード、「↳」から子ノードを追加できます。', ['使い方']);
  mk(b, null, 2, '世界観', '大陸の北半分を占める王国が舞台。', ['設定']);
  mk(c, b, 1, '王都', '城壁に囲まれた古都。\n人口は12万人ほど。', ['設定/地名'], '人口はあとで決める');
  mk(d, null, 3, 'キャラクター', '', ['キャラ']);
  mk(e, d, 1, 'リオ', '名前：リオ\n年齢：17\n役割：主人公\n性格：\n外見：\n口調：\n', ['キャラ/主人公']);
  mk(f, null, 4, 'プロット', '発端：\n展開：\n転換：\n結末：', ['プロット']);
  const tt = (name, body, tags) => { const id = uuid(); s.templates.set(id, normalizeTemplate({ id, name, body, tags, updatedAt: t })); };
  tt('キャラクターシート', '名前：{{名前}}\n年齢：{{年齢}}\n役割：\n性格：\n外見：\n口調：\n{{名前}}の目的：\n', ['キャラ']);
  tt('プロット（起承転結）', '発端：\n展開：\n転換：\n結末：\n', ['プロット']);
  [...s.nodes.keys()].forEach((id) => s._pending.nodes.add(id));
  [...s.templates.keys()].forEach((id) => s._pending.templates.add(id));
  s.meta.dirty = false;
}
