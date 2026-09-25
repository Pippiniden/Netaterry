// UIモジュール間で共有するコンテキスト（app.js が中身を設定する）
export const ctx = {
  /** 検索から開いた場合の一致箇所ナビ { query, opts, idx } */
  searchNav: null,
  select: (id, opts) => {},
  openEditor: (id, opts) => {},
  showScreen: (name) => {},
  refreshAll: () => {},
  focusEditorTitle: () => {},
};
