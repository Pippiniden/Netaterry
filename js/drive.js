// Google Identity Services（トークンモデル）と Drive API
//
// 保存先: マイドライブの「Netaterry」フォルダ。作品ごとの JSON とテンプレートの JSON を置く。
// 権限は drive.file（このアプリが作ったファイルだけを読み書きできる）。
// ファイルは名前ではなく appProperties（netaterry=work/templates/folder、workId）で見分けるので、
// ドライブ上で名前を変えたり別のフォルダへ動かしたりしても同期は続く。
//
// v1.3 までは drive.appdata（アプリ専用の隠し領域）に1ファイルで保存していた。
// その端末で初めて同期するときだけ drive.appdata も求めて、旧ファイルを読み込む。
import { CONFIG } from '../config.js';

export const SCOPE_FILE = 'https://www.googleapis.com/auth/drive.file';
export const SCOPE_APPDATA = 'https://www.googleapis.com/auth/drive.appdata';
export const FOLDER_NAME = 'Netaterry';
const LEGACY_FILE_NAMES = ['netaterry.json', 'novelmemo.json']; // 旧保存先（アプリ専用領域）のファイル名
const TOKEN_KEY = 'netaterry.token.v2';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export class AuthError extends Error {}
export class NotFoundError extends Error {}

let gisPromise = null;
let token = null; // { access_token, expires_at, scope }

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
  /** 旧保存先（アプリ専用領域）を読める権限があるか */
  get canReadLegacy() { return this.hasToken && (token.scope || '').split(' ').includes(SCOPE_APPDATA); },

  clear() {
    token = null;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* noop */ }
  },

  /**
   * 必ずユーザー操作（クリック）から呼ぶこと（ポップアップブロック対策）
   * @param legacy true なら旧保存先を読む権限（drive.appdata）も求める
   */
  async login({ legacy = false } = {}) {
    if (!this.configured) throw new Error('config.js に Google のクライアントIDが設定されていません');
    await loadGis();
    const scope = legacy ? `${SCOPE_FILE} ${SCOPE_APPDATA}` : SCOPE_FILE;
    return new Promise((resolve, reject) => {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.GOOGLE_CLIENT_ID,
        scope,
        callback: (resp) => {
          if (resp.error) return reject(new Error(resp.error_description || resp.error));
          const granted = String(resp.scope || scope);
          if (!granted.split(' ').includes(SCOPE_FILE)) {
            return reject(new Error('Googleドライブへのファイル保存が許可されませんでした。ログイン画面で「Googleドライブのファイル」へのアクセスにチェックを入れてください'));
          }
          token = { access_token: resp.access_token, expires_at: Date.now() + (Number(resp.expires_in) || 3600) * 1000, scope: granted };
          try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token)); } catch { /* noop */ }
          resolve();
        },
        error_callback: (err) => reject(new Error(err?.message || err?.type || 'ログインがキャンセルされました')),
      });
      client.requestAccessToken({ prompt: '' });
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
  if (res.status === 401 || (res.status === 403 && /auth|scope|permission/i.test(await res.clone().text()))) {
    auth.clear();
    throw new AuthError('ログインの有効期限が切れました');
  }
  if (res.status === 404) throw new NotFoundError('ファイルが見つかりません');
  if (!res.ok) throw new Error(`Drive API エラー (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res;
}
const jsonBody = (o) => ({ headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(o) });

/** ファイル名に使えない文字を置き換える */
export function fileNameFor(name) {
  return (String(name || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim().slice(0, 80) || '無題の作品') + '.json';
}

const FIELDS = 'id,name,modifiedTime,createdTime,appProperties';

export const drive = {
  /** アプリの目印が付いたファイルを探す（ゴミ箱のものは除く） */
  async list(value) {
    const q = encodeURIComponent(`appProperties has { key='netaterry' and value='${value}' } and trashed=false`);
    const out = [];
    let pageToken = '';
    do {
      const res = await api(`${API}/files?q=${q}&fields=nextPageToken,files(${FIELDS})&orderBy=createdTime&pageSize=100${pageToken ? '&pageToken=' + pageToken : ''}`);
      const j = await res.json();
      out.push(...(j.files || []));
      pageToken = j.nextPageToken || '';
    } while (pageToken);
    return out;
  },

  /** 保存用フォルダ（なければ作る）。見つかったもののうち一番古いものを使う */
  async ensureFolder(knownId) {
    if (knownId) {
      try {
        const res = await api(`${API}/files/${knownId}?fields=id,trashed`);
        if (!(await res.json()).trashed) return knownId;
      } catch (e) { if (!(e instanceof NotFoundError)) throw e; }
    }
    const found = (await this.list('folder'))[0];
    if (found) return found.id;
    const res = await api(`${API}/files?fields=id`, { method: 'POST', ...jsonBody({ name: FOLDER_NAME, mimeType: FOLDER_MIME, appProperties: { netaterry: 'folder' } }) });
    return (await res.json()).id;
  },

  async getModifiedTime(fileId) {
    const res = await api(`${API}/files/${fileId}?fields=id,modifiedTime,trashed`);
    const j = await res.json();
    if (j.trashed) throw new NotFoundError('ファイルがゴミ箱にあります');
    return j.modifiedTime;
  },

  async download(fileId) {
    const res = await api(`${API}/files/${fileId}?alt=media`, { cache: 'no-store' });
    return res.json();
  },

  /** 新しいファイルを作る: meta = { name, folderId, appProperties } */
  async create(data, { name, folderId, appProperties }) {
    const boundary = 'nm' + Math.random().toString(36).slice(2);
    const meta = { name, mimeType: 'application/json', appProperties, ...(folderId ? { parents: [folderId] } : {}) };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--`;
    const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return res.json();
  },

  async update(fileId, data) {
    const res = await api(`${UPLOAD}/files/${fileId}?uploadType=media&fields=${FIELDS}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async rename(fileId, name) {
    const res = await api(`${API}/files/${fileId}?fields=${FIELDS}`, { method: 'PATCH', ...jsonBody({ name }) });
    return res.json();
  },

  /** ドライブのゴミ箱へ移す（30日間は元に戻せる） */
  async trash(fileId) {
    try { await api(`${API}/files/${fileId}?fields=id`, { method: 'PATCH', ...jsonBody({ trashed: true }) }); }
    catch (e) { if (!(e instanceof NotFoundError)) throw e; }
  },

  // ---------- 旧保存先（v1.3 まで・アプリ専用領域） ----------
  async findLegacyFile() {
    const names = LEGACY_FILE_NAMES.map((n) => `name='${n}'`).join(' or ');
    const q = encodeURIComponent(`(${names}) and trashed=false`);
    const res = await api(`${API}/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=10`);
    const { files } = await res.json();
    if (!files || !files.length) return null;
    return files.find((f) => f.name === LEGACY_FILE_NAMES[0]) || files[0];
  },
};
