// 共通ユーティリティ

export const SCHEMA_VERSION = 1;
const FUTURE_TOLERANCE = 24 * 60 * 60 * 1000; // 1日以上未来の時刻は補正する

export function uuid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  (globalThis.crypto || { getRandomValues: (a) => a.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const now = () => Date.now();

/** 極端に未来の時刻を補正 */
export function clampTime(t) {
  const n = Date.now();
  if (typeof t !== 'number' || !isFinite(t)) return n;
  return t > n + FUTURE_TOLERANCE ? n : t;
}

/** 兄弟間の並び順（小数方式） */
export function orderBetween(a, b) {
  if (a == null && b == null) return 1;
  if (a == null) return b - 1;
  if (b == null) return a + 1;
  return (a + b) / 2;
}

export function clone(o) {
  return o == null ? o : JSON.parse(JSON.stringify(o));
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
  d.cancel = () => clearTimeout(t);
  d.flush = (...args) => { if (t) { clearTimeout(t); t = null; fn(...args); } };
  return d;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 正規化 ----------

/** カタカナ→ひらがな */
export function kataToHira(s) {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/**
 * 表記ゆれ吸収のための正規化。
 * 全角/半角の統一（NFKC）、英字小文字化、必要ならひらがな/カタカナ同一視。
 */
export function normalize(s, kanaFold = false) {
  let r = String(s ?? '').normalize('NFKC').toLowerCase();
  if (kanaFold) r = kataToHira(r);
  return r;
}

/**
 * 元の文字位置と対応付けながら正規化する（検索のハイライト用）。
 * 戻り値: { text, map } map[i] = 正規化後 i 文字目に対応する元文字列の開始位置。map[text.length] = 元の長さ
 */
export function normalizeWithMap(s, kanaFold = false) {
  let text = '';
  const map = [];
  let i = 0;
  const src = String(s ?? '');
  for (const ch of src) {
    const n = normalize(ch, kanaFold);
    for (let k = 0; k < n.length; k++) map.push(i);
    text += n;
    i += ch.length;
  }
  map.push(src.length);
  return { text, map };
}

// ---------- ダウンロード・ファイル ----------

export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      input.remove();
      if (!f) return resolve(null);
      const r = new FileReader();
      r.onload = () => resolve({ name: f.name, text: String(r.result) });
      r.onerror = () => resolve(null);
      r.readAsText(f, 'utf-8');
    });
    input.click();
  });
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function formatDate(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function sanitizeTitle(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ');
}

/** 改行コードを LF に統一し BOM を除去 */
export function normalizeNewlines(s) {
  return String(s ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}
