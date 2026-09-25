// Google Identity Services（トークンモデル）と Drive API（appDataFolder）
import { CONFIG } from '../config.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'netaterry.json';
const TOKEN_KEY = 'netaterry.token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export class AuthError extends Error {}
export class NotFoundError extends Error {}

let gisPromise = null;
let tokenClient = null;
let token = null; // { access_token, expires_at }

function loadGis() {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { gisPromise = null; reject(new Error('Googleログインの読み込みに失敗しました（オフライン？）')); };
    document.head.appendChild(s);
  });
  return gisPromise;
}

export const auth = {
  get configured() { return !!CONFIG.GOOGLE_CLIENT_ID && !CONFIG.GOOGLE_CLIENT_ID.startsWith('YOUR_'); },

  restore() {
    try {
      const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null');
      if (t && t.expires_at > Date.now() + 60_000) token = t;
    } catch { /* sessionStorage が使えない環境 */ }
    return !!token;
  },

  get hasToken() { return !!token && token.expires_at > Date.now(); },

  clear() {
    token = null;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* noop */ }
  },

  /** 必ずユーザー操作（クリック）から呼ぶこと（ポップアップブロック対策） */
  async login() {
    if (!this.configured) throw new Error('config.js に Google のクライアントIDが設定されていません');
    await loadGis();
    return new Promise((resolve, reject) => {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.GOOGLE_CLIENT_ID,
        scope: SCOPE,
        callback: (resp) => {
          if (resp.error) return reject(new Error(resp.error_description || resp.error));
          token = { access_token: resp.access_token, expires_at: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
          try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token)); } catch { /* noop */ }
          resolve();
        },
        error_callback: (err) => reject(new Error(err?.message || err?.type || 'ログインがキャンセルされました')),
      });
      tokenClient.requestAccessToken({ prompt: '' });
    });
  },

  async logout() {
    if (token && window.google?.accounts?.oauth2) {
      try { window.google.accounts.oauth2.revoke(token.access_token, () => {}); } catch { /* noop */ }
    }
    this.clear();
  },
};

async function api(url, init = {}) {
  if (!auth.hasToken) throw new AuthError('ログインが必要です');
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token.access_token}` },
  });
  if (res.status === 401 || res.status === 403 && /auth/i.test(await res.clone().text())) {
    auth.clear();
    throw new AuthError('ログインの有効期限が切れました');
  }
  if (res.status === 404) throw new NotFoundError('ファイルが見つかりません');
  if (!res.ok) throw new Error(`Drive API エラー (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res;
}

export const drive = {
  async findFile() {
    const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
    const res = await api(`${API}/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)&orderBy=modifiedTime desc&pageSize=10`);
    const { files } = await res.json();
    return files && files.length ? files[0] : null;
  },

  async getModifiedTime(fileId) {
    const res = await api(`${API}/files/${fileId}?fields=id,modifiedTime`);
    return (await res.json()).modifiedTime;
  },

  async download(fileId) {
    const res = await api(`${API}/files/${fileId}?alt=media`, { cache: 'no-store' });
    return res.json();
  },

  async create(data) {
    const boundary = 'nm' + Math.random().toString(36).slice(2);
    const meta = { name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--`;
    const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return res.json();
  },

  async update(fileId, data) {
    const res = await api(`${UPLOAD}/files/${fileId}?uploadType=media&fields=id,modifiedTime`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(data),
    });
    return res.json();
  },
};
