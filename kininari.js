/* ============================================================
   Recall — 気になり帳（kininari.html）へ送る

   仕組み: 気になり帳の受け口 `#knadd=<JSON>` を裏のタブで開き、
   アプリ側が保存を終えて window.__kininariClipSaved を立てたら閉じる。
   この裏タブの扱いは「気になり帳クリッパー v1.2.1」で作り込まれた
   ものを、そのまま持ち込んでいる（取りこぼし・二重報告・タブの
   開きっぱなしを避けるための工夫がすべて入っている）。
   ============================================================ */
import {
  clip, thumbOf, normalizeUrl, getAll, getMeta, setMeta, putItems, newId,
  STATUS, DEFAULT_STEPS, CAT_COLORS, META_KEY, LOCAL_PREFIX
} from './store.js';

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
// 失敗した項目は、前回から4分たつまで自動では送り直さない。Service Worker はタブの更新などで
// 頻繁に起き直し、そのたびに送り直すと裏タブが何度も開き、5回の試行をすぐ使い切ってしまう
export const RETRY_GAP_MS = 4 * 60000;
const QUEUE_MAX = 200;
const GONE_PREFIX = 'rcClipGone:';   // session: 送っている間に消された項目の「送った印」

export const CLIP_MESSAGE = {
  saved: '気になり帳に保存しました',
  dup: '気になり帳にはもう入っていました（二重には登録していません）',
  quota: '気になり帳の保存容量がいっぱいで、保存できませんでした。気になり帳で不要なメモや画像を減らしてから、もう一度送ってください',
  parse: '気になり帳が受け取った内容を読めませんでした。気になり帳を新しい版にしてから、もう一度送ってください',
  blind: '気になり帳を開きました（保存できたかは未確認）',
  unconfirmed: '保存を確認できませんでした。保存先URLを確かめてください',
  closed: '裏のタブが閉じられたため、保存できたか分かりません',
  failed: '気になり帳に送れませんでした。保存先URLを確かめてください',
  off: '気になり帳への送信はオフです',
  nourl: '気になり帳の保存先URLが未設定です'
};

/* ---------- 送る内容を組み立てる（純粋な関数：テストしやすい） ---------- */

/** 気になり帳の復習の間隔（日）。気になり帳側は固定で、設定では変えられない */
export const KN_STEPS = [1, 3, 7, 14, 30, 60, 120];

/**
 * クリップの番号。気になり帳は、同じ番号が二度届いたら2件目を作らない（30日・500件まで覚えている）。
 * 送り直しでも同じ番号を使えば、1回目が実は届いていたときに二重に登録されない。
 */
export const NONCE_RE = /^[0-9a-f]{8,64}$/;
export function newClipNonce() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map(x => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Recall の段位を、気になり帳でいちばん近い間隔の段に置き換える。
 * Recall は間隔を設定で変えられるので、同じ「何段目」でも日数が違うことがある
 * （そのまま送ると、気になり帳で「覚えた」を押したときの伸び方がずれる）。
 */
export function knBox(b, steps) {
  const st = steps && steps.length ? steps : DEFAULT_STEPS;
  const days = Number(st[Math.min(Math.max(0, Math.round(Number(b) || 0)), st.length - 1)]) || 1;
  let best = 0;
  for (let i = 1; i < KN_STEPS.length; i++) {
    if (Math.abs(KN_STEPS[i] - days) < Math.abs(KN_STEPS[best] - days)) best = i;
  }
  return best;
}

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
      f: clip(fields.folder || '', 40),   // "" = フォルダなし（Recall の未分類）
      src: 'recall'                        // 気になり帳は、Recall から来たメモに分類の控え（rc）を付ける
    };
    if (fields.tags && fields.tags.length) p.tags = fields.tags;
    if (fields.srs) p.srs = fields.srs;          // 復習の進み具合をそのまま引き継ぐ
    if (NONCE_RE.test(String(fields.nonce || ''))) p.k = fields.nonce;   // クリップの番号（二重登録よけ）
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

/**
 * Recall のカテゴリを気になり帳のフォルダ名にする。
 * 未分類（c0）と見つからないカテゴリは ""（＝気になり帳の「フォルダなし」）。
 * 以前は「未分類」という名前のまま送っていたため、気になり帳に「未分類」フォルダができ、
 * Recall で分け直してもメモがそこに溜まったままになっていた。
 */
const KN_UNSORTED = '未分類';
export function knFolderName(cat) {
  if (!cat || cat.id === 'c0') return '';
  const name = String(cat.name || '').trim();
  return name === KN_UNSORTED ? '' : name;   // 名前が「未分類」のものも同じ扱い（気になり帳もそう読む）
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
    folder: knFolderName(cat),           // Recall のカテゴリ＝気になり帳のフォルダ（未分類は「フォルダなし」）
    tags: (item.g || []).slice(0, 12),
    srs: srsFor(item, meta.s && meta.s.steps)
  };
}

/**
 * Recall の復習状態を気になり帳の形にそろえる。
 * 気になり帳側は 0=未読 / 1=学習中 / 2=完了 の3つ。アーカイブは復習に入れない。
 */
export function srsFor(item, steps) {
  if (item.s === STATUS.ARCHIVED) return null;
  const st = item.s === STATUS.DONE ? 2 : (item.s === STATUS.LEARNING ? 1 : 0);
  return {
    b: knBox(item.b, steps),
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
export function markClipped(item, confirmed, nonce) {
  const out = { ...item, kn: Date.now(), knc: confirmed ? 1 : 0 };
  if (NONCE_RE.test(String(nonce || ''))) out.knk = nonce;   // 送り直すときに同じ番号を使うため
  return out;
}

/** 項目の送信状態を一言で表す */
export function clipStateOf(item, queueEntry) {
  if (queueEntry) {
    // 気になり帳から理由が返ってきたもの（自動では送り直さない）
    if (queueEntry.status === 'quota') return { key: 'stuck', text: '送れていません（気になり帳の保存容量がいっぱい）' };
    if (queueEntry.status === 'parse') return { key: 'stuck', text: '送れていません（気になり帳が受け取れない形式）' };
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

/**
 * 送信の予約。すでに並んでいれば何もしない。いっぱいなら断る（黙って捨てない）。
 * opts.nonce … 前に送ったときの番号を使い回す（届いていたかどうか分からない分を送り直すとき）
 */
export async function enqueueClip(id, opts = {}) {
  let refused = false;
  const k = NONCE_RE.test(String(opts.nonce || '')) ? opts.nonce : newClipNonce();
  const next = await editQueue(q => {
    if (q.some(e => e.id === id)) return null;
    if (q.length >= QUEUE_MAX) { refused = true; return null; }   // 古い方を守る
    q.push({ id, at: Date.now(), tries: 0, status: '', err: '', k });
    return q;
  });
  return { ok: !refused, refused, size: next.length };
}

export async function removeFromQueue(id) {
  return editQueue(q => q.filter(e => e.id !== id));
}

/** giveUp … 待っても直らない失敗（気になり帳の容量不足など）。自動では送り直さず、「今すぐ送る」を待つ */
async function noteFailure(id, status, err, giveUp) {
  return editQueue(q => q.map(e => e.id === id
    ? { ...e, tries: giveUp ? Math.max(MAX_TRIES, (e.tries || 0) + 1) : (e.tries || 0) + 1, status, err: String(err || '').slice(0, 200), at: Date.now() }
    : e));
}

/** 諦めた分もふくめて、もう一度ぜんぶ送り直す */
export async function resetQueueTries() {
  return editQueue(q => q.map(e => ({ ...e, tries: 0, status: '', err: '' })));
}

/**
 * 送っている最中に項目が消された。送れたこと自体は事実なので、
 * 「元に戻す」で戻したときに印ごと戻せるよう控えておく（印が無いと、もう一度送られて二重になる）。
 * session に置くので、ブラウザを閉じれば消える（元に戻せるのは削除の直後だけ）。
 */
async function noteSentWhileGone(id, confirmed, nonce) {
  const mark = { kn: Date.now(), knc: confirmed ? 1 : 0 };
  if (NONCE_RE.test(String(nonce || ''))) mark.knk = nonce;
  try { await chrome.storage.session.set({ [GONE_PREFIX + id]: mark }); }
  catch { /* 控えられなくても送信自体は済んでいる */ }
}

/** 元に戻すときに呼ぶ。消していた間に送り終えた分の印 {id: {kn, knc}} を返し、控えは片付ける */
export async function takeSentWhileGone(ids) {
  const keys = (ids || []).map(id => GONE_PREFIX + id);
  if (!keys.length) return {};
  try {
    const got = await chrome.storage.session.get(keys);
    const found = Object.keys(got);
    if (found.length) await chrome.storage.session.remove(found);
    const out = {};
    for (const k of found) out[k.slice(GONE_PREFIX.length)] = got[k];
    return out;
  } catch { return {}; }
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

let running = null;   // 送信中の回（Promise）。裏タブは一度に1つしか開かない

/**
 * 待ち行列を順番に送る。裏タブは一度に1つしか開かない。
 * opts.force … 手動の「今すぐ送る」など。試行回数の上限と間隔を無視する
 * opts.retry … 5分ごとの再送アラーム。間隔（RETRY_GAP_MS）は無視するが上限は守る
 * opts.wait  … 送信中の回があれば、終わるのを待ってからもう一度送る（結果を画面に出す操作用）。
 *              待たないと「送れませんでした」と出るのに、実は送信中の回が送っている、ということが起きる
 * @returns {{ok:boolean, sent:number, left:number, reason?:string}}
 */
export async function flushClips(opts) {
  if (running) {
    if (!(opts && opts.wait)) return { ok: true, sent: 0, left: (await getQueue()).length, reason: 'busy' };
    await running.catch(() => {});
    return flushClips(opts);
  }
  // 終わったときには running が空になっているようにする（待っていた側がすぐ次を始められる）
  running = (async () => {
    try { return await flushOnce(opts); } finally { running = null; }
  })();
  return running;
}

async function flushOnce(opts) {
  try {
    if (!(await getQueue()).length) { await clearRetryAlarm(); return { ok: true, sent: 0, left: 0 }; }

    const first = await getAll();
    if (!clipEnabled(first.meta)) {
      // オフの間は再送アラームも止める（オンに戻したときは設定の変更をきっかけに送り直す）
      await clearRetryAlarm();
      return { ok: false, sent: 0, left: (await getQueue()).length, reason: 'off' };
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      await ensureRetryAlarm();
      return { ok: false, sent: 0, left: (await getQueue()).length, reason: 'offline' };
    }

    const force = !!(opts && opts.force);
    const retry = !!(opts && opts.retry);
    const done = [];
    const results = {};          // 項目ごとの結果（saved / dup / blind / quota / parse / …）
    const attempted = new Set();
    let sent = 0;
    // 送信中に新しく積まれた分も同じ回で送る。
    // 一度きりにすると、まとめて保存したときに1件しか送られず、
    // 残りは5分後の再送まで待つことになる。
    for (;;) {
    const q = (await getQueue()).filter(e => !attempted.has(e.id));
    const now = Date.now();
    const todo = q.filter(e => force || ((e.tries || 0) < MAX_TRIES
      && (retry || !(e.tries > 0) || now - (e.at || 0) >= RETRY_GAP_MS)));   // 失敗したばかりの分は待つ
    if (!todo.length) break;
    for (const entry of todo) {
      attempted.add(entry.id);

      // 1件ごとに読み直す。送信には1件あたり最大25秒かかるので、
      // 最初のスナップショットで書き戻すと、その間の編集が巻き戻ってしまう。
      const { items, meta, rich } = await getAll();
      if (!clipEnabled(meta)) break;
      const item = items.find(i => i.id === entry.id);
      if (!item) { await removeFromQueue(entry.id); continue; }   // 消された項目は送らない

      // 番号は待ち行列の項目に持たせ、送り直しでも同じものを使う（前の版で積んだ分には、ここで振る）
      let k = entry.k;
      if (!NONCE_RE.test(String(k || ''))) {
        k = newClipNonce();
        await editQueue(q => q.map(e => (e.id === entry.id ? { ...e, k } : e)));
      }
      const built = buildClipUrl(meta.s.knUrl, { ...clipFieldsFor(item, meta, rich[item.id]), nonce: k });
      if (!built.url) { await noteFailure(entry.id, 'toolong', '内容が大きすぎます'); continue; }
      // http/https 以外はタブが開けても中身が動かない。
      // 「開いたから送れたことにする」と、URLの打ち間違いが静かに握りつぶされる。
      if (!originOf(built.url)) {
        await noteFailure(entry.id, 'badurl', '保存先URLが http:// または https:// ではありません');
        continue;
      }

      const res = await startClipAwait(built.url);
      results[entry.id] = res.status;
      if (res.status === 'saved' || res.status === 'dup' || res.status === 'blind') {
        // dup … 気になり帳にはもう入っていた（前の送信が届いていた）。確かめられたので「送信済み」にする
        const confirmed = res.status !== 'blind';
        // 送信中に編集されているかもしれないので、いまの内容に印だけを足す
        const latest = (await getAll()).items.find(i => i.id === entry.id);
        if (latest) await putItems([markClipped(latest, confirmed, k)]);
        else await noteSentWhileGone(entry.id, confirmed, k);   // 送っている間に消された
        await removeFromQueue(entry.id);
        done.push(entry.id);
        sent++;
      } else if (res.status === 'quota' || res.status === 'parse') {
        // 気になり帳が理由を返してきた。待っても直らないので、自動では送り直さない
        await noteFailure(entry.id, res.status, CLIP_MESSAGE[res.status], true);
      } else {
        await noteFailure(entry.id, res.status, res.err);
      }
    }
    }

    const left = await getQueue();
    if (left.some(e => (e.tries || 0) < MAX_TRIES)) await ensureRetryAlarm();
    else await clearRetryAlarm();
    return { ok: true, sent, left: left.length, done, results };
  } catch (e) {
    return { ok: false, sent: 0, left: (await getQueue()).length, reason: String((e && e.message) || e) };
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

/**
 * 気になり帳の返事を読む。返事はページ本体（MAIN）に立つ。結合アプリ（index.html）では iframe の中なので全フレームを見る。
 *   __kininariClipStatus … 'saved' / 'dup'（もう入っていた）/ 'quota'（容量不足）/ 'parse'（形式エラー）
 *   __kininariClipSaved  … 保存できた（古い版の気になり帳はこれだけを立てる）
 * @returns {{done: boolean, status?: string}|null} null は権限が無い・まだ読み込み中
 */
export function readClipReply(values) {
  let saved = false;
  const statuses = [];
  for (const v of values || []) {
    if (v === true) saved = true;
    else if (v && typeof v === 'object') {
      if (v.saved) saved = true;
      if (typeof v.status === 'string' && v.status) statuses.push(v.status);
    }
  }
  const bad = statuses.find(st => st === 'quota' || st === 'parse');
  if (bad) return { done: true, status: bad };
  if (saved) return { done: true, status: statuses.includes('dup') ? 'dup' : 'saved' };
  return { done: false };
}

async function clipReplyInTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: () => {
        try { return { saved: !!window.__kininariClipSaved, status: String(window.__kininariClipStatus || '') }; }
        catch { return { saved: false, status: '' }; }
      }
    });
    return readClipReply((results || []).map(r => r && r.result));
  } catch { return null; }   // 権限が無い・まだ読み込み中
}

async function report(tabId, status, err) {
  try { await chrome.storage.session.set({ [LAST_CLIP_KEY]: { status, err: err || '', at: Date.now() } }); }
  catch { /* 続行 */ }
  if (tabId != null) {
    const send = responders.get(tabId);
    if (send) {
      responders.delete(tabId);
      try { send({ ok: status === 'saved' || status === 'dup', status, err: err || '', message: CLIP_MESSAGE[status] || '' }); } catch { /* 続行 */ }
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
        const reply = await clipReplyInTab(tabId);
        if (reply && reply.done) { await finish(tabId, reply.status); return; }
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

/* ============================================================
   気になり帳のフォルダを読む（Recall のカテゴリに取り込むため）
     気になり帳は、この Chrome の localStorage（気になり帳のサイト）に全データを持っている。
     「保存の確認を許可する」で得たサイトへの権限で、そこを読むだけ（気になり帳には何も書かない）。
   ============================================================ */

const KN_DATA_KEY = 'kininari:data:v2';
const FOLDER_WAIT_MS = 20000;
export const CAT_NAME_MAX = 20;      // Recall のカテゴリ名の上限（設定画面と同じ）

/**
 * 気になり帳のデータからフォルダの名前と色を取り出す（純粋な関数）。
 * 同じ名前のフォルダ（入れ子の別の場所にあるもの）は1つにまとめる。気になり帳も送られてきたクリップを名前で入れるため。
 * @returns {Array<{name: string, color: string}>|null} 気になり帳のデータでなければ null
 */
export function foldersFromKininariData(raw) {
  let data = raw;
  if (typeof raw === 'string') { try { data = JSON.parse(raw); } catch { return null; } }
  if (!data || typeof data !== 'object' || !Array.isArray(data.notebooks)) return null;
  const out = [];
  const seen = new Set();
  for (const f of data.notebooks) {
    if (!f || typeof f !== 'object') continue;
    const name = typeof f.name === 'string' ? f.name.trim() : '';
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, color: /^#[0-9a-fA-F]{3,8}$/.test(String(f.color || '')) ? f.color : '' });
  }
  return out;
}

/**
 * 気になり帳のフォルダのうち、Recall に無いものをカテゴリとして足す（純粋な関数）。
 * 同じ名前（大文字小文字は区別しない。気になり帳の照合と同じ）のものはそのまま。消したり名前を変えたりはしない。
 * 長すぎる名前は、Recall の上限に切り詰めると気になり帳に別のフォルダができてしまうので取り込まない。
 */
export function mergeFolderCats(cats, folders, makeId) {
  const have = new Set((cats || []).map(c => String(c.name || '').trim().toLowerCase()));
  const add = [], tooLong = [];
  let same = 0;
  for (const f of folders || []) {
    const key = f.name.toLowerCase();
    if (have.has(key)) { same++; continue; }
    if (f.name.length > CAT_NAME_MAX) { tooLong.push(f.name); continue; }
    const color = f.color || CAT_COLORS[((cats || []).length + add.length) % CAT_COLORS.length];
    add.push({ id: makeId(), name: f.name, color });
    have.add(key);
  }
  return { cats: [...(cats || []), ...add], added: add.map(c => c.name), same, tooLong };
}

/** 気になり帳のデータ（localStorage）をそのタブから読む。undefined はまだ読み込み中・読めないページ */
async function readKnData(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
      args: [KN_DATA_KEY]
    });
    return r ? r.result : null;
  } catch { return undefined; }
}

/**
 * 気になり帳のフォルダを読む。気になり帳のサイトのタブが開いていればそこから、無ければ裏のタブで開いて読み、閉じる。
 * @returns {Promise<{ok: boolean, folders?: Array, reason?: string, message?: string}>}
 */
export async function readKininariFolders(knUrl) {
  const base = String(knUrl || '').trim().split('#')[0];
  const origin = originOf(base);
  if (!origin) return { ok: false, reason: 'nourl', message: CLIP_MESSAGE.nourl };
  if (!(await canScript(origin))) {
    return { ok: false, reason: 'perm', message: '先に「保存の確認を許可する」を押してください（気になり帳のフォルダを読むのに使います）。' };
  }
  const read = readKnData;
  const done = (v) => {
    const folders = v == null ? null : foldersFromKininariData(v);
    if (!folders) return { ok: false, reason: 'nodata', message: 'この Chrome には気になり帳のデータが見つかりませんでした（このブラウザで気になり帳を開いたことがあるか確かめてください）。' };
    return { ok: true, folders };
  };
  // 同じサイトのタブが開いていれば、それを使う（同じサイトなら、どのページからでも同じデータが見える）
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: origin }); } catch { tabs = []; }
  for (const t of tabs || []) {
    if (!t || t.id == null || t.status !== 'complete') continue;
    const v = await read(t.id);
    if (typeof v === 'string') return done(v);
  }
  let tab = null;
  try { tab = await chrome.tabs.create({ url: base, active: false }); }
  catch (e) { return { ok: false, reason: 'failed', message: '気になり帳を開けませんでした: ' + String((e && e.message) || e) }; }
  try {
    const end = Date.now() + FOLDER_WAIT_MS;
    while (Date.now() < end) {
      if (await tabLoaded(tab.id)) {
        const v = await read(tab.id);
        if (v !== undefined) return done(v);
      }
      await sleep(400);
    }
    return { ok: false, reason: 'timeout', message: '気になり帳を開けませんでした。URL とネットの接続を確かめてください。' };
  } finally {
    try { chrome.tabs.remove(tab.id, () => void chrome.runtime.lastError); } catch { /* 続行 */ }
  }
}

/* ============================================================
   気になり帳と合わせる（分類とフォルダの一覧）
     ・分類は Recall に合わせる。Recall でカテゴリを変えると、気になり帳のメモもそのフォルダへ移る
       （気になり帳の中でメモを動かしても Recall は変わらない）。
     ・フォルダ（カテゴリ）の一覧は両方向。どちらかで足したものは、もう片方にもできる。
       消したり名前を変えたりは伝えない（片方の操作で、もう片方の中身が消えると取り返しがつかない）。
     ・Recall の未分類（c0）＝ 気になり帳の「フォルダなし」。
   やり方: 開いている気になり帳のページの window.__kininariRecall.apply(payload) を呼ぶ
   （取り決めは「Recall ⇄ 気になり帳 フォルダ同期 protocol v1」）。
   自動で合わせるときは、すでに開いているタブだけを使う。勝手にタブを開くと、
   カテゴリを変えるたびに画面の外でタブが開いたり閉じたりして落ち着かないため。
   ============================================================ */

export const KN_SYNC_KEY = 'rcKnSync';          // local: 合わせた記録 { lastOk, sig, pendingAt, last }
export const KN_SYNC_DELAY_MS = 3000;            // 変えてから合わせるまで待つ（続けて変えたときは1回にまとめる）
export const KN_SYNC_STALE_MS = 30 * 60000;      // 気になり帳を開いたとき、これより前に合わせたきりなら合わせ直す
// 開いているタブに気になり帳がまだ出ていないとき（結合アプリ index.html で別のアプリを見ている など）に見直す間隔。
// index.html は気になり帳のタブを選んだときに iframe を読み込むが、iframe の読み込みでは tabs.onUpdated が来ないため
export const KN_SYNC_ALARM = 'recall-kn-sync-retry';
const KN_RETRY_MIN = 0.5;                        // 分（chrome.alarms の下限は 30 秒）
// 待ち時間（テストでは短くする）
export const KN_SYNC_WAIT = {
  api: 10000,      // 読み込んだばかりのページで、受け口が出てくるまで待つ（気になり帳はデータを非同期で読む）
  probe: 3000,     // 前から開いているタブ（読み終わっているので、出ているならもう出ている）
  poll: 500,       // 受け口を探し直す間隔
  load: 20000,     // 手動で裏のタブを開いたとき、読み終わるまで待つ
  apply: 20000     // 気になり帳が返事をしないとき、ここで諦める
};
const HEX6 = /^#[0-9a-fA-F]{6}$/;                // Recall の色（<input type=color> が読める形）

/**
 * 気になり帳がメモの重複を見分けるときと同じ形の URL（# 以降と末尾の / は区別しない）。
 * 同じページが Recall に2件あると、気になり帳のメモが2つのフォルダの間を行ったり来たりするので、そろえて1件にする。
 */
export function knUrlKey(u) {
  const s = typeof u === 'string' ? u.trim() : '';
  if (!s) return '';
  try { const x = new URL(s); x.hash = ''; return x.href.replace(/\/+$/, ''); }
  catch { return s.replace(/#.*$/, '').replace(/\/+$/, ''); }
}

/**
 * 気になり帳へ渡す中身を作る（純粋な関数）。
 *   cats  … 未分類を除いた全カテゴリ（名前と色）
 *   items … http(s) の全項目（URL はそのまま。f はフォルダ名、未分類・見つからないカテゴリは ""）
 * 同じページが2件あれば先に来た方（getAll は新しい順）を使う。
 */
export function buildSyncPayload(items, meta) {
  const list = (meta && Array.isArray(meta.cats)) ? meta.cats : [];
  const cats = [];
  const seen = new Set();
  for (const c of list) {
    const name = knFolderName(c);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;   // 大文字小文字だけ違う名前は、気になり帳では同じフォルダ
    seen.add(key);
    cats.push({ name, color: HEX6.test(String((c && c.color) || '')) ? c.color : '' });
  }
  const byId = new Map(list.filter(Boolean).map(c => [c.id, c]));
  const out = [];
  const urls = new Set();
  for (const it of items || []) {
    const u = it && typeof it.u === 'string' ? it.u : '';
    if (!/^https?:\/\//i.test(u)) continue;
    const key = knUrlKey(u);
    if (urls.has(key)) continue;
    urls.add(key);
    out.push({ u, f: knFolderName(byId.get(it.c)) });
  }
  return { v: 1, cats, items: out };
}

/**
 * 中身の指紋。前に合わせたときと同じなら、変更のたびに気になり帳を呼ばずに済む。
 * 全文を持つと大きいので短い要約にする（FNV-1a を2本と長さ）。保存先が変われば別物として扱う。
 */
export function payloadSig(payload, origin) {
  const s = String(origin || '') + '\n' + JSON.stringify(payload);
  let a = 0x811c9dc5, b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 2246822519);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0') + ':' + s.length;
}

/**
 * 気になり帳の返事からフォルダを取り出す（純粋な関数）。
 * 「未分類」は Recall の未分類と同じものなので足さない。名前の無いもの・同じ名前は除く。
 */
export function foldersFromSyncResult(res) {
  const out = [];
  const seen = new Set();
  for (const f of (res && Array.isArray(res.folders)) ? res.folders : []) {
    if (!f || typeof f !== 'object') continue;
    const name = typeof f.name === 'string' ? f.name.trim() : '';
    if (!name || name === KN_UNSORTED || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, color: HEX6.test(String(f.color || '')) ? f.color : '' });
  }
  return out;
}

/** 気になり帳の返事のうち、受け口のあったフレームのものを選ぶ。どのフレームにも無ければ null */
export function pickApplyResult(results) {
  let first = null;
  for (const r of results || []) {
    const v = r && r.result;
    if (!v || typeof v !== 'object' || !v.found) continue;
    const res = (v.result && typeof v.result === 'object') ? v.result : { ok: false, error: '気になり帳から返事がありませんでした' };
    if (res.ok) return res;
    if (!first) first = res;
  }
  return first;
}

const catNamesOf = (m) => JSON.stringify(((m && Array.isArray(m.cats)) ? m.cats : []).map(c => [c && c.id, String((c && c.name) || '').trim()]));
const knCfgOf = (m) => JSON.stringify([!!(m && m.s && m.s.knOn), String((m && m.s && m.s.knUrl) || '')]);

/**
 * この変更で、気になり帳と合わせ直す必要が出たか（純粋な関数。storage.onChanged の中身を見る）。
 * 項目のカテゴリ・URL、カテゴリの一覧（名前）、送信の設定が変わったときだけ。
 * 復習の結果やメモの編集のたびに合わせに行かないようにする（項目の追加は、送るときにフォルダ付きで届く）。
 */
export function knSyncRelevant(changes, area) {
  if (!changes || typeof changes !== 'object') return false;
  if (area === 'sync') {
    const ch = changes[META_KEY];
    if (!ch) return false;
    return catNamesOf(ch.oldValue) !== catNamesOf(ch.newValue) || knCfgOf(ch.oldValue) !== knCfgOf(ch.newValue);
  }
  if (area !== 'local') return false;
  for (const [k, ch] of Object.entries(changes)) {
    if (!k.startsWith(LOCAL_PREFIX) || !ch) continue;
    const a = ch.oldValue, b = ch.newValue;
    if (!a || !b) continue;
    if (a.c !== b.c || a.u !== b.u) return true;
  }
  return false;
}

/** 気になり帳を開いたときに合わせるか（未反映の変更がある・しばらく合わせていない） */
export function knSyncDueOnLoad(state, now = Date.now()) {
  const s = state || {};
  return !!s.pendingAt || !(s.lastOk > 0) || now - s.lastOk >= KN_SYNC_STALE_MS;
}

/** そのタブで合わせてよいか。送信用の裏タブ（#knadd=）は閉じられる途中なので使わない */
export function knTabUsable(tab, origin, needComplete = true) {
  if (!tab || tab.id == null || tab.discarded) return false;
  const u = typeof tab.url === 'string' ? tab.url : '';
  if (!u || u.includes('#knadd=') || originOf(u) !== origin) return false;
  return !needComplete || tab.status === 'complete';
}

export const KN_SYNC_MESSAGE = {
  nourl: '気になり帳の URL が未設定です（「気になり帳へ送る」の欄に入れてください）。',
  perm: '先に「気になり帳へ送る」の「保存の確認を許可する」を押してください（気になり帳と合わせるのに使います）。',
  open: '気になり帳を開けませんでした。',
  timeout: '気になり帳を開けませんでした。URL とネットの接続を確かめてください。',
  noapi: '気になり帳の「合わせる」の受け口が見つかりませんでした。気になり帳を新しい版にしてください（URL が kininari.html を指しているかも確かめてください）。',
  nodata: 'この Chrome には気になり帳のデータが見つかりませんでした（このブラウザで気になり帳を開いたことがあるか確かめてください）。',
  failed: '気になり帳と合わせられませんでした。',
  off: '「気になり帳へ送る」がオフです。',
  notab: '開いている気になり帳がありません。',
  busy: 'ほかの合わせる処理が動いています。'
};

/** 結果を一言で表す（設定画面に出す） */
export function knSyncMessage(res) {
  if (!res) return '結果を受け取れませんでした。';
  const long = (res.tooLong && res.tooLong.length)
    ? `名前が長い ${res.tooLong.length} 件（${res.tooLong.map(n => clip(n, 16)).join('・')}）はカテゴリにできませんでした（カテゴリ名は${CAT_NAME_MAX}文字まで）。`
    : '';
  const added = (res.added && res.added.length) ? `気になり帳のフォルダ ${res.added.length} 件をカテゴリに足しました（${res.added.join('・')}）。` : '';
  if (!res.ok) {
    const base = KN_SYNC_MESSAGE[res.reason] || KN_SYNC_MESSAGE.failed;
    return base + (res.error ? `（${clip(res.error, 120)}）` : '');
  }
  if (res.old) {
    // 受け口の無い古い気になり帳。フォルダを読んで足すことだけはできる
    return '気になり帳と分類を合わせられませんでした（気になり帳が古い版か、URL が kininari.html を指していません）。フォルダの取り込みだけしました。'
      + (added || 'フォルダはすべて Recall のカテゴリにあります。') + long;
  }
  const parts = [];
  const moved = Math.max(0, Number(res.moved) || 0);
  if (moved) parts.push(`メモ ${moved} 件を Recall のカテゴリのフォルダへ移しました。`);
  if (res.created && res.created.length) parts.push(`気になり帳にフォルダを ${res.created.length} 件作りました（${res.created.join('・')}）。`);
  if (added) parts.push(added);
  if (res.removed && res.removed.length) parts.push(`空になった「${res.removed.join('・')}」フォルダを片付けました。`);
  return '気になり帳と合わせました。' + (parts.length ? parts.join('') : '変わったところはありません。') + long;
}

/* ---------- 記録（Service Worker が止まっても残るよう local に置く） ---------- */

export async function getKnSyncState() {
  try {
    const v = (await chrome.storage.local.get(KN_SYNC_KEY))[KN_SYNC_KEY];
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

/** 記録の書き換えは必ずここを通す（「変更あり」の印と、合わせ終わった記録が取り合いにならないように） */
function editKnSyncState(fn) {
  return serial(async () => {
    const cur = await getKnSyncState();
    const next = fn({ ...cur });
    if (next && JSON.stringify(next) !== JSON.stringify(cur)) {
      try { await chrome.storage.local.set({ [KN_SYNC_KEY]: next }); } catch { /* 次の変更か、気になり帳を開いたときに合わせる */ }
    }
    return next || cur;
  });
}

/**
 * 「まだ気になり帳に届いていない変更がある」印。local に置くので、Service Worker が止まっても、
 * ブラウザを閉じても残り、次に気になり帳を開いたときに合わせられる。
 */
export function markKnSyncPending(now = Date.now()) {
  return editKnSyncState(s => ({ ...s, pendingAt: now }));
}

/* ---------- 気になり帳のページの中で動かす ---------- */

/**
 * ページ本体（MAIN）で動かす。chrome.scripting で送るので、外の変数は使えない。
 * 受け口はデータを読み終えてから出てくるので、無ければ「まだ」と返す（呼ぶ側が少し待って呼び直す）。
 */
function runKininariApply(payload, timeoutMs) {
  const api = window.__kininariRecall;
  if (!api || typeof api.apply !== 'function') return { found: false };
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve({ found: true, result }); } };
    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), timeoutMs);
    let p;
    try { p = Promise.resolve(api.apply(payload)); }
    catch (e) { p = Promise.reject(e); }
    p.then((r) => {
      clearTimeout(timer);
      let out = null;
      try { out = JSON.parse(JSON.stringify(r === undefined ? null : r)); } catch { out = { ok: false, error: 'bad result' }; }
      done(out);
    }, (e) => {
      clearTimeout(timer);
      done({ ok: false, error: String((e && e.message) || e) });
    });
  });
}

/**
 * そのタブの気になり帳に apply を頼む。結合アプリ（index.html）では iframe の中にあるので、全フレームに送る。
 * 受け口が出るまで waitMs だけ呼び直す。どのフレームにも無ければ null。
 */
async function applyInTab(tabId, payload, waitMs) {
  const end = Date.now() + waitMs;
  for (;;) {
    let results = null;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        func: runKininariApply,
        args: [payload, KN_SYNC_WAIT.apply]
      });
    } catch { results = null; }   // 読み込み中・閉じられた・読めないページ
    const res = pickApplyResult(results);
    if (res) return res;
    if (Date.now() >= end || !(await tabExists(tabId))) return null;
    await sleep(KN_SYNC_WAIT.poll);
  }
}

/**
 * 手動のときだけ: 気になり帳を裏のタブで開いて合わせ、閉じる。
 * 受け口の無い古い気になり帳なら、フォルダを読むだけにする（1.10 の「フォルダを取り込む」と同じ）。
 */
async function applyInNewTab(base, payload) {
  let tab = null;
  try { tab = await chrome.tabs.create({ url: base, active: false }); }
  catch (e) { return { reason: 'open', error: String((e && e.message) || e) }; }
  try {
    const end = Date.now() + KN_SYNC_WAIT.load;
    while (Date.now() < end && !(await tabLoaded(tab.id))) {
      if (!(await tabExists(tab.id))) return { reason: 'open' };
      await sleep(Math.min(400, KN_SYNC_WAIT.poll));
    }
    if (!(await tabLoaded(tab.id))) return { reason: 'timeout' };
    const res = await applyInTab(tab.id, payload, KN_SYNC_WAIT.api);
    if (res) return { res };
    const raw = await readKnData(tab.id);
    const folders = typeof raw === 'string' ? foldersFromKininariData(raw) : null;
    if (!folders) return { reason: raw === undefined ? 'noapi' : 'nodata' };
    return { old: true, folders };
  } finally {
    try { chrome.tabs.remove(tab.id, () => void chrome.runtime.lastError); } catch { /* 続行 */ }
  }
}

/** 気になり帳のフォルダを Recall のカテゴリに足す（足すだけ。消したり名前を変えたりはしない） */
async function addFolderCats(folders) {
  const cur = await getMeta();
  const r = mergeFolderCats(cur.cats, folders, () => 'c' + newId());
  if (!r.added.length) return { ...r, ok: true, cats: cur.cats };
  const w = await setMeta({ cats: r.cats });
  if (!w.ok) return { ...r, ok: false, added: [], cats: cur.cats, error: w.error };
  return { ...r, ok: true };
}

/**
 * 見直しの予約。届いていない変更があり、気になり帳のサイトのタブは開いているのに気になり帳が出ていないときだけ置く。
 * 合わせられた・タブが無くなった（次に開いたときに合わせる）・使えない設定のときは外す。
 */
async function setKnRetry(on) {
  try {
    if (!on) { await chrome.alarms.clear(KN_SYNC_ALARM); return; }
    if (!(await chrome.alarms.get(KN_SYNC_ALARM))) {
      await chrome.alarms.create(KN_SYNC_ALARM, { delayInMinutes: KN_RETRY_MIN, periodInMinutes: KN_RETRY_MIN });
    }
  } catch { /* 次の変更か、気になり帳を開いたときに合わせる */ }
}

/** 自動の回の結果から、見直しの予約を置くか外すかを決める（純粋な関数） */
export function knRetryAfter(res, pending) {
  if (!res || res.reason === 'busy') return null;                 // 動いている回が決める
  if (res.reason === 'noapi') return !!pending;
  return false;
}

/* ---------- 合わせる（自動・手動の入り口） ---------- */

let knRun = null;     // 動いている回。一度に1回だけ（同じメモを2回動かさない）
let knAgain = null;   // 動いている間に頼まれた自動の回（終わってからもう一度）

/**
 * 気になり帳と合わせる。
 *   opts.trigger 'change' … Recall の分類が変わった（少し待ってから・開いているタブだけ）
 *                'load'   … 気になり帳のタブを読み終えた（opts.tabId。未反映の変更があるか、しばらく合わせていないとき）
 *                'retry'  … 見直しの予約（未反映の変更があるときだけ。開いているタブだけ）
 *   opts.manual  … 設定の「気になり帳と合わせる」。開いていなければ裏のタブで開き、終わったら閉じる
 *   opts.knUrl   … 手動のとき、設定画面で入力中の URL
 * @returns {Promise<{ok:boolean, reason?:string, skipped?:string, moved?:number, created?:string[], removed?:string[],
 *   added?:string[], tooLong?:string[], same?:number, old?:boolean, opened?:boolean, error?:string}>}
 */
export async function syncKininari(opts = {}) {
  if (knRun) {
    if (!opts.manual) { knAgain = opts; return { ok: false, reason: 'busy' }; }
    while (knRun) await knRun.catch(() => {});   // 手動は、動いている回が終わるのを待ってから
  }
  knRun = (async () => {
    try { return await knSyncOnce(opts); }
    catch (e) { return { ok: false, reason: 'failed', error: String((e && e.message) || e) }; }
    finally { knRun = null; }
  })();
  const res = await knRun;
  const retry = knRetryAfter(res, (await getKnSyncState()).pendingAt);
  if (retry !== null) await setKnRetry(retry);
  if (knAgain && !knRun) {
    const again = knAgain;
    knAgain = null;
    syncKininari(again).catch(() => {});
  }
  return res;
}

async function knSyncOnce(opts) {
  const manual = !!opts.manual;
  const trigger = manual ? 'manual' : (opts.trigger || 'change');
  const startedAt = Date.now();
  const { items, meta } = await getAll();
  // 自動で合わせるのは「気になり帳へ送る」をオンにしているときだけ
  if (!manual && !clipEnabled(meta)) return { ok: false, reason: 'off' };
  const base = String((manual && opts.knUrl) || meta.s.knUrl || '').trim().split('#')[0];
  const origin = originOf(base);
  if (!origin) return { ok: false, reason: 'nourl' };
  if (!(await canScript(origin))) return { ok: false, reason: 'perm' };   // 自動のときは黙って見送る

  const payload = buildSyncPayload(items, meta);
  const sig = payloadSig(payload, origin);
  const state = await getKnSyncState();
  if (trigger === 'retry' && !state.pendingAt) return { ok: true, skipped: 'nothing' };
  if ((trigger === 'change' || trigger === 'retry') && state.sig === sig) {
    // 前に合わせたときと同じ（変えて、すぐ戻した など）。気になり帳を呼ぶまでもない
    await editKnSyncState(s => (s.pendingAt && s.pendingAt <= startedAt ? { ...s, pendingAt: 0 } : null));
    return { ok: true, skipped: 'same' };
  }
  if (trigger === 'load' && !knSyncDueOnLoad(state, startedAt)) return { ok: true, skipped: 'recent' };

  // 使うタブを決める。自動のときは開いているタブだけ（自分では開かない）。
  // 送信用の裏タブは、気になり帳が # を消したあとでも見分けられるよう、送信中のタブの記録でも除く
  const clipTabs = new Set(Object.keys(await getPending()));
  let tabs = [];
  if (trigger === 'load') {
    try { const t = await chrome.tabs.get(opts.tabId); if (knTabUsable(t, origin, false)) tabs = [t]; } catch { tabs = []; }
  } else {
    try { tabs = ((await chrome.tabs.query({ url: origin })) || []).filter(t => knTabUsable(t, origin)); } catch { tabs = []; }
  }
  tabs = tabs.filter(t => !clipTabs.has(String(t.id)));
  let res = null;
  for (const t of tabs) {
    // 読み終えたばかりなら受け口が出るまで待つ。見直しの予約では1回見るだけ（30秒ごとにまた来る）
    const wait = trigger === 'load' ? KN_SYNC_WAIT.api : (trigger === 'retry' ? 0 : KN_SYNC_WAIT.probe);
    res = await applyInTab(t.id, payload, wait);
    if (res) break;
  }

  let opened = false, old = null, reason = '';
  if (!res) {
    if (!manual) reason = tabs.length ? 'noapi' : 'notab';
    else {
      opened = true;
      const r = await applyInNewTab(base, payload);
      if (r.res) res = r.res;
      else if (r.old) old = r.folders;
      else reason = r.reason || 'failed';
    }
  }

  const finish = async (out) => {
    await editKnSyncState(s => {
      const next = { ...s, last: { at: Date.now(), ok: !!out.ok, reason: out.reason || '', trigger, moved: out.moved || 0,
        created: (out.created || []).length, added: (out.added || []).length } };
      if (out.ok && !out.old) {
        next.lastOk = Date.now();
        next.sig = out.sig;
        // 合わせている間に入った変更は、まだ届いていない（印を残して、もう一度合わせる）
        if (!(s.pendingAt > startedAt)) next.pendingAt = 0;
      }
      return next;
    });
    delete out.sig;
    return { ...out, opened };
  };

  if (old) {
    const m = await addFolderCats(old);
    return finish({ ok: m.ok, old: true, added: m.added, tooLong: m.tooLong, same: m.same, error: m.error || '' });
  }
  if (!res) return finish({ ok: false, reason });
  if (!res.ok) return finish({ ok: false, reason: 'failed', error: String(res.error || '') });

  const m = await addFolderCats(foldersFromSyncResult(res));
  // 足したカテゴリは気になり帳から来たもの（向こうにはもうある）。足した後の中身を「合わせ済み」として控える
  const after = m.added.length ? payloadSig(buildSyncPayload(items, { ...meta, cats: m.cats }), origin) : sig;
  return finish({
    ok: m.ok, sig: after, error: m.error || '',
    moved: Math.max(0, Number(res.moved) || 0),
    created: Array.isArray(res.created) ? res.created.filter(n => typeof n === 'string') : [],
    removed: Array.isArray(res.removed) ? res.removed.filter(n => typeof n === 'string') : [],
    added: m.added, tooLong: m.tooLong, same: m.same
  });
}

/**
 * 気になり帳のタブを読み終えたら合わせる（未反映の変更がある・しばらく合わせていないとき）。
 * どのページを開いても呼ばれるので、保存先と同じサイトかを先に安く確かめる。
 */
export function onKnTabUpdated(tabId, info, tab) {
  if (!info || info.status !== 'complete') return;
  const u = String((tab && tab.url) || '');
  if (!/^https?:\/\//i.test(u) || u.includes('#knadd=')) return;
  (async () => {
    const meta = await getMeta();
    if (!clipEnabled(meta)) return;
    const origin = originOf(String(meta.s.knUrl || '').trim().split('#')[0]);
    if (!origin || originOf(u) !== origin) return;
    await syncKininari({ trigger: 'load', tabId });
  })().catch(() => {});
}

export function onClipTabUpdated(tabId, info) {
  if (info.status !== 'complete') return;
  getPending().then(p => { if (p[String(tabId)]) watch(tabId); });
}

export function onClipTabRemoved(tabId) { abandon(tabId); }
