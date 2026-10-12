/* ============================================================
   Recall — Google ドライブ同期

   ・Chrome にログインしている Google アカウントのドライブの「アプリ専用の領域」
     （appDataFolder。ドライブの画面には出ず、ほかのアプリからは読めない）に、
     全項目を1つのファイル（recall-sync.json）で置く。
   ・各 PC は「ダウンロード → 端末の内容と合わせる → 変わっていればアップロード」をくり返す。
     どちらが新しいかは項目の更新時刻（up）で決め、削除は「削除の記録」で伝える。
   ・2台が同時に書いて片方の内容が上書きされても、各 PC は自分の内容を持ち続けているので、
     次の同期でまた足し合わされる（ドライブのファイルには条件付き書き込みが無いため、この形にしている）。
   ・1日1回、その日の内容を別のファイル（recall-backup-YYYY-MM-DD.json）に残す（7日分）。
     「すべて削除」や誤操作のあとでも、設定画面からその日の状態を読み込み直せる。
   ============================================================ */
import {
  getAll, getMeta, setMeta, applyRemote, makeItem, isSavableUrl, stampOf, isDeleted,
  readTombs, readLocalTombs, sanitizeSettings, clip, DEFAULT_META, DEL_KEEP_DAYS, WIPE_KEY, LOCAL_TOMBS_KEY
} from './store.js';
import { KN_CATEGORIES } from './kininari.js';

export const DRIVE_FILE = 'recall-sync.json';
export const BACKUP_PREFIX = 'recall-backup-';
export const BACKUP_KEEP = 7;
export const DRIVE_STATE_KEY = 'rcDrive';     // local: 最後に同期したときの控え（ファイルID・版・中身の指紋・結果）
export const DRIVE_ALARM = 'recall-drive';    // 変更のあと少し待ってから同期する
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const DAY_MS = 86400000;

export const DRIVE_MESSAGE = {
  noclient: 'Google ドライブ同期の準備がまだです（manifest.json の oauth2.client_id が未設定）。README の「Google ドライブ同期の準備」を見てください。',
  clientid: 'OAuth クライアント ID が正しくありません。Google Cloud で作ったクライアントの「アイテム ID」が、この拡張機能の ID と同じか確かめてください。',
  denied: 'Google ドライブへのアクセスが許可されませんでした。',
  auth: 'Google の許可が切れています。「Google ドライブにつなぐ」をもう一度押してください。',
  signin: 'Chrome に Google アカウントでログインしてから、もう一度つないでください。',
  offline: 'ネットにつながっていないようです。つながったら自動で同期します。',
  api: 'Google Cloud で「Google Drive API」が有効になっていません。',
  busy: 'Google ドライブが混み合っています。少し待ってから自動でやり直します。',
  off: 'Google ドライブ同期はオフです。',
  failed: 'Google ドライブと同期できませんでした。'
};

/* ---------- 送る内容（純粋な関数：テストしやすい） ---------- */

const byId = (a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);

/**
 * 端末の内容をドライブに置く形にする。並び順をそろえるので、同じ中身なら同じ文字列になる。
 * ドメインごとのカテゴリの記憶（閲覧したサイトの一覧）は載せない。
 */
export function buildSnapshot({ items, rich, tombs, wipe, meta }, now = Date.now()) {
  const list = [...(items || [])].sort(byId);
  const r = {};
  for (const it of list) if (rich && rich[it.id]) r[it.id] = rich[it.id];
  const t = {};
  for (const id of Object.keys(tombs || {}).sort()) t[id] = tombs[id];
  return {
    app: 'recall', kind: 'drive-sync', v: 1, savedAt: now,
    items: list, rich: r, tombs: t, wipe: Number(wipe) || 0,
    meta: { cats: (meta && meta.cats) || [], s: (meta && meta.s) || {} }
  };
}

/**
 * 中身の指紋。保存した時刻（savedAt）と設定（meta.s）は含めない。
 * 設定まで比べると、設定の違う PC 同士が同期のたびに互いを書き換え合ってしまう
 * （設定は項目が変わったときに一緒に載るので、入れ直した PC の復元には足りる）。
 */
export function fingerprint(snap) {
  if (!snap) return '';
  const parts = [
    (snap.items || []).map(i => `${i.id}:${stampOf(i)}`).join(','),
    JSON.stringify(snap.rich || {}),
    JSON.stringify(snap.tombs || {}),
    String(Number(snap.wipe) || 0),
    JSON.stringify((snap.meta && snap.meta.cats) || [])
  ];
  // FNV-1a（32bit）を2本。比べるだけなので暗号的な強さは要らない
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `${str.length.toString(36)}-${h1.toString(36)}-${h2.toString(36)}`;
}

const CAT_ID = /^[A-Za-z0-9_-]{1,32}$/;
const HEX = /^#[0-9a-fA-F]{3,8}$/;

/**
 * ドライブから読んだファイルを確かめて取り込める形にする。Recall のファイルでなければ null。
 * 項目は makeItem を通して形をそろえ、http/https 以外の URL は捨てる。更新時刻（up）は保つ。
 */
export function parseSnapshot(raw, meta = DEFAULT_META) {
  if (!raw || typeof raw !== 'object' || raw.app !== 'recall' || !Array.isArray(raw.items)) return null;
  const items = [];
  const seen = new Set();
  for (const r of raw.items) {
    if (!r || typeof r !== 'object' || r.id == null || r.id === '') continue;
    const it = makeItem(r, meta);
    if (!isSavableUrl(it.u) || seen.has(String(it.id))) continue;
    const up = Number(r.up);
    if (Number.isFinite(up) && up > 0) it.up = up;
    seen.add(String(it.id));
    items.push(it);
  }
  const rich = {};
  if (raw.rich && typeof raw.rich === 'object') {
    for (const [id, v] of Object.entries(raw.rich)) {
      if (!seen.has(id) || !v || typeof v !== 'object') continue;
      const o = {};
      for (const k of ['th', 'si', 'au', 'du']) if (typeof v[k] === 'string' && v[k]) o[k] = clip(v[k], 400);
      if (o.th && !/^https?:\/\//i.test(o.th)) delete o.th;
      if (Object.keys(o).length) rich[id] = o;
    }
  }
  const tombs = {};
  if (raw.tombs && typeof raw.tombs === 'object') {
    for (const [id, t] of Object.entries(raw.tombs)) { const n = Number(t); if (n > 0) tombs[id] = n; }
  }
  const cats = [];
  const m = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
  for (const c of Array.isArray(m.cats) ? m.cats : []) {
    if (!c || !CAT_ID.test(String(c.id || '')) || cats.some(x => x.id === c.id)) continue;
    cats.push({ id: c.id, name: clip(c.name || 'カテゴリ', 20), color: HEX.test(String(c.color || '')) ? c.color : '#94a3b8' });
  }
  return {
    items, rich, tombs,
    wipe: Math.max(0, Number(raw.wipe) || 0),
    meta: { cats, s: (m.s && typeof m.s === 'object') ? m.s : {} }
  };
}

/**
 * 端末とドライブの内容を合わせる（純粋な関数）。
 * 同じ項目は更新時刻の新しい方、削除の記録と「すべて削除」の時刻は両方を足し合わせる。
 * @returns {{items: object[], rich: object, tombs: object, wipe: number, put: object[]}}
 *   put … ドライブの方が新しく、端末に書く項目
 */
export function mergeSync(local, remote, now = Date.now()) {
  const keepMs = DEL_KEEP_DAYS * DAY_MS;
  const tombs = {};
  const addT = (id, t) => {
    const n = Number(t);
    if (!(n > 0) || now - n >= keepMs) return;            // 60日を過ぎた記録は捨てる
    if (n > (tombs[id] || 0)) tombs[id] = n;
  };
  for (const [id, t] of Object.entries((local && local.tombs) || {})) addT(id, t);
  for (const [id, t] of Object.entries((remote && remote.tombs) || {})) addT(id, t);
  const wipe = Math.max(Number(local && local.wipe) || 0, Number(remote && remote.wipe) || 0);
  const tombAt = new Map(Object.entries(tombs));

  const all = new Map();
  for (const it of (local && local.items) || []) all.set(String(it.id), it);
  const put = [];
  for (const it of (remote && remote.items) || []) {
    const id = String(it.id);
    const cur = all.get(id);
    if (!cur || stampOf(it) > stampOf(cur)) { all.set(id, it); put.push(it); }
  }
  const alive = (it) => !isDeleted(String(it.id), stampOf(it), tombAt, wipe);
  const items = [...all.values()].filter(alive);
  const rich = {};
  const lr = (local && local.rich) || {}, rr = (remote && remote.rich) || {};
  for (const it of items) { const r = lr[it.id] || rr[it.id]; if (r) rich[it.id] = r; }
  return { items, rich, tombs, wipe, put: put.filter(alive) };
}

/** 項目が指しているのに端末に無いカテゴリを、ドライブ側の定義から拾う */
export function missingCats(items, localCats, remoteCats) {
  const have = new Set((localCats || []).map(c => c.id));
  const out = [];
  for (const it of items || []) {
    if (have.has(it.c)) continue;
    const c = (remoteCats || []).find(x => x.id === it.c);
    if (c) { out.push(c); have.add(c.id); }
  }
  return out;
}

/** バックアップのファイル名（その日の日付） */
export function backupName(now = Date.now()) {
  const d = new Date(now);
  return `${BACKUP_PREFIX}${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
}

/* ---------- 認証とドライブの API ---------- */

export function clientIdReady() {
  let id = '';
  try { const m = chrome.runtime.getManifest(); id = (m.oauth2 && m.oauth2.client_id) || ''; } catch { id = ''; }
  return /^[\w.-]+\.apps\.googleusercontent\.com$/.test(id) && !/YOUR_CLIENT_ID/i.test(id);
}

/** 画面に出せる種類つきのエラー */
function driveError(code, detail) {
  const e = new Error(DRIVE_MESSAGE[code] || DRIVE_MESSAGE.failed);
  e.code = code;
  e.detail = detail || '';
  e.isDrive = true;
  return e;
}

/** chrome.identity や fetch のエラーを、画面に出せる種類に分ける */
export function classifyError(e) {
  if (e && e.isDrive) return e;
  const msg = String((e && e.message) || e || '');
  if (/did not approve|user cancel|canceled|cancelled/i.test(msg)) return driveError('denied', msg);
  if (/not signed in|sign ?in/i.test(msg)) return driveError('signin', msg);
  if (/bad client id|invalid.*client|client.*invalid|OAuth2 client/i.test(msg)) return driveError('clientid', msg);
  if (/not granted|revoked|invalid_grant|unauthori[sz]ed/i.test(msg)) return driveError('auth', msg);
  if (/Failed to fetch|NetworkError|network|could not be loaded|ERR_INTERNET/i.test(msg)) return driveError('offline', msg);
  return driveError('failed', msg);
}

async function getToken(interactive) {
  const r = await chrome.identity.getAuthToken({ interactive: !!interactive, scopes: [DRIVE_SCOPE] });
  const token = typeof r === 'string' ? r : (r && r.token);
  if (!token) throw driveError(interactive ? 'denied' : 'auth');
  return token;
}

/** トークンの期限切れ（401）は1回だけ取り直してやり直す */
function makeApi(interactive) {
  let token = null;
  async function call(url, init = {}, retried = false) {
    if (!token) token = await getToken(interactive);
    let res;
    try {
      res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + token } });
    } catch (e) { throw driveError('offline', String((e && e.message) || e)); }
    if (res.status === 401 && !retried) {
      try { await chrome.identity.removeCachedAuthToken({ token }); } catch { /* 取り直すだけ */ }
      token = null;
      return call(url, init, true);
    }
    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      const err = (body && body.error) || {};
      const reason = ((err.errors || [])[0] || {}).reason || err.status || '';
      const text = `${res.status} ${reason} ${err.message || ''}`.trim();
      if (res.status === 401) throw driveError('auth', text);
      if (/accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/i.test(text)) throw driveError('api', text);
      if (res.status === 429 || res.status >= 500 || /rateLimit|userRateLimit/i.test(text)) throw driveError('busy', text);
      throw driveError('failed', text);
    }
    return res;
  }
  const list = async (q) => {
    const u = new URL(API + '/files');
    u.searchParams.set('spaces', 'appDataFolder');
    u.searchParams.set('q', q);
    u.searchParams.set('fields', 'files(id,name,version,modifiedTime,size)');
    u.searchParams.set('orderBy', 'createdTime');
    u.searchParams.set('pageSize', '100');
    const res = await call(u.toString());
    const body = await res.json();
    return Array.isArray(body.files) ? body.files : [];
  };
  const download = async (id) => {
    const res = await call(`${API}/files/${encodeURIComponent(id)}?alt=media`);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return null; }   // 空・壊れたファイルは「無かった」ことにする
  };
  const update = async (id, data) => {
    const res = await call(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=id,version`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  };
  /** 作ってから中身を書く（2回に分けると、マルチパートを組み立てずに済む） */
  const create = async (name, data) => {
    const res = await call(`${API}/files?fields=id,version`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parents: ['appDataFolder'], mimeType: 'application/json' })
    });
    const f = await res.json();
    return update(f.id, data);
  };
  const remove = async (id) => {
    await call(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
  };
  return { list, download, update, create, remove };
}

/* ---------- 端末の控え ---------- */

export async function getDriveState() {
  try { return (await chrome.storage.local.get(DRIVE_STATE_KEY))[DRIVE_STATE_KEY] || {}; }
  catch { return {}; }
}
async function setDriveState(st) {
  try { await chrome.storage.local.set({ [DRIVE_STATE_KEY]: st }); } catch { /* 控えられなくても同期は済んでいる */ }
}

/** 端末の内容を、同期に使う形で読む（Chrome の同期で届いた分の取り込みも済ませる） */
async function readLocal(now) {
  const { items, meta, rich } = await getAll();
  const [ls, ss] = await Promise.all([chrome.storage.local.get(LOCAL_TOMBS_KEY), chrome.storage.sync.get(null)]);
  const tombs = readLocalTombs(ls, now);
  for (const [id, t] of readTombs(ss)) if (now - t < DEL_KEEP_DAYS * DAY_MS && t > (tombs[id] || 0)) tombs[id] = t;
  return { items, rich, tombs, wipe: Number(ss[WIPE_KEY]) || 0, meta };
}

const sameCats = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- 同期 ---------- */

let running = null;

/**
 * Google ドライブと同期する。同時には1つしか走らせない。
 * opts.interactive … 「つなぐ」を押したとき。Google の許可画面を出してよい
 * opts.force       … 前回から何も変わっていなくてもダウンロードして確かめる
 * opts.now         … テスト用の現在時刻
 * @returns {Promise<{ok: boolean, reason?: string, message?: string, skipped?: boolean, put?: number, dropped?: number, total?: number}>}
 */
export async function syncDrive(opts = {}) {
  if (running) {
    if (!opts.force && !opts.interactive) return running;
    await running.catch(() => {});
    return syncDrive(opts);
  }
  running = (async () => {
    try { return await runSync(opts); } finally { running = null; }
  })();
  return running;
}

async function runSync({ interactive = false, force = false, now: nowOpt } = {}) {
  const now = nowOpt || Date.now();
  const state = await getDriveState();
  try {
    if (!clientIdReady()) throw driveError('noclient');
    const first = await readLocal(now);
    if (!first.meta.s.driveOn && !interactive) return { ok: false, reason: 'off', message: DRIVE_MESSAGE.off };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw driveError('offline');

    const api = makeApi(interactive);
    const files = await api.list(`name = '${DRIVE_FILE}' and trashed = false`);
    const primary = files[0] || null;
    const localFp = fingerprint(buildSnapshot(first, now));
    if (!force && primary && files.length === 1 && state.fileId === primary.id
      && state.version === String(primary.version) && state.fp === localFp) {
      await setDriveState({ ...state, checkedAt: now, err: '', errMsg: '' });
      return { ok: true, skipped: true, total: first.items.length };
    }

    // ドライブ側を読む（同じ名前のファイルが2つ以上あれば、ぜんぶ足し合わせて1つにまとめる）
    let remote = null;
    for (const f of files) {
      const snap = parseSnapshot(await api.download(f.id), first.meta);
      if (!snap) continue;
      if (!remote) { remote = snap; continue; }
      const m = mergeSync(remote, snap, now);
      remote = { ...m, meta: { cats: [...remote.meta.cats, ...snap.meta.cats.filter(c => !remote.meta.cats.some(x => x.id === c.id))], s: remote.meta.s } };
    }

    let put = 0, dropped = 0;
    if (remote) {
      // 「すべて削除」したあとも同じ見た目になるが、そのときは設定を戻さない（消したものが戻ってしまう）
      const fresh = first.items.length === 0 && sameCats(first.meta.cats, DEFAULT_META.cats) && !(first.wipe > 0);
      const m = mergeSync(first, remote, now);
      const res = await applyRemote({ items: m.put, rich: remote.rich, tombs: m.tombs, wipe: m.wipe });
      if (!res.ok) throw driveError('failed', res.error);
      put = res.put; dropped = res.dropped;
      // カテゴリ: 入れ直したばかりの端末なら、ドライブの定義と設定をそのまま使う（＝復元）。
      // そうでなければ、項目が指しているのに端末に無いカテゴリだけを足す
      const cur = await getMeta();
      if (fresh && remote.meta.cats.length) {
        const { s } = sanitizeSettings(remote.meta.s, cur.s, { cats: remote.meta.cats, knCats: KN_CATEGORIES });
        await setMeta({ cats: remote.meta.cats, s: { ...s, driveOn: true } });
      } else {
        const add = missingCats(m.items, cur.cats, remote.meta.cats);
        if (add.length) await setMeta({ cats: [...cur.cats, ...add] });
      }
    }

    // 書き戻す。同期の最中に端末で変わった分も含めるため、読み直してから作る
    const after = await readLocal(now);
    const snap = buildSnapshot(after, now);
    const fp = fingerprint(snap);
    let fileId = primary ? primary.id : '';
    let version = primary ? String(primary.version) : '';
    let uploaded = false;
    if (!primary) {
      const f = await api.create(DRIVE_FILE, snap);
      fileId = f.id; version = String(f.version); uploaded = true;
    } else if (files.length > 1 || !remote || fp !== fingerprint(remote)) {
      const f = await api.update(primary.id, snap);
      version = String(f.version); uploaded = true;
    }
    for (const f of files.slice(1)) { try { await api.remove(f.id); } catch { /* 次の同期でまた片付ける */ } }

    // 1日1回のバックアップ（空のときは残さない。空で上書きしていくと、7日後には戻せる日が無くなる）
    let backupDay = state.backupDay || '';
    const today = backupName(now);
    if (snap.items.length && backupDay !== today) {
      try {
        const olds = await api.list(`name contains '${BACKUP_PREFIX}' and trashed = false`);
        const same = olds.find(f => f.name === today);
        if (same) await api.update(same.id, snap); else await api.create(today, snap);
        const keep = [...olds.map(f => f.name), today].filter((n, i, a) => a.indexOf(n) === i).sort().reverse().slice(0, BACKUP_KEEP);
        for (const f of olds) if (!keep.includes(f.name)) { try { await api.remove(f.id); } catch { /* 次の日にまた片付ける */ } }
        backupDay = today;
      } catch { /* バックアップに失敗しても同期は済んでいる */ }
    }

    await setDriveState({ fileId, version, fp, at: now, checkedAt: now, err: '', errMsg: '', total: snap.items.length, backupDay });
    return { ok: true, put, dropped, uploaded, total: snap.items.length };
  } catch (e) {
    const err = classifyError(e);
    await setDriveState({ ...state, err: err.code, errMsg: err.detail ? `${err.message}（${clip(err.detail, 160)}）` : err.message, errAt: now });
    return { ok: false, reason: err.code, message: err.message };
  }
}

/** 「Google ドライブにつなぐ」: 許可を求め、オンにして、すぐに同期する */
export async function connectDrive() {
  if (!clientIdReady()) return { ok: false, reason: 'noclient', message: DRIVE_MESSAGE.noclient };
  try { await getToken(true); }
  catch (e) {
    const err = classifyError(e);
    await setDriveState({ ...(await getDriveState()), err: err.code, errMsg: err.message, errAt: Date.now() });
    return { ok: false, reason: err.code, message: err.message };
  }
  const r = await setMeta({ s: { driveOn: true } });
  if (!r.ok) return { ok: false, reason: 'failed', message: r.error };
  return syncDrive({ interactive: true, force: true });
}

/**
 * 「同期をやめる」: オフにして、この拡張機能に与えた許可を取り消す。
 * ドライブに置いたデータは消さない（またつなげば、そこから続きを同期できる）。
 */
export async function disconnectDrive() {
  await setMeta({ s: { driveOn: false } });
  let token = '';
  try { token = await getToken(false); } catch { token = ''; }
  if (token) {
    try { await chrome.identity.removeCachedAuthToken({ token }); } catch { /* 続行 */ }
    try { await fetch('https://accounts.google.com/o/oauth2/revoke?token=' + encodeURIComponent(token), { mode: 'no-cors' }); } catch { /* 取り消せなくてもオフにはなっている */ }
  }
  try { await chrome.storage.local.remove(DRIVE_STATE_KEY); } catch { /* 続行 */ }
  return { ok: true };
}

/** 設定画面に出す状態 */
export async function driveStatus() {
  const meta = await getMeta();
  return { ready: clientIdReady(), on: !!meta.s.driveOn, state: await getDriveState(), messages: DRIVE_MESSAGE };
}

/** ドライブに残っている日ごとのバックアップ（新しい順） */
export async function listBackups() {
  try {
    if (!clientIdReady()) throw driveError('noclient');
    const api = makeApi(false);
    const files = await api.list(`name contains '${BACKUP_PREFIX}' and trashed = false`);
    return {
      ok: true,
      backups: files
        .map(f => ({ id: f.id, name: f.name, day: f.name.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10), size: Number(f.size) || 0 }))
        .sort((a, b) => (a.name < b.name ? 1 : -1))
    };
  } catch (e) {
    const err = classifyError(e);
    return { ok: false, reason: err.code, message: err.message, backups: [] };
  }
}

/** バックアップを1つ読む（画面の「読み込み」と同じ形で返す） */
export async function getBackup(id) {
  try {
    const raw = await makeApi(false).download(id);
    const snap = parseSnapshot(raw);
    if (!snap) return { ok: false, reason: 'failed', message: 'バックアップを読めませんでした。' };
    return { ok: true, data: { app: 'recall', items: snap.items, rich: snap.rich, meta: snap.meta } };
  } catch (e) {
    const err = classifyError(e);
    return { ok: false, reason: err.code, message: err.message };
  }
}
