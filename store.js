/* ============================================================
   Recall — データ層（chrome.storage.sync）
   1件 = 1キー（"i:<id>"）で保存し、meta キーに設定とカテゴリを持つ。
   sync の上限: 全体 102,400 バイト / 1キー 8,192 バイト / 512 キー
   ============================================================ */

export const ITEM_PREFIX = 'i:';          // sync: 同期する項目
export const LOCAL_PREFIX = 'L:';         // local: 全項目の本体
export const RICH_PREFIX = 'R:';          // local: サムネイルなどの付随情報（同期しない）
export const META_KEY = 'meta';
export const DEL_KEY = 'del';             // sync: 削除の記録（他の端末へ削除を伝える）
export const WIPE_KEY = 'wipe';           // sync: 「すべて削除」した時刻（他の端末にも伝える）
export const SYNC_BUDGET_BYTES = 80000;   // 同期に使う上限（100KB のうち meta などの余白を残す）
export const DEL_KEEP_DAYS = 60;
export const DEL_MAX = 120;
export const SYNC_QUOTA_BYTES = 102400;
export const SYNC_MAX_ITEMS = 512;
export const RESERVED_KEYS = 2; // meta + 予備

export const STATUS = { NEW: 0, LEARNING: 1, DONE: 2, ARCHIVED: 3 };
export const STATUS_LABEL = { 0: '未読', 1: '学習中', 2: '完了', 3: 'アーカイブ' };

/** 既定の忘却曲線ステップ（日数） */
export const DEFAULT_STEPS = [1, 3, 7, 14, 30, 60, 120];

/** 固定間隔プリセット（0 = 自動 / 忘却曲線） */
export const PRESET_INTERVALS = [
  { v: 0, label: '自動（忘却曲線）' },
  { v: 1, label: '毎日' },
  { v: 3, label: '3日ごと' },
  { v: 7, label: '毎週' },
  { v: 14, label: '2週ごと' },
  { v: 30, label: '毎月' },
  { v: 90, label: '3ヶ月ごと' }
];

export const CAT_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f59e0b',
  '#10b981', '#14b8a6', '#0ea5e9', '#64748b', '#a16207'
];

export const DEFAULT_META = {
  v: 1,
  cats: [
    { id: 'c0', name: '未分類', color: '#94a3b8' },
    { id: 'c1', name: 'あとで読む', color: '#6366f1' },
    { id: 'c2', name: '学習', color: '#10b981' },
    { id: 'c3', name: '仕事', color: '#f59e0b' },
    { id: 'c4', name: '技術', color: '#0ea5e9' },
    { id: 'c5', name: '趣味', color: '#ec4899' }
  ],
  dom: {},               // ドメイン -> 最後に使ったカテゴリ id
  s: {
    steps: DEFAULT_STEPS,
    notify: true,
    hour: 9,             // 復習通知を出す時刻（0-23）
    badge: true,
    defaultCat: 'c0',
    defaultInterval: 0,
    firstDelay: 1,       // 保存してから最初の復習までの日数
    againMode: 'reset',  // 'reset' = 最初に戻す / 'back' = 1段階戻す
    sync: true,          // 直近の項目を Chrome アカウントで同期する
    syncMax: 300,        // 同期する件数の上限
    thumbs: true,        // サムネイルを表示する
    embed: true,         // YouTube をその場で再生できるようにする
    knOn: false,         // 保存したページを気になり帳にも送る
    knUrl: '',           // 気になり帳（kininari.html）の URL
    knCat: '調べる'      // 気になり帳側のカテゴリ
  },
  lastNotified: 0   // 後方互換のため残しているが、実際は chrome.storage.local を使う
};

/* ---------- 小道具 ---------- */

export const LIMITS = { title: 200, url: 1000, note: 1200, tag: 24, tags: 12 };

export function newId() {
  const rnd = (globalThis.crypto && crypto.getRandomValues)
    ? [...crypto.getRandomValues(new Uint8Array(5))].map(b => b.toString(36)).join('').slice(0, 7)
    : Math.random().toString(36).slice(2, 9);
  return Date.now().toString(36).slice(-6) + rnd;
}

export function clip(str, n) {
  const s = String(str == null ? '' : str).trim();
  return s.length > n ? s.slice(0, n) : s;
}

export function byteSize(value) {
  return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
}

const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_cid|mc_eid|igshid|yclid|_ga|ref_src|spm)/i;

const YT_HOSTS = /^(www\.|m\.|music\.)?(youtube\.com|youtube-nocookie\.com)$/i;

/** YouTube の動画 ID を取り出す（watch / youtu.be / shorts / embed / live に対応） */
export function youtubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'youtu.be' || host === 'www.youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return /^[\w-]{11}$/.test(id) ? id : '';
    }
    if (!YT_HOSTS.test(host)) return '';
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/);
    return m ? m[2] : '';
  } catch { return ''; }
}

/** 保存されている項目のサムネイル URL。YouTube は ID から導けるので保存しない */
export function thumbOf(item, rich) {
  const vid = youtubeId(item.u);
  if (vid) return `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`;
  return (rich && rich.th) || '';
}

/** ISO8601 の再生時間（PT4M13S）を 4:13 の形にする */
export function fmtDuration(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return /^[0-9:]+$/.test(iso) ? iso : '';
  const [, d, h, mi, sec] = m.map(v => Number(v || 0));
  const total = d * 86400 + h * 3600 + mi * 60 + sec;
  if (!total) return '';
  const hh = Math.floor(total / 3600), mm = Math.floor((total % 3600) / 60), ss = total % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
            : `${mm}:${String(ss).padStart(2, '0')}`;
}

/** 拡張機能から保存してよい URL か（popup / background / library で共通） */
export function isSavableUrl(url) {
  return !!url && /^https?:\/\//i.test(url);
}

/** 重複判定に使う正規化URL */
export function normalizeUrl(url) {
  const vid = youtubeId(url);
  if (vid) return 'https://www.youtube.com/watch?v=' + vid;   // 同じ動画はまとめる
  try {
    const u = new URL(url);
    // #!/... や #/... はハッシュルーティングのページ識別子なので残す
    u.hash = /^#!?\//.test(u.hash) ? u.hash : '';
    const keep = [];
    u.searchParams.forEach((v, k) => { if (!TRACKING_PARAMS.test(k)) keep.push([k, v]); });
    u.search = '';
    keep.sort((a, b) => a[0].localeCompare(b[0])).forEach(([k, v]) => u.searchParams.append(k, v));
    // パスとクエリは大文字小文字を区別するサービスがあるので小文字化しない
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch { return String(url || ''); }
}

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function faviconUrl(url, size = 32) {
  try {
    const u = new URL(chrome.runtime.getURL('/_favicon/'));
    u.searchParams.set('pageUrl', url);
    u.searchParams.set('size', String(size));
    return u.toString();
  } catch { return ''; }
}

/** 指定日数後の「通知時刻」ちょうどの時刻を返す */
export function dueAfterDays(days, hour = 9, from = Date.now()) {
  const n = Number(days);
  const safe = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 1;   // 不正値でも必ず有効な日付にする
  const d = new Date(from);
  d.setDate(d.getDate() + safe);
  d.setHours(Number.isFinite(Number(hour)) ? Number(hour) : 9, 0, 0, 0);
  // 当日指定で既に時刻を過ぎている場合はそのまま（すぐ復習対象）
  return d.getTime();
}

export function startOfToday() {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
}

export function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const today = startOfToday();
  const diff = Math.round((new Date(ts).setHours(0, 0, 0, 0) - today) / 86400000);
  if (diff === 0) return '今日';
  if (diff === 1) return '明日';
  if (diff === -1) return '昨日';
  if (diff < 0) return `${-diff}日前`;
  if (diff <= 30) return `${diff}日後`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/* ---------- アイテム ---------- */

/**
 * item = {
 *   id, u:url, t:title, n:note, c:catId, g:[tags],
 *   s:status, f:fav(0/1), b:box, d:due(ms), cr:created(ms), rv:reviews, iv:固定間隔(日|0)
 * }
 */
export function makeItem(raw, meta) {
  // 他形式（url / title / note / tags）からの読み込みも受け付ける
  const partial = {
    ...raw,
    u: raw.u ?? raw.url ?? raw.href ?? '',
    t: raw.t ?? raw.title ?? raw.name ?? '',
    n: raw.n ?? raw.note ?? raw.memo ?? raw.description ?? '',
    g: raw.g ?? raw.tags ?? raw.labels ?? []
  };
  const set = (meta || DEFAULT_META).s;
  const now = Date.now();
  const iv = Math.max(0, Number(partial.iv) || 0);
  const firstDays = iv > 0 ? iv : (set.firstDelay ?? 1);
  const steps = (set.steps && set.steps.length) ? set.steps : DEFAULT_STEPS;
  const status = [0, 1, 2, 3].includes(Number(partial.s)) ? Number(partial.s) : STATUS.NEW;
  let due = Number(partial.d);
  if (!Number.isFinite(due) || due < 0) due = dueAfterDays(firstDays, set.hour, now);
  // 完了・アーカイブは期限を持たない（isDue の前提と揃える）
  if (status === STATUS.DONE || status === STATUS.ARCHIVED) due = 0;
  return {
    id: partial.id || newId(),
    u: clip(partial.u, LIMITS.url),
    t: clip(partial.t || partial.u, LIMITS.title),
    n: clip(partial.n || '', LIMITS.note),
    c: partial.c || set.defaultCat || 'c0',
    g: normalizeTags(partial.g),
    s: status,
    f: partial.f ? 1 : 0,
    b: clampBox(partial.b, steps),
    d: due,
    cr: Number.isFinite(Number(partial.cr)) ? Number(partial.cr) : now,
    rv: Math.max(0, Number(partial.rv) || 0),
    iv,
    kn: Math.max(0, Number(partial.kn) || 0),  // 気になり帳へ送った時刻（0 = 未送信）
    knc: partial.knc ? 1 : 0                   // 1 = 保存されたことを確認できた / 0 = 未確認
  };
}

/** box が steps の範囲を超えないようにする（設定でステップを短くした後も安全に動く） */
export function clampBox(b, steps) {
  const n = Number(b) || 0;
  return Math.min(Math.max(0, Math.round(n)), Math.max(0, steps.length - 1));
}

export function normalizeTags(tags) {
  if (!tags) return [];
  const arr = Array.isArray(tags) ? tags : String(tags).split(/[,、\s]+/);
  const out = [];
  for (const raw of arr) {
    const t = clip(String(raw).replace(/^#/, ''), LIMITS.tag);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= LIMITS.tags) break;
  }
  return out;
}

/* ---------- 忘却曲線スケジューラ ---------- */

/**
 * 復習結果を反映して次回日時を決める。
 * result: 'ok'（覚えた） | 'again'（まだ） | 'later'（あとで＝1日後）
 * 破壊的ではなく新しいオブジェクトを返す。
 */
export function review(item, result, meta = DEFAULT_META) {
  const set = meta.s || DEFAULT_META.s;
  const steps = (set.steps && set.steps.length ? set.steps : DEFAULT_STEPS);
  const it = { ...item };
  it.b = clampBox(it.b, steps);          // 設定変更でステップが短くなっていても壊れない
  it.iv = Math.max(0, Number(it.iv) || 0);
  it.rv = (it.rv || 0) + 1;

  if (result === 'later') {
    it.d = dueAfterDays(1, set.hour);
    if (it.s !== STATUS.NEW) it.s = STATUS.LEARNING;
    return it;
  }

  if (it.iv > 0) {
    // 固定間隔：まだ の場合も同じ間隔で繰り返す
    it.d = dueAfterDays(result === 'ok' ? it.iv : Math.max(1, Math.round(it.iv / 3)), set.hour);
    it.s = STATUS.LEARNING;
    return it;
  }

  if (result === 'again') {
    it.b = set.againMode === 'back' ? Math.max(0, it.b - 1) : 0;
    it.s = STATUS.LEARNING;
    it.d = dueAfterDays(steps[it.b], set.hour);
    return it;
  }

  // ok
  const next = it.b + 1;
  if (next >= steps.length) {
    it.b = steps.length - 1;
    it.s = STATUS.DONE;      // 最終ステップを通過したら完了
    it.d = 0;
  } else {
    it.b = next;
    it.s = STATUS.LEARNING;
    it.d = dueAfterDays(steps[next], set.hour);
  }
  return it;
}

/** 完了・アーカイブから学習中へ戻す（期限を必ず入れ直す） */
export function resume(item, meta = DEFAULT_META, days = 0) {
  const set = meta.s || DEFAULT_META.s;
  const steps = (set.steps && set.steps.length ? set.steps : DEFAULT_STEPS);
  return {
    ...item,
    s: STATUS.LEARNING,
    b: clampBox(item.b, steps),
    // days=0 は「今すぐ復習対象に戻す」。通知時刻を待たせない
    d: days > 0 ? dueAfterDays(days, set.hour) : Date.now()
  };
}

export function isDue(item, at = Date.now()) {
  return (item.s === STATUS.NEW || item.s === STATUS.LEARNING) && item.d > 0 && item.d <= at;
}

/* ---------- ストレージ ---------- */

const sync = () => chrome.storage.sync;
const local = () => chrome.storage.local;

/* --- meta（設定・カテゴリ）は小さいので常に sync に置く --- */

function mergeMeta(raw) {
  const m = { ...structuredClone(DEFAULT_META), ...(raw || {}) };
  m.s = { ...DEFAULT_META.s, ...((raw && raw.s) || {}) };
  m.dom = (raw && raw.dom) || {};
  if (!Array.isArray(m.cats) || !m.cats.length) m.cats = structuredClone(DEFAULT_META.cats);
  return m;
}

export async function getMeta() {
  const raw = await sync().get(META_KEY);
  return mergeMeta(raw[META_KEY]);
}

/**
 * meta を「読み直してからマージして書く」ことで、
 * ポップアップとライブラリ、他デバイスの変更が互いを消し合わないようにする。
 */
export async function setMeta(patch) {
  try {
    const cur = await getMeta();
    const next = { ...cur, ...patch };
    if (patch.s) next.s = { ...cur.s, ...patch.s };
    if (patch.dom) next.dom = pruneDom({ ...cur.dom, ...patch.dom });
    await sync().set({ [META_KEY]: next });
    return { ok: true, meta: next };
  } catch (e) {
    return { ok: false, error: describeQuotaError(e), meta: null };
  }
}

export const DOM_MAX = 60;

/**
 * ドメイン→カテゴリの記憶を上限まで刈り込む。
 * マージで書くため呼び出し側で消しても復活してしまうので、ここで面倒をみる。
 * meta は同期の1キー（8KBまで）なので、放っておくと設定が保存できなくなる。
 */
export function pruneDom(dom) {
  const keys = Object.keys(dom || {});
  if (keys.length <= DOM_MAX) return dom || {};
  const out = {};
  for (const k of keys.slice(keys.length - DOM_MAX)) out[k] = dom[k];
  return out;
}

/** meta 全体を丸ごと置き換える（設定ダイアログのように全体を編集した場合のみ） */
export async function replaceMeta(meta) {
  try {
    await sync().set({ [META_KEY]: meta });
    return { ok: true, meta };
  } catch (e) {
    return { ok: false, error: describeQuotaError(e), meta: null };
  }
}

/* 通知の最終実行時刻は同期させない（他デバイスと取り合って通知が二重に出るため） */
export async function getLastNotified() {
  try { return (await local().get('lastNotified')).lastNotified || 0; } catch { return 0; }
}
export async function setLastNotified(ts) {
  try { await local().set({ lastNotified: ts }); } catch { /* 失敗しても致命的ではない */ }
}

/* ============================================================
   ハイブリッド保存
     local … 全項目の本体（L:<id>）とサムネイル等（R:<id>）。容量無制限。
     sync  … 直近の項目だけ（i:<id>）と削除の記録（del）。他の PC へ届く分。
   ============================================================ */

/** 削除の記録を id → 時刻 の表にする */
function tombMap(dels) {
  const m = new Map();
  for (const d of (Array.isArray(dels) ? dels : [])) {
    if (d && d.i) m.set(d.i, Math.max(m.get(d.i) || 0, d.t || 0));
  }
  return m;
}

/** 項目の「最後に触った時刻」。旧バージョンの項目には up が無いので保存時刻で代用する */
function stampOf(v) {
  return Number(v && (v.up || v.cr)) || 0;
}

/** その項目が削除済みか（個別の削除、または「すべて削除」より前の内容か） */
function isDeleted(id, stamp, tombAt, wipedAt) {
  const t = tombAt.get(id);
  if (t && stamp <= t) return true;
  // 「すべて削除」と同じミリ秒に保存された項目は残す側に倒す
  //（消しすぎるより、消え残る方が取り返しがつく）
  if (wipedAt && stamp < wipedAt) return true;
  return false;
}

/** 全項目 + 設定 + 付随情報を読み出し、同期で降ってきた変更を取り込む */
export async function getAll() {
  const [ls, ss] = await Promise.all([local().get(null), sync().get(null)]);
  const meta = mergeMeta(ss[META_KEY]);

  const byId = new Map();
  const rich = {};
  for (const [k, v] of Object.entries(ls)) {
    if (k.startsWith(LOCAL_PREFIX) && v && v.u) byId.set(v.id, v);
    else if (k.startsWith(RICH_PREFIX) && v) rich[k.slice(RICH_PREFIX.length)] = v;
  }

  // 削除の記録を先に読む。取り込みより後に見ると
  // 「取り込む → 消す」を毎回くり返して書き込みが止まらなくなる。
  const tombAt = tombMap(ss[DEL_KEY]);
  const wipedAt = Number(ss[WIPE_KEY]) || 0;

  // 他の PC で保存・更新されたものを取り込む（削除済みのものは取り込まない）
  const adopt = [];
  const staleSync = [];
  for (const [k, v] of Object.entries(ss)) {
    if (!k.startsWith(ITEM_PREFIX) || !v || !v.u || !v.id) continue;
    const up = v.up || 0;
    if (isDeleted(v.id, stampOf(v), tombAt, wipedAt)) { staleSync.push(k); continue; }
    const cur = byId.get(v.id);
    if (!cur || up > (cur.up || 0)) { byId.set(v.id, v); adopt.push(v); }
  }

  // 他の PC での削除（と「すべて削除」）を反映する
  const dropped = [];
  for (const [id, cur] of [...byId.entries()]) {
    if (isDeleted(id, stampOf(cur), tombAt, wipedAt)) { byId.delete(id); dropped.push(id); }
  }

  if (adopt.length || dropped.length) {
    try {
      if (adopt.length) await local().set(Object.fromEntries(adopt.map(v => [LOCAL_PREFIX + v.id, v])));
      if (dropped.length) await local().remove(dropped.flatMap(id => [LOCAL_PREFIX + id, RICH_PREFIX + id]));
    } catch { /* 取り込みに失敗しても読み出し結果は返す */ }
  }
  // 削除済みなのに同期に残っているものを片付ける（放っておくと毎回やり直しになる）
  if (staleSync.length) { try { await sync().remove(staleSync); } catch { /* 続行 */ } }

  const items = [...byId.values()].sort((a, b) => (b.cr || 0) - (a.cr || 0));
  return { items, meta, rich };
}

export async function findByUrl(url) {
  const key = normalizeUrl(url);
  const { items } = await getAll();
  return items.find(i => normalizeUrl(i.u) === key) || null;
}

/**
 * 保存する。本体は必ず local に入るので容量で失敗しない。
 * そのあと「直近 N 件」を sync に載せ直す（載らなかった分は端末内だけに残る）。
 * @param {object} [richMap] {id: {th, si, au, du}} サムネイル等（同期しない）
 */
export async function putItems(list, richMap) {
  const now = Date.now();
  const payload = {};
  for (const it of list) {
    it.up = now;
    if (itemBytes(it) > 8100) {
      return { ok: false, error: `「${clip(it.t, 20)}」のメモが長すぎます。少し短くしてください。` };
    }
    payload[LOCAL_PREFIX + it.id] = it;
  }
  if (richMap) for (const [id, r] of Object.entries(richMap)) if (r) payload[RICH_PREFIX + id] = r;
  try {
    await local().set(payload);
  } catch (e) {
    return { ok: false, error: describeLocalError(e) };
  }
  const sres = await syncPush();
  return { ok: true, count: list.length, sync: sres };
}

export async function putItem(item, rich) {
  return putItems([item], rich ? { [item.id]: rich } : undefined);
}

/** 付随情報だけを更新する（サムネイル取得が遅れて届いた場合など） */
export async function putRich(id, rich) {
  try { await local().set({ [RICH_PREFIX + id]: rich }); return { ok: true }; }
  catch (e) { return { ok: false, error: describeLocalError(e) }; }
}

/** sync 側を「更新が新しい順に、上限まで」載せ直す */
export async function syncPush() {
  try {
    const [ls, ss] = await Promise.all([local().get(null), sync().get(null)]);
    const meta = mergeMeta(ss[META_KEY]);
    const tombAt = tombMap(ss[DEL_KEY]);
    const wipedAt = Number(ss[WIPE_KEY]) || 0;
    const all = Object.entries(ls)
      .filter(([k, v]) => k.startsWith(LOCAL_PREFIX) && v && v.u)
      .filter(([, v]) => !isDeleted(v.id, stampOf(v), tombAt, wipedAt))   // 削除済みは載せ直さない
      .map(([, v]) => v);
    const localIds = new Set(all.map(i => i.id));

    const want = [];
    if (meta.s.sync !== false) {
      const sorted = [...all].sort((a, b) => (b.up || b.cr || 0) - (a.up || a.cr || 0));
      const maxCount = Math.max(0, Number(meta.s.syncMax) || 300);
      let bytes = 0;
      for (const it of sorted) {
        if (want.length >= maxCount) break;
        const b = itemBytes(it);
        if (bytes + b > SYNC_BUDGET_BYTES) break;
        bytes += b;
        want.push(it);
      }
    }

    const wantKeys = new Set(want.map(i => ITEM_PREFIX + i.id));
    // まだこの端末に取り込んでいない他端末の項目は、同期から降ろさない。
    // 降ろすと、その端末には永久に届かなくなる。
    const drop = Object.keys(ss).filter(k => {
      if (!k.startsWith(ITEM_PREFIX) || wantKeys.has(k)) return false;
      const id = k.slice(ITEM_PREFIX.length);
      if (isDeleted(id, stampOf(ss[k]), tombAt, wipedAt)) return true;
      return localIds.has(id);
    });
    const set = {};
    for (const it of want) {
      const k = ITEM_PREFIX + it.id;
      const prev = ss[k];
      if (!prev || (prev.up || 0) !== (it.up || 0)) set[k] = it;   // 変わったものだけ書く
    }
    if (drop.length) await sync().remove(drop);
    if (Object.keys(set).length) await sync().set(set);
    return { ok: true, synced: want.length, total: all.length };
  } catch (e) {
    return { ok: false, error: describeQuotaError(e), synced: 0 };
  }
}

export async function removeItems(ids) {
  if (!ids.length) return { ok: true };
  try {
    await local().remove(ids.flatMap(id => [LOCAL_PREFIX + id, RICH_PREFIX + id]));
  } catch (e) {
    return { ok: false, error: describeLocalError(e) };
  }
  try {
    // 他の PC にも削除を伝えるため、記録を残す（60日 / 120件まで）
    const ss = await sync().get(DEL_KEY);
    const now = Date.now();
    const keep = (Array.isArray(ss[DEL_KEY]) ? ss[DEL_KEY] : [])
      .filter(d => d && d.i && now - d.t < DEL_KEEP_DAYS * 86400000 && !ids.includes(d.i));
    for (const id of ids) keep.push({ i: id, t: now });
    await sync().remove(ids.map(id => ITEM_PREFIX + id));
    await sync().set({ [DEL_KEY]: keep.slice(-DEL_MAX) });
  } catch { /* 同期側の後片付けに失敗しても本体は消えている */ }
  return { ok: true };
}

/** すべて消す（設定ダイアログの「すべて削除」） */
export async function wipeAll() {
  // 先に sync を空にする。逆順だと、消している最中に別のコンテキスト（Service Worker）が
  // getAll() を呼び、sync に残っていた項目を local へ取り込み直してしまう。
  try { await sync().clear(); } catch { /* 続行 */ }
  try { await local().clear(); } catch { /* 続行 */ }
  await new Promise(r => setTimeout(r, 250));
  try { await local().clear(); } catch { /* 続行 */ }   // 取り込みが競合した場合の念のため
  // 「すべて削除した」ことを同期にも残す。これが無いと、他の PC に残っていた項目が
  // 次の同期でそっくり戻ってきてしまう（削除の記録は消してしまったので効かない）。
  try { await sync().set({ [WIPE_KEY]: Date.now() }); } catch { /* 続行 */ }
  return { ok: true };
}

/** Chrome が数えるのと同じ「キー名 + JSON 文字列」の UTF-8 バイト数 */
export function itemBytes(item) {
  return byteSize(ITEM_PREFIX + item.id) + byteSize(JSON.stringify(item));
}

export function describeQuotaError(e) {
  const msg = String((e && e.message) || e || '');
  if (/QUOTA_BYTES_PER_ITEM/i.test(msg)) return '1件あたりの上限を超えました。メモを短くしてください。';
  if (/MAX_ITEMS/i.test(msg)) return `同期できる件数の上限に達しました。新しいものから順に同期され、残りは端末内に保存されます。`;
  if (/QUOTA_BYTES/i.test(msg)) return '同期ストレージ（100KB）がいっぱいです。新しいものから順に同期され、残りは端末内に保存されます。';
  if (/WRITE_OPERATIONS/i.test(msg)) return '短時間に書き込みすぎました。少し待ってからもう一度お試しください。';
  return msg || '同期に失敗しました。';
}

export function describeLocalError(e) {
  const msg = String((e && e.message) || e || '');
  if (/QUOTA_BYTES/i.test(msg)) return 'この端末の保存領域がいっぱいです。不要な項目を削除してください。';
  return msg || '保存に失敗しました。';
}

export async function usage() {
  const [ls, ss] = await Promise.all([local().get(null), sync().get(null)]);
  const total = Object.keys(ls).filter(k => k.startsWith(LOCAL_PREFIX)).length;
  const synced = Object.keys(ss).filter(k => k.startsWith(ITEM_PREFIX)).length;
  let syncBytes = 0, localBytes = 0;
  try { syncBytes = await sync().getBytesInUse(null); } catch { /* 取れなくても表示は続ける */ }
  try { localBytes = await local().getBytesInUse(null); } catch { /* 同上 */ }
  return {
    total, synced, syncBytes, localBytes,
    maxBytes: SYNC_QUOTA_BYTES,
    pct: Math.min(1, syncBytes / SYNC_QUOTA_BYTES)
  };
}

/* ---------- 集計・検索 ---------- */

export function tagCounts(items) {
  const map = new Map();
  for (const it of items) for (const t of it.g || []) map.set(t, (map.get(t) || 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function matches(item, query) {
  if (!query) return true;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${item.t} ${item.u} ${item.n} ${(item.g || []).join(' ')}`.toLowerCase();
  return terms.every(t => hay.includes(t));
}
