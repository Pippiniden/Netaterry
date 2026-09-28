// アプリの状態管理（作品・ノード・テンプレート・Undo/Redo・永続化）
//
// 作品（work）ごとにノードと共通メモを持ち、テンプレートと設定は全作品で共通。
// メモリ上に持つのは「今開いている作品」だけで、切り替えるたびに読み込み直す。
import { db } from './db.js';
import { migrate, normalizeNode, normalizeTemplate, normalizeGlobalNote, normalizeWork, reassignNodeIds, KIND } from './merge.js';
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
  currentWorkId: null,
  filter: { tags: [], mode: 'and', display: 'tree', includeDesc: false },
  searchHistory: [],
  searchOpts: { note: false, trash: false, scope: false, withFilter: true, sort: 'relevance', regex: false, kanaFold: null },
  tagsOpen: true,
  noteTab: 'node', // サイドメモのタブ: 'node'（このノード） | 'global'（共通）
};

/** 作品に分かれる前のデータを移した作品の id。複数の端末で移しても同じ作品になるよう固定値にする */
export const LEGACY_WORK_ID = 'first-work';
const emptySync = () => ({ fileId: null, remoteMT: null, dirty: false });

/** 作品レコードを作る */
export function makeWork({ id = uuid(), name = '新しい作品', globalNote = null, dirty = true, seed = false, needsDownload = false } = {}) {
  const t = now();
  const w = {
    id, name, nameUpdatedAt: t, createdAt: t, openedAt: t,
    globalNote: normalizeGlobalNote(globalNote),
    sync: { ...emptySync(), dirty },
  };
  if (seed) w.seed = true;               // 初回起動のサンプルのまま（未編集）。ドライブに作品があればそちらを優先して消す
  if (needsDownload) w.needsDownload = true; // ドライブにだけある作品（まだ中身を取得していない）
  return w;
}

const listeners = new Map();
function emit(ev, info) { (listeners.get(ev) || []).forEach((fn) => { try { fn(info); } catch (e) { console.error(e); } }); }
const newPending = () => ({ nodes: new Set(), templates: new Set(), delNodes: new Set(), delTemplates: new Set(), global: false });

export const store = {
  works: new Map(),          // 作品レコード（全作品）
  workId: null,              // 今開いている作品
  nodes: new Map(),          // 今開いている作品のノード
  templates: new Map(),      // テンプレート（全作品共通）
  globalNote: { text: '', updatedAt: 0 }, // 今開いている作品の共通メモ
  settings: clone(DEFAULT_SETTINGS),
  ui: clone(DEFAULT_UI),
  // テンプレートの同期状態・ドライブのフォルダ・旧版（アプリ専用領域）の同期データの引き継ぎ状況
  meta: { templatesSync: emptySync(), driveFolderId: null, legacyDrive: null, everSynced: false },
  editCounter: 0,
  history: [],
  future: [],
  _childCache: null,
  _pending: newPending(),
  _flushTimer: null,

  on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn); },
  off(ev, fn) { const a = listeners.get(ev); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
  emit,

  async init() {
    const initialized = await db.getMeta('initialized', false);
    // 旧アプリ名（ノベルメモ）で使っていたデータがあれば、初回起動時に引き継ぐ
    if (!initialized) {
      const n = await db.importLegacy();
      if (n) this.importedLegacy = n;
    }
    // 作品に分かれる前（v1.3 まで）のデータを「最初の作品」にする
    const legacy = { driveFileId: null };
    const migrated = await db.migrateToWorks((m) => {
      legacy.driveFileId = m.driveFileId;
      return makeWork({ id: LEGACY_WORK_ID, name: '最初の作品', globalNote: m.globalNote, dirty: true });
    });
    const s = await db.getMeta('settings', null);
    if (s) this.settings = deepMerge(clone(DEFAULT_SETTINGS), s);
    const ui = await db.getMeta('ui', null);
    if (ui) this.ui = deepMerge(clone(DEFAULT_UI), ui);
    this.meta.templatesSync = { ...emptySync(), ...(await db.getMeta('templatesSync', null)) };
    this.meta.driveFolderId = await db.getMeta('driveFolderId', null);
    this.meta.legacyDrive = await db.getMeta('legacyDrive', null);
    this.meta.everSynced = await db.getMeta('everSynced', false);
    if (migrated) {
      this.migratedWork = migrated.id;
      // 以前ドライブと同期していた端末: 旧保存先のデータも取り込めるようにしておく
      if (legacy.driveFileId) { this.meta.legacyDrive = { pending: true }; await db.setMeta('legacyDrive', this.meta.legacyDrive); this.meta.everSynced = true; await db.setMeta('everSynced', true); }
      this.meta.templatesSync.dirty = true; // 今あるテンプレートは新しい保存先へ送る
      await db.setMeta('templatesSync', this.meta.templatesSync);
    }

    (await db.loadWorks()).forEach((w) => this.works.set(w.id, w));
    const templates = (await db.loadTemplates()).map(normalizeTemplate);
    templates.forEach((t) => this.templates.set(t.id, t));

    if (!this.liveWorks().length) {
      if (!initialized && !migrated) {
        // 初回起動: 使い方とサンプルの作品を作る
        const w = makeWork({ name: '使い方とサンプル', dirty: false, seed: true });
        this.works.set(w.id, w);
        this.workId = w.id;
        seedSample(this);
        w.globalNote = clone(this.globalNote);
        await db.putWork(clone(w));
        await this.flush();
      } else {
        const w = makeWork({ name: '新しい作品' });
        this.works.set(w.id, w);
        await db.putWork(clone(w));
      }
    }
    const cur = this.works.get(this.ui.currentWorkId);
    await this._load(cur && !cur.deleted ? cur.id : this.liveWorks()[0].id);
    await db.setMeta('initialized', true);
  },

  // ---------- 作品 ----------
  get work() { return this.works.get(this.workId); },
  liveWorks() {
    return [...this.works.values()].filter((w) => !w.deleted).sort((a, b) => a.name.localeCompare(b.name, 'ja') || a.createdAt - b.createdAt);
  },
  /** 作品の中身を読み込んで「今開いている作品」にする（保存は呼び出し側で済ませておく） */
  async _load(workId) {
    const w = this.works.get(workId);
    this.workId = workId;
    this.nodes = new Map((await db.loadNodes(workId)).map((n) => { const x = normalizeNode(n); return [x.id, x]; }));
    this.globalNote = normalizeGlobalNote(w.globalNote);
    this._childCache = null;
    this._pending = newPending();
    this.history = [];
    this.future = [];
    this.ui.currentWorkId = workId;
    this.ui.selectedId = w.selectedId && this.nodes.get(w.selectedId) && !this.nodes.get(w.selectedId).deleted ? w.selectedId : null;
    this.ui.filter.tags = [];
    w.openedAt = now();
    await db.putWork(clone(w));
    this.saveUI();
  },
  /** 作品を切り替える */
  async switchWork(workId) {
    if (workId === this.workId || !this.works.get(workId) || this.works.get(workId).deleted) return;
    const cur = this.work;
    if (cur) cur.selectedId = this.ui.selectedId;
    await this.flush();
    if (cur) await this.saveWork(cur.id);
    emit('beforeWorkSwitch', { from: this.workId, to: workId });
    await this._load(workId);
    emit('work', { id: workId });
    emit('change', { fields: new Set(['structure', 'templates', 'title', 'body', 'tags', 'sideNote', 'globalNote']), source: 'work-switch', ids: new Set() });
  },
  /** 新しい作品を作る（nodes を渡すとその中身で作る） */
  async createWork(name, { id, nodes = [], globalNote = null, open = true } = {}) {
    const w = makeWork({ ...(id ? { id } : {}), name: String(name || '').trim() || '新しい作品', globalNote });
    this.works.set(w.id, w);
    await db.putWork(clone(w));
    if (nodes.length) await db.replaceNodes(w.id, nodes.map((n) => normalizeNode(n)));
    emit('works', {});
    this.setDirtyFlag();
    if (open) await this.switchWork(w.id);
    return w;
  },
  async renameWork(workId, name) {
    const w = this.works.get(workId);
    name = String(name || '').trim();
    if (!w || !name || name === w.name) return;
    w.name = name;
    w.nameUpdatedAt = now();
    this._touchWork(w);
    await this.saveWork(workId);
    emit('works', {});
  },
  /** 作品の中身（ノード・共通メモ）を複製して新しい作品にする */
  async duplicateWork(workId, name) {
    if (workId === this.workId) await this.flush();
    const d = await this.loadWorkData(workId);
    const nodes = reassignNodeIds(d.nodes.filter((n) => !n.purged), uuid).map((n) => ({ ...n, updatedAt: now() }));
    const g = d.globalNote.text ? { text: d.globalNote.text, updatedAt: now() } : null;
    return this.createWork(name, { nodes, globalNote: g });
  },
  /** 作品を削除する。ドライブにあるものは次の同期でドライブのゴミ箱へ移す */
  async deleteWork(workId) {
    const w = this.works.get(workId);
    if (!w || w.deleted) return;
    if (workId === this.workId) {
      const next = this.liveWorks().find((x) => x.id !== workId);
      if (next) await this.switchWork(next.id);
      else await this.createWork('新しい作品');
    }
    if (w.sync.fileId) {
      w.deleted = true;
      w.deletedAt = now();
      await db.replaceNodes(workId, []);
      await this.saveWork(workId);
    } else {
      this.works.delete(workId);
      await db.removeWork(workId);
    }
    emit('works', {});
    this.setDirtyFlag();
  },
  /** 作品をこの端末から外す（同期で「ドライブ側で削除された」と分かったとき） */
  async forgetWork(workId) {
    if (workId === this.workId) {
      const next = this.liveWorks().find((x) => x.id !== workId);
      if (next) await this.switchWork(next.id); else await this.createWork('新しい作品');
    }
    this.works.delete(workId);
    await db.removeWork(workId);
    emit('works', {});
  },
  /** ドライブにだけある作品を一覧に加える（中身は開いたとき・同期のときに取得） */
  async addRemoteWork({ id, name, fileId }) {
    const w = makeWork({ id, name: name || '無題の作品', dirty: false, needsDownload: true });
    w.nameUpdatedAt = 0;
    w.sync.fileId = fileId;
    this.works.set(w.id, w);
    await db.putWork(clone(w));
    emit('works', {});
    return w;
  },
  async saveWork(workId) {
    const w = this.works.get(workId);
    if (!w) return;
    if (workId === this.workId) w.globalNote = clone(this.globalNote);
    await db.putWork(clone(w));
  },
  _touchWork(w) {
    w.sync.dirty = true;
    delete w.seed;
    this.setDirtyFlag();
  },

  /** 作品の中身を取り出す（今開いている作品ならメモリから） */
  async loadWorkData(workId) {
    const w = this.works.get(workId);
    if (workId === this.workId) return this.exportWork();
    return {
      schemaVersion: SCHEMA_VERSION, kind: KIND.work,
      work: { id: w.id, name: w.name, nameUpdatedAt: w.nameUpdatedAt },
      nodes: (await db.loadNodes(workId)).map(normalizeNode),
      globalNote: normalizeGlobalNote(w.globalNote),
    };
  },
  /** 開いていない作品の中身を置き換える（同期用） */
  async saveWorkData(workId, data) {
    if (workId === this.workId) return this.replaceData(data, { source: 'sync-replace', keepHistory: true });
    const w = this.works.get(workId);
    const d = migrate(data);
    await db.replaceNodes(workId, d.nodes);
    w.globalNote = d.globalNote;
    if (d.work && d.work.nameUpdatedAt >= w.nameUpdatedAt) { w.name = d.work.name; w.nameUpdatedAt = d.work.nameUpdatedAt; }
    delete w.needsDownload;
    await db.putWork(clone(w));
    emit('works', {});
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
          changes.set(key, { kind, id, before: clone(this._src(kind, id)) ?? null });
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
      /** 共通メモの更新 */
      updateGlobalNote: (text) => {
        tx.touch('global', 'global');
        this.globalNote = { text: String(text), updatedAt: t };
        fields.add('globalNote');
      },
    };
    fn(tx);
    if (changes.size === 0) return;
    // 変更後のスナップショット
    const entry = { label, t, coalesce: opts.coalesce || null, changes: [] };
    for (const c of changes.values()) {
      const src = this._src(c.kind, c.id);
      entry.changes.push({ ...c, after: src ? clone(src) : null });
      this._markPending(c.kind, c.id);
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
    this._afterChange(fields, 'local', entry.changes);
  },

  _src(kind, id) {
    if (kind === 'node') return this.nodes.get(id);
    if (kind === 'tpl') return this.templates.get(id);
    return this.globalNote;
  },
  _markPending(kind, id) {
    if (kind === 'node') this._pending.nodes.add(id);
    else if (kind === 'tpl') this._pending.templates.add(id);
    else this._pending.global = true;
  },

  _afterChange(fields, source, changes = []) {
    if ([...fields].some((f) => ['structure', 'parentId', 'order', 'deleted', 'collapsed'].includes(f))) this._childCache = null;
    if (source !== 'sync-replace') {
      this.editCounter++;
      // 変わったもの（作品の中身・テンプレート）ごとに「未同期」にする
      if (changes.some((c) => c.kind !== 'tpl') && this.work) this._touchWork(this.work);
      if (changes.some((c) => c.kind === 'tpl')) this.setDirty(true, 'templates');
    }
    this._scheduleFlush();
    emit('change', { fields, source, ids: new Set(changes.map((c) => c.id)) });
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
      } else if (c.kind === 'global') {
        this.globalNote = { text: snap ? snap.text : '', updatedAt: t };
        this._pending.global = true;
        fields.add('globalNote');
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
    this._afterChange(fields, 'undo', list);
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
    if (!p.nodes.size && !p.templates.size && !p.delNodes.size && !p.delTemplates.size && !p.global) return;
    const workId = this.workId;
    const nodes = [...p.nodes].map((id) => this.nodes.get(id)).filter(Boolean);
    const templates = [...p.templates].map((id) => this.templates.get(id)).filter(Boolean);
    const writeGlobal = p.global;
    this._pending = newPending();
    try {
      if (nodes.length || p.delNodes.size) await db.writeNodes(workId, clone(nodes), [...p.delNodes]);
      if (templates.length || p.delTemplates.size) await db.writeTemplates(clone(templates), [...p.delTemplates]);
      if (writeGlobal) await this.saveWork(workId);
    } catch (e) {
      console.error('保存に失敗しました', e);
      emit('error', { message: 'ローカル保存に失敗しました: ' + e.message });
    }
  },

  // ---------- 同期状態 ----------
  /** 未同期の変更があるか（どれか1つの作品・テンプレート） */
  isDirty() {
    return this.meta.templatesSync.dirty || [...this.works.values()].some((w) => w.sync.dirty || (w.deleted && w.sync.fileId));
  },
  /** 同期状態の表示を更新 */
  setDirtyFlag() { emit('dirty', this.isDirty()); },
  /**
   * 未同期の印を付け外しする
   * @param which 'work'（今開いている作品） | 'templates' | 'all'（両方）
   */
  setDirty(v, which = 'all') {
    if ((which === 'work' || which === 'all') && this.work && this.work.sync.dirty !== v) {
      this.work.sync.dirty = v;
      if (v) delete this.work.seed;
      this.saveWork(this.workId);
    }
    if ((which === 'templates' || which === 'all') && this.meta.templatesSync.dirty !== v) {
      this.meta.templatesSync.dirty = v;
      db.setMeta('templatesSync', clone(this.meta.templatesSync));
    }
    this.setDirtyFlag();
  },
  get dirty() { return this.isDirty(); },
  async setMeta(key, v) { this.meta[key] = v; await db.setMeta(key, clone(v)); },
  async saveTemplatesSync() { await db.setMeta('templatesSync', clone(this.meta.templatesSync)); this.setDirtyFlag(); },

  // ---------- 書き出し・置き換え ----------
  /** 今開いている作品のデータ（作品ファイル形式） */
  exportWork() {
    const w = this.work;
    return {
      schemaVersion: SCHEMA_VERSION,
      kind: KIND.work,
      work: { id: w.id, name: w.name, nameUpdatedAt: w.nameUpdatedAt },
      nodes: [...this.nodes.values()].map(clone),
      globalNote: clone(this.globalNote),
    };
  },
  exportData() { return this.exportWork(); },
  /** テンプレート（テンプレートファイル形式） */
  exportTemplates(list = [...this.templates.values()]) {
    return { schemaVersion: SCHEMA_VERSION, kind: KIND.templates, templates: list.map(clone) };
  },
  /** すべての作品とテンプレート（バックアップ形式） */
  async exportBackup() {
    await this.flush();
    const works = [];
    for (const w of this.liveWorks()) works.push(await this.loadWorkData(w.id));
    return { schemaVersion: SCHEMA_VERSION, kind: KIND.backup, exportedAt: new Date().toISOString(), works, templates: [...this.templates.values()].map(clone) };
  },

  /** 今開いている作品の中身を丸ごと置き換える（同期・インポート） */
  async replaceData(data, { source = 'sync-replace', keepHistory = false } = {}) {
    const d = migrate(data);
    const w = this.work;
    // 開閉状態はローカルの状態を優先
    const collapsed = new Map([...this.nodes.values()].map((n) => [n.id, n.collapsed]));
    this.nodes = new Map(d.nodes.map((n) => [n.id, collapsed.has(n.id) ? { ...n, collapsed: collapsed.get(n.id) } : n]));
    this.globalNote = d.globalNote;
    if (d.work && d.work.nameUpdatedAt > w.nameUpdatedAt) { w.name = d.work.name; w.nameUpdatedAt = d.work.nameUpdatedAt; emit('works', {}); }
    delete w.needsDownload;
    this._childCache = null;
    this._pending.nodes = new Set();
    this._pending.delNodes = new Set();
    this._pending.global = false;
    if (!keepHistory) { this.history = []; this.future = []; }
    await db.replaceNodes(this.workId, clone([...this.nodes.values()]));
    await this.saveWork(this.workId);
    if (source !== 'sync-replace') { this.editCounter++; this._touchWork(w); }
    emit('change', { fields: new Set(['structure', 'title', 'body', 'tags', 'sideNote', 'globalNote']), source, ids: new Set() });
  },
  /** テンプレートを丸ごと置き換える（同期） */
  async replaceTemplates(list, { source = 'sync-replace' } = {}) {
    this.templates = new Map(list.map((t) => { const x = normalizeTemplate(t); return [x.id, x]; }));
    this._pending.templates = new Set();
    this._pending.delTemplates = new Set();
    await db.replaceTemplates(clone([...this.templates.values()]));
    emit('change', { fields: new Set(['templates']), source, ids: new Set() });
  },

  async saveSettings() { await db.setMeta('settings', clone(this.settings)); emit('settings', this.settings); },
  saveUI() { db.setMeta('ui', clone(this.ui)); },
};

export { normalizeWork };

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
  const id = () => uuid();

  const root = id();
  mk(root, null, 1, 'Netaterryの使い方', 'このツリーは操作を試しながら読める説明です。不要になったら削除してかまいません（左のツリーで選び、下のごみ箱アイコンでゴミ箱へ移動します）。', ['使い方']);

  const basic = id();
  mk(basic, root, 1, '基本の操作', 'ここが「ノード」です。左のツリーで選ぶと、右側にタイトル・タグ・本文が表示されます。');
  const n1 = id();
  mk(n1, basic, 1, 'ノードの追加', '下のツールバーの＋で「下に兄弟ノードを追加」、↳で「子ノードを追加」します。\nPCではキーボードでも操作できます：\n・Ctrl+Enter（Macは⌘+Enter）で兄弟追加\n・Tab / Shift+Tab で階層を下げる・上げる\n・↑↓ で並べ替え、←→ でツリーの開閉');
  const n2 = id();
  mk(n2, basic, 2, '移動・複製・削除', '↑↓で並べ替え、⇤⇥で階層の上げ下げができます。\nPCではドラッグ＆ドロップでも移動できます。\n複製ボタンで、このノードと子ノードをまとめてコピーできます。\n削除するとゴミ箱に移動します（メニューの「ゴミ箱」から復元・完全削除）。');
  const n3 = id();
  mk(n3, basic, 3, 'サイドメモ', '本文とは別に、作業用のメモを持たせられます。\nツールバーのメモアイコンから開いてみてください。閲覧モードには表示されません。\n\nサイドメモには2つのタブがあります。\n・このノード：開いているノードだけのメモ\n・共通：どのノードからでも同じ内容が見られるメモ（用語集やToDoなどに）', [], 'これはこのノードのサイドメモです。設定の裏話や、まだ決まっていないことのメモなどに使えます。\n上の「共通」タブに切り替えると、全ノード共通のメモが開きます。');

  const tagNode = id();
  mk(tagNode, root, 2, 'タグ', 'タグは自由なテキストです。決まったノードの種類はなく、タグで分類します。\n入力欄にタグ名を書いて Enter（または「,」「、」）で確定します。\n\n「キャラ/主人公」のように「/」で区切ると階層タグになり、「キャラ」で絞り込むと配下もまとめて表示されます。', ['使い方/タグ']);
  const tagEx = id();
  mk(tagEx, tagNode, 1, 'タグの例', 'このノードには「キャラ/主人公」というタグが付いています。\n左上の「タグで絞り込む」から「キャラ」を選ぶと、このノードが表示されます。', ['キャラ/主人公']);

  const search = id();
  mk(search, root, 3, '検索', '上部の検索アイコン（またはCtrl+F / ⌘+F）で検索できます。\n\n・語を空白で区切るとAND検索：イタケー 求婚者\n・-語 で除外：神 -ポセイドン\n・"語 句" で空白を含む語句そのまま\n・tag:タグ名 でタグ絞り込み\n・in:title / in:body / in:note で検索範囲を限定\n\n検索結果からノードへジャンプでき、一致箇所の一括置換もできます。', ['使い方']);

  const works = id();
  mk(works, root, 4, '作品', '上部の作品名（いまは「使い方とサンプル」）を押すと、作品の一覧が開きます。\n\n・作品ごとにノード・タグ・共通メモが分かれます\n・テンプレートと設定は全作品で共通です\n・「新しい作品」で別の作品を作り、一覧から切り替えます\n・一覧の「…」から名前の変更・複製・ファイルへの保存・削除\n・保存したファイルは「ファイルから読み込む」で取り込めます', ['使い方']);
  const tpl = id();
  mk(tpl, root, 5, 'テンプレート', 'メニューの「テンプレート管理」で定型文を登録できます（全作品で共通）。\n本文に {{変数名}} と書いておくと、呼び出し時に入力欄が出ます。\nためしにキャラクターシートのテンプレートを呼び出してみてください（ツールバーのテンプレートアイコン）。\n\nテンプレート管理では、1件ずつ「書き出す」でファイルにでき、「ファイルから読み込む」で追加できます。', ['使い方']);

  const view = id();
  mk(view, root, 6, '閲覧モード（ビューモード）', '上部の本のアイコンから、読み物としての見た目で表示できます。設定から縦書き・ページめくり表示にも切り替えられます。\nこのノードの本文は、編集画面では記法のまま、閲覧モードでは変換後の見た目になります。両方を見比べてみてください（書き方の一覧はメニューの「使い方」にもあります）。\n長い文章での見え方は、下の「（サンプル）オデュッセイア」の「本文」で試せます。\n\n## ルビ\n｜漂泊の英雄《オデュッセウス》は、故郷《イタケー》を目指した。\n（漢字の直後なら、親文字の前の縦線は省略できます）\n\n## 傍点\nそれは《《決して》》口にしてはならない、太陽神の牛だった。\n\n## 区切り線と場面転換\n（次の行は区切り線）\n---\n（次の行は場面転換）\n* * *\n\n## 文字の装飾\n**太字**、*斜体*（縦書きでは傍線）、~~取り消し線~~、`コード`、[リンク](https://example.com)\n縦書きでは「20年ぶりの帰郷」の数字や「!?」が縦中横になります。\n\n## 箇条書き・引用\n- 箇条書き\n  - 字下げで入れ子\n1. 番号付き\n> 「わが名は“誰でもない”という」', ['使い方']);

  const sync = id();
  mk(sync, root, 7, 'データの保存・同期', 'このデータはこの端末（ブラウザ）の中に自動で保存されます。\n\n右上のボタンからGoogleにログインすると、複数の端末でデータを同期できます（あらかじめ config.js の設定が必要です。DEPLOY.md を参照）。同期したデータは、マイドライブの「Netaterry」フォルダに作品ごとのファイルとして保存されます。\n\nメニューの「バックアップを保存」で、すべての作品をJSONファイルとして書き出せます。定期的な保存をおすすめします。', ['使い方']);

  const sample = id();
  const world = id();
  const ithaca = id();
  const ogygia = id();
  const cyclops = id();
  const chara = id();
  const ody = id();
  const pen = id();
  const tel = id();
  const ath = id();
  const pos = id();
  const poly = id();
  const plot = id();
  const nBody = id();
  const b1 = id();
  const b2 = id();
  mk(sample, null, 2, '（サンプル）オデュッセイア', 'ここから下は、書き始めるときの参考にするサンプルです。題材はホメロスの叙事詩『オデュッセイア』。自由に書き換えたり、消したりしてかまいません。\n\n「本文」ノードを選んで閲覧モードを開くと、ルビ・傍点・場面転換などを縦書き・ページめくりで確かめられます。', ['設定']);
  mk(world, sample, 1, '世界観', 'トロイア戦争が終わったあとのギリシア世界。\n神々は人間の運命にたびたび口を出し、海を渡る旅は神の機嫌ひとつで生死が分かれる。\n客人をもてなす掟（クセニア）は神聖なもので、それを破る者は神の罰を受ける。', ['設定']);
  mk(ithaca, world, 1, 'イタケー', 'オデュッセウスが治める、岩がちの小さな島国。\n王が二十年も戻らないため、近隣の若い貴族たちが王妃への求婚者として館に居座り、財産を食いつぶしている。', ['設定/地名'], '求婚者の人数はあとで確認する');
  mk(ogygia, world, 2, 'オーギュギエー島', '海のただなかにある、女神カリュプソの島。\nオデュッセウスは七年のあいだ、ここに留め置かれた。', ['設定/地名']);
  mk(cyclops, world, 3, 'キュクロプスの国', '一つ目の巨人たちが暮らす土地。\n畑を耕さず、掟も集会も持たず、それぞれが洞窟で羊を飼って暮らしている。', ['設定/地名']);
  mk(chara, sample, 2, 'キャラクター', 'メニューの「テンプレート管理」にある「キャラクターシート」と同じ書式で書いています。', ['キャラ']);
  mk(ody, chara, 1, 'オデュッセウス', '名前：オデュッセウス\n年齢：四十歳前後（出征から二十年）\n役割：主人公／イタケーの王\n性格：知略に長け、辛抱強い。好奇心が強く、ときに危険に首を突っ込む\n外見：がっしりとした体つき。帰郷後は女神の力で老いた乞食の姿に変えられる\n口調：落ち着いていて弁が立つ。身分を偽る作り話がうまい\nオデュッセウスの目的：故郷イタケーに帰り、妻と息子のもとへ戻ること\n', ['キャラ/主人公'], '名乗りの場面では、身分を隠すか明かすかで毎回駆け引きがある');
  mk(pen, chara, 2, 'ペネロペイア', '名前：ペネロペイア\n年齢：三十代後半\n役割：オデュッセウスの妻／イタケーの王妃\n性格：聡明で、夫を待ち続ける意志が固い。慎重でしたたか\n外見：気品のある王妃。人前ではベールをかぶる\n口調：控えめで思慮深い\nペネロペイアの目的：夫の帰りを待ち、求婚者から家を守ること\n', ['キャラ/家族'], '「義父の経帷子を織り上げたら再婚相手を選ぶ」と言い、昼に織った布を夜ごとにほどいて時間を稼いだ');
  mk(tel, chara, 3, 'テレマコス', '名前：テレマコス\n年齢：二十歳前後\n役割：オデュッセウスの息子\n性格：最初は頼りないが、旅を通じて王子らしく成長する\n外見：若々しい青年\n口調：はじめは遠慮がち。次第に堂々と話すようになる\nテレマコスの目的：父の消息を知り、館を荒らす求婚者たちに立ち向かうこと\n', ['キャラ/家族']);
  mk(ath, chara, 4, 'アテナ', '名前：アテナ\n年齢：不詳（女神）\n役割：オデュッセウスとテレマコスの守護者\n性格：知恵と戦いの女神。策を好み、機略に富む者を気に入っている\n外見：人間に化けて現れることが多い（旅人メンテスや老人メントルなど）\n口調：威厳があるが、オデュッセウスには親しげにからかうこともある\nアテナの目的：オデュッセウスの帰郷を実現させること\n', ['キャラ/神']);
  mk(pos, chara, 5, 'ポセイドン', '名前：ポセイドン\n年齢：不詳（神）\n役割：海の神／オデュッセウスを阻む者\n性格：気性が激しく、執念深い\n外見：三叉の矛を持つ\n口調：荒々しい\nポセイドンの目的：息子ポリュペモスの目を潰したオデュッセウスを苦しめること\n', ['キャラ/神', 'キャラ/敵']);
  mk(poly, chara, 6, 'ポリュペモス', '名前：ポリュペモス\n年齢：不詳\n役割：キュクロプス（一つ目の巨人）／ポセイドンの息子\n性格：粗暴で、客人をもてなす掟を平然と破る\n外見：額にひとつだけ目がある巨人\n口調：荒々しく、見下した物言い\nポリュペモスの目的：洞窟に迷い込んだ者たちを食らうこと\n', ['キャラ/敵'], '「誰でもない」と名乗る策の場面は、本文サンプルの「第九歌より」に');
  mk(plot, sample, 3, 'プロット', '発端：トロイア戦争から十年。オデュッセウスは女神カリュプソの島に留め置かれ、故郷イタケーでは求婚者たちが館に居座っている。息子テレマコスは父の消息を求めて旅立つ。\n展開：神々の決定によりオデュッセウスは島を離れる。流れ着いたパイエケス人の国で、一つ目の巨人や魔女キルケ、冥府行きなど、これまでの放浪を語る。\n転換：乞食に身をやつしてイタケーに帰還する。息子と再会し、ペネロペイアが催した弓の競技で正体を現す。\n結末：求婚者たちを討ち果たし、二十年ぶりにペネロペイアと再会する。', ['プロット']);
  mk(nBody, sample, 4, '本文', '閲覧モードで読むための本文サンプルです。訳文は、このアプリのためにホメロスの原典から訳し起こしたものです。', ['本文']);
  mk(b1, nBody, 1, '第一歌より　詩女神への呼びかけ', '　語ってくれ、詩女神《ムーサ》よ。機略《きりゃく》に富んだあの男のことを。\n　聖なるトロイアの城を陥《おと》したのち、はるかな地をさまよい続けた男のことを。\n　彼は多くの人々の町を見て、その心を知った。海の上では、胸の内でいくつもの苦しみに耐えた。自らの命と、仲間たちの《《帰郷》》とを勝ち取ろうとして。\n　だが、どれほど願っても、仲間を救うことはできなかった。彼らは自分たちの無分別のせいで滅んだのだ。天をゆく太陽神ヒュペリオンの牛を食らったがために、神は彼らから帰郷の日を取り上げた。\n　ゼウスの娘なる女神よ、そのいきさつを、どこからでもよい、わたしたちにも語り聞かせてくれ。\n\n* * *\n\n　さて、ほかの者たちはみな、むごい死を逃れて、とうに家へ帰り着いていた。戦からも、海からも逃れて。\n　ただひとり、帰郷と妻とを恋い焦がれるあの男だけを、気高いニンフ、女神たちのなかでもひときわ輝くカリュプソが、うつろな洞窟に引き留めていた。彼を夫にしたいと望んで。\n　やがて年がめぐり、神々が彼の帰郷を紡ぎ定めた年がやって来た。けれども故郷イタケーに着いてからも、身内のもとにあってさえ、彼の試練は終わらなかった。\n　神々はみな彼を哀れんだ。ただポセイドンだけは、神にも似たオデュッセウスが故国にたどり着くまで、烈しい怒りを収めることがなかった。', ['本文'], '冒頭の呼びかけ（プロエミウム）。ここで「帰郷」が物語全体の主題として示される');
  mk(b2, nBody, 2, '第九歌より　「誰でもない」', '　洞窟の奥で、巨人は大きな声で問うた。\n「客人よ、おまえの名はなんというのだ」\n　オデュッセウスは、甘い言葉で答えた。\n「キュクロプスよ、わが名を問うのか。ならば教えよう。わが名は《《誰でもない》》。父も母も、仲間たちも、みなわたしをそう呼ぶ」\n　巨人は酒に酔い、やがて眠りに落ちた。\n　男たちは、火で先を固めたオリーブの杭を担ぎ上げた。\n\n---\n\n「誰がおまえを傷つけたのだ、ポリュペモス」\n　駆けつけた仲間の巨人たちが、洞窟の外から叫んだ。\n「“誰でもない”が、わしを策にかけて殺そうとしているのだ!!」\n「誰もおまえを傷つけていないのなら、それは大神ゼウスの下した病だ。父なるポセイドンに祈るがよい」\n　巨人たちは去っていった。オデュッセウスは、胸の内でひそかに笑った。', ['本文']);

  const tt = (name, body, tags) => { const tid = uuid(); s.templates.set(tid, normalizeTemplate({ id: tid, name, body, tags, updatedAt: t })); };
  tt('キャラクターシート', '名前：{{名前}}\n年齢：{{年齢}}\n役割：\n性格：\n外見：\n口調：\n{{名前}}の目的：\n', ['キャラ']);
  tt('プロット（起承転結）', '発端：\n展開：\n転換：\n結末：\n', ['プロット']);

  // 共通メモの初期文。updatedAt を 0 にして、他の端末で書いた共通メモを同期時に上書きしないようにする
  s.globalNote = { text: 'ここは「共通メモ」です。どのノードを開いていても同じ内容が表示されます。\n用語集・登場人物の早見表・執筆中のToDoなど、作品全体に関わるメモに使えます。\n\n隣の「このノード」タブは、開いているノードだけのメモです。', updatedAt: 0 };
  s._pending.global = true;
  [...s.nodes.keys()].forEach((nid) => s._pending.nodes.add(nid));
  [...s.templates.keys()].forEach((tid) => s._pending.templates.add(tid));
}
