/* ============================================================
   Recall — 気になり帳（kininari.html）へ送る

   仕組み: 気になり帳の受け口 `#knadd=<JSON>` を裏のタブで開き、
   アプリ側が保存を終えて window.__kininariClipSaved を立てたら閉じる。
   この裏タブの扱いは「気になり帳クリッパー v1.2.1」で作り込まれた
   ものを、そのまま持ち込んでいる（取りこぼし・二重報告・タブの
   開きっぱなしを避けるための工夫がすべて入っている）。
   ============================================================ */
import { clip, thumbOf, normalizeUrl, getAll, putItems, STATUS } from './store.js';

/** 気になり帳が受け付けるカテゴリ（これ以外は「調べる」になる） */
export const KN_CATEGORIES = ['メモ', 'アイデア', '調べる', 'やること', '行きたい'];

export const CLIP_LIMITS = {
  url: 8000,      // #knadd= まで含めた最終URLの上限
  note: 2000      // メモの文字数上限（共有メニュー経由と同じ）
};

const POLL_MS = 500;          // 保存フラグを見に行く間隔
const POLL_MAX_MS = 20000;    // ここまでは保存完了を待つ
const BLIND_WAIT_MS = 8000;   // 確認する権限が無いときの待ち時間
const HARD_LIMIT_MS = 25000;  // 何があってもここで閉じる
const SWEEP_MIN = 1;          // 取り残し点検の間隔（分。chrome.alarms の下限）
const PENDING_KEY = 'rcClipPending';
const OPENED_KEY = 'rcClipOpened';
const OPENED_MAX = 20;
export const LAST_CLIP_KEY = 'rcClipLast';
export const CLIP_ALARM = 'recall-clip-sweep';
export const RETRY_ALARM = 'recall-clip-retry';
export const QUEUE_KEY = 'rcClipQueue';
export const MAX_TRIES = 5;          // これを超えたら自動では送り直さない（手動で再送できる）
const RETRY_MIN = 5;                 // 自動で送り直す間隔（分）
const QUEUE_MAX = 200;

export const CLIP_MESSAGE = {
  saved: '気になり帳に保存しました',
  blind: '気になり帳を開きました（保存できたかは未確認）',
  unconfirmed: '保存を確認できませんでした。保存先URLを確かめてください',
  closed: '裏のタブが閉じられたため、保存できたか分かりません',
  failed: '気になり帳に送れませんでした。保存先URLを確かめてください',
  off: '気になり帳への送信はオフです',
  nourl: '気になり帳の保存先URLが未設定です'
};

/* ---------- 送る内容を組み立てる（純粋な関数：テストしやすい） ---------- */

/**
 * 気になり帳のメモ本文に載せる文章。メモ本体のあとにタグを並べる。
 * 気になり帳の受け口は tags を受け取らないため、本文に混ぜて検索できるようにする。
 */
export function clipNote(item) {
  const parts = [];
  if (item.n) parts.push(item.n);
  const tags = (item.g || []).filter(Boolean);
  if (tags.length) parts.push(tags.map(t => '#' + t).join(' '));
  return clip(parts.join('\n\n'), CLIP_LIMITS.note);
}

/**
 * `#knadd=` 付きの URL を作る。長すぎるときは画像 → メモの順に削る
 * （URL が途中で切られてクリップごと失われるのを防ぐ）。
 * @returns {{url:string, cutImg:boolean, cutNote:boolean, payload:object|null}}
 */
export function buildClipUrl(base, fields) {
  const head = String(base || '').split('#')[0] + '#knadd=';
  const category = KN_CATEGORIES.includes(fields.category) ? fields.category : '調べる';
  const make = (note, img) => {
    const p = {
      t: clip(fields.title, 200) || fields.url,
      u: fields.url,
      n: note,
      img: img,
      c: category,
      f: clip(fields.folder || '', 40)
    };
    if (fields.tags && fields.tags.length) p.tags = fields.tags;
    if (fields.srs) p.srs = fields.srs;          // 復習の進み具合をそのまま引き継ぐ
    return p;
  };
  const render = (p) => head + encodeURIComponent(JSON.stringify(p));

  let note = fields.note || '';
  let img = /^https?:\/\//i.test(fields.image || '') ? fields.image : '';
  let payload = make(note, img);
  let url = render(payload);
  let cutImg = false, cutNote = false;

  if (url.length > CLIP_LIMITS.url && img) {
    img = ''; cutImg = true;
    payload = make(note, img); url = render(payload);
  }
  while (url.length > CLIP_LIMITS.url && note.length) {
    note = note.slice(0, Math.max(0, Math.floor(note.length * 0.8) - 1));
    cutNote = true;
    payload = make(note, img); url = render(payload);
  }
  if (url.length > CLIP_LIMITS.url) return { url: '', cutImg, cutNote, payload: null };
  return { url, cutImg, cutNote, payload };
}

/** Recall の項目を、気になり帳へ送る形にそろえる */
export function clipFieldsFor(item, meta, rich) {
  const cat = (meta.cats || []).find(c => c.id === item.c);
  return {
    title: item.t,
    url: item.u,
    note: clipNote(item),
    image: thumbOf(item, rich),          // YouTube はIDから、それ以外は保存済みのOGP画像
    category: meta.s.knCat,
    folder: cat ? cat.name : '',         // Recall のカテゴリ＝気になり帳のフォルダ
    tags: (item.g || []).slice(0, 12),
    srs: srsFor(item)
  };
}

/**
 * Recall の復習状態を気になり帳の形にそろえる。
 * 気になり帳側は 0=未読 / 1=学習中 / 2=完了 の3つ。アーカイブは復習に入れない。
 */
export function srsFor(item) {
  if (item.s === STATUS.ARCHIVED) return null;
  const st = item.s === STATUS.DONE ? 2 : (item.s === STATUS.LEARNING ? 1 : 0);
  return {
    b: Math.max(0, Number(item.b) || 0),
    d: st === 2 ? 0 : Math.max(0, Number(item.d) || 0),
    rv: Math.max(0, Number(item.rv) || 0),
    st,
    iv: Math.max(0, Number(item.iv) || 0)
  };
}

export function clipEnabled(meta) {
  return !!(meta && meta.s && meta.s.knOn && String(meta.s.knUrl || '').trim());
}

export function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin + '/*';
  } catch { return null; }
}

/** 同じページを二重に送っていないか（気になり帳側に重複判定が無いため拡張側で見る） */
export function alreadyClipped(item) {
  return !!(item && item.kn && item.kn > 0);
}

/**
 * 送れたことを項目に記録する。
 * confirmed=false は「気になり帳を開いたが、保存できたかは確かめていない」状態
 * （保存の確認を許可していないとき）。画面では「未確認」と出して送り直せるようにする。
 */
export function markClipped(item, confirmed) {
  return { ...item, kn: Date.now(), knc: confirmed ? 1 : 0 };
}

/** 項目の送信状態を一言で表す */
export function clipStateOf(item, queueEntry) {
  if (queueEntry) {
    if (queueEntry.tries >= MAX_TRIES) return { key: 'stuck', text: `送れていません（${queueEntry.tries}回失敗）` };
    return { key: 'pending', text: queueEntry.tries ? `送信待ち（${queueEntry.tries}回失敗）` : '送信待ち' };
  }
  if (!item || !item.kn) return { key: 'none', text: 'まだ送っていません' };
  if (item.knc) return { key: 'sent', text: '送信済み' };
  return { key: 'unconfirmed', text: '送信済み（未確認）' };
}

export function sameTarget(a, b) {
  return normalizeUrl(a) === normalizeUrl(b);
}


/* ============================================================
   送信の待ち行列
     気になり帳への送信は、URL の間違い・オフライン・裏タブを閉じられた等で失敗する。
     失敗を黙って「送信済み」にすると、スマホ側にだけ無い項目が静かに増えていく。
     そこで「確認できたときだけ印を付け、それ以外は待ち行列に残して送り直す」。
   ============================================================ */

export async function getQueue() {
  try {
    const v = (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY];
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

async function writeQueue(list) {
  try { await chrome.storage.local.set({ [QUEUE_KEY]: list }); }
  catch { /* 書けなくても送信自体は試みる */ }
}

/**
 * 待ち行列の書き換えは必ずここを通す。
 * 「読む→加工→書き戻す」の途中に別の書き換えが割り込むと、
 * 積んだばかりの項目がまるごと消える（そして未送信にも出ないので気づけない）。
 */
function editQueue(fn) {
  return serial(async () => {
    const cur = await getQueue();
    const next = fn([...cur]);
    if (!next) return cur;
    if (JSON.stringify(next) !== JSON.stringify(cur)) await writeQueue(next);
    return next;
  });
}

/** 送信の予約。すでに並んでいれば何もしない。いっぱいなら断る（黙って捨てない） */
export async function enqueueClip(id) {
  let refused = false;
  const next = await editQueue(q => {
    if (q.some(e => e.id === id)) return null;
    if (q.length >= QUEUE_MAX) { refused = true; return null; }   // 古い方を守る
    q.push({ id, at: Date.now(), tries: 0, status: '', err: '' });
    return q;
  });
  return { ok: !refused, refused, size: next.length };
}

export async function removeFromQueue(id) {
  return editQueue(q => q.filter(e => e.id !== id));
}

async function noteFailure(id, status, err) {
  return editQueue(q => q.map(e => e.id === id
    ? { ...e, tries: (e.tries || 0) + 1, status, err: String(err || '').slice(0, 200), at: Date.now() }
    : e));
}

/** 諦めた分もふくめて、もう一度ぜんぶ送り直す */
export async function resetQueueTries() {
  return editQueue(q => q.map(e => ({ ...e, tries: 0, status: '', err: '' })));
}

async function ensureRetryAlarm() {
  try {
    const a = await chrome.alarms.get(RETRY_ALARM);
    if (!a) chrome.alarms.create(RETRY_ALARM, { delayInMinutes: RETRY_MIN, periodInMinutes: RETRY_MIN });
  } catch { /* 続行 */ }
}
async function clearRetryAlarm() {
  try { await chrome.alarms.clear(RETRY_ALARM); } catch { /* 続行 */ }
}

function startClipAwait(url) {
  return new Promise(resolve => { startClip(url, resolve); });
}

let flushing = false;

/**
 * 待ち行列を順番に送る。裏タブは一度に1つしか開かない。
 * @returns {{ok:boolean, sent:number, left:number, reason?:string}}
 */
export async function flushClips(opts) {
  if (flushing) return { ok: true, sent: 0, left: (await getQueue()).length, reason: 'busy' };
  flushing = true;
  try {
    if (!(await getQueue()).length) { await clearRetryAlarm(); return { ok: true, sent: 0, left: 0 }; }

    const first = await getAll();
    if (!clipEnabled(first.meta)) {
      return { ok: false, sent: 0, left: (await getQueue()).length, reason: 'off' };
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      await ensureRetryAlarm();
      return { ok: false, sent: 0, left: (await getQueue()).length, reason: 'offline' };
    }

    const force = !!(opts && opts.force);
    const done = [];
    const attempted = new Set();
    let sent = 0;
    // 送信中に新しく積まれた分も同じ回で送る。
    // 一度きりにすると、まとめて保存したときに1件しか送られず、
    // 残りは5分後の再送まで待つことになる。
    for (;;) {
    const q = (await getQueue()).filter(e => !attempted.has(e.id));
    const todo = q.filter(e => force || (e.tries || 0) < MAX_TRIES);
    if (!todo.length) break;
    for (const entry of todo) {
      attempted.add(entry.id);

      // 1件ごとに読み直す。送信には1件あたり最大25秒かかるので、
      // 最初のスナップショットで書き戻すと、その間の編集が巻き戻ってしまう。
      const { items, meta, rich } = await getAll();
      if (!clipEnabled(meta)) break;
      const item = items.find(i => i.id === entry.id);
      if (!item) { await removeFromQueue(entry.id); continue; }   // 消された項目は送らない

      const built = buildClipUrl(meta.s.knUrl, clipFieldsFor(item, meta, rich[item.id]));
      if (!built.url) { await noteFailure(entry.id, 'toolong', '内容が大きすぎます'); continue; }
      // http/https 以外はタブが開けても中身が動かない。
      // 「開いたから送れたことにする」と、URLの打ち間違いが静かに握りつぶされる。
      if (!originOf(built.url)) {
        await noteFailure(entry.id, 'badurl', '保存先URLが http:// または https:// ではありません');
        continue;
      }

      const res = await startClipAwait(built.url);
      if (res.status === 'saved' || res.status === 'blind') {
        // 送信中に編集されているかもしれないので、いまの内容に印だけを足す
        const latest = (await getAll()).items.find(i => i.id === entry.id);
        if (latest) await putItems([markClipped(latest, res.status === 'saved')]);
        await removeFromQueue(entry.id);
        done.push(entry.id);
        sent++;
      } else {
        await noteFailure(entry.id, res.status, res.err);
      }
    }
    }

    const left = await getQueue();
    if (left.some(e => (e.tries || 0) < MAX_TRIES)) await ensureRetryAlarm();
    else await clearRetryAlarm();
    return { ok: true, sent, left: left.length, done };
  } catch (e) {
    return { ok: false, sent: 0, left: (await getQueue()).length, reason: String((e && e.message) || e) };
  } finally {
    flushing = false;
  }
}

/** 待ち行列の要約（画面に出す用） */
export async function queueSummary() {
  const q = await getQueue();
  return {
    total: q.length,
    stuck: q.filter(e => (e.tries || 0) >= MAX_TRIES).length,
    entries: q
  };
}

/* ============================================================
   裏タブの管理（Service Worker で動く）
   ============================================================ */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const responders = new Map();
const watching = new Set();

let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(() => fn(), () => fn());
  queue = run.then(() => {}, () => {});
  return run;
}

async function getPending() {
  try { return (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY] || {}; }
  catch { return {}; }
}
async function setPending(p) {
  try { await chrome.storage.session.set({ [PENDING_KEY]: p }); } catch { /* 続行 */ }
}
function editPending(fn) {
  return serial(async () => {
    const p = await getPending();
    const before = JSON.stringify(p);
    const out = await fn(p);
    if (JSON.stringify(p) !== before) await setPending(p);
    return out;
  });
}
async function getOpened() {
  try {
    const v = (await chrome.storage.local.get(OPENED_KEY))[OPENED_KEY];
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function rememberOpened(url) {
  if (!url) return Promise.resolve();
  return serial(async () => {
    const list = await getOpened();
    if (list.includes(url)) return;
    list.push(url);
    try { await chrome.storage.local.set({ [OPENED_KEY]: list.slice(-OPENED_MAX) }); } catch { /* 続行 */ }
  });
}
function dropOpened(url) {
  if (!url) return Promise.resolve();
  return serial(async () => {
    const list = await getOpened();
    const next = list.filter(u => u !== url);
    if (next.length !== list.length) {
      try { await chrome.storage.local.set({ [OPENED_KEY]: next }); } catch { /* 続行 */ }
    }
  });
}

async function tabExists(tabId) {
  try { await chrome.tabs.get(tabId); return true; } catch { return false; }
}

/** タブが読み終わったか（保存の確認ができないときの最低限の目安） */
async function tabLoaded(tabId) {
  try { const t = await chrome.tabs.get(tabId); return t && t.status === 'complete'; }
  catch { return false; }
}

async function canScript(origin) {
  if (!origin) return false;
  try { return await chrome.permissions.contains({ origins: [origin] }); } catch { return false; }
}

/** 保存完了の印はページ本体（MAIN）に立つ。結合アプリでは iframe の中なので全フレームを見る */
async function savedInTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: () => { try { if (window.__kininariClipSaved) return true; } catch { /* 無視 */ } return false; }
    });
    return (results || []).some(r => r && r.result === true);
  } catch { return null; }   // 権限が無い・まだ読み込み中
}

async function report(tabId, status, err) {
  try { await chrome.storage.session.set({ [LAST_CLIP_KEY]: { status, err: err || '', at: Date.now() } }); }
  catch { /* 続行 */ }
  if (tabId != null) {
    const send = responders.get(tabId);
    if (send) {
      responders.delete(tabId);
      try { send({ ok: status === 'saved', status, err: err || '', message: CLIP_MESSAGE[status] || '' }); } catch { /* 続行 */ }
    }
  }
}

async function forget(tabId) {
  const key = String(tabId);
  const st = await editPending((p) => {
    const cur = p[key];
    if (!cur) return null;
    delete p[key];
    return cur;
  });
  if (!st) return null;
  await dropOpened(st.url);
  if (!Object.keys(await getPending()).length) {
    try { await chrome.alarms.clear(CLIP_ALARM); } catch { /* 続行 */ }
  }
  return st;
}

async function finish(tabId, status, err) {
  const st = await forget(tabId);
  if (!st) return;
  await report(tabId, status, err);
  try { chrome.tabs.remove(tabId, () => void chrome.runtime.lastError); } catch { /* 続行 */ }
}

async function abandon(tabId) {
  const st = await forget(tabId);
  if (!st) return;          // finish 経由。結果は伝え済み
  if (st.reported) return;  // blind を伝えたあとなので蒸し返さない
  await report(tabId, 'closed');
}

async function ensureClipAlarm() {
  try {
    const a = await chrome.alarms.get(CLIP_ALARM);
    if (!a) chrome.alarms.create(CLIP_ALARM, { delayInMinutes: SWEEP_MIN, periodInMinutes: SWEEP_MIN });
  } catch { /* 続行 */ }
}

async function watch(tabId) {
  const key = String(tabId);
  if (watching.has(key)) return;
  watching.add(key);
  try {
    for (;;) {
      const st = (await getPending())[key];
      if (!st) return;
      if (!(await tabExists(tabId))) { await abandon(tabId); return; }
      const now = Date.now();
      if (await canScript(st.origin)) {
        if ((await savedInTab(tabId)) === true) { await finish(tabId, 'saved'); return; }
        if (now - st.startedAt >= POLL_MAX_MS || now >= st.hardAt) { await finish(tabId, 'unconfirmed'); return; }
      } else {
        // 保存の確認ができない場合。「タブを作れた」だけで送れたことにすると、
        // URL の打ち間違いや到達できないページを黙って握りつぶすので、
        // 少なくともページが読み終わるまでは待ち、終わらなければ失敗として扱う。
        if (now - st.startedAt >= BLIND_WAIT_MS || now >= st.hardAt) {
          await finish(tabId, (await tabLoaded(tabId)) ? 'blind' : 'unconfirmed');
          return;
        }
      }
      await sleep(POLL_MS);
    }
  } finally {
    watching.delete(key);
  }
}

/** 取り残しがないか点検する。Service Worker が起き直すたびに1回走る */
export async function sweepClips() {
  const pending = await getPending();
  const keys = Object.keys(pending);
  if (!keys.length) { try { await chrome.alarms.clear(CLIP_ALARM); } catch { /* 続行 */ } return; }
  await ensureClipAlarm();
  for (const key of keys) {
    const tabId = Number(key);
    if (!(await tabExists(tabId))) { await abandon(tabId); continue; }
    watch(tabId);
  }
}

/** ブラウザ再起動で復元された裏タブを引き取る（開きっぱなしを防ぐ） */
export async function adoptRestoredClipTabs() {
  if (!(await getOpened()).length) return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { tabs = []; }
  const found = await serial(async () => {
    const want = new Set(await getOpened());
    const hit = tabs.filter(t => t && t.id != null && typeof t.url === 'string' && want.has(t.url));
    try { await chrome.storage.local.set({ [OPENED_KEY]: [...new Set(hit.map(t => t.url))] }); } catch { /* 続行 */ }
    return hit;
  });
  if (!found.length) return;
  const now = Date.now();
  await editPending((p) => {
    for (const t of found) {
      if (p[String(t.id)]) continue;
      p[String(t.id)] = { url: t.url, origin: originOf(t.url), startedAt: now, hardAt: now + HARD_LIMIT_MS, reported: '' };
    }
  });
  await ensureClipAlarm();
  for (const t of found) watch(t.id);
}

/** 裏タブを開いて保存を見届ける。sendResponse には結果を返す */
export async function startClip(url, sendResponse) {
  let tab = null, err = '';
  try { tab = await chrome.tabs.create({ url, active: false }); }
  catch (e) { err = String((e && e.message) || e); }

  if (!tab || tab.id == null) {
    await report(null, 'failed', err || 'タブを開けませんでした');
    try { sendResponse({ ok: false, status: 'failed', err, message: CLIP_MESSAGE.failed }); } catch { /* 続行 */ }
    return;
  }
  const tabId = tab.id;
  responders.set(tabId, sendResponse);
  const now = Date.now();
  await editPending((p) => {
    p[String(tabId)] = { url, origin: originOf(url), startedAt: now, hardAt: now + HARD_LIMIT_MS, reported: '' };
  });
  await rememberOpened(url);
  await ensureClipAlarm();
  watch(tabId);
}

export function onClipTabUpdated(tabId, info) {
  if (info.status !== 'complete') return;
  getPending().then(p => { if (p[String(tabId)]) watch(tabId); });
}

export function onClipTabRemoved(tabId) { abandon(tabId); }
